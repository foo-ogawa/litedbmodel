// litedbmodel v2 SCP — the SHARED relation-grouping CORE (#141), Go port.
//
// The ONE implementation of relation key-identity + dedupe + parent grouping, behaviour-identical to
// the TS SSoT `src/scp/grouping.ts` (and the Rust twin `rust/litedbmodel_runtime/src/grouping.rs`).
// It is a SINGLE generic algorithm ([recordOps]-parameterised) instantiated over BOTH row
// representations so there is no duplicated grouping logic:
//
//   - `wire.WireValue` — the type the bc-generated native module speaks; the op-independent
//     `Pluck` / `Group` leaf transports (leaf_transport.go) run the WIRE instantiation directly, so
//     the hot read path carries NO `WireValue`↔`Value` conversion (the read never boxes into bc's
//     `Value` — mirrors the rust core);
//   - `bc.Value` — already-fetched bc rows, grouped over the SAME algorithm.
//
// Nothing here touches SQL or a driver: it is pure in-memory grouping over already-fetched rows.
// Ordered TUPLE keys are supported (composite keys), matching TS.

package litedbmodel_runtime

import (
	"strconv"
	"strings"
)

// keySep separates the encoded cells of a 3+-column key. It is NUL, the same byte the TS `KEY_SEP` uses,
// and for the same reason: a SPACE (what this was) collides as soon as a text key contains one —
// ("a", "b c") and ("a b", "c") became the same key. The 1- and 2-column keys every relation actually
// uses are carried in [keyID]'s inline cells and never render.
const keySep = "\x00"

// keyCell is ONE key column's value, comparable and allocation-free. A raw-driver consumer groups on the
// native value (`map[int64][]row`, a struct key for a composite one); rendering each cell to a string
// instead cost one allocation per row per level, which is what made a relation op lose to a raw driver.
// A Go string field is a header copy, so a text key costs nothing either.
//
// The layout is deliberately TIGHT — 32 bytes, not one field per kind. Go hashes a map key by its bytes,
// so a wide key costs more to hash than the short string it replaces, and a wider `keyCell` measured
// SLOWER on the 1,100-row level even while it was faster on the 11,100-row one. `num` carries an int
// directly and a float by its bit pattern (a whole float is normalized to the int, so a parent read as 1
// and a child FK read as 1.0 are one key); a bool rides as 0/1 in `num`.
type keyCell struct {
	kind uint8 // 0 null/absent · 1 int · 2 float bits · 3 string · 4 bool
	num  int64
	s    string
}

// keyID is a key tuple usable as a map key. The 1- and 2-column arms are inline; a wider key encodes its
// cells into `more` (rare — no relation is keyed on three columns — and by the same rule as the inline
// arms, so the collapse semantics do not change with arity).
type keyID struct {
	a, b keyCell
	more string
}

// absentIdx marks a key column that is not present in the sample row's column order — its per-row
// lookup then falls back to the linear name scan (matches the rust `usize::MAX` sentinel).
const absentIdx = -1

// recordOps abstracts the row/cell representation the shared grouping ALGORITHM runs over — ONE
// algorithm, no duplicated dedupe/group/attach logic. Its instantiation is [wireOps], the native leaf
// path (`pluck`/`group`), which is the only path production reaches a relation through. A record is a
// column-ordered row and a cell is one column's value, both the SAME type R (a wire row and its cells
// are `wire.WireValue`). The generic form is what keeps the algorithm independent of that choice.
type recordOps[R any] struct {
	// isRecord reports whether v is a column-ordered record row (a non-record row is passed through
	// untouched by group, and yields no key by dedupe/attach).
	isRecord func(v R) bool
	// numCols / colNameAt / cellAt give O(1) positional access to a record's ordered columns.
	numCols   func(v R) int
	colNameAt func(v R, i int) string
	cellAt    func(v R, i int) R
	// field is the linear by-name fallback (row shape differs from the resolved sample): ok=false if the
	// column is ABSENT (distinct from a PRESENT null cell, which isNull reports).
	field func(v R, name string) (R, bool)
	// isNull reports a null/absent cell (dropped from a key tuple — the no-partial-keys rule).
	isNull func(cell R) bool
	// keyCellOf projects a scalar cell to its comparable key value (no allocation).
	keyCellOf func(cell R) keyCell
	// makeList wraps children into a record-list value ([] when children is empty); nul is the
	// null/absent value. These build the [attachG] output in the representation's own shape.
	makeList func(children []R) R
	nul      R
}

// keyIdentityG is the key identity for dedupe/grouping — the cells themselves for the 1- and 2-column
// keys a relation is keyed on (no allocation); a wider key encodes the SAME cells into [keyID]'s one
// string field, because [keyID] cannot inline more than two.
//
// Every arity derives its identity from keyCellOf. It used to render a 3+-column key through a separate
// per-representation `keyFrag`, which gave a wide key DIFFERENT collapse semantics from a narrow one in
// this same function — a bool and the string "true" were one key at three columns and two keys at two.
// One rule, one place.
func keyIdentityG[R any](ops recordOps[R], cells []R) keyID {
	switch len(cells) {
	case 1:
		return keyID{a: ops.keyCellOf(cells[0])}
	case 2:
		return keyID{a: ops.keyCellOf(cells[0]), b: ops.keyCellOf(cells[1])}
	default:
		parts := make([]string, 0, len(cells)*3)
		for _, c := range cells {
			kc := ops.keyCellOf(c)
			parts = append(parts, strconv.Itoa(int(kc.kind)), strconv.FormatInt(kc.num, 10), kc.s)
		}
		return keyID{more: strings.Join(parts, keySep)}
	}
}

