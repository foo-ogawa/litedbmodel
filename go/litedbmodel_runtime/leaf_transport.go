// litedbmodel v2 SCP — the op-INDEPENDENT NATIVE leaf TRANSPORT (#141), Go.
//
// The bc `go-typed-native` covered module (the generated `<Method>()` entry) calls ONE op-agnostic leaf
// transport DIRECTLY at each covered node: `ExecuteSQL` (a SQL node), `PluckKeys` (relation key
// extraction), `GroupChildren` (relation parent grouping). Each takes ONE generic `wire.WireRow`
// payload (the node's ports as named fields) and each node's result rides back as a BC-OWNED
// `wire.WireValue`, so these three transports are the ONLY boundary between
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
	"github.com/foo-ogawa/litedbmodel/go/litedbmodel_runtime/wire"
	"math"
	"regexp"
	"strconv"

	bc "github.com/foo-ogawa/behavior-contracts/go"
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

// ── Port unbox — the generic-wire payload → the leaf's declared ports ───────────────────────────────
//
// A leaf transport takes ONE generic wire.WireRow payload whose fields ARE the node's ports (the
// covered runner assembles it by name), so divergent port SETS across leaves are just different field
// lists behind ONE signature <Leaf>(payload wire.WireRow) (wire.WireValue, error). Unbox is
// FAIL-CLOSED: an absent or wrong-variant port is a loud error, never a silent default — a port that
// is not there is an ABI break, not a data case.
//
// The BC-owned wire.WireRow / wire.WireList keep their backing slices UNEXPORTED, so a list port
// cannot be aliased out of the payload: [wireItems] MATERIALIZES it to []wire.WireValue ONCE, here at
// the transport edge, and every leaf body below then runs on that ONE materialization (de-box at most
// once). The rebuild stays entirely INSIDE the wire type — it does not route through bc.Value, so the
// wire-native grouping core the bodies consume is unchanged.

// wireProbeAbsent mirrors the BC-OWNED wire package's probe Kind for "no attribute for this field"
// (the wire package keeps its probe-kind consts unexported; 2 = absent is the stable contract).
const wireProbeAbsent uint8 = 2

// portErr is the fail-closed port failure: an ABSENT port names the port, a present-but-wrong one also
// names the DECLARED wire kind and the producer's actual tag.
func portErr(name, expected string, kind uint8, actual string) error {
	if kind == wireProbeAbsent {
		return fmt.Errorf("leaf transport: port %q is absent from the payload", name)
	}
	return fmt.Errorf("leaf transport: port %q expected a wire %s, got %s", name, expected, actual)
}

// portBool reads a bool port (write / returning / bigint / single).
func portBool(payload wire.WireRow, name string) (bool, error) {
	p := payload.ProbeBool(name)
	if p.Kind != wireProbeGot {
		return false, portErr(name, "bool", p.Kind, p.ActualWireType)
	}
	return p.Got, nil
}

// portString reads a string port (sql / into).
func portString(payload wire.WireRow, name string) (string, error) {
	p := payload.ProbeString(name)
	if p.Kind != wireProbeGot {
		return "", portErr(name, "string", p.Kind, p.ActualWireType)
	}
	return p.Got, nil
}

// portList reads a list port (params / rows / parents / children) as the transport's own materialized
// slice — the ONE de-box of that port.
func portList(payload wire.WireRow, name string) ([]wire.WireValue, error) {
	p := payload.ProbeList(name)
	if p.Kind != wireProbeGot {
		return nil, portErr(name, "list", p.Kind, p.ActualWireType)
	}
	return wireItems(p.Got, name)
}

// portStrings reads an {arr:'string'} port — the ordered key-column TUPLE (col / pk / fk). Every
// element must be a wire string (a column NAME), so it reads straight off the string probe: no cell
// materialization is involved.
func portStrings(payload wire.WireRow, name string) ([]string, error) {
	p := payload.ProbeList(name)
	if p.Kind != wireProbeGot {
		return nil, portErr(name, "list", p.Kind, p.ActualWireType)
	}
	out := make([]string, p.Got.Len())
	for i := range out {
		e := p.Got.ElemString(i)
		if e.Kind != wireProbeGot {
			return nil, portErr(name, "string element", e.Kind, e.ActualWireType)
		}
		out[i] = e.Got
	}
	return out, nil
}

// relationGuard is the unboxed `guard` port: the relation runaway cap the emitter baked onto a guarded
// relation child fetch, together with the identity the raised error reports (Go twin of the litedbmodel
// `RelationGuard` record). Model is optional exactly as LimitExceededError.Model is ("" ⇒ "unknown").
type relationGuard struct {
	limit    int
	model    string
	relation string
}

