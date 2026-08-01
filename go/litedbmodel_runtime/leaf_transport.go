// litedbmodel v2 SCP — the op-INDEPENDENT NATIVE leaf TRANSPORT (#141), Go.
//
// The bc `go-typed-native` covered module (the generated `<Method>()` entry) calls ONE op-agnostic leaf
// transport DIRECTLY at each covered node: `ExecuteSQL` (a SQL node), `PluckKeys` (relation key
// extraction), `GroupChildren` (relation parent grouping). Each takes ONE generic `wire.WireRow`
// payload (the node's ports as named fields) and each node's result rides back as a BC-OWNED
// `wire.WireValue`, so these three transports are the ONLY boundary between
// the wire plane and the runtime: they convert `wire.WireValue` ↔ bc `Value`/`*Obj` and delegate the
// relation shaping to the SHARED grouping CORE (grouping.go `dedupeKeyTuplesG`/`groupByKeyG`/
// `attachG`). There is NO second grouping implementation here — that core is the single source of
// truth, and this file is its only consumer; this file only bridges
// wire ↔ Value at the transport edge and issues SQL through the central [Execute]/[Run] seam. This is
// the Go twin of the rust `execute_sql`/`pluck_keys`/`group_children` leaf (same op-agnostic wire
// contract), NOT the py/php native-record method leaf.
//
// CONNECTION: the covered module calls these as free functions (bc's transport contract carries no db
// handle), so the consumer BINDS the target [ExecutionContext] once via [BindLeafTransport] before
// driving the generated runners. This is the leaf transport's single bound context — not a fallback
// path. It is the CONTEXT that is bound, not a raw db: the ctx is what carries the connection ROUTING
// (reader/writer split, named DB, writer-sticky), and this is the only path a bc typed-native module
// reaches a connection by, so a routed consumer configuration has to arrive HERE. Wrapping the db in
// [ContextForDB] inside the binder instead — which never sets `routing` — left every routed setup
// inert (#214).

package litedbmodel_runtime

import (
	"fmt"
	"github.com/foo-ogawa/litedbmodel/go/litedbmodel_runtime/wire"
	"math"
	"strconv"
	"strings"

	bc "github.com/foo-ogawa/behavior-contracts/go"
)

// wireProbeGot mirrors the BC-OWNED wire package's probe-result Kind for "present and matching" (the
// wire package keeps its probe-kind consts unexported; 0 = got is the stable public contract the
// generated de-box also compares against).
const wireProbeGot uint8 = 0

// leaf transport bound state (set by BindLeafTransport). The bench/consumer drives the generated
// runners sequentially against ONE bound context; ExecuteSQL funnels every SQL node through it.
var (
	leafExecCtx *ExecutionContext
	leafDialect = "sqlite"
)

// BindLeafTransport binds the [ExecutionContext] (+ dialect for placeholder rendering) the
// free-function leaf transport issues SQL against. Call ONCE before driving
// RunNativeRawStruct_<comp>. A single-DB consumer passes [ContextForDB]; a routed one passes
// [ContextForRouting], and its reader/writer split, named-DB registry and writer-sticky clock then
// resolve per statement inside [ExecutionContext.ConnectionFor] — the leaf issues an INTENT, the ctx
// picks the connection.
func BindLeafTransport(ctx *ExecutionContext, dialect string) {
	leafExecCtx = ctx
	leafDialect = dialect
}

// UnbindLeafTransport clears the bound CONTEXT (leaves ExecuteSQL fail-closed until re-bound).
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

// portBool reads a bool port (the control record's write / returning, or group's single).
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

// optRowField reads a NULLABLE STRUCT field of a struct that IS present. A wire NULL is the declared
// ABSENCE (no cap / no plan / a read); an ABSENT KEY is an ABI BREAK, and the two must not collapse:
// bc types a port by the literal wired into it and REJECTS a partial struct, so a generated module
// ALWAYS spells every field (`null` is how absence is spelled). A key that is not there did not come
// from one, and reading it as null would silently drop a relation cap, erase a SKIP predicate, or run a
// write as a read (#205).
func optRowField(row wire.WireRow, name string) (wire.WireRow, bool, error) {
	p := row.ProbeRow(name)
	switch p.Kind {
	case wireProbeGot:
		return p.Got, true, nil
	case wireProbeNull:
		return wire.WireRow{}, false, nil
	default:
		return wire.WireRow{}, false, portErr(name, "row", p.Kind, p.ActualWireType)
	}
}

