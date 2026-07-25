// Unit tests for the op-agnostic NATIVE leaf transport (#141): the wire ↔ Value bridge over the shared
// grouping CORE. PluckKeys / GroupChildren are pure (no DB), so they are tested directly over BC-owned
// wire values; ExecuteSQL's live path is exercised end-to-end by the lm_orm_native bench cell.

package litedbmodel_runtime

import (
	"errors"
	"strings"
	"testing"

	"github.com/foo-ogawa/litedbmodel/go/litedbmodel_runtime/wire"
)

// wireUsers builds the wire row SLICE (the shape the covered runner hands the transport — a
// de-boxed []wire.WireValue, NOT a wire list value) for a set of {id:int} rows.
func wireUsers(ids ...int64) []wire.WireValue {
	items := make([]wire.WireValue, len(ids))
	for i, id := range ids {
		items[i] = wire.WireRowOf([]wire.WireField{{Key: "id", Val: wire.WireInt(id)}})
	}
	return items
}

// leafPayload builds the generic-wire PAYLOAD a covered runner hands a leaf — the node's ports as
// named fields, the SAME shape the generated module assembles.
func leafPayload(ports ...wire.WireField) wire.WireRow { return wire.WireRowOfFields(ports) }

// port is one payload field; wireStrings builds an {arr:'string'} port (a key-column tuple).
func port(key string, val wire.WireValue) wire.WireField { return wire.WireField{Key: key, Val: val} }

func wireStrings(names ...string) wire.WireValue {
	items := make([]wire.WireValue, len(names))
	for i, n := range names {
		items[i] = wire.WireStr(n)
	}
	return wire.WireListOf(items)
}

func wirePosts(idAuthor ...[2]int64) []wire.WireValue {
	items := make([]wire.WireValue, len(idAuthor))
	for i, pa := range idAuthor {
		items[i] = wire.WireRowOf([]wire.WireField{
			{Key: "id", Val: wire.WireInt(pa[0])},
			{Key: "author_id", Val: wire.WireInt(pa[1])},
		})
	}
	return items
}

func TestPluckKeysDedupesNonNull(t *testing.T) {
	// duplicate + a null id → deduped, null dropped (CORE dedupe semantics over wire). A single-key
	// `col` emits FLAT scalar keys (not 1-tuples).
	rows := []wire.WireValue{
		wire.WireRowOf([]wire.WireField{{Key: "id", Val: wire.WireInt(1)}}),
		wire.WireRowOf([]wire.WireField{{Key: "id", Val: wire.WireInt(2)}}),
		wire.WireRowOf([]wire.WireField{{Key: "id", Val: wire.WireInt(1)}}),
		wire.WireRowOf([]wire.WireField{{Key: "id", Val: wire.WireNull()}}),
	}
	out, err := PluckKeys(leafPayload(port("col", wireStrings("id")), port("rows", wire.WireListOf(rows))))
	if err != nil {
		t.Fatalf("PluckKeys: %v", err)
	}
	lp := out.AsList()
	if lp.Kind != 0 {
		t.Fatalf("expected a wire list, kind=%d", lp.Kind)
	}
	if lp.Got.Len() != 2 {
		t.Fatalf("expected 2 deduped non-null keys, got %d", lp.Got.Len())
	}
	if k0 := lp.Got.ElemNumber(0); k0.Kind != 0 || k0.Got != "1" {
		t.Fatalf("single-key pluck must emit flat scalars; elem0 = %+v", k0)
	}
}

// A COMPOSITE `col` emits an array-of-TUPLES (each key a wire list) — deduped on the whole tuple.
func TestPluckKeysCompositeEmitsTuples(t *testing.T) {
	mk := func(tid, uid int64) wire.WireValue {
		return wire.WireRowOf([]wire.WireField{
			{Key: "tenant_id", Val: wire.WireInt(tid)},
			{Key: "user_id", Val: wire.WireInt(uid)},
		})
	}
	rows := []wire.WireValue{mk(1, 9), mk(1, 9), mk(1, 8)} // one dup tuple
	out, err := PluckKeys(leafPayload(port("col", wireStrings("tenant_id", "user_id")), port("rows", wire.WireListOf(rows))))
	if err != nil {
		t.Fatalf("PluckKeys composite: %v", err)
	}
	lp := out.AsList()
	if lp.Kind != 0 || lp.Got.Len() != 2 {
		t.Fatalf("expected 2 deduped tuples, got kind=%d len=%d", lp.Kind, lp.Got.Len())
	}
	if el := lp.Got.ElemList(0); el.Kind != 0 || el.Got.Len() != 2 {
		t.Fatalf("composite pluck must emit 2-element tuples; elem0 = %+v", el)
	}
}

