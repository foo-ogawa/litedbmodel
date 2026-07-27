// Unit tests for the SHARED relation-grouping core (grouping.go, #141) — the Go twin of the Rust
// tests in `rust/litedbmodel_runtime/src/grouping.rs` and the TS SSoT `src/scp/grouping.ts`.

package litedbmodel_runtime

import (
	"math"
	"testing"

	bc "github.com/foo-ogawa/behavior-contracts/go"
)

// row builds an insertion-ordered *bc.Obj record from key/value pairs (reuses the package `scope`
// helper defined in runtime_test.go; a distinct name keeps the grouping tests self-describing).
func row(pairs ...any) bc.Value {
	return scope(pairs...)
}

func cols(cs ...string) []string { return cs }

func TestKeyIdentity_CarriesTheCells(t *testing.T) {
	// A whole float and the same integer are ONE key (a parent read as 1 and a child FK read as 1.0 must
	// land in one bucket); string/bool ride verbatim; a 2-column key is inline, not rendered.
	cases := []struct {
		in   []bc.Value
		want keyID
	}{
		{[]bc.Value{float64(1)}, keyID{a: keyCell{kind: 1, num: 1}}},
		{[]bc.Value{int64(1)}, keyID{a: keyCell{kind: 1, num: 1}}},
		{[]bc.Value{int64(2)}, keyID{a: keyCell{kind: 1, num: 2}}},
		{[]bc.Value{"x"}, keyID{a: keyCell{kind: 3, s: "x"}}},
		{[]bc.Value{true}, keyID{a: keyCell{kind: 4, num: 1}}},
		{[]bc.Value{false}, keyID{a: keyCell{kind: 4}}},
		{[]bc.Value{float64(1.5)}, keyID{a: keyCell{kind: 2, num: int64(math.Float64bits(1.5))}}},
		{[]bc.Value{int64(1), "a"}, keyID{a: keyCell{kind: 1, num: 1}, b: keyCell{kind: 3, s: "a"}}},
	}
	for _, c := range cases {
		if got := KeyIdentity(c.in); got != c.want {
			t.Errorf("KeyIdentity(%v) = %+v, want %+v", c.in, got, c.want)
		}
	}
}

// The three ways keying on cells could go wrong, none of which the table above can see.
func TestKeyIdentity_CollapseRulesDoNotDependOnArity(t *testing.T) {
	// A whole float PAST int64 must not fold onto MaxInt64: `int64(f)` out of range is implementation
	// defined in Go, and a round-trip does not catch the boundary (float64(MaxInt64) rounds up to 2^63).
	if KeyIdentity([]bc.Value{1e30}) == KeyIdentity([]bc.Value{1e31}) {
		t.Error("1e30 and 1e31 share a bucket")
	}
	if KeyIdentity([]bc.Value{1e30}) == KeyIdentity([]bc.Value{int64(math.MaxInt64)}) {
		t.Error("1e30 shares a bucket with MaxInt64")
	}
	if KeyIdentity([]bc.Value{float64(9223372036854775808)}) == KeyIdentity([]bc.Value{int64(math.MaxInt64)}) {
		t.Error("2^63 shares a bucket with MaxInt64")
	}
	// …while a whole float inside the range still folds onto the integer, which is the point.
	if KeyIdentity([]bc.Value{float64(-9007199254740992)}) != KeyIdentity([]bc.Value{int64(-9007199254740992)}) {
		t.Error("-2^53 as float and as int must be one key")
	}

	// A 3-column key must collapse by the SAME rule as a 1- or 2-column one. It used to render through a
	// separate `keyFrag`, under which bool true and the string "true" were ONE key at three columns and
	// TWO at two — the identity rule silently changed with the key's width.
	wide3 := func(a bc.Value) keyID { return KeyIdentity([]bc.Value{a, int64(0), int64(0)}) }
	if wide3(true) == wide3("true") {
		t.Error("3-column key: bool true collapses with the string \"true\"")
	}
	if (KeyIdentity([]bc.Value{true, int64(0)}) == KeyIdentity([]bc.Value{"true", int64(0)})) != (wide3(true) == wide3("true")) {
		t.Error("the bool-vs-text collapse differs between a 2- and a 3-column key")
	}

	// The tuple separator must not be a byte a text key can contain: with a SPACE, ("a","b c","d") and
	// ("a b","c","d") were the same key.
	l := func(s ...string) keyID {
		vs := make([]bc.Value, len(s))
		for i, v := range s {
			vs[i] = v
		}
		return KeyIdentity(vs)
	}
	if l("a", "b c", "d") == l("a b", "c", "d") {
		t.Error("a space in a text key collides with the tuple separator")
	}
}

