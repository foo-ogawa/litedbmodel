// DB-backed unit tests for the native leaf transport (#141): the tx-scope wrapper (WithAmbientTransaction)
// and the single-write summary shape. These exercise ExecuteSQL against a real in-proc sqlite so the
// transport's live SQL path + tx boundary are proven independently of the bc-generated bench cell (the
// full bench is blocked on bc#174). Go twins of the rust `leaves.rs` tests.

package litedbmodel_runtime

import (
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/foo-ogawa/litedbmodel/go/litedbmodel_runtime/wire"

	_ "modernc.org/sqlite" // pure-go sqlite driver (registered as "sqlite")
)

// openBoundT opens a fresh in-memory sqlite (one pooled connection so schema + tx + reads share the same
// DB), creates table t, and binds the leaf transport to it. Returns the db; the caller unbinds.
func openBoundT(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if _, err := db.Exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)"); err != nil {
		t.Fatalf("ddl: %v", err)
	}
	BindLeafTransport(ContextForDB(db), "sqlite")
	return db
}

// optsPort builds the `opts` control record port — the ExecOptions record the covered runner assembles:
// how to run the statement plus its two optional control structs (wire.WireNull() ⇒ the record's null
// field, which is how ABSENCE is spelled now that nothing is positional). `write` is the WriteMode ROW
// (or null for a read), so a read cannot claim a `returning` of its own (#206).
func optsPort(db, write, whereDynamic, guard wire.WireValue) wire.WireField {
	return port("opts", wire.WireRowOf([]wire.WireField{
		{Key: "db", Val: db},
		{Key: "guard", Val: guard},
		{Key: "whereDynamic", Val: whereDynamic},
		{Key: "write", Val: write},
	}))
}

// writeMode builds the `write` field's WriteMode row — a write, and whether it yields rows.
func writeModeRow(returning bool) wire.WireValue {
	return wire.WireRowOf([]wire.WireField{{Key: "returning", Val: wire.WireBool(returning)}})
}

// planPort builds an `opts` record whose `whereDynamic` carries ONE fragment (the #209 cases).
func planPort(frag wire.WireValue) wire.WireField {
	return optsPort(wire.WireNull(), wire.WireNull(), wire.WireRowOf([]wire.WireField{
		{Key: "frags", Val: wire.WireListOf([]wire.WireValue{frag})},
	}), wire.WireNull())
}

// sqlPayload builds the executeSQL node payload (the ports the covered runner assembles by name). A
// plain READ omits the control record entirely — exactly what the emitter generates for one — so this
// covers both the absent-record default and the present-record path.
func sqlPayload(params []wire.WireValue, sql string, write bool) wire.WireRow {
	ports := []wire.WireField{port("params", wire.WireListOf(params)), port("sql", wire.WireStr(sql))}
	if write {
		ports = append(ports, optsPort(wire.WireNull(), writeModeRow(false), wire.WireNull(), wire.WireNull()))
	}
	return leafPayload(ports...)
}

// insT issues one INSERT through ExecuteSQL (the covered write path). Returns the leaf result wire.
func insT(id int64, v string) (wire.WireValue, error) {
	return ExecuteSQL(sqlPayload([]wire.WireValue{wire.WireInt(id), wire.WireStr(v)}, "INSERT INTO t (id, v) VALUES (?, ?)", true))
}

// countT reads COUNT(*) via ExecuteSQL (the covered read path) and returns the single numeric cell.
func countT(t *testing.T) string {
	t.Helper()
	out, err := ExecuteSQL(sqlPayload(nil, "SELECT COUNT(*) AS c FROM t", false))
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	lp := out.AsList()
	if lp.Kind != wireProbeGot || lp.Got.Len() != 1 {
		t.Fatalf("count: want 1 row, got kind=%d len=%d", lp.Kind, lp.Got.Len())
	}
	row := lp.Got.ElemRow(0)
	np := row.Got.ProbeInt("c")
	if np.Kind != wireProbeGot {
		t.Fatalf("count cell not an int (kind=%d)", np.Kind)
	}
	return strconv.FormatInt(np.Got, 10)
}