func TestGroupChildrenDistributesPerParent(t *testing.T) {
	parents := wireUsers(1, 2, 3)
	children := wirePosts([2]int64{10, 1}, [2]int64{11, 1}, [2]int64{12, 2})
	out, err := GroupChildren(leafPayload(
		port("children", wire.WireListOf(children)),
		port("fk", wireStrings("author_id")),
		port("into", wire.WireStr("posts")),
		port("parents", wire.WireListOf(parents)),
		port("pk", wireStrings("id")),
		port("single", wire.WireBool(false)),
	))
	if err != nil {
		t.Fatalf("GroupChildren: %v", err)
	}
	lp := out.AsList()
	if lp.Kind != 0 || lp.Got.Len() != 3 {
		t.Fatalf("expected 3 grouped parents, got kind=%d len=%d", lp.Kind, lp.Got.Len())
	}
	// parent id=1 must carry its 2 posts under "posts"; id=3 must carry an empty list.
	postsLen := func(i int) int {
		row := lp.Got.ElemRow(i)
		if row.Kind != 0 {
			t.Fatalf("parent %d not a row", i)
		}
		pl := row.Got.ProbeList("posts")
		if pl.Kind != 0 {
			t.Fatalf("parent %d has no posts list (kind=%d)", i, pl.Kind)
		}
		return pl.Got.Len()
	}
	if got := postsLen(0); got != 2 {
		t.Fatalf("parent id=1 expected 2 posts, got %d", got)
	}
	if got := postsLen(2); got != 0 {
		t.Fatalf("parent id=3 expected 0 posts, got %d", got)
	}
}

// The payload materialization is LOSSLESS. The BC-owned go wire types keep their backing slices
// unexported, so a list port is rebuilt cell-by-cell at the transport edge; this pins that every
// variant survives that rebuild EXACTLY — a number keeps its RAW text (no parse/format round-trip), a
// bool / string / null keeps its variant, an already-nested child list (a grouped level feeding the
// next one) survives whole, and the row's key ORDER is preserved.
func TestPayloadMaterializationIsLossless(t *testing.T) {
	parent := wire.WireRowOf([]wire.WireField{
		{Key: "id", Val: wire.WireInt(1)},
		{Key: "score", Val: wire.WireNum("1.500")}, // raw numeric text, NOT a normalized 1.5
		{Key: "active", Val: wire.WireBool(true)},
		{Key: "name", Val: wire.WireStr("A")},
		{Key: "deleted_at", Val: wire.WireNull()},
		{Key: "comments", Val: wire.WireListOf([]wire.WireValue{
			wire.WireRowOf([]wire.WireField{{Key: "body", Val: wire.WireStr("c1")}}),
		})},
	})
	out, err := GroupChildren(leafPayload(
		port("children", wire.WireListOf(wirePosts([2]int64{10, 1}))),
		port("fk", wireStrings("author_id")),
		port("into", wire.WireStr("posts")),
		port("parents", wire.WireListOf([]wire.WireValue{parent})),
		port("pk", wireStrings("id")),
		port("single", wire.WireBool(false)),
	))
	if err != nil {
		t.Fatalf("GroupChildren: %v", err)
	}
	rp := out.AsList().Got.ElemRow(0)
	if rp.Kind != wireProbeGot {
		t.Fatalf("parent 0 is not a row (kind=%d)", rp.Kind)
	}
	row := rp.Got
	if p := row.ProbeNumber("score"); p.Kind != wireProbeGot || p.Got != "1.500" {
		t.Fatalf("raw numeric text not preserved: %+v", p)
	}
	if p := row.ProbeBool("active"); p.Kind != wireProbeGot || !p.Got {
		t.Fatalf("bool cell not preserved: %+v", p)
	}
	if p := row.ProbeString("name"); p.Kind != wireProbeGot || p.Got != "A" {
		t.Fatalf("string cell not preserved: %+v", p)
	}
	if p := row.ProbeString("deleted_at"); p.Kind != wireProbeNull {
		t.Fatalf("null cell not preserved: %+v", p)
	}
	cs := row.ProbeList("comments")
	if cs.Kind != wireProbeGot || cs.Got.Len() != 1 {
		t.Fatalf("pre-nested child list not preserved: %+v", cs)
	}
	if b := cs.Got.ElemRow(0).Got.ProbeString("body"); b.Kind != wireProbeGot || b.Got != "c1" {
		t.Fatalf("nested child row not preserved: %+v", b)
	}
	if p := row.ProbeList("posts"); p.Kind != wireProbeGot || p.Got.Len() != 1 {
		t.Fatalf("grouped children missing: %+v", p)
	}
	want := []string{"id", "score", "active", "name", "deleted_at", "comments", "posts"}
	got := row.Keys()
	if len(got) != len(want) {
		t.Fatalf("column order/count changed: %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("column order changed: %v, want %v", got, want)
		}
	}
}