// resolveKeyIndicesG resolves each key column to its POSITION in the first record of rows (every row
// of a SQL result set shares the SAME column order), so the per-row/per-parent path replaces a linear
// name scan with O(1) index access. A column absent from the sample resolves to [absentIdx]; if no row
// is a record every index is absentIdx (per-row lookup then reports absent). Port of the rust
// `resolve_key_indices`.
func resolveKeyIndicesG[R any](ops recordOps[R], rows []R, cols []string) []int {
	idx := make([]int, len(cols))
	for i := range idx {
		idx[i] = absentIdx
	}
	for _, r := range rows {
		if !ops.isRecord(r) {
			continue
		}
		n := ops.numCols(r)
		for i, c := range cols {
			idx[i] = absentIdx
			for j := 0; j < n; j++ {
				if ops.colNameAt(r, j) == c {
					idx[i] = j
					break
				}
			}
		}
		return idx
	}
	return idx
}

// keyCells returns the key cells of row via precomputed idx (O(1) index access; verifies the column
// name still matches, else falls back to the linear field scan). ok=false (the tuple is dropped) if
// row is not a record or ANY key column is absent/null (the no-partial-keys rule).
func keyCells[R any](ops recordOps[R], row R, cols []string, idx []int) ([]R, bool) {
	if !ops.isRecord(row) {
		return nil, false
	}
	n := ops.numCols(row)
	out := make([]R, len(cols))
	for i, c := range cols {
		var cell R
		if j := idx[i]; j != absentIdx && j < n && ops.colNameAt(row, j) == c {
			cell = ops.cellAt(row, j)
		} else {
			v, ok := ops.field(row, c)
			if !ok {
				return nil, false
			}
			cell = v
		}
		if ops.isNull(cell) {
			return nil, false
		}
		out[i] = cell
	}
	return out, true
}

// dedupeKeyTuplesG returns the deduped, non-null key TUPLES of rows over keyCols (insertion order
// preserved — deterministic). A tuple is dropped if ANY key column is absent/null (no partial keys);
// deduped on the stringified tuple identity. Port of TS `dedupeKeyTuples`.
func dedupeKeyTuplesG[R any](ops recordOps[R], rows []R, keyCols []string) [][]R {
	idx := resolveKeyIndicesG(ops, rows, keyCols)
	seen := map[keyID]struct{}{}
	out := [][]R{}
	for _, r := range rows {
		cells, ok := keyCells(ops, r, keyCols, idx)
		if !ok {
			continue
		}
		id := keyIdentityG(ops, cells)
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, cells)
	}
	return out
}

// groupByKeyG groups children by their fkCols tuple identity (a null/absent key drops the child). The
// child list order within a bucket is the input order (append order). Port of TS `groupByKey`.
func groupByKeyG[R any](ops recordOps[R], children []R, fkCols []string) map[keyID][]R {
	idx := resolveKeyIndicesG(ops, children, fkCols)
	byKey := map[keyID][]R{}
	for _, c := range children {
		cells, ok := keyCells(ops, c, fkCols, idx)
		if !ok {
			continue
		}
		id := keyIdentityG(ops, cells)
		byKey[id] = append(byKey[id], c)
	}
	return byKey
}

// attachG distributes grouped children onto ONE parent per cardinality (port of TS `attachToParent`):
// single==false (hasMany) → the child list ([] when none); single==true (belongsTo/hasOne) → the
// single child (or the null value). Keyed by the parent's pkCols tuple identity (pkIdx resolved ONCE
// by the caller — no per-parent index scan); a null/absent parent key matches nothing ([] / null).
func attachG[R any](ops recordOps[R], parent R, pkCols []string, pkIdx []int, byKey map[keyID][]R, single bool) R {
	var rows []R
	if cells, ok := keyCells(ops, parent, pkCols, pkIdx); ok {
		rows = byKey[keyIdentityG(ops, cells)]
	}
	if !single {
		return ops.makeList(rows)
	}
	if len(rows) > 0 {
		return rows[0]
	}
	return ops.nul
}

// stringKeyCell collapses a numeric string onto the int it renders as: `1` and `"1"` are ONE key. The
// rendering this replaces collapsed them (both `String(v)` to "1"), and a driver may hand a numeric column
// back as text, so the collapse is load-bearing. Only an EXACT round-trip collapses, so "01" and " 1" stay
// distinct strings.
func stringKeyCell(t string) keyCell {
	if t != "" && (t[0] == '-' || (t[0] >= '0' && t[0] <= '9')) {
		if n, err := strconv.ParseInt(t, 10, 64); err == nil && strconv.FormatInt(n, 10) == t {
			return keyCell{kind: 1, num: n}
		}
	}
	return keyCell{kind: 3, s: t}
}