// A non-RETURNING write returns the uniform one-row [{changes,lastInsertRowid}] summary (rust
// execute_sql parity) — NOT an empty list. (#141 slice-2 piece 2.)
func TestExecuteSQL_WriteSummaryShape(t *testing.T) {
	db := openBoundT(t)
	defer db.Close()
	defer UnbindLeafTransport()

	out, err := insT(7, "a")
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	lp := out.AsList()
	if lp.Kind != wireProbeGot || lp.Got.Len() != 1 {
		t.Fatalf("write summary: want a 1-row list, got kind=%d len=%d", lp.Kind, lp.Got.Len())
	}
	row := lp.Got.ElemRow(0)
	if row.Kind != wireProbeGot {
		t.Fatalf("write summary elem is not a row (kind=%d)", row.Kind)
	}
	if ch := row.Got.ProbeInt("changes"); ch.Kind != wireProbeGot || ch.Got != 1 {
		t.Fatalf("changes = %+v, want 1", ch)
	}
	if li := row.Got.ProbeInt("lastInsertRowid"); li.Kind != wireProbeGot || li.Got != 7 {
		t.Fatalf("lastInsertRowid = %+v, want 7 (the inserted PK)", li)
	}
}

// WithAmbientTransaction atomicity (#142 / slice-2 piece 1): ok body COMMITs (all writes persist);
// a mid-tx body error ROLLBACKs (no rows persist). Mirror of rust's
// tx_commits_on_ok_and_rolls_back_on_err. Proves the covered tx runner's boundary is genuinely atomic.
func TestWithAmbientTransaction_CommitsOnOkRollsBackOnErr(t *testing.T) {
	db := openBoundT(t)
	defer db.Close()
	defer UnbindLeafTransport()

	// Ok body: two inserts on the tx-owned connection → COMMIT → both rows persist.
	if err := WithAmbientTransaction(func() error {
		if _, e := insT(1, "a"); e != nil {
			return e
		}
		_, e := insT(2, "b")
		return e
	}); err != nil {
		t.Fatalf("committed tx returned error: %v", err)
	}
	if got := countT(t); got != "2" {
		t.Fatalf("after commit: row count = %s, want 2 (all writes persisted)", got)
	}

	// Err body: insert row 3 then fail mid-tx → ROLLBACK → row 3 must NOT persist (still 2 rows).
	boom := errors.New("mid-tx failure")
	err := WithAmbientTransaction(func() error {
		if _, e := insT(3, "c"); e != nil { // issued inside the tx…
			return e
		}
		return boom // …then the body errors → rollback
	})
	if !errors.Is(err, boom) {
		t.Fatalf("rolled-back tx must propagate the body error, got %v", err)
	}
	if got := countT(t); got != "2" {
		t.Fatalf("after rollback: row count = %s, want 2 (row 3 must be gone)", got)
	}
}

// The tx-scoped ambient is restored after the transaction: a plain ExecuteSQL write AFTER the tx runs
// on the bound (non-tx) connection and persists (proves the ambient swap does not leak past the body).
func TestWithAmbientTransaction_RestoresAmbient(t *testing.T) {
	db := openBoundT(t)
	defer db.Close()
	defer UnbindLeafTransport()

	if err := WithAmbientTransaction(func() error { _, e := insT(1, "a"); return e }); err != nil {
		t.Fatalf("tx: %v", err)
	}
	if _, err := insT(2, "b"); err != nil { // outside any tx — on the restored ambient
		t.Fatalf("post-tx write: %v", err)
	}
	if got := countT(t); got != "2" {
		t.Fatalf("row count = %s, want 2 (tx write + post-tx write)", got)
	}
}

// guardPayload builds a READ executeSQL payload whose control record carries the relation `guard` — the
// runaway cap the emitter bakes onto a guarded relation child fetch (`{limit, model, relation}`).
func guardPayload(sql string, limit int64, model, relation string) wire.WireRow {
	return leafPayload(
		optsPort(wire.WireNull(), wire.WireNull(), wire.WireNull(), wire.WireRowOf([]wire.WireField{
			{Key: "limit", Val: wire.WireInt(limit)},
			{Key: "model", Val: wire.WireStr(model)},
			{Key: "relation", Val: wire.WireStr(relation)},
		})),
		port("params", wire.WireListOf(nil)),
		port("sql", wire.WireStr(sql)),
	)
}

