// litedbmodel v2 SCP — the op-INDEPENDENT NATIVE leaf TRANSPORT (#141), Go.
//
// The bc `go-typed-native` covered module (RunNativeRawStruct_<comp>) calls ONE op-agnostic leaf
// transport DIRECTLY at each covered node: `ExecuteSQL` (a SQL node), `PluckKeys` (relation key
// extraction), `GroupChildren` (relation parent grouping). Post-bc#164 (wire-passthrough) each node's
// result rides as a BC-OWNED `wire.WireValue`, so these three transports are the ONLY boundary between
// the wire plane and the runtime: they convert `wire.WireValue` ↔ bc `Value`/`*Obj` and delegate the
// relation shaping to the SHARED grouping CORE (grouping.go `DedupeKeyTuples`/`GroupByKey`/
// `AttachToParent`). There is NO second grouping implementation here — that core is the single source
// of truth (the runtime lazy path in relation.go consumes the SAME functions); this file only bridges
// wire ↔ Value at the transport edge and issues SQL through the central [Execute]/[Run] seam. This is
// the Go twin of the rust `execute_sql`/`pluck_keys`/`group_children` leaf (same op-agnostic wire
// contract), NOT the py/php native-record method leaf.
//
// CONNECTION: the covered module calls these as free functions (bc's transport contract carries no db
// handle), so the consumer BINDS the target connection once via [BindLeafTransport] before driving the
// generated runners. This is the leaf transport's single bound connection — not a fallback path.

package litedbmodel_runtime

import (
	"fmt"
	"strconv"

	bc "github.com/foo-ogawa/behavior-contracts/go"
	"github.com/foo-ogawa/litedbmodel/go/litedbmodel_runtime/wire"
)

// wireProbeGot mirrors the BC-OWNED wire package's probe-result Kind for "present and matching" (the
// wire package keeps its probe-kind consts unexported; 0 = got is the stable public contract the
// generated de-box also compares against).
const wireProbeGot uint8 = 0

// leaf transport bound state (set by BindLeafTransport). The bench/consumer drives the generated
// runners sequentially against ONE bound connection; ExecuteSQL funnels every SQL node through it.
var (
	leafExecCtx *ExecutionContext
	leafDialect = "sqlite"
)

// BindLeafTransport binds the connection (+ dialect for placeholder rendering) the free-function leaf
// transport issues SQL against. Call ONCE before driving RunNativeRawStruct_<comp>.
func BindLeafTransport(db SQLDB, dialect string) {
	leafExecCtx = ContextForDB(db)
	leafDialect = dialect
}

// UnbindLeafTransport clears the bound connection (leaves ExecuteSQL fail-closed until re-bound).
func UnbindLeafTransport() { leafExecCtx = nil }

// ExecuteSQL runs ONE SQL node and returns its rows as a wire list of wire rows (empty list for a
// non-RETURNING write). Params ride as wire values: a scalar binds directly (toDriverParam); a wire
// LIST param binds as ONE JSON array string (the `json_each(?)` batch-key contract — SAME rendering as
// the runtime relation bindKeys). bigint is a render hint the native path does not need here.
func ExecuteSQL(bigint bool, params []wire.WireValue, returning bool, sql string, write bool) (wire.WireValue, error) {
	_ = bigint
	if leafExecCtx == nil {
		return wire.WireNull(), fmt.Errorf("leaf transport: no bound connection (call BindLeafTransport before running the native module)")
	}
	args := make([]any, len(params))
	for i, p := range params {
		args[i] = leafParam(p)
	}
	text := renderPlaceholders(sql, leafDialect)
	if write && !returning {
		info, err := Run(leafExecCtx, text, args, WriteIntent())
		if err != nil {
			return wire.WireNull(), err
		}
		// The affected-write summary row — a uniform one-row `[{changes,lastInsertRowid}]` list (the
		// TS `writeSummary` / rust `execute_sql` shape), so every leaf output is a List of Rows.
		summary := wire.WireRowOf([]wire.WireField{
			{Key: "changes", Val: wire.WireInt(info.Changes)},
			{Key: "lastInsertRowid", Val: wire.WireInt(info.LastInsertRowid)},
		})
		return wire.WireListOf([]wire.WireValue{summary}), nil
	}
	rows, err := Execute(leafExecCtx, text, args, ReadIntent())
	if err != nil {
		return wire.WireNull(), err
	}
	items := make([]wire.WireValue, len(rows))
	for i, r := range rows {
		items[i] = valueToWire(r)
	}
	return wire.WireListOf(items), nil
}