// relationGuard is the unboxed `guard` port: the relation runaway cap the emitter baked onto a guarded
// relation child fetch, together with the identity the raised error reports (Go twin of the litedbmodel
// `RelationGuard` record). On the WIRE `model`'s key is always spelled — bc types a port by the literal
// wired into it and rejects a partial struct — so "no model" rides as a wire null ("" ⇒ "unknown" in the
// error), and the key itself is read fail-closed rather than defaulted when absent.
type relationGuard struct {
	limit    int
	model    string
	relation string
}

// portRelationGuard reads the `guard` field of the control record. A wire NULL ⇒ nil ⇒ the statement is
// uncapped and NO check runs; an ABSENT KEY is LOUD ([optRowField]), because a guard read as "no cap" is
// the runaway the cap exists to stop. PRESENT but malformed is equally loud, never a silently dropped
// guard — a guard that fails to unbox is a runaway that would otherwise sail through.
func portRelationGuard(opts wire.WireRow) (*relationGuard, error) {
	row, present, err := optRowField(opts, "guard")
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, nil
	}
	n := row.ProbeInt("limit")
	if n.Kind != wireProbeGot {
		return nil, portErr("guard.limit", "int", n.Kind, n.ActualWireType)
	}
	limit := int(n.Got)
	rel := row.ProbeString("relation")
	if rel.Kind != wireProbeGot {
		return nil, portErr("guard.relation", "string", rel.Kind, rel.ActualWireType)
	}
	g := &relationGuard{limit: limit, relation: rel.Got}
	// `model` is a NULLABLE field, so a wire null is its declared absence ("" ⇒ "unknown" in the error)
	// — but the KEY must be there, exactly like every other field of a struct the generator wrote.
	switch model := row.ProbeString("model"); model.Kind {
	case wireProbeGot:
		g.model = model.Got
	case wireProbeNull:
	default:
		return nil, portErr("guard.model", "string", model.Kind, model.ActualWireType)
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

// dynamicWherePlan is the unboxed `whereDynamic` plan: the fragments plus the three facts that FINISH
// the statement. `lead` is the connector the first surviving fragment joins the head with ("AND" when
// the head already ends in a static WHERE, "WHERE" when it does not); `tail` is the text that follows
// the WHERE region (` ORDER BY …` / the page / the row lock, "" when the statement ends there) and
// `tailParams` its own bound values. They come from the emitter's SELECT builder, which is what put the
// WHERE in the statement — so assembly is a CONCATENATION and no scan of the base SQL is involved. Go
// twin of the TS `DynamicWherePlan`.
type dynamicWherePlan struct {
	frags      []dynamicWhereFrag
	lead       string
	tail       string
	tailParams []wire.WireValue
}

// portDynamicWhere reads the `whereDynamic` field of the control record — a wire row
// `{frags, lead, tail, tailParams}`. A wire NULL ⇒ nil ⇒ no dynamic WHERE (the statement passes through
// unchanged): only a read that declares an OPTIONAL predicate carries a plan (CLAUDE.md §2). An ABSENT
// KEY is LOUD ([optRowField]), because a plan read as "no plan" erases the call's SKIP predicates.
// PRESENT but wrong-variant, or a malformed fragment, is equally loud — and so is a missing `lead` /
// `tail` / `tailParams`: defaulting `lead` opens a second WHERE (or continues an absent one), and
// defaulting the tail DROPS the statement's ORDER BY and page while still returning rows.
func portDynamicWhere(opts wire.WireRow) (*dynamicWherePlan, error) {
	row, present, err := optRowField(opts, "whereDynamic")
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, nil
	}
	fl := row.ProbeList("frags")
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
	lead := row.ProbeString("lead")
	if lead.Kind != wireProbeGot {
		return nil, portErr("whereDynamic.lead", "string", lead.Kind, lead.ActualWireType)
	}
	tail := row.ProbeString("tail")
	if tail.Kind != wireProbeGot {
		return nil, portErr("whereDynamic.tail", "string", tail.Kind, tail.ActualWireType)
	}
	tp := row.ProbeList("tailParams")
	if tp.Kind != wireProbeGot {
		return nil, portErr("whereDynamic.tailParams", "list", tp.Kind, tp.ActualWireType)
	}
	tailParams, err := wireItems(tp.Got, "whereDynamic.tailParams")
	if err != nil {
		return nil, err
	}
	return &dynamicWherePlan{frags: frags, lead: lead.Got, tail: tail.Got, tailParams: tailParams}, nil
}