// The RELATION runaway guard (#160), on the RAW child rows of a guarded relation child fetch: over the
// cap ⇒ a *LimitExceededError with the relation-context fields and the EXACT batch count; within the
// cap ⇒ the rows, unchanged. This is the go leg of "the same behaviour in all five languages" — the
// twin of the rust `relation_guard_trips_on_the_raw_child_rows` and of the TS conformance guard
// vectors, proven against a real in-proc sqlite rather than by inspection.
func TestExecuteSQL_RelationGuardOnRawChildRows(t *testing.T) {
	db := openBoundT(t)
	defer db.Close()
	defer UnbindLeafTransport()
	for i, v := range []string{"a", "b", "c"} {
		if _, err := insT(int64(i+1), v); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	// 3 rows > cap 2 ⇒ the transport raises before the rows are handed on.
	_, err := ExecuteSQL(guardPayload("SELECT id, v FROM t ORDER BY id", 2, "t", "things"))
	if err == nil {
		t.Fatal("a relation batch over its cap must raise")
	}
	var lim *LimitExceededError
	if !errors.As(err, &lim) {
		t.Fatalf("want *LimitExceededError, got %T (%v)", err, err)
	}
	if lim.Context != LimitContextRelation || lim.Limit != 2 || lim.Count != 3 || lim.Model != "t" || lim.Relation != "things" {
		t.Fatalf("unexpected guard fields: %+v", lim)
	}
	want := "Query limit exceeded: relation 'things' on t returned 3 records, but limit is 2. " +
		"This usually indicates a missing WHERE clause or an N+1 query pattern. " +
		"Set a higher limit or use pagination."
	if lim.Error() != want {
		t.Fatalf("message =\n%q\nwant\n%q", lim.Error(), want)
	}

	// 3 rows ≤ cap 3 ⇒ no raise, and the rows come back untouched.
	out, err := ExecuteSQL(guardPayload("SELECT id, v FROM t ORDER BY id", 3, "t", "things"))
	if err != nil {
		t.Fatalf("a batch within its cap must pass: %v", err)
	}
	if lp := out.AsList(); lp.Kind != wireProbeGot || lp.Got.Len() != 3 {
		t.Fatalf("want the 3 rows back, got kind=%d len=%d", lp.Kind, lp.Got.Len())
	}

	// An UNCAPPED statement (no guard port at all) is never checked — the byte-unchanged path.
	if _, err := ExecuteSQL(sqlPayload(nil, "SELECT id, v FROM t ORDER BY id", false)); err != nil {
		t.Fatalf("an uncapped read must not be guarded: %v", err)
	}
}

// #192 — a MIXED read as the emitter now lowers it (CLAUDE.md §2): the BOUNDED predicate is the
// statement's own static WHERE and the page count binds after it, so the surviving fragment has to
// CONTINUE that WHERE with " AND " (a second " WHERE " is a syntax error) and its param has to bind
// BETWEEN the bounded value and the count (any other order binds `id > 'c'` / `v = 1` and returns
// nothing). Proven end-to-end against a real sqlite: only the correct assembly yields row 3. The go leg
// of the five-language parity (rust `dynamic_where_continues_a_bounded_where`, python
// `test_dynamic_where_continues_a_bounded_where`, php `DynamicWhereTest`, TS `leaves.test.ts`).
func TestExecuteSQL_DynamicWhereContinuesBoundedWhere(t *testing.T) {
	db := openBoundT(t)
	defer db.Close()
	defer UnbindLeafTransport()
	for i, v := range []string{"a", "b", "c"} {
		if _, err := insT(int64(i+1), v); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	frag := wire.WireRowOf([]wire.WireField{
		{Key: "skipped", Val: wire.WireBool(false)},
		{Key: "sql", Val: wire.WireStr("v = ?")},
		{Key: "params", Val: wire.WireListOf([]wire.WireValue{wire.WireStr("c")})},
	})
	out, err := ExecuteSQL(leafPayload(
		optsPort(wire.WireNull(), wire.WireNull(), wire.WireRowOf([]wire.WireField{
			{Key: "frags", Val: wire.WireListOf([]wire.WireValue{frag})},
		}), wire.WireNull()),
		port("params", wire.WireListOf([]wire.WireValue{wire.WireInt(1), wire.WireInt(2)})),
		port("sql", wire.WireStr("SELECT id FROM t WHERE id > ? ORDER BY id LIMIT ?")),
	))
	if err != nil {
		t.Fatalf("dynamic read: %v", err)
	}
	lp := out.AsList()
	if lp.Kind != wireProbeGot || lp.Got.Len() != 1 {
		t.Fatalf("id > 1 AND v = 'c' selects exactly one row, got kind=%d len=%d", lp.Kind, lp.Got.Len())
	}
	if id := lp.Got.ElemRow(0).Got.ProbeInt("id"); id.Kind != wireProbeGot || id.Got != 3 {
		t.Fatalf("id = %+v, want 3", id)
	}
}

// #205 — a field ABSENT from a PRESENT struct, or present as the WRONG VARIANT, is an ABI BREAK, never
// an absent VALUE. bc types a port by the literal wired into it and REJECTS a partial struct, so a
// generated module always spells every field of every struct it wires, with the type the port declares
// (`null` is how absence is spelled). Neither shape came from one, and reading it anyway would silently
// drop a relation cap, erase a SKIP predicate, or run a write as a read. The five languages must agree;
// this is the go leg.
func TestExecuteSQL_MissingOrMistypedFieldOfAPresentStructIsLoud(t *testing.T) {
	db := openBoundT(t)
	defer db.Close()
	defer UnbindLeafTransport()
	for i, v := range []string{"a", "b", "c"} {
		if _, err := insT(int64(i+1), v); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	sqlPort := port("sql", wire.WireStr("SELECT id, v FROM t ORDER BY id"))
	paramsPort := port("params", wire.WireListOf(nil))
	cap2 := wire.WireRowOf([]wire.WireField{
		{Key: "limit", Val: wire.WireInt(2)},
		{Key: "model", Val: wire.WireStr("t")},
		{Key: "relation", Val: wire.WireStr("things")},
	})

	// Each case breaks exactly ONE declared field of a struct that is present — by DROPPING it first…
	for _, tc := range []struct {
		name    string
		payload wire.WireRow
		want    string
	}{
		{"payload without sql", leafPayload(paramsPort), `port "sql" is absent`},
		{"payload without params", leafPayload(sqlPort), `port "params" is absent`},
		{"record without db", leafPayload(sqlPort, paramsPort, port("opts", wire.WireRowOf([]wire.WireField{
			{Key: "guard", Val: wire.WireNull()}, {Key: "whereDynamic", Val: wire.WireNull()},
			{Key: "write", Val: wire.WireNull()},
		}))), `port "db" is absent`},
		{"record without write", leafPayload(sqlPort, paramsPort, port("opts", wire.WireRowOf([]wire.WireField{
			{Key: "db", Val: wire.WireNull()},
			{Key: "guard", Val: wire.WireNull()}, {Key: "whereDynamic", Val: wire.WireNull()},
		}))), `port "write" is absent`},
		{"record without whereDynamic", leafPayload(sqlPort, paramsPort, port("opts", wire.WireRowOf([]wire.WireField{
			{Key: "db", Val: wire.WireNull()},
			{Key: "guard", Val: wire.WireNull()}, {Key: "write", Val: wire.WireNull()},
		}))), `port "whereDynamic" is absent`},
		{"record without guard", leafPayload(sqlPort, paramsPort, port("opts", wire.WireRowOf([]wire.WireField{
			{Key: "db", Val: wire.WireNull()},
			{Key: "whereDynamic", Val: wire.WireNull()}, {Key: "write", Val: wire.WireNull()},
		}))), `port "guard" is absent`},
		{"write mode without returning", leafPayload(sqlPort, paramsPort,
			optsPort(wire.WireNull(), wire.WireRowOf(nil), wire.WireNull(), wire.WireNull())), `port "returning" is absent`},
		{"guard without model", leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(), wire.WireNull(),
			wire.WireRowOf([]wire.WireField{{Key: "limit", Val: wire.WireInt(2)}, {Key: "relation", Val: wire.WireStr("things")}}))),
			`port "guard.model" is absent`},
		// An absent `guard.limit` / `guard.relation` reports ABSENT, not "expected an int, got NULL":
		// #205/#210's whole point is that a wire null and a missing key are different failures, and a
		// reader that names the wrong one sends the next reader looking for a null that was never there.
		{"guard without limit", leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(), wire.WireNull(),
			wire.WireRowOf([]wire.WireField{{Key: "model", Val: wire.WireStr("t")}, {Key: "relation", Val: wire.WireStr("things")}}))),
			`port "guard.limit" is absent`},
		{"guard without relation", leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(), wire.WireNull(),
			wire.WireRowOf([]wire.WireField{{Key: "limit", Val: wire.WireInt(2)}, {Key: "model", Val: wire.WireStr("t")}}))),
			`port "guard.relation" is absent`},
		// …and the PLAN and its FRAGMENTS, one level further down (#209).
		{"plan without frags", leafPayload(sqlPort, paramsPort,
			optsPort(wire.WireNull(), wire.WireNull(), wire.WireRowOf(nil), wire.WireNull())), `port "whereDynamic.frags" is absent`},
		{"fragment without skipped", leafPayload(sqlPort, paramsPort, planPort(wire.WireRowOf([]wire.WireField{
			{Key: "sql", Val: wire.WireStr("v = ?")}, {Key: "params", Val: wire.WireListOf([]wire.WireValue{wire.WireStr("zzz")})},
		}))), `whereDynamic.frags.skipped`},
		{"fragment without sql", leafPayload(sqlPort, paramsPort, planPort(wire.WireRowOf([]wire.WireField{
			{Key: "skipped", Val: wire.WireBool(false)}, {Key: "params", Val: wire.WireListOf([]wire.WireValue{wire.WireStr("zzz")})},
		}))), `whereDynamic.frags.sql`},
		{"fragment without params", leafPayload(sqlPort, paramsPort, planPort(wire.WireRowOf([]wire.WireField{
			{Key: "skipped", Val: wire.WireBool(false)}, {Key: "sql", Val: wire.WireStr("v = ?")},
		}))), `whereDynamic.frags.params`},
		// A SKIPPED fragment is unboxed too — it is spelled in full like any other.
		{"skipped fragment without sql", leafPayload(sqlPort, paramsPort, planPort(wire.WireRowOf([]wire.WireField{
			{Key: "skipped", Val: wire.WireBool(true)}, {Key: "params", Val: wire.WireListOf(nil)},
		}))), `whereDynamic.frags.sql`},
		// …and then by giving it the WRONG VARIANT, which is the same ABI break in every one of those
		// positions: bc emits the literal the port's type says, so nothing else can arrive from a
		// generated module, and reading it anyway is how a `returning` that is not a bool would run an
		// INSERT on the READ seam and a `skipped` that is not a bool would apply a predicate the call
		// SKIPPED — the #209 failure modes, reached by another route.
		{"payload sql not a string", leafPayload(paramsPort, port("sql", wire.WireInt(42))),
			`port "sql" expected a wire string`},
		{"payload params not a list", leafPayload(sqlPort, port("params", wire.WireStr("x"))),
			`port "params" expected a wire list`},
		{"opts not a row", leafPayload(sqlPort, paramsPort, port("opts", wire.WireStr("nope"))),
			`port "opts" expected a wire row`},
		{"write not a row", leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireStr("nope"), wire.WireNull(), wire.WireNull())),
			`port "write" expected a wire row`},
		{"returning not a bool", leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(),
			wire.WireRowOf([]wire.WireField{{Key: "returning", Val: wire.WireStr("nope")}}), wire.WireNull(), wire.WireNull())),
			`port "returning" expected a wire bool`},
		{"whereDynamic not a row", leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(), wire.WireStr("nope"), wire.WireNull())),
			`port "whereDynamic" expected a wire row`},
		{"frags not a list", leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(),
			wire.WireRowOf([]wire.WireField{{Key: "frags", Val: wire.WireStr("nope")}}), wire.WireNull())),
			`port "whereDynamic.frags" expected a wire list`},
		{"fragment not a row", leafPayload(sqlPort, paramsPort, planPort(wire.WireStr("nope"))),
			`port "whereDynamic.frags element" expected a wire row`},
		{"fragment skipped not a bool", leafPayload(sqlPort, paramsPort, planPort(wire.WireRowOf([]wire.WireField{
			{Key: "skipped", Val: wire.WireStr("no")}, {Key: "sql", Val: wire.WireStr("v = ?")},
			{Key: "params", Val: wire.WireListOf(nil)},
		}))), `port "whereDynamic.frags.skipped" expected a wire bool`},
		{"fragment sql not a string", leafPayload(sqlPort, paramsPort, planPort(wire.WireRowOf([]wire.WireField{
			{Key: "skipped", Val: wire.WireBool(false)}, {Key: "sql", Val: wire.WireInt(42)},
			{Key: "params", Val: wire.WireListOf(nil)},
		}))), `port "whereDynamic.frags.sql" expected a wire string`},
		{"fragment params not a list", leafPayload(sqlPort, paramsPort, planPort(wire.WireRowOf([]wire.WireField{
			{Key: "skipped", Val: wire.WireBool(false)}, {Key: "sql", Val: wire.WireStr("v = ?")},
			{Key: "params", Val: wire.WireStr("z")},
		}))), `port "whereDynamic.frags.params" expected a wire list`},
		{"guard not a row", leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(), wire.WireNull(), wire.WireStr("nope"))),
			`port "guard" expected a wire row`},
		{"guard limit not an int", leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(), wire.WireNull(),
			wire.WireRowOf([]wire.WireField{
				{Key: "limit", Val: wire.WireStr("nope")}, {Key: "model", Val: wire.WireStr("t")},
				{Key: "relation", Val: wire.WireStr("things")},
			}))), `port "guard.limit" expected a wire int`},
		{"guard model not a string", leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(), wire.WireNull(),
			wire.WireRowOf([]wire.WireField{
				{Key: "limit", Val: wire.WireInt(2)}, {Key: "model", Val: wire.WireInt(42)},
				{Key: "relation", Val: wire.WireStr("things")},
			}))), `port "guard.model" expected a wire string`},
		{"guard relation not a string", leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(), wire.WireNull(),
			wire.WireRowOf([]wire.WireField{
				{Key: "limit", Val: wire.WireInt(2)}, {Key: "model", Val: wire.WireStr("t")},
				{Key: "relation", Val: wire.WireInt(42)},
			}))), `port "guard.relation" expected a wire string`},
	} {
		_, err := ExecuteSQL(tc.payload)
		if err == nil {
			t.Fatalf("%s: must be loud, got no error", tc.name)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: error %q does not name the broken field (want %q)", tc.name, err.Error(), tc.want)
		}
	}

	// The LEGAL absences stay silent: an omitted record is a plain read, and a null FIELD is how an
	// absent write mode / plan / cap is spelled. Neither may be turned into a failure by the above.
	if _, err := ExecuteSQL(leafPayload(sqlPort, paramsPort)); err != nil {
		t.Fatalf("an omitted control record is a plain read, got %v", err)
	}
	if _, err := ExecuteSQL(leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(), wire.WireNull(), wire.WireNull()))); err != nil {
		t.Fatalf("an all-null control record is a plain read, got %v", err)
	}
	// …and a cap that IS spelled still trips (the fail-closed reads did not disarm it).
	if _, err := ExecuteSQL(leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(), wire.WireNull(), cap2))); err == nil {
		t.Fatal("a relation batch over its cap must still raise")
	}
}

