// Unit tests for the SHARED relation-grouping core (grouping.go, #141) — the Go twin of the Rust tests
// in `rust/litedbmodel_runtime/src/grouping.rs` and the TS SSoT `src/scp/grouping.ts`.
//
// Driven through the WIRE instantiation ([wireOps]), because that is the one production runs: the leaf
// transport calls the generic core directly on wire rows (`leaf_transport.go` dedupeKeyTuplesG /
// groupByKeyG / attachG), with no wire↔Value round-trip. There is no second instantiation to test — the
// `bc.Value` face these cases used to go through had no production reader once the ir-exec relation path
// was deleted (#223), so it went with it rather than being kept alive by these tests.

package litedbmodel_runtime

import (
	"math"
	"testing"

	"github.com/foo-ogawa/litedbmodel/go/litedbmodel_runtime/wire"
)

// row builds a column-ordered wire record from key/value pairs — the shape a SQL row arrives in.
func row(pairs ...any) wire.WireValue {
	fields := make([]wire.WireField, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		fields = append(fields, wire.WireField{Key: pairs[i].(string), Val: pairs[i+1].(wire.WireValue)})
	}
	return wire.WireRowOf(fields)
}

func cols(cs ...string) []string { return cs }

// keyOf / dedupe / group / attach: the generic core at its PRODUCTION instantiation.
func keyOf(cells ...wire.WireValue) keyID { return keyIdentityG(wireOps, cells) }

func dedupe(rows []wire.WireValue, keyCols []string) [][]wire.WireValue {
	return dedupeKeyTuplesG(wireOps, rows, keyCols)
}

func group(children []wire.WireValue, fkCols []string) map[keyID][]wire.WireValue {
	return groupByKeyG(wireOps, children, fkCols)
}

func attach(parent wire.WireValue, pkCols []string, byKey map[keyID][]wire.WireValue, single bool) wire.WireValue {
	pkIdx := resolveKeyIndicesG(wireOps, []wire.WireValue{parent}, pkCols)
	return attachG(wireOps, parent, pkCols, pkIdx, byKey, single)
}

func TestKeyIdentity_CarriesTheCells(t *testing.T) {
	// A whole float and the same integer are ONE key (a parent read as 1 and a child FK read as 1.0 must
	// land in one bucket); string/bool ride verbatim; a 2-column key is inline, not rendered.
	cases := []struct {
		in   []wire.WireValue
		want keyID
	}{
		{[]wire.WireValue{wire.WireFloat(1)}, keyID{a: keyCell{kind: 1, num: 1}}},
		{[]wire.WireValue{wire.WireInt(1)}, keyID{a: keyCell{kind: 1, num: 1}}},
		{[]wire.WireValue{wire.WireInt(2)}, keyID{a: keyCell{kind: 1, num: 2}}},
		{[]wire.WireValue{wire.WireStr("x")}, keyID{a: keyCell{kind: 3, s: "x"}}},
		{[]wire.WireValue{wire.WireBool(true)}, keyID{a: keyCell{kind: 4, num: 1}}},
		{[]wire.WireValue{wire.WireBool(false)}, keyID{a: keyCell{kind: 4}}},
		{[]wire.WireValue{wire.WireFloat(1.5)}, keyID{a: keyCell{kind: 2, num: int64(math.Float64bits(1.5))}}},
		{[]wire.WireValue{wire.WireInt(1), wire.WireStr("a")}, keyID{a: keyCell{kind: 1, num: 1}, b: keyCell{kind: 3, s: "a"}}},
	}
	for _, c := range cases {
		if got := keyIdentityG(wireOps, c.in); got != c.want {
			t.Errorf("keyIdentity(%v) = %+v, want %+v", c.in, got, c.want)
		}
	}
}

