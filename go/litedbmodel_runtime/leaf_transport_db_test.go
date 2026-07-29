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
	BindLeafTransport(db, "sqlite")
	return db
}

// optsPort builds the `opts` control record port — the ExecOptions record the covered runner assembles:
// how to run the statement plus its two optional control structs (wire.WireNull() ⇒ the record's null
// field, which is how ABSENCE is spelled now that nothing is positional). `write` is the WriteMode ROW
// (or null for a read), so a read cannot claim a `returning` of its own (#206).
func optsPort(write, whereDynamic, guard wire.WireValue) wire.WireField {
	return port("opts", wire.WireRowOf([]wire.WireField{
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
	return optsPort(wire.WireNull(), wire.WireRowOf([]wire.WireField{
		{Key: "frags", Val: wire.WireListOf([]wire.WireValue{frag})},
	}), wire.WireNull())
}

// sqlPayload builds the executeSQL node payload (the ports the covered runner assembles by name). A
// plain READ omits the control record entirely — exactly what the emitter generates for one — so this
// covers both the absent-record default and the present-record path.
func sqlPayload(params []wire.WireValue, sql string, write bool) wire.WireRow {
	ports := []wire.WireField{port("params", wire.WireListOf(params)), port("sql", wire.WireStr(sql))}
	if write {
		ports = append(ports, optsPort(writeModeRow(false), wire.WireNull(), wire.WireNull()))
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
	if err := WithAmbientTransaction(db, func() error {
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
	err := WithAmbientTransaction(db, func() error {
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

	if err := WithAmbientTransaction(db, func() error { _, e := insT(1, "a"); return e }); err != nil {
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
		optsPort(wire.WireNull(), wire.WireNull(), wire.WireRowOf([]wire.WireField{
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
		optsPort(wire.WireNull(), wire.WireRowOf([]wire.WireField{
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

// #205 — a field ABSENT from a PRESENT struct is an ABI BREAK, never an absent VALUE. bc types a port
// by the literal wired into it and REJECTS a partial struct, so a generated module always spells every
// field of every struct it wires (`null` is how absence is spelled). A key that is not there did not
// come from one, and reading it as null would silently drop a relation cap, erase a SKIP predicate, or
// run a write as a read. The five languages must agree; this is the go leg.
func TestExecuteSQL_MissingFieldOfAPresentStructIsLoud(t *testing.T) {
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

	// Each case drops exactly ONE declared field of a struct that is present.
	for _, tc := range []struct {
		name    string
		payload wire.WireRow
		want    string
	}{
		{"payload without sql", leafPayload(paramsPort), `port "sql" is absent`},
		{"payload without params", leafPayload(sqlPort), `port "params" is absent`},
		{"record without write", leafPayload(sqlPort, paramsPort, port("opts", wire.WireRowOf([]wire.WireField{
			{Key: "guard", Val: wire.WireNull()}, {Key: "whereDynamic", Val: wire.WireNull()},
		}))), `port "write" is absent`},
		{"record without whereDynamic", leafPayload(sqlPort, paramsPort, port("opts", wire.WireRowOf([]wire.WireField{
			{Key: "guard", Val: wire.WireNull()}, {Key: "write", Val: wire.WireNull()},
		}))), `port "whereDynamic" is absent`},
		{"record without guard", leafPayload(sqlPort, paramsPort, port("opts", wire.WireRowOf([]wire.WireField{
			{Key: "whereDynamic", Val: wire.WireNull()}, {Key: "write", Val: wire.WireNull()},
		}))), `port "guard" is absent`},
		{"write mode without returning", leafPayload(sqlPort, paramsPort,
			optsPort(wire.WireRowOf(nil), wire.WireNull(), wire.WireNull())), `port "returning" is absent`},
		{"guard without model", leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(),
			wire.WireRowOf([]wire.WireField{{Key: "limit", Val: wire.WireInt(2)}, {Key: "relation", Val: wire.WireStr("things")}}))),
			`port "guard.model" is absent`},
		// …and the PLAN and its FRAGMENTS, one level further down (#209).
		{"plan without frags", leafPayload(sqlPort, paramsPort,
			optsPort(wire.WireNull(), wire.WireRowOf(nil), wire.WireNull())), `port "whereDynamic.frags" is absent`},
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
	} {
		_, err := ExecuteSQL(tc.payload)
		if err == nil {
			t.Fatalf("%s: must be loud, got no error", tc.name)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: error %q does not name the missing field (want %q)", tc.name, err.Error(), tc.want)
		}
	}

	// The LEGAL absences stay silent: an omitted record is a plain read, and a null FIELD is how an
	// absent write mode / plan / cap is spelled. Neither may be turned into a failure by the above.
	if _, err := ExecuteSQL(leafPayload(sqlPort, paramsPort)); err != nil {
		t.Fatalf("an omitted control record is a plain read, got %v", err)
	}
	if _, err := ExecuteSQL(leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(), wire.WireNull()))); err != nil {
		t.Fatalf("an all-null control record is a plain read, got %v", err)
	}
	// …and a cap that IS spelled still trips (the fail-closed reads did not disarm it).
	if _, err := ExecuteSQL(leafPayload(sqlPort, paramsPort, optsPort(wire.WireNull(), wire.WireNull(), cap2))); err == nil {
		t.Fatal("a relation batch over its cap must still raise")
	}
}