// ── #217 named-DB: the statement's own connection reaches the router, or is LOUD ─────────────────

// namedDBPools opens TWO in-proc sqlite databases and registers them as the `default` and `B`
// connections. `B` alone holds the table, so a statement that lands on the WRONG connection does not
// return the wrong rows — it cannot see a table at all. A single-DB fixture cannot tell a honored
// connection name from a dropped one, which is exactly why the defect survived the single-DB
// conformance and livedb suites (#217).
func namedDBPools(t *testing.T) (*ExecutionContext, func()) {
	t.Helper()
	open := func(seed ...string) *sql.DB {
		db, err := sql.Open("sqlite", ":memory:")
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
		for _, s := range seed {
			if _, err := db.Exec(s); err != nil {
				t.Fatalf("seed %q: %v", s, err)
			}
		}
		return db
	}
	// DB "A" (the default connection) holds an UNRELATED table; DB "B" holds `named_users`.
	a := open("CREATE TABLE only_in_a (id INTEGER PRIMARY KEY)")
	b := open("CREATE TABLE named_users (id INTEGER PRIMARY KEY, name TEXT)",
		"INSERT INTO named_users VALUES (1,'Ada'),(2,'Bob')")
	reg := NewConnectionRegistry(map[string]ReaderWriterPools{
		DefaultConnection: SinglePoolPair(NewSQLDBPool(a)),
		"B":               SinglePoolPair(NewSQLDBPool(b)),
	})
	ctx := ContextForRouting(RoutingConfig{
		Registry: reg,
		Sticky:   NewWriterStickyClock(StickyOptions{UseWriterAfterTransaction: boolPtr(false)}),
	}, nil)
	BindLeafTransport(ctx, "sqlite")
	return ctx, func() {
		UnbindLeafTransport()
		_ = a.Close()
		_ = b.Close()
	}
}