// The three ways keying on cells could go wrong, none of which the table above can see.
func TestKeyIdentity_CollapseRulesDoNotDependOnArity(t *testing.T) {
	// A whole float PAST int64 must not fold onto MaxInt64: `int64(f)` out of range is implementation
	// defined in Go, and a round-trip does not catch the boundary (float64(MaxInt64) rounds up to 2^63).
	if keyOf(wire.WireFloat(1e30)) == keyOf(wire.WireFloat(1e31)) {
		t.Error("1e30 and 1e31 share a bucket")
	}
	if keyOf(wire.WireFloat(1e30)) == keyOf(wire.WireInt(math.MaxInt64)) {
		t.Error("1e30 shares a bucket with MaxInt64")
	}
	if keyOf(wire.WireFloat(9223372036854775808)) == keyOf(wire.WireInt(math.MaxInt64)) {
		t.Error("2^63 shares a bucket with MaxInt64")
	}
	// …while a whole float inside the range still folds onto the integer, which is the point.
	if keyOf(wire.WireFloat(-9007199254740992)) != keyOf(wire.WireInt(-9007199254740992)) {
		t.Error("-2^53 as float and as int must be one key")
	}

	// A 3-column key must collapse by the SAME rule as a 1- or 2-column one. It used to render through a
	// separate `keyFrag`, under which bool true and the string "true" were ONE key at three columns and
	// TWO at two — the identity rule silently changed with the key's width.
	wide3 := func(a wire.WireValue) keyID { return keyOf(a, wire.WireInt(0), wire.WireInt(0)) }
	if wide3(wire.WireBool(true)) == wide3(wire.WireStr("true")) {
		t.Error("3-column key: bool true collapses with the string \"true\"")
	}
	narrow2 := keyOf(wire.WireBool(true), wire.WireInt(0)) == keyOf(wire.WireStr("true"), wire.WireInt(0))
	if narrow2 != (wide3(wire.WireBool(true)) == wide3(wire.WireStr("true"))) {
		t.Error("the bool-vs-text collapse differs between a 2- and a 3-column key")
	}

	// The tuple separator must not be a byte a text key can contain: with a SPACE, ("a","b c","d") and
	// ("a b","c","d") were the same key.
	l := func(s ...string) keyID {
		vs := make([]wire.WireValue, len(s))
		for i, v := range s {
			vs[i] = wire.WireStr(v)
		}
		return keyIdentityG(wireOps, vs)
	}
	if l("a", "b c", "d") == l("a b", "c", "d") {
		t.Error("a space in a text key collides with the tuple separator")
	}
}

func TestDedupeKeyTuples_DropsNullAndDedupesPreservingOrder(t *testing.T) {
	rows := []wire.WireValue{
		row("id", wire.WireInt(2)),
		row("id", wire.WireInt(1)),
		row("id", wire.WireInt(2)),    // dup
		row("id", wire.WireNull()),    // dropped (null)
		row("other", wire.WireInt(9)), // dropped (absent id)
	}
	keys := dedupe(rows, cols("id"))
	if len(keys) != 2 {
		t.Fatalf("got %d tuples, want 2", len(keys))
	}
	if keyIdentityG(wireOps, keys[0]) != (keyID{a: keyCell{kind: 1, num: 2}}) ||
		keyIdentityG(wireOps, keys[1]) != (keyID{a: keyCell{kind: 1, num: 1}}) {
		t.Errorf("insertion order/dedupe wrong: got [%+v %+v], want [2 1]",
			keyIdentityG(wireOps, keys[0]), keyIdentityG(wireOps, keys[1]))
	}
}

func TestDedupeKeyTuples_CompositeTuple(t *testing.T) {
	rows := []wire.WireValue{
		row("t", wire.WireInt(1), "u", wire.WireInt(9)),
		row("t", wire.WireInt(1), "u", wire.WireInt(9)), // dup tuple
		row("t", wire.WireInt(1), "u", wire.WireInt(8)),
		row("t", wire.WireInt(1), "u", wire.WireNull()), // dropped (partial null)
	}
	keys := dedupe(rows, cols("t", "u"))
	if len(keys) != 2 {
		t.Fatalf("got %d tuples, want 2", len(keys))
	}
	want0 := keyID{a: keyCell{kind: 1, num: 1}, b: keyCell{kind: 1, num: 9}}
	want1 := keyID{a: keyCell{kind: 1, num: 1}, b: keyCell{kind: 1, num: 8}}
	if keyIdentityG(wireOps, keys[0]) != want0 || keyIdentityG(wireOps, keys[1]) != want1 {
		t.Errorf("composite tuples wrong: got [%+v %+v]",
			keyIdentityG(wireOps, keys[0]), keyIdentityG(wireOps, keys[1]))
	}
}