// WithAmbientTransaction runs `body` inside ONE transaction on `db`, threading the tx-owned connection
// as the AMBIENT the free-function [ExecuteSQL] resolves — so a bc-generated tx runner (which calls
// ExecuteSQL directly, taking no db handle) executes every statement ON the transaction. BEGIN →
// run body under the tx-pinned ambient → COMMIT on ok / ROLLBACK on a body error (atomicity). This is
// the CONSUMER's tx-boundary responsibility (NOT a bc feature, NOT emitted into the generated runner);
// it adds NO tx engine — it reuses the existing tx combinator ([WithTransaction], which owns BEGIN/
// COMMIT/ROLLBACK through the central seam) and only swaps the ambient leaf ctx for the body span.
// Go twin of the rust `with_ambient_transaction` leaf. Requires a bound transport ([BindLeafTransport]).
func WithAmbientTransaction(db TxDB, body func() error) error {
	base := leafExecCtx
	if base == nil {
		return fmt.Errorf("leaf transport: WithAmbientTransaction needs a bound transport (call BindLeafTransport first)")
	}
	prev := leafExecCtx
	_, err := WithTransaction(base, db, func(txCtx *ExecutionContext) (struct{}, error) {
		leafExecCtx = txCtx                   // the tx-owned ctx is the ambient the covered runner's ExecuteSQL resolves…
		defer func() { leafExecCtx = prev }() // …restored on COMMIT / ROLLBACK / panic (scopes restore)
		return struct{}{}, body()
	})
	return err
}

// PluckKeys extracts the deduped, non-null key array from `rows` over the ordered key-column TUPLE
// `col` — the batch key set the relation child fetch binds (`WHERE fk IN (SELECT value FROM
// json_each(?))` single-key, or the `$[i]` per-ordinal EXISTS form for a composite tuple). Dedupe runs
// on the WIRE rows DIRECTLY via the shared grouping CORE ([dedupeKeyTuplesG] over [wireOps]) — the SAME
// algorithm the runtime relation path consumes ([bcOps]); there is NO wire↔Value round-trip on the hot
// read path. A single-key `col` emits a FLAT scalar key array (the deduped cell itself); a composite
// `col` emits an array-of-tuples (each a wire list) — the SAME shape the child SQL's json_each param
// expects. Go twin of the rust `pluck_keys` leaf.
func PluckKeys(col []string, rows []wire.WireValue) (wire.WireValue, error) {
	tuples := dedupeKeyTuplesG(wireOps, rows, col) // dedupe DIRECTLY on wire rows — no wire↔Value round-trip
	keys := make([]wire.WireValue, len(tuples))
	for i, t := range tuples {
		if len(col) == 1 {
			keys[i] = t[0] // single key → the flat scalar wire cell itself (json_each scalar `value`)
			continue
		}
		keys[i] = wire.WireListOf(t) // composite → the tuple's wire cells as an array-of-tuples element
	}
	return wire.WireListOf(keys), nil
}

// GroupChildren distributes the flat `children` onto `parents` by matching the child `fk` tuple to the
// parent `pk` tuple, nesting the result under `into`: single==true (belongsTo/hasOne) nests the one
// matching child (or nil); otherwise (hasMany) nests the child list ([] when none). Grouping runs on
// the WIRE rows DIRECTLY via the shared grouping CORE ([groupByKeyG]/[attachG] over [wireOps]) — the
// SAME algorithm the runtime relation path uses ([bcOps]); NO wire↔Value round-trip. `pk`/`fk` are the
// ordered key-column TUPLES, so a composite relation nests by the WHOLE tuple identity (no
// scalar-collapse cartesian). The parent-key columns are resolved ONCE (all parents share column
// order). Each parent is shallow-copied before the own-key set (matching the TS `{...par, [into]: …}`
// spread — the input is not mutated; nested children are referenced, not deep-cloned). Go twin of the
// rust `group_children` leaf.
func GroupChildren(children []wire.WireValue, fk []string, into string, parents []wire.WireValue, pk []string, single bool) (wire.WireValue, error) {
	byKey := groupByKeyG(wireOps, children, fk)       // group DIRECTLY on wire children — no wire↔Value round-trip
	pkIdx := resolveKeyIndicesG(wireOps, parents, pk) // parent key columns resolved ONCE (all parents share order)
	out := make([]wire.WireValue, len(parents))
	for i, p := range parents {
		if !wireIsRecord(p) {
			// Records are objects by contract (SQL rows); a non-object passes through untouched.
			out[i] = p
			continue
		}
		nested := attachG(wireOps, p, pk, pkIdx, byKey, single)
		out[i] = withOwnKeyWire(p, into, nested)
	}
	return wire.WireListOf(out), nil
}