// The go leg of "the same behaviour in all five languages": the `db` field of the control record is the
// ONLY thing that decides which registered connection serves the statement. The twin of the TS
// `leaves.test.ts` #217 tests, the rust `named_db_routes_the_statement`, the python
// `test_named_db_routes_the_statement` and the php `NamedDbRoutingTest`.
func TestExecuteSQL_NamedDBRoutesTheStatement(t *testing.T) {
	_, done := namedDBPools(t)
	defer done()

	read := func(db wire.WireValue) (wire.WireValue, error) {
		return ExecuteSQL(leafPayload(
			port("sql", wire.WireStr("SELECT id, name FROM named_users ORDER BY id")),
			port("params", wire.WireListOf(nil)),
			optsPort(db, wire.WireNull(), wire.WireNull(), wire.WireNull()),
		))
	}

	// NAMED ⇒ B served it. The rows are unforgeable: `named_users` exists in NO other registered db.
	got, err := read(wire.WireStr("B"))
	if err != nil {
		t.Fatalf(`db "B": %v`, err)
	}
	if l := got.AsList(); l.Kind != wireProbeGot || l.Got.Len() != 2 {
		t.Fatalf(`db "B" returned %v, want the 2 rows of the named db`, got)
	}

	// NEGATIVE CONTROL — the name DROPPED (a wire null, which is exactly the pre-#217 lowering) sends the
	// SAME statement to the DEFAULT connection, where the table does not exist. Measured, not reasoned:
	// this is the failure a cross-DB relation produced before the emitter lowered the name.
	if _, err := read(wire.WireNull()); err == nil {
		t.Fatal("db null must hit the DEFAULT connection, where named_users does not exist — got no error")
	} else if !strings.Contains(err.Error(), "named_users") {
		t.Fatalf("db null error = %v, want a missing-table failure naming named_users", err)
	}

	// An UNREGISTERED name is LOUD, never a silent fall back to the default.
	if _, err := read(wire.WireStr("ghost")); err == nil || !strings.Contains(err.Error(), "no connection registered under name 'ghost'") {
		t.Fatalf(`db "ghost" error = %v, want the loud unregistered-name failure`, err)
	}
}