// portRelationGuard reads the OPTIONAL `guard` port. ABSENT (or an explicit null) ⇒ nil ⇒ the statement
// is uncapped and NO check runs. PRESENT but malformed is a LOUD port error, never a silently dropped
// guard — a guard that fails to unbox is a runaway that would otherwise sail through.
func portRelationGuard(payload wire.WireRow) (*relationGuard, error) {
	p := payload.ProbeRow("guard")
	if p.Kind == wireProbeAbsent || p.Kind == wireProbeNull {
		return nil, nil
	}
	if p.Kind != wireProbeGot {
		return nil, portErr("guard", "row", p.Kind, p.ActualWireType)
	}
	n := p.Got.ProbeInt("limit")
	if n.Kind != wireProbeGot {
		return nil, portErr("guard.limit", "int", n.Kind, n.ActualWireType)
	}
	limit := int(n.Got)
	rel := p.Got.ProbeString("relation")
	if rel.Kind != wireProbeGot {
		return nil, portErr("guard.relation", "string", rel.Kind, rel.ActualWireType)
	}
	g := &relationGuard{limit: limit, relation: rel.Got}
	if model := p.Got.ProbeString("model"); model.Kind == wireProbeGot {
		g.model = model.Got
	}
	return g, nil
}

// dynamicWhereFrag is one unboxed dynamic-WHERE fragment: its SQL text, its bound params (wire), and the
// per-call SKIP flag. The homogeneous fragment vocabulary the leaf assembles at run (CLAUDE.md §2: SQL
// text + params + a SKIP flag) — a skipped fragment is PRESENT with `skipped` true, never a null
// element. Go twin of the TS `DynamicWhereFrag`.
type dynamicWhereFrag struct {
	skipped bool
	sql     string
	params  []wire.WireValue
}

// portDynamicWhere reads the OPTIONAL `whereDynamic` plan port — a wire row `{frags: [...]}`. ABSENT (or
// an explicit null) ⇒ nil ⇒ no dynamic WHERE (the statement passes through unchanged): a bounded read, a
// write, and an uncapped fetch OMIT it (CLAUDE.md §2). PRESENT but wrong-variant, or a malformed
// fragment, is a LOUD error.
func portDynamicWhere(payload wire.WireRow) ([]dynamicWhereFrag, error) {
	p := payload.ProbeRow("whereDynamic")
	if p.Kind == wireProbeAbsent || p.Kind == wireProbeNull {
		return nil, nil
	}
	if p.Kind != wireProbeGot {
		return nil, portErr("whereDynamic", "row", p.Kind, p.ActualWireType)
	}
	fl := p.Got.ProbeList("frags")
	if fl.Kind != wireProbeGot {
		return nil, portErr("whereDynamic.frags", "list", fl.Kind, fl.ActualWireType)
	}
	frags := make([]dynamicWhereFrag, fl.Got.Len())
	for i := range frags {
		row := fl.Got.ElemRow(i)
		if row.Kind != wireProbeGot {
			return nil, portErr("whereDynamic.frags element", "row", row.Kind, row.ActualWireType)
		}
		skipped := row.Got.ProbeBool("skipped")
		if skipped.Kind != wireProbeGot {
			return nil, portErr("whereDynamic.frags.skipped", "bool", skipped.Kind, skipped.ActualWireType)
		}
		sql := row.Got.ProbeString("sql")
		if sql.Kind != wireProbeGot {
			return nil, portErr("whereDynamic.frags.sql", "string", sql.Kind, sql.ActualWireType)
		}
		fp := row.Got.ProbeList("params")
		if fp.Kind != wireProbeGot {
			return nil, portErr("whereDynamic.frags.params", "list", fp.Kind, fp.ActualWireType)
		}
		items, err := wireItems(fp.Got, "whereDynamic.frags.params")
		if err != nil {
			return nil, err
		}
		frags[i] = dynamicWhereFrag{skipped: skipped.Got, sql: sql.Got, params: items}
	}
	return frags, nil
}

// ── Payload materialization (wire → wire; the go wire type's slices are unexported) ─────────────────

// wireItems materializes a payload list port into the []wire.WireValue the leaf bodies consume.
func wireItems(l wire.WireList, port string) ([]wire.WireValue, error) {
	out := make([]wire.WireValue, l.Len())
	for i := range out {
		v, err := wireOfElem(l, i)
		if err != nil {
			return nil, fmt.Errorf("leaf transport: port %q element %d: %w", port, i, err)
		}
		out[i] = v
	}
	return out, nil
}