// execOptions is the UNBOXED control record of one statement (the `opts` port — the TS `ExecOptions`):
// how to run it plus the two optional control structs. Everything the transport branches on besides the
// statement itself lives here, so a new fact is a new FIELD and no call site's arguments shift (#193).
type execOptions struct {
	// db is the NAMED connection (database) the statement runs on — "" ⇒ the DEFAULT connection. Baked
	// at emit from the statement's model (the litedbmodel `connectionOf`), or, for a relation child
	// fetch, from the compiled op's TARGET model. It reaches the router as [StatementIntent.DB].
	db        string
	write     *writeMode
	wherePlan *dynamicWherePlan
	guard     *relationGuard
}

// writeMode is the unboxed `write` field: nil ⇒ the statement is a READ, non-nil ⇒ a write carrying its
// OWN `returning`. ONE field with three values, so "returns rows but is not a write" is not a state
// this transport can be handed (#206) — there is nothing to reject at run time because it cannot exist.
type writeMode struct {
	returning bool
}

// portWriteMode reads the `write` field of the control record. A wire NULL ⇒ nil ⇒ a READ; an ABSENT KEY
// is LOUD ([optRowField]), and PRESENT but malformed is equally loud — a write read as a read runs an
// INSERT on the read seam.
func portWriteMode(opts wire.WireRow) (*writeMode, error) {
	row, present, err := optRowField(opts, "write")
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, nil
	}
	returning, err := portBool(row, "returning")
	if err != nil {
		return nil, err
	}
	return &writeMode{returning: returning}, nil
}

// portExecOptions reads the OPTIONAL `opts` control record. ABSENT (or null) ⇒ the ZERO record — a plain
// READ with no dynamic WHERE and no cap, which is the ONE statement shape that omits the port (its
// payload is `sql` + `params` and nothing else). PRESENT ⇒ every field is read FAIL-CLOSED: the record
// is what says whether the statement writes, so a missing field is an ABI break, never a default.
func portExecOptions(payload wire.WireRow) (execOptions, error) {
	p := payload.ProbeRow("opts")
	if p.Kind == wireProbeAbsent || p.Kind == wireProbeNull {
		return execOptions{}, nil
	}
	if p.Kind != wireProbeGot {
		return execOptions{}, portErr("opts", "row", p.Kind, p.ActualWireType)
	}
	db, err := portNamedDB(p.Got)
	if err != nil {
		return execOptions{}, err
	}
	write, err := portWriteMode(p.Got)
	if err != nil {
		return execOptions{}, err
	}
	plan, err := portDynamicWhere(p.Got)
	if err != nil {
		return execOptions{}, err
	}
	guard, err := portRelationGuard(p.Got)
	if err != nil {
		return execOptions{}, err
	}
	return execOptions{db: db, write: write, wherePlan: plan, guard: guard}, nil
}