// A named statement on a NON-ROUTED ctx (the single-primary-db [ContextForDB] path) has no registry to
// resolve the name against, so it must be LOUD. Running it on the primary db anyway is the silent
// wrong-database execution named-DB lowering exists to prevent — and a single-DB deployment is exactly
// where it would go unnoticed.
func TestExecuteSQL_NamedDBOnANonRoutedContextIsLoud(t *testing.T) {
	db := openBoundT(t)
	defer func() {
		UnbindLeafTransport()
		_ = db.Close()
	}()
	_, err := ExecuteSQL(leafPayload(
		port("sql", wire.WireStr("SELECT id FROM t")),
		port("params", wire.WireListOf(nil)),
		optsPort(wire.WireStr("analytics"), wire.WireNull(), wire.WireNull(), wire.WireNull()),
	))
	if err == nil || !strings.Contains(err.Error(), "a statement names connection 'analytics'") {
		t.Fatalf("non-routed named statement error = %v, want the loud no-registry failure", err)
	}
	// The DEFAULT connection is the single-db case itself and still runs.
	if _, err := ExecuteSQL(leafPayload(
		port("sql", wire.WireStr("SELECT id FROM t")),
		port("params", wire.WireListOf(nil)),
		optsPort(wire.WireNull(), wire.WireNull(), wire.WireNull(), wire.WireNull()),
	)); err != nil {
		t.Fatalf("unnamed statement on the single-db ctx: %v", err)
	}
}