// withOwnKeyWire returns a shallow copy of the wire row with key set to v (insertion order preserved;
// an existing key keeps its position, value overwritten). Mirrors the TS `{...par, [into]: v}` spread —
// the leaf output is a new record, the input parent is not mutated. The field copy is shallow (a
// WireValue is slice-header sized); no nested cell is deep-cloned.
func withOwnKeyWire(row wire.WireValue, key string, v wire.WireValue) wire.WireValue {
	src := row.Entries
	fields := make([]wire.WireField, len(src), len(src)+1)
	copy(fields, src)
	for i := range fields {
		if fields[i].Key == key {
			fields[i].Val = v // existing key keeps its position, value overwritten
			return wire.WireRowOf(fields)
		}
	}
	return wire.WireRowOf(append(fields, wire.WireField{Key: key, Val: v}))
}

// ── The wire.WireValue instantiation of the shared grouping CORE (grouping.go) ──────────────────────
//
// The native leaf path groups over `wire.WireValue` rows DIRECTLY (the type the generated module
// speaks) — the twin of the runtime path's `bcOps`. The SAME generic algorithm ([recordOps]) runs; only
// the row/cell accessors differ, so there is ONE dedupe/group/attach implementation (SSoT).

// wireProbeNull mirrors the BC-OWNED wire package's probe Kind for "present as the producer's null
// variant" (the wire package keeps its probe-kind consts unexported; 3 = null is the stable contract).
const wireProbeNull uint8 = 3

// wireOps is the [recordOps] over wire rows: a record is a `wire.WireValue` of kind Row (its ordered
// (key,value) entries exported as `.Entries`), a cell is a `wire.WireValue`.
var wireOps = recordOps[wire.WireValue]{
	isRecord:  wireIsRecord,
	numCols:   func(v wire.WireValue) int { return len(v.Entries) },
	colNameAt: func(v wire.WireValue, i int) string { return v.Entries[i].Key },
	cellAt:    func(v wire.WireValue, i int) wire.WireValue { return v.Entries[i].Val },
	field:     wireField,
	isNull:    func(cell wire.WireValue) bool { return cell.AsNumber().Kind == wireProbeNull },
	keyFrag:   wireKeyFrag,
	makeList:  func(children []wire.WireValue) wire.WireValue { return wire.WireListOf(children) },
	nul:       wire.WireNull(),
}

// wireIsRecord reports whether w is a wire Row (the only classifier that returns "got" for a row).
func wireIsRecord(w wire.WireValue) bool { return w.AsRow().Kind == wireProbeGot }

// wireField is the linear by-name cell lookup (the row-shape-differs fallback): ok=false if the column
// is ABSENT (a PRESENT null cell is returned and dropped later by isNull).
func wireField(w wire.WireValue, name string) (wire.WireValue, bool) {
	for i := range w.Entries {
		if w.Entries[i].Key == name {
			return w.Entries[i].Val, true
		}
	}
	return wire.WireValue{}, false
}

// wireKeyFrag renders a scalar wire cell to its key-identity fragment (matches JS `String(v)`), the
// wire twin of [stringifyKey]. A number's raw text is NORMALIZED exactly as the bc path renders it
// (integer text / whole-float → integer, else shortest round-trip), so a wire-path key and a bc-path
// key are byte-identical. A Row/List is never a scalar key (totality fallback only).
func wireKeyFrag(cell wire.WireValue) string {
	if p := cell.AsNumber(); p.Kind == wireProbeGot {
		if i, err := strconv.ParseInt(p.Got, 10, 64); err == nil {
			return strconv.FormatInt(i, 10)
		}
		if f, err := strconv.ParseFloat(p.Got, 64); err == nil {
			return encodeFloat(f)
		}
		return p.Got
	}
	if p := cell.AsString(); p.Kind == wireProbeGot {
		return p.Got
	}
	if p := cell.AsBool(); p.Kind == wireProbeGot {
		if p.Got {
			return "true"
		}
		return "false"
	}
	return ""
}

// leafParam converts ONE wire param to a driver-bindable arg. A wire LIST (the plucked batch keys)
// binds as ONE JSON array string (json_each(?) contract, same as relation bindKeys); a scalar binds
// via toDriverParam.
func leafParam(p wire.WireValue) any {
	v := wireToValue(p)
	if arr, ok := v.([]bc.Value); ok {
		return jsStringify(bc.Value(arr))
	}
	return toDriverParam(v)
}