func TestDedupeKeyTuples_DropsNullAndDedupesPreservingOrder(t *testing.T) {
	rows := []bc.Value{
		row("id", int64(2)),
		row("id", int64(1)),
		row("id", int64(2)),    // dup
		row("id", nil),         // dropped (null)
		row("other", int64(9)), // dropped (absent id)
	}
	keys := DedupeKeyTuples(rows, cols("id"))
	if len(keys) != 2 {
		t.Fatalf("got %d tuples, want 2", len(keys))
	}
	if KeyIdentity(keys[0]) != (keyID{a: keyCell{kind: 1, num: 2}}) ||
		KeyIdentity(keys[1]) != (keyID{a: keyCell{kind: 1, num: 1}}) {
		t.Errorf("insertion order/dedupe wrong: got [%+v %+v], want [2 1]", KeyIdentity(keys[0]), KeyIdentity(keys[1]))
	}
}

func TestDedupeKeyTuples_CompositeTuple(t *testing.T) {
	rows := []bc.Value{
		row("t", int64(1), "u", int64(9)),
		row("t", int64(1), "u", int64(9)), // dup tuple
		row("t", int64(1), "u", int64(8)),
		row("t", int64(1), "u", nil), // dropped (partial null)
	}
	keys := DedupeKeyTuples(rows, cols("t", "u"))
	if len(keys) != 2 {
		t.Fatalf("got %d tuples, want 2", len(keys))
	}
	want0 := keyID{a: keyCell{kind: 1, num: 1}, b: keyCell{kind: 1, num: 9}}
	want1 := keyID{a: keyCell{kind: 1, num: 1}, b: keyCell{kind: 1, num: 8}}
	if KeyIdentity(keys[0]) != want0 || KeyIdentity(keys[1]) != want1 {
		t.Errorf("composite tuples wrong: got [%+v %+v]", KeyIdentity(keys[0]), KeyIdentity(keys[1]))
	}
}

func TestGroupByKey_And_AttachToParent_HasMany(t *testing.T) {
	children := []bc.Value{
		row("author_id", int64(1), "t", "a"),
		row("author_id", int64(1), "t", "b"),
		row("author_id", int64(2), "t", "c"),
		row("author_id", nil, "t", "x"), // dropped (null fk)
	}
	byKey := GroupByKey(children, cols("author_id"))

	// parent 1 → two children in input order
	a1 := AttachToParent(scope("id", int64(1)), cols("id"), byKey, false)
	list1, ok := a1.([]bc.Value)
	if !ok || len(list1) != 2 {
		t.Fatalf("hasMany parent 1: want 2-elem list, got %#v", a1)
	}
	if got, _ := list1[0].(*bc.Obj).Get("t"); got != "a" {
		t.Errorf("child order wrong: first t = %v, want a", got)
	}

	// parent 2 → one child
	a2 := AttachToParent(scope("id", int64(2)), cols("id"), byKey, false)
	if list2, ok := a2.([]bc.Value); !ok || len(list2) != 1 {
		t.Errorf("hasMany parent 2: want 1-elem list, got %#v", a2)
	}

	// a parent with no matches → empty list (NOT nil)
	a3 := AttachToParent(scope("id", int64(3)), cols("id"), byKey, false)
	list3, ok := a3.([]bc.Value)
	if !ok || len(list3) != 0 {
		t.Errorf("hasMany no-match: want empty list, got %#v", a3)
	}

	// null-fk child was dropped → never in any bucket (the null key cell is the zero keyCell)
	nullKey := keyID{}
	if len(byKey[nullKey]) != 0 {
		t.Errorf("null-fk child must be dropped, got bucket %#v", byKey[nullKey])
	}
}

func TestAttachToParent_SingleReturnsFirstOrNil(t *testing.T) {
	children := []bc.Value{
		row("post_id", int64(5), "b", "first"),
		row("post_id", int64(5), "b", "second"),
	}
	byKey := GroupByKey(children, cols("post_id"))

	// single → the FIRST matching child (input order)
	one := AttachToParent(scope("id", int64(5)), cols("id"), byKey, true)
	obj, ok := one.(*bc.Obj)
	if !ok {
		t.Fatalf("single match: want *bc.Obj, got %#v", one)
	}
	if got, _ := obj.Get("b"); got != "first" {
		t.Errorf("single match: b = %v, want first", got)
	}

	// single, no match → nil
	if none := AttachToParent(scope("id", int64(6)), cols("id"), byKey, true); none != nil {
		t.Errorf("single no-match: want nil, got %#v", none)
	}

	// single, parent key null → nil (null parent key matches nothing)
	if none := AttachToParent(scope("id", nil), cols("id"), byKey, true); none != nil {
		t.Errorf("single null-key: want nil, got %#v", none)
	}
}