// #217 R1 — INSIDE a transaction, a statement's named database must AGREE with the one the transaction
// opened on, or be LOUD. The pin is resolved BEFORE routing (per-execution ownership depends on it), so
// intent.DB used to be dropped unread: a `db:"B"` statement inside a tx on the DEFAULT connection ran on
// the DEFAULT one, silently, and an UNREGISTERED name never surfaced at all. A transaction is ONE
// connection on ONE database, so the two cannot both be honored.
//
// The whole matrix is asserted, the NORMAL cases included: an unnamed in-body statement, and one naming
// the tx's OWN database, must NOT become loud. The go leg; twins in TS / rust / python / php.
func TestExecuteSQL_NamedDBInsideATransactionMustAgree(t *testing.T) {
	ctx, done := namedDBPools(t)
	defer done()

	read := func(db wire.WireValue) (wire.WireValue, error) {
		return ExecuteSQL(leafPayload(
			port("sql", wire.WireStr("SELECT id, name FROM named_users ORDER BY id")),
			port("params", wire.WireListOf(nil)),
			optsPort(db, wire.WireNull(), wire.WireNull(), wire.WireNull()),
		))
	}
	// The DEFAULT db has no `named_users`, so a read that reaches it fails on the TABLE — which is how a
	// silently-mis-routed statement is told apart from a LOUD refusal.
	countOnA := func(db wire.WireValue) (wire.WireValue, error) {
		return ExecuteSQL(leafPayload(
			port("sql", wire.WireStr("SELECT count(*) AS n FROM only_in_a")),
			port("params", wire.WireListOf(nil)),
			optsPort(db, wire.WireNull(), wire.WireNull(), wire.WireNull()),
		))
	}

	// A transaction on the DEFAULT connection (the ctx names none).
	BindLeafTransport(ctx, "sqlite")
	if err := WithAmbientTransaction(func() error {
		// ORDINARY in-body statement (unnamed) → the pin. It must NOT be loud.
		if _, err := countOnA(wire.WireNull()); err != nil {
			t.Fatalf("an unnamed in-body statement must run on the pin: %v", err)
		}
		// A statement naming ANOTHER database is LOUD. Before this it returned B's rows' worth of nothing:
		// it ran on the tx's own (DEFAULT) connection, silently.
		if _, err := read(wire.WireStr("B")); err == nil ||
			!strings.Contains(err.Error(), "transaction opened on 'default'") {
			t.Fatalf(`db "B" inside a default tx = %v, want the LOUD disagreement`, err)
		}
		// An UNREGISTERED name is loud too (the pin used to swallow it whole).
		if _, err := read(wire.WireStr("ghost")); err == nil ||
			!strings.Contains(err.Error(), "names connection 'ghost'") {
			t.Fatalf(`db "ghost" inside a tx = %v, want LOUD`, err)
		}
		return nil
	}); err != nil {
		t.Fatalf("default tx: %v", err)
	}

	// A transaction on "B": the statement naming "B" AGREES and runs on the pin — the rows are
	// unforgeable (named_users exists in NO other registered db) — and "default" now disagrees.
	BindLeafTransport(ctx.WithConnectionName("B"), "sqlite")
	if err := WithAmbientTransaction(func() error {
		got, err := read(wire.WireStr("B"))
		if err != nil {
			t.Fatalf(`db "B" inside a tx on B must run: %v`, err)
		}
		if l := got.AsList(); l.Kind != wireProbeGot || l.Got.Len() != 2 {
			t.Fatalf(`db "B" inside a tx on B returned %v, want B's 2 rows`, got)
		}
		if _, err := read(wire.WireNull()); err != nil {
			t.Fatalf("an unnamed in-body statement must run on the pin: %v", err)
		}
		if _, err := countOnA(wire.WireStr("default")); err == nil ||
			!strings.Contains(err.Error(), "transaction opened on 'B'") {
			t.Fatalf(`db "default" inside a tx on B = %v, want the LOUD disagreement`, err)
		}
		return nil
	}); err != nil {
		t.Fatalf("named tx: %v", err)
	}
}