// ── wire ↔ Value bridge (transport edge only) ──────────────────────────────────────────────────────

// valueToWire lowers a bc Value into the BC-OWNED wire representation (recursive for rows/lists). Row
// cells arrive from the DB scan as float64/string/bool/nil (value.go scanValue); grouped parents carry
// nested []Value / *Obj.
func valueToWire(v bc.Value) wire.WireValue {
	switch t := v.(type) {
	case nil:
		return wire.WireNull()
	case bool:
		return wire.WireBool(t)
	case float64:
		return wire.WireFloat(t)
	case int64:
		return wire.WireInt(t)
	case string:
		return wire.WireStr(t)
	case []bc.Value:
		items := make([]wire.WireValue, len(t))
		for i, e := range t {
			items[i] = valueToWire(e)
		}
		return wire.WireListOf(items)
	case *bc.Obj:
		fields := make([]wire.WireField, 0, t.Len())
		for _, k := range t.Keys {
			fields = append(fields, wire.WireField{Key: k, Val: valueToWire(t.Vals[k])})
		}
		return wire.WireRowOf(fields)
	default:
		return wire.WireNull()
	}
}

// wireToValue reverse-maps ONE wire value to a bc Value using the public probe API (the wire scalar
// payload is unexported; the probe classifiers are the sanctioned reader). Exactly one classifier
// matches a non-null value, so probe order is not ambiguous.
func wireToValue(w wire.WireValue) bc.Value {
	if p := w.AsNumber(); p.Kind == wireProbeGot {
		return parseWireNum(p.Got)
	}
	if p := w.AsString(); p.Kind == wireProbeGot {
		return p.Got
	}
	if p := w.AsBool(); p.Kind == wireProbeGot {
		return p.Got
	}
	if p := w.AsRow(); p.Kind == wireProbeGot {
		return wireRowToObj(p.Got)
	}
	if p := w.AsList(); p.Kind == wireProbeGot {
		out := make([]bc.Value, p.Got.Len())
		for i := 0; i < p.Got.Len(); i++ {
			out[i] = wireElemToValue(p.Got, i)
		}
		return out
	}
	return nil
}

// wireRowToObj rebuilds an insertion-ordered *Obj from a wire row (keys preserved).
func wireRowToObj(r wire.WireRow) *bc.Obj {
	o := bc.NewObj()
	for _, k := range r.Keys() {
		o.Set(k, wireFieldToValue(r, k))
	}
	return o
}

// wireFieldToValue classifies one wire row field via the probe API.
func wireFieldToValue(r wire.WireRow, k string) bc.Value {
	if p := r.ProbeNumber(k); p.Kind == wireProbeGot {
		return parseWireNum(p.Got)
	}
	if p := r.ProbeString(k); p.Kind == wireProbeGot {
		return p.Got
	}
	if p := r.ProbeBool(k); p.Kind == wireProbeGot {
		return p.Got
	}
	if p := r.ProbeRow(k); p.Kind == wireProbeGot {
		return wireRowToObj(p.Got)
	}
	if p := r.ProbeList(k); p.Kind == wireProbeGot {
		out := make([]bc.Value, p.Got.Len())
		for i := 0; i < p.Got.Len(); i++ {
			out[i] = wireElemToValue(p.Got, i)
		}
		return out
	}
	return nil
}

// wireElemToValue classifies one wire list element via the probe API.
func wireElemToValue(l wire.WireList, i int) bc.Value {
	if p := l.ElemNumber(i); p.Kind == wireProbeGot {
		return parseWireNum(p.Got)
	}
	if p := l.ElemString(i); p.Kind == wireProbeGot {
		return p.Got
	}
	if p := l.ElemBool(i); p.Kind == wireProbeGot {
		return p.Got
	}
	if p := l.ElemRow(i); p.Kind == wireProbeGot {
		return wireRowToObj(p.Got)
	}
	if p := l.ElemList(i); p.Kind == wireProbeGot {
		out := make([]bc.Value, p.Got.Len())
		for j := 0; j < p.Got.Len(); j++ {
			out[j] = wireElemToValue(p.Got, j)
		}
		return out
	}
	return nil
}

// parseWireNum decodes the raw numeric text a wire number carries into a float64 (the row-scan
// convention — an integer column scans as a JS-number float64; grouping key identity handles it).
func parseWireNum(raw string) bc.Value {
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return raw
	}
	return f
}