// wireScalarCell rebuilds a SCALAR cell from its STRING probe — the ONE probe that classifies every
// variant (Got = a string; Null; Wrong carries the producer's ActualWireType + Raw). A number keeps its
// RAW text, so the rebuild is byte-exact and no parse/format round-trip happens. ok=false means the cell
// is COMPOSITE (M / L) or an unknown tag: only the CONTAINER accessor differs there, so the two callers
// below hand back the nested handle and this classifier stays the single copy.
func wireScalarCell(p wire.StringProbe) (wire.WireValue, bool) {
	switch p.Kind {
	case wireProbeGot:
		return wire.WireStr(p.Got), true
	case wireProbeNull:
		return wire.WireNull(), true
	}
	switch p.ActualWireType {
	case "N":
		// The wire carries int and float as distinct kinds, so the raw text decides which to rebuild:
		// integer text → WireInt, anything else parseable → WireFloat.
		if i, err := strconv.ParseInt(p.Raw, 10, 64); err == nil {
			return wire.WireInt(i), true
		}
		if f, err := strconv.ParseFloat(p.Raw, 64); err == nil {
			return wire.WireFloat(f), true
		}
		return wire.WireValue{}, false
	case "BOOL":
		return wire.WireBool(p.Raw == "true"), true
	}
	return wire.WireValue{}, false
}

// wireOfRow rebuilds a wire row VALUE from a row handle (keys in order, each cell classified once).
func wireOfRow(r wire.WireRow) (wire.WireValue, error) {
	entries := r.Entries()
	fields := make([]wire.WireField, len(entries))
	for i, e := range entries {
		k := e.Key
		p := r.ProbeString(k)
		v, ok := wireScalarCell(p)
		if !ok {
			var err error
			switch p.ActualWireType {
			case "M":
				v, err = wireOfRow(r.ProbeRow(k).Got)
			case "L":
				v, err = wireOfList(r.ProbeList(k).Got)
			default:
				err = fmt.Errorf("unknown wire tag %q", p.ActualWireType)
			}
			if err != nil {
				return wire.WireValue{}, fmt.Errorf("field %q: %w", k, err)
			}
		}
		fields[i] = wire.WireField{Key: k, Val: v}
	}
	return wire.WireRowOf(fields), nil
}

// wireOfList rebuilds a wire list VALUE from a list handle (the element twin of [wireOfRow]).
func wireOfList(l wire.WireList) (wire.WireValue, error) {
	items := make([]wire.WireValue, l.Len())
	for i := range items {
		v, err := wireOfElem(l, i)
		if err != nil {
			return wire.WireValue{}, fmt.Errorf("element %d: %w", i, err)
		}
		items[i] = v
	}
	return wire.WireListOf(items), nil
}

// wireOfElem rebuilds ONE list element (the list accessor to [wireScalarCell]'s classification).
func wireOfElem(l wire.WireList, i int) (wire.WireValue, error) {
	p := l.ElemString(i)
	if v, ok := wireScalarCell(p); ok {
		return v, nil
	}
	switch p.ActualWireType {
	case "M":
		return wireOfRow(l.ElemRow(i).Got)
	case "L":
		return wireOfList(l.ElemList(i).Got)
	}
	return wire.WireValue{}, fmt.Errorf("unknown wire tag %q", p.ActualWireType)
}

// ── the DYNAMIC (SKIP) WHERE: assembled by the transport, at execution time (leaves.ts) ─────────────

// whereTailRe matches the SQL keywords that may follow a WHERE clause; the dynamic WHERE splices in
// BEFORE the first of them, so it lands at exactly the position a bounded WHERE occupies. Port of the
// TS `WHERE_TAIL_RE` (`/\s+(GROUP BY|ORDER BY|LIMIT|OFFSET|FOR UPDATE|RETURNING)\b/i`).
var whereTailRe = regexp.MustCompile(`(?i)\s+(GROUP BY|ORDER BY|LIMIT|OFFSET|FOR UPDATE|RETURNING)\b`)

// spliceWhere splices a ` WHERE …` clause (leading space included, or "") into baseSql before its first
// tail keyword. Byte-for-byte port of leaves.ts `spliceWhere`.
func spliceWhere(baseSql, whereSql string) string {
	if whereSql == "" {
		return baseSql
	}
	loc := whereTailRe.FindStringIndex(baseSql)
	if loc == nil {
		return baseSql + whereSql
	}
	return baseSql[:loc[0]] + whereSql + baseSql[loc[0]:]
}

