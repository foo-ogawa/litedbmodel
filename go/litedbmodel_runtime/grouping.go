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
//   - `bc.Value` — the runtime lazy / declarative path (relation.go `runRelationOpCtx` /
//     `DistributeToParent`), which groups already-fetched bc rows over the SAME algorithm.
//
// Nothing here touches SQL or a driver: it is pure in-memory grouping over already-fetched rows.
// Ordered TUPLE keys are supported (composite keys), matching TS.

package litedbmodel_runtime

import (
	"strings"

	bc "github.com/foo-ogawa/behavior-contracts/go"
)

// keySep is a separator no scalar keyFrag rendering contains, so distinct tuples never collide
// (matches the TS `KEY_SEP`).
const keySep = " "

// absentIdx marks a key column that is not present in the sample row's column order — its per-row
// lookup then falls back to the linear name scan (matches the rust `usize::MAX` sentinel).
const absentIdx = -1

// recordOps abstracts the row/cell representation the shared grouping ALGORITHM runs over. ONE
// algorithm, two instantiations ([wireOps] for the native leaf path; [bcOps] for the runtime bundle
// path) — no duplicated dedupe/group/attach logic. A record is a column-ordered row; a cell is one
// column's value; both are the SAME type R (a wire row and its cells are `wire.WireValue`; a bc row is
// a `*bc.Obj` carried as `bc.Value`, its cells `bc.Value`).
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
	// keyFrag renders a scalar cell to its key-identity fragment (matches JS `String(v)`).
	keyFrag func(cell R) string
	// makeList wraps children into a record-list value ([] when children is empty); nul is the
	// null/absent value. These build the [attachG] output in the representation's own shape.
	makeList func(children []R) R
	nul      R
}

// keyIdentityG is the stringified key identity for dedupe/grouping. A single scalar → its keyFrag
// rendering; a tuple → the renderings joined by keySep (matches TS `keyIdentity`).
func keyIdentityG[R any](ops recordOps[R], cells []R) string {
	if len(cells) == 1 {
		return ops.keyFrag(cells[0])
	}
	parts := make([]string, len(cells))
	for i, c := range cells {
		parts[i] = ops.keyFrag(c)
	}
	return strings.Join(parts, keySep)
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
	seen := map[string]struct{}{}
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
func groupByKeyG[R any](ops recordOps[R], children []R, fkCols []string) map[string][]R {
	idx := resolveKeyIndicesG(ops, children, fkCols)
	byKey := map[string][]R{}
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
func attachG[R any](ops recordOps[R], parent R, pkCols []string, pkIdx []int, byKey map[string][]R, single bool) R {
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

// ── The bc.Value instantiation — the runtime lazy/declarative path (relation.go) + the unit tests ────

// bcOps is the [recordOps] over bc rows: a record is a `*bc.Obj` (insertion-ordered Keys + Vals map),
// a cell is a `bc.Value` (a scanned column arrives as float64/string/bool/nil).
var bcOps = recordOps[bc.Value]{
	isRecord:  func(v bc.Value) bool { _, ok := v.(*bc.Obj); return ok },
	numCols:   func(v bc.Value) int { return v.(*bc.Obj).Len() },
	colNameAt: func(v bc.Value, i int) string { return v.(*bc.Obj).Keys[i] },
	cellAt:    func(v bc.Value, i int) bc.Value { o := v.(*bc.Obj); return o.Vals[o.Keys[i]] },
	field: func(v bc.Value, name string) (bc.Value, bool) {
		o, ok := v.(*bc.Obj)
		if !ok {
			return nil, false
		}
		return o.Get(name) // ok=key present; a present-nil cell is dropped by isNull
	},
	isNull:   func(cell bc.Value) bool { return cell == nil },
	keyFrag:  stringifyKey,
	makeList: func(children []bc.Value) bc.Value { return bc.Value(children) },
	nul:      nil,
}

// stringifyKey mirrors TS `String(v)` for the bc key identity. A whole float prints as an integer (a
// scanned int column arrives as float64), int64 same, bool → "true"/"false", null → "null" (a null
// key is dropped before it is ever stringified, so that arm only exists for totality).
func stringifyKey(v bc.Value) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case bool:
		if t {
			return "true"
		}
		return "false"
	case string:
		return t
	case float64:
		return encodeFloat(t)
	case int64:
		return encodeFloat(float64(t))
	default:
		return jsStringify(v)
	}
}

// KeyIdentity is the stringified key identity of an already-extracted bc key tuple (a single scalar →
// its stringifyKey rendering; a tuple → the renderings joined by keySep). Consumed by relation.go +
// the unit tests.
func KeyIdentity(values []bc.Value) string { return keyIdentityG(bcOps, values) }

// DedupeKeyTuples returns the deduped, non-null bc key TUPLES of rows over keyCols (the runtime
// relation path's parent-key dedupe). See [dedupeKeyTuplesG].
func DedupeKeyTuples(rows []bc.Value, keyCols []string) [][]bc.Value {
	return dedupeKeyTuplesG(bcOps, rows, keyCols)
}

// GroupByKey groups bc children by their fkCols tuple identity (the runtime relation path's child
// grouping). See [groupByKeyG].
func GroupByKey(children []bc.Value, fkCols []string) map[string][]bc.Value {
	return groupByKeyG(bcOps, children, fkCols)
}

// AttachToParent distributes grouped bc children onto ONE parent per cardinality (the runtime relation
// path's per-parent attach): single==false (hasMany) → the child list ([]bc.Value{} when none);
// single==true (belongsTo/hasOne) → the single child (or nil). See [attachG].
func AttachToParent(parent *bc.Obj, pkCols []string, byKey map[string][]bc.Value, single bool) bc.Value {
	p := bc.Value(parent)
	pkIdx := resolveKeyIndicesG(bcOps, []bc.Value{p}, pkCols)
	return attachG(bcOps, p, pkCols, pkIdx, byKey, single)
}