// listLen / listElem read an attach result that carried a child LIST (hasMany).
func listLen(t *testing.T, v wire.WireValue) int {
	t.Helper()
	lp := v.AsList()
	if lp.Kind != wireProbeGot {
		t.Fatalf("want a wire list, got %#v", v)
	}
	return lp.Got.Len()
}

func TestGroupByKey_And_AttachToParent_HasMany(t *testing.T) {
	children := []wire.WireValue{
		row("author_id", wire.WireInt(1), "t", wire.WireStr("a")),
		row("author_id", wire.WireInt(1), "t", wire.WireStr("b")),
		row("author_id", wire.WireInt(2), "t", wire.WireStr("c")),
		row("author_id", wire.WireNull(), "t", wire.WireStr("x")), // dropped (null fk)
	}
	byKey := group(children, cols("author_id"))

	// parent 1 → two children in input order
	a1 := attach(row("id", wire.WireInt(1)), cols("id"), byKey, false)
	if n := listLen(t, a1); n != 2 {
		t.Fatalf("hasMany parent 1: want 2-elem list, got %d", n)
	}
	first := a1.AsList().Got.ElemRow(0)
	if first.Kind != wireProbeGot {
		t.Fatalf("hasMany parent 1: first child is not a row")
	}
	if got := first.Got.ProbeString("t"); got.Kind != wireProbeGot || got.Got != "a" {
		t.Errorf("child order wrong: first t = %+v, want a", got)
	}

	// parent 2 → one child
	if n := listLen(t, attach(row("id", wire.WireInt(2)), cols("id"), byKey, false)); n != 1 {
		t.Errorf("hasMany parent 2: want 1-elem list, got %d", n)
	}

	// a parent with no matches → empty list (NOT null)
	if n := listLen(t, attach(row("id", wire.WireInt(3)), cols("id"), byKey, false)); n != 0 {
		t.Errorf("hasMany no-match: want empty list, got %d", n)
	}

	// null-fk child was dropped → never in any bucket (the null key cell is the zero keyCell)
	if nullBucket := byKey[keyID{}]; len(nullBucket) != 0 {
		t.Errorf("null-fk child must be dropped, got bucket %#v", nullBucket)
	}
}

func TestAttachToParent_SingleReturnsFirstOrNil(t *testing.T) {
	children := []wire.WireValue{
		row("post_id", wire.WireInt(5), "b", wire.WireStr("first")),
		row("post_id", wire.WireInt(5), "b", wire.WireStr("second")),
	}
	byKey := group(children, cols("post_id"))

	// single → the FIRST matching child (input order)
	one := attach(row("id", wire.WireInt(5)), cols("id"), byKey, true)
	orow := one.AsRow()
	if orow.Kind != wireProbeGot {
		t.Fatalf("single match: want a wire row, got %#v", one)
	}
	if got := orow.Got.ProbeString("b"); got.Kind != wireProbeGot || got.Got != "first" {
		t.Errorf("single match: b = %+v, want first", got)
	}

	// single, no match → null (the representation's own null, not an empty list)
	if none := attach(row("id", wire.WireInt(6)), cols("id"), byKey, true); none.AsRow().Kind == wireProbeGot {
		t.Errorf("single no-match: want null, got %#v", none)
	}

	// single, parent key null → null (a null parent key matches nothing)
	if none := attach(row("id", wire.WireNull()), cols("id"), byKey, true); none.AsRow().Kind == wireProbeGot {
		t.Errorf("single null-key: want null, got %#v", none)
	}
}