// Port unbox is FAIL-CLOSED: an ABSENT port and a WRONG-VARIANT port both surface a loud error (never a
// silent default) — a port that is missing or mistyped is an ABI break, and a default would corrupt the
// result instead of stopping it.
func TestPortUnboxIsFailClosed(t *testing.T) {
	_, err := PluckKeys(leafPayload(port("col", wireStrings("id"))))
	if err == nil || !strings.Contains(err.Error(), `"rows"`) || !strings.Contains(err.Error(), "absent") {
		t.Fatalf("absent port must fail loudly, got %v", err)
	}
	_, err = PluckKeys(leafPayload(port("col", wireStrings("id")), port("rows", wire.WireInt(7))))
	if err == nil || !strings.Contains(err.Error(), `"rows"`) || !strings.Contains(err.Error(), "got N") {
		t.Fatalf("wrong-variant port must name the actual wire tag, got %v", err)
	}
	_, err = PluckKeys(leafPayload(
		port("col", wire.WireListOf([]wire.WireValue{wire.WireInt(1)})),
		port("rows", wire.WireListOf(nil)),
	))
	if err == nil || !strings.Contains(err.Error(), `"col"`) || !strings.Contains(err.Error(), "string element") {
		t.Fatalf("a key-column tuple element must be a column name, got %v", err)
	}
}

// A batch write's opaque `rows` array param (createMany/upsertMany/updateMany) rides as ONE JSON array
// string through leafParam — the `json_each(?)` batch payload the generated batch SQL binds (SAME
// encoding as the relation bindKeys JSON). Key order is preserved (jsStringify = insertion order).
// (#141 slice-2 piece 3 — the go param-encoding half of rust's baked 1-statement batch.)
func TestLeafParam_BatchRowsArrayEncoding(t *testing.T) {
	rows := wire.WireListOf([]wire.WireValue{
		wire.WireRowOf([]wire.WireField{
			{Key: "email", Val: wire.WireStr("a@x")},
			{Key: "name", Val: wire.WireStr("A")},
		}),
		wire.WireRowOf([]wire.WireField{
			{Key: "email", Val: wire.WireStr("b@x")},
			{Key: "name", Val: wire.WireStr("B")},
		}),
	})
	got := leafParam(rows)
	want := `[{"email":"a@x","name":"A"},{"email":"b@x","name":"B"}]`
	if s, ok := got.(string); !ok || s != want {
		t.Fatalf("batch rows leafParam = %#v, want JSON %q", got, want)
	}
}

// A scalar param binds directly (NOT JSON-wrapped) — only an array param (batch rows / plucked keys)
// serializes to a JSON string. Guards the leafParam array-vs-scalar branch.
func TestLeafParam_ScalarBindsDirect(t *testing.T) {
	if got := leafParam(wire.WireStr("user@x")); got != "user@x" {
		t.Fatalf("scalar string leafParam = %#v, want the bare value", got)
	}
	// an integral wire number binds as int64 (toDriverParam collapses a whole float to the integer slot).
	if got := leafParam(wire.WireInt(42)); got != int64(42) {
		t.Fatalf("scalar int leafParam = %#v, want int64(42)", got)
	}
}

// CheckFindHardLimit (#141 slice-2 piece 5): count > cap ⇒ a *LimitExceededError with the find-context
// message; count ≤ cap ⇒ nil. Delegates to the shared checkHardLimit SSoT (twin of rust
// check_find_hard_limit); NOT wired into the transport (the 19 ops bake explicit LIMITs).
func TestCheckFindHardLimit(t *testing.T) {
	if err := CheckFindHardLimit(100, 100, "benchmark_users"); err != nil {
		t.Fatalf("count == limit must pass, got %v", err)
	}
	err := CheckFindHardLimit(100, 101, "benchmark_users")
	if err == nil {
		t.Fatal("count > limit must error")
	}
	var lim *LimitExceededError
	if !errors.As(err, &lim) {
		t.Fatalf("want *LimitExceededError, got %T", err)
	}
	if lim.Context != LimitContextFind || lim.Model != "benchmark_users" || lim.Limit != 100 || lim.Count != 101 {
		t.Fatalf("unexpected limit error fields: %+v", lim)
	}
	want := "Query limit exceeded: find() on benchmark_users returned more than 100 records, " +
		"but limit is 100. This usually indicates a missing WHERE clause or an N+1 query pattern. " +
		"Set a higher limit or use pagination."
	if lim.Error() != want {
		t.Fatalf("find-context message mismatch:\n got: %s\nwant: %s", lim.Error(), want)
	}
}