// assembleDynamicWhere assembles the effective (sql, params) from the dynamic-WHERE plan: DROP the
// skipped fragments, join the survivors with ` WHERE `(first)/` AND `(rest) + the fragment SQL, splice
// the clause before the first tail keyword (spliceWhere), and bind the surviving fragments' params
// BEFORE the base params (the WHERE `?`s precede the tail's). Byte-for-byte port of leaves.ts
// `assembleDynamicWhere`; a plan with no surviving fragment leaves the statement unchanged.
func assembleDynamicWhere(baseSql string, baseParams []wire.WireValue, frags []dynamicWhereFrag) (string, []wire.WireValue) {
	whereSql := ""
	var whereParams []wire.WireValue
	for _, f := range frags {
		if f.skipped {
			continue
		}
		if whereSql == "" {
			whereSql += " WHERE " + f.sql
		} else {
			whereSql += " AND " + f.sql
		}
		whereParams = append(whereParams, f.params...)
	}
	params := make([]wire.WireValue, 0, len(whereParams)+len(baseParams))
	params = append(params, whereParams...)
	params = append(params, baseParams...)
	return spliceWhere(baseSql, whereSql), params
}

// ExecuteSQL runs ONE SQL node and returns its rows as a wire list of wire rows (empty list for a
// non-RETURNING write). The DYNAMIC (SKIP) WHERE is assembled FIRST when a plan is present
// (assembleDynamicWhere): the final statement shape is only known here, so the placeholder render
// (finalizeSQL) must follow it (CLAUDE.md §2). Params ride as wire values: a scalar binds directly
// (toDriverParam); a wire LIST param binds as ONE JSON array string (the `json_each(?)` batch-key
// contract — SAME rendering as the runtime relation bindKeys). bigint is a render hint the native path
// does not need here. The OPTIONAL `guard` port is the RELATION runaway cap of a guarded relation child
// fetch (absent/null ⇒ uncapped): the raw rows are asserted against it HERE (the shared checkHardLimit
// SSoT) because past [GroupChildren] the graph is already nested. Both control ports are OPTIONAL, so
// ports ride in the payload as {bigint, guard?, params, returning, sql, whereDynamic?, write}.
func ExecuteSQL(payload wire.WireRow) (wire.WireValue, error) {
	bigint, err := portBool(payload, "bigint")
	if err != nil {
		return wire.WireNull(), err
	}
	params, err := portList(payload, "params")
	if err != nil {
		return wire.WireNull(), err
	}
	returning, err := portBool(payload, "returning")
	if err != nil {
		return wire.WireNull(), err
	}
	sql, err := portString(payload, "sql")
	if err != nil {
		return wire.WireNull(), err
	}
	write, err := portBool(payload, "write")
	if err != nil {
		return wire.WireNull(), err
	}
	whereFrags, err := portDynamicWhere(payload)
	if err != nil {
		return wire.WireNull(), err
	}
	guard, err := portRelationGuard(payload)
	if err != nil {
		return wire.WireNull(), err
	}
	_ = bigint
	if leafExecCtx == nil {
		return wire.WireNull(), fmt.Errorf("leaf transport: no bound connection (call BindLeafTransport before running the native module)")
	}
	// Assemble the DYNAMIC (SKIP) WHERE FIRST when a plan is present: the final statement shape is only
	// known here, so the placeholder render (finalizeSQL, below) must follow it (CLAUDE.md §2). An
	// ABSENT plan (whereFrags nil) leaves the bounded sql/params untouched (pass-through).
	if whereFrags != nil {
		sql, params = assembleDynamicWhere(sql, params, whereFrags)
	}
	args := make([]any, len(params))
	values := make([]bc.Value, len(params))
	for i, p := range params {
		values[i] = wireToValue(p)
		args[i] = leafParam(p, leafDialect)
	}
	text := finalizeSQL(sql, arrayBinds(values), leafDialect)
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
	// The RELATION runaway guard, on the RAW child rows — the only point they are visible (past
	// GroupChildren the graph is already nested) and the reason the cap rides on this transport at all.
	// The comparison + error assembly are the shared [checkHardLimit] SSoT, so this path cannot drift
	// from the runtime relation path (relation.go) or from the TS reference.
	if guard != nil {
		if err := checkHardLimit(guard.limit, len(rows), LimitContextRelation, guard.model, guard.relation); err != nil {
			return wire.WireNull(), err
		}
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
// expects. Go twin of the rust `pluck_keys` leaf. Ports ride in the payload as {col, rows}.
func PluckKeys(payload wire.WireRow) (wire.WireValue, error) {
	col, err := portStrings(payload, "col")
	if err != nil {
		return wire.WireNull(), err
	}
	rows, err := portList(payload, "rows")
	if err != nil {
		return wire.WireNull(), err
	}
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
// rust `group_children` leaf. Ports ride in the payload as {children, fk, into, parents, pk, single}.
func GroupChildren(payload wire.WireRow) (wire.WireValue, error) {
	children, err := portList(payload, "children")
	if err != nil {
		return wire.WireNull(), err
	}
	fk, err := portStrings(payload, "fk")
	if err != nil {
		return wire.WireNull(), err
	}
	into, err := portString(payload, "into")
	if err != nil {
		return wire.WireNull(), err
	}
	parents, err := portList(payload, "parents")
	if err != nil {
		return wire.WireNull(), err
	}
	pk, err := portStrings(payload, "pk")
	if err != nil {
		return wire.WireNull(), err
	}
	single, err := portBool(payload, "single")
	if err != nil {
		return wire.WireNull(), err
	}
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
	isNull:    func(cell wire.WireValue) bool { return cell.AsInt().Kind == wireProbeNull },
	keyCellOf: wireKeyCell,
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

// wireKeyCell projects a scalar wire cell to its comparable key value — no allocation, the shape a
// raw-driver consumer groups on. An integer and the same whole float are ONE key.
func wireKeyCell(cell wire.WireValue) keyCell {
	if p := cell.AsInt(); p.Kind == wireProbeGot {
		return keyCell{kind: 1, num: p.Got}
	}
	if p := cell.AsFloat(); p.Kind == wireProbeGot {
		if p.Got == float64(int64(p.Got)) {
			return keyCell{kind: 1, num: int64(p.Got)}
		}
		return keyCell{kind: 2, num: int64(math.Float64bits(p.Got))}
	}
	if p := cell.AsString(); p.Kind == wireProbeGot {
		return stringKeyCell(p.Got)
	}
	if p := cell.AsBool(); p.Kind == wireProbeGot {
		if p.Got {
			return keyCell{kind: 4, num: 1}
		}
		return keyCell{kind: 4}
	}
	return keyCell{}
}

// leafParam converts ONE wire param to a driver-bindable arg, by the SAME rule as TS
// `leaves.encodeParams`: a scalar binds via toDriverParam; a TUPLE SET (a composite relation key set —
// a list whose elements are themselves lists) binds as ONE JSON array-of-tuples string on EVERY
// dialect, because PostgreSQL expands it server-side with json_array_elements (#159); any other list
// is a list of scalar cells, which PostgreSQL binds as a NATIVE array (`= ANY($1)`) and MySQL/SQLite
// as ONE JSON array string (the `json_each(?)` / `JSON_TABLE(?)` contract).
func leafParam(p wire.WireValue, dialect string) any {
	v := wireToValue(p)
	arr, ok := v.([]bc.Value)
	if !ok {
		return toDriverParam(v)
	}
	if dialect == "postgres" && !isTupleSet(arr) {
		out := make([]any, len(arr))
		for i, e := range arr {
			out[i] = toDriverParam(e)
		}
		return out
	}
	return jsStringify(bc.Value(arr))
}

// isTupleSet reports whether a bound array is a composite key set (its elements are key TUPLES). Every
// other array param is a list of SCALAR cells, because no column class de-boxes to a nested list.
func isTupleSet(arr []bc.Value) bool {
	if len(arr) == 0 {
		return false
	}
	_, ok := arr[0].([]bc.Value)
	return ok
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
	if p := w.AsInt(); p.Kind == wireProbeGot {
		return float64(p.Got) // the row-scan convention: a JS-number float64
	}
	if p := w.AsFloat(); p.Kind == wireProbeGot {
		return p.Got
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
	for _, e := range r.Entries() {
		o.Set(e.Key, wireFieldToValue(r, e.Key))
	}
	return o
}

// wireFieldToValue classifies one wire row field via the probe API.
func wireFieldToValue(r wire.WireRow, k string) bc.Value {
	if p := r.ProbeInt(k); p.Kind == wireProbeGot {
		return float64(p.Got)
	}
	if p := r.ProbeFloat(k); p.Kind == wireProbeGot {
		return p.Got
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
	if p := l.ElemInt(i); p.Kind == wireProbeGot {
		return float64(p.Got)
	}
	if p := l.ElemFloat(i); p.Kind == wireProbeGot {
		return p.Got
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