// #217 R2 — a NON-ROUTED ctx rejects a named statement IDENTICALLY inside a transaction and outside it.
// The guard used to sit BEFORE the pin on the TS/php planes and AFTER it here, so "a named statement in a
// non-routed tx" threw in two languages and ran silently in three.
func TestExecuteSQL_NamedDBOnANonRoutedContextIsLoudInsideATransactionToo(t *testing.T) {
	db := openBoundT(t)
	defer func() {
		UnbindLeafTransport()
		_ = db.Close()
	}()
	named := func() error {
		_, err := ExecuteSQL(leafPayload(
			port("sql", wire.WireStr("SELECT id FROM t")),
			port("params", wire.WireListOf(nil)),
			optsPort(wire.WireStr("analytics"), wire.WireNull(), wire.WireNull(), wire.WireNull()),
		))
		return err
	}
	unnamed := func() error {
		_, err := ExecuteSQL(leafPayload(
			port("sql", wire.WireStr("SELECT id FROM t")),
			port("params", wire.WireListOf(nil)),
			optsPort(wire.WireNull(), wire.WireNull(), wire.WireNull(), wire.WireNull()),
		))
		return err
	}
	if err := named(); err == nil || !strings.Contains(err.Error(), "names connection 'analytics'") {
		t.Fatalf("outside a tx = %v, want LOUD", err)
	}
	if err := WithAmbientTransaction(func() error {
		if err := named(); err == nil || !strings.Contains(err.Error(), "names connection 'analytics'") {
			t.Fatalf("inside a tx = %v, want the SAME loud outcome as outside it", err)
		}
		// …and the ordinary unnamed statement still runs on the pin.
		return unnamed()
	}); err != nil {
		t.Fatalf("tx: %v", err)
	}
}