// portNamedDB reads the `db` field of the control record — the NAMED connection the statement runs on.
// A wire NULL ⇒ "" ⇒ the DEFAULT connection; an ABSENT KEY is LOUD, exactly like every other field of a
// struct the generator wrote, because a name read as "no name" runs the statement against a DIFFERENT
// database than its model declares (#217). It is the only control field that is a bare nullable STRING
// rather than a struct, so it reads off the string probe instead of [optRowField].
func portNamedDB(opts wire.WireRow) (string, error) {
	switch db := opts.ProbeString("db"); db.Kind {
	case wireProbeGot:
		return db.Got, nil
	case wireProbeNull:
		return "", nil
	default:
		return "", portErr("db", "string", db.Kind, db.ActualWireType)
	}
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

// assembleDynamicWhere assembles the effective (sql, params) from the dynamic-WHERE plan: DROP the
// skipped fragments, join the survivors with " AND ", and CONCATENATE the three pieces already in hand —
// the statement's HEAD (which ends at its WHERE region), the assembled clause, and the plan's tail. The
// params follow the same order: the head's, the survivors', the tail's.
//
// Nothing is LOCATED here. The emitter's SELECT builder is what puts the WHERE in the statement, so it
// hands the boundary over on the plan (`lead` says whether the head already ends in a WHERE, `tail` /
// `tailParams` are what follows it) instead of leaving five transports to rediscover it by scanning: a
// scan took a NESTED statement's tail keyword for the outer statement's (#198), counted a QUOTED `?` the
// placeholder render skips (#202), and produced a byte offset that is not the same number in five
// languages. Port of leaves.ts `assembleDynamicWhere`; a plan whose fragments are all skipped leaves the
// emitted statement exactly as it was compiled (head + tail, no clause).
func assembleDynamicWhere(head string, headParams []wire.WireValue, plan *dynamicWherePlan) (string, []wire.WireValue) {
	clause := ""
	params := make([]wire.WireValue, 0, len(headParams)+len(plan.tailParams))
	params = append(params, headParams...)
	for _, f := range plan.frags {
		if f.skipped {
			continue
		}
		if clause == "" {
			clause = " " + plan.lead + " "
		} else {
			clause += " AND "
		}
		clause += f.sql
		params = append(params, f.params...)
	}
	return head + clause + plan.tail, append(params, plan.tailParams...)
}

// ExecuteSQL runs ONE SQL node and returns its rows as a wire list of wire rows (empty list for a
// non-RETURNING write). The DYNAMIC (SKIP) WHERE is assembled FIRST when a plan is present
// (assembleDynamicWhere): the final statement shape is only known here, so the placeholder render
// (finalizeSQL) must follow it (CLAUDE.md §2). Params ride as wire values: a scalar binds directly
// (toDriverParam); a wire LIST param binds as ONE JSON array string (the `json_each(?)` batch-key
// contract — SAME rendering as the runtime relation bindKeys). `opts.guard` is the RELATION runaway cap
// of a guarded relation child fetch (absent ⇒ uncapped): the raw rows are asserted against it HERE (the
// shared checkHardLimit SSoT) because past [GroupChildren] the graph is already nested. The whole
// control surface is ONE optional record, so ports ride in the payload as {opts?, params, sql} — a
// bounded read carries `sql` and `params` alone.
func ExecuteSQL(payload wire.WireRow) (wire.WireValue, error) {
	params, err := portList(payload, "params")
	if err != nil {
		return wire.WireNull(), err
	}
	sql, err := portString(payload, "sql")
	if err != nil {
		return wire.WireNull(), err
	}
	opts, err := portExecOptions(payload)
	if err != nil {
		return wire.WireNull(), err
	}
	if leafExecCtx == nil {
		return wire.WireNull(), fmt.Errorf("leaf transport: no bound execution context (call BindLeafTransport before running the native module)")
	}
	// Assemble the DYNAMIC (SKIP) WHERE FIRST when a plan is present: the final statement shape is only
	// known here, so the placeholder render (finalizeSQL, below) must follow it (CLAUDE.md §2). With a
	// plan the `sql` port is the statement's HEAD and the plan carries what finishes it; an ABSENT plan
	// (wherePlan nil) means `sql`/`params` are the WHOLE statement and pass through untouched.
	if opts.wherePlan != nil {
		sql, params = assembleDynamicWhere(sql, params, opts.wherePlan)
	}
	args := make([]any, len(params))
	values := make([]bc.Value, len(params))
	for i, p := range params {
		values[i] = wireToValue(p)
		args[i] = leafParam(p, leafDialect)
	}
	text := finalizeSQL(sql, arrayBinds(values), leafDialect)
	// The seam INTENT the statement's RUN MODE reduces to: a write mode PRESENT ⇒ a WRITE (the writer /
	// tx connection), absent ⇒ a READ. Derived ONCE, BEFORE the branch, because the branch selects the
	// SEAM (`returning` ⇒ the row seam) while the intent selects the CONNECTION: a RETURNING write runs
	// on [Execute] and still belongs on the WRITER. Reading `returning` as the intent sent
	// `INSERT … RETURNING` to the READ REPLICA (#207). Same rule in all five languages (TS `prepareSql`).
	// The NAMED database rides on the SAME intent, because [resolvePool] resolves both together: it picks
	// the named connection's reader/writer PAIR first, then the write/sticky split within it. "" ⇒ the
	// default connection, i.e. the intent every single-DB statement has always carried.
	intent := StatementIntent{Write: opts.write != nil, DB: opts.db}
	if opts.write != nil && !opts.write.returning {
		info, err := Run(leafExecCtx, text, args, intent)
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
	rows, err := Execute(leafExecCtx, text, args, intent)
	if err != nil {
		return wire.WireNull(), err
	}
	// The RELATION runaway guard, on the RAW child rows — the only point they are visible (past
	// GroupChildren the graph is already nested) and the reason the cap rides on this transport at all.
	// The comparison + error assembly are the shared [checkHardLimit] SSoT, so this path cannot drift
	// from the TS reference.
	if opts.guard != nil {
		if err := checkHardLimit(opts.guard.limit, len(rows), LimitContextRelation, opts.guard.model, opts.guard.relation); err != nil {
			return wire.WireNull(), err
		}
	}
	items := make([]wire.WireValue, len(rows))
	for i, r := range rows {
		items[i] = valueToWire(r)
	}
	return wire.WireListOf(items), nil
}

// WithAmbientTransaction runs `body` inside ONE transaction on the BOUND context, threading the
// tx-owned connection as the AMBIENT the free-function [ExecuteSQL] resolves — so a bc-generated tx
// runner (which calls ExecuteSQL directly, taking no db handle) executes every statement of the tx's own database (an unnamed one, or one naming that database) ON the
// transaction. BEGIN → run body under the tx-pinned ambient → COMMIT on ok / ROLLBACK on a body error
// (atomicity). This is the CONSUMER's tx-boundary responsibility (NOT a bc feature, NOT emitted into
// the generated runner); it adds NO tx engine — it reuses the existing tx combinator
// ([WithTransaction], which owns BEGIN/COMMIT/ROLLBACK through the central seam, acquires the tx's
// owned connection from the ctx's WRITER pool and arms writer-sticky on COMMIT) and only swaps the
// ambient leaf ctx for the body span. WHICH connection the transaction opens on is therefore the same
// question the bound ctx already answers for every statement — taking a `db` here instead let a routed
// covered plane BEGIN outside its own routing (#215). Go twin of the rust `with_ambient_transaction`
// leaf. Requires a bound transport ([BindLeafTransport]).
func WithAmbientTransaction(body func() error) error {
	base := leafExecCtx
	if base == nil {
		return fmt.Errorf("leaf transport: WithAmbientTransaction needs a bound transport (call BindLeafTransport first)")
	}
	prev := leafExecCtx
	_, err := WithTransaction(base, func(txCtx *ExecutionContext) (struct{}, error) {
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
// algorithm, run directly on wire rows ([wireOps]); there is NO wire↔Value round-trip on the hot
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
// SAME algorithm, run directly on wire rows ([wireOps]); NO wire↔Value round-trip. `pk`/`fk` are the
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
// speaks) — the ONE instantiation of [recordOps]. The SAME generic algorithm runs; only
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
		// A whole float folds onto the integer key, but ONLY from inside int64's range — tested
		// DIRECTLY, never by round-tripping through `int64(f)`. That conversion is
		// implementation-defined out of range, and the two implementations disagree in a way that
		// decides this: arm64's `fcvtzs` SATURATES to MaxInt64, whose float64 rounds back up to 2^63,
		// so `f == float64(int64(f))` held for f = 2^63 and put it in MaxInt64's bucket — a child keyed
		// 2^63 nested under the parent keyed MaxInt64. x86-64's `cvttsd2si` yields MinInt64 instead, so
		// the same code was correct there and CI (x86) could never see it (#262).
		// Both bounds are exactly representable as a float64; the upper one is EXCLUSIVE because
		// `float64(MaxInt64)` rounds up to 2^63. The range test also excludes ±Inf and NaN, which fall
		// through to the bits branch. Same rule, same constants as rust `grouping.rs` and php
		// `Grouping.php` — this was the one of the four runtimes still spelling it as a round-trip.
		const i64MinF = -9223372036854775808.0 // MinInt64, exact
		const i64SupF = 9223372036854775808.0  // 2^63, the first float64 past MaxInt64
		if p.Got == math.Trunc(p.Got) && p.Got >= i64MinF && p.Got < i64SupF {
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

// ── Render-layer placeholder resolution (spec §8) ──────────────────────────────
//
// The final render-layer steps that can only run once a statement's SQL text AND its bound params
// are final: resolve each deferred PG array-cast token from the array param that fills it, then
// rewrite `?` → the dialect placeholder form. The leaf transport ([ExecuteSQL]) is the SOLE caller —
// the DYNAMIC (SKIP) WHERE is assembled FIRST (assembleDynamicWhere), so this placeholder render must
// follow it (CLAUDE.md §2: `?`→`$N` after the final SQL is known).

// pgArrayCastToken is the DEFERRED PG array-cast placeholder: emitted in the STATIC SQL where the
// `= ANY(?::<T>[])` element type is unknown at symbolic compile (a schema-less `whereIn`). Resolved
// at render from the BOUND array via inferPgArrayType — the same render-layer step as `?`→`$N`.
const pgArrayCastToken = "@@PG_ARRAY_CAST@@"

// inferPgArrayType ports the ORIGINAL inferPgArrayType (v1 LazyRelation): the element type inferred
// from the sample values (no sqlCast at this schema-less surface). A bc integer arrives as int64;
// a non-integer number as float64.
func inferPgArrayType(values []bc.Value) string {
	if len(values) == 0 {
		return "text[]"
	}
	switch values[0].(type) {
	case bool:
		return "boolean[]"
	case int64, int:
		return "int[]"
	case float64:
		// A float64 whose every element is an exact integer is still an int key; only a genuine
		// fractional value is numeric.
		allInt := true
		for _, v := range values {
			if f, ok := v.(float64); !ok || f != float64(int64(f)) {
				allInt = false
				break
			}
		}
		if allInt {
			return "int[]"
		}
		return "numeric[]"
	default:
		return "text[]"
	}
}

// resolvePgArrayCast resolves the FIRST unresolved cast token to the element type inferred from
// values (mirrors TS resolvePgArrayCast). SQL with no token is unchanged.
func resolvePgArrayCast(sql string, values []bc.Value) string {
	at := strings.Index(sql, pgArrayCastToken)
	if at < 0 {
		return sql
	}
	return sql[:at] + inferPgArrayType(values) + sql[at+len(pgArrayCastToken):]
}

// arrayBinds picks the ARRAY-valued binds out of a driver param list, in order — the arrays that fill
// the deferred cast tokens (each postgres __jsonArray param resolves exactly one token).
func arrayBinds(params []bc.Value) [][]bc.Value {
	var out [][]bc.Value
	for _, p := range params {
		if arr, ok := p.([]bc.Value); ok {
			out = append(out, arr)
		}
	}
	return out
}

// renderPlaceholders rewrites `?` → the dialect placeholder form: PG `$N` (quote-aware), MySQL/SQLite
// keep `?`. Byte-for-byte port of the TS renderPlaceholders: a `?` inside a single-quoted string
// literal is NOT a placeholder.
func renderPlaceholders(sql, dialectName string) string {
	if dialectName != "postgres" {
		return sql
	}
	var out strings.Builder
	index := 0
	inString := false
	for _, ch := range sql {
		if inString {
			out.WriteRune(ch)
			if ch == '\'' {
				inString = false
			}
		} else if ch == '\'' {
			out.WriteRune(ch)
			inString = true
		} else if ch == '?' {
			index++
			fmt.Fprintf(&out, "$%d", index)
		} else {
			out.WriteRune(ch)
		}
	}
	return out.String()
}

// finalizeSQL runs the render-layer steps that can only happen once a statement's SQL text AND its
// bound params are final (spec §8): resolve each deferred PG array-cast token from the array param
// that fills it, left-to-right, then rewrite `?` → `$N`. `arrays` is the ordered list of ARRAY-valued
// binds — one per cast token, in the order the tokens appear; pass nil when a statement binds none.
func finalizeSQL(sql string, arrays [][]bc.Value, dialectName string) string {
	if dialectName == "postgres" {
		for _, a := range arrays {
			if !strings.Contains(sql, pgArrayCastToken) {
				break
			}
			sql = resolvePgArrayCast(sql, a)
		}
	}
	return renderPlaceholders(sql, dialectName)
}
