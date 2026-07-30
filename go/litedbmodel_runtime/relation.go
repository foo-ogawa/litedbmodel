// litedbmodel v2 SCP — read-relation batch EXECUTION (Go port of src/scp/relation.ts, #43).
//
// Byte-for-byte port of the TS reference relation runtime: the STATIC pre-compiled batch op
// (bundle.relations[name] — pure JSON) is EXECUTED, never regenerated. A RelationOp carries the
// batched child SELECT text with ONE `?` for the deduped-key array param; the runtime dedupes the
// parent keys, resolves the deferred PG array cast from the REAL keys, renders `?`→`$N`, short-
// circuits an empty key set (NO query), runs the batch, groups the child rows by target key, and
// distributes them onto the parents per cardinality (hasMany → list, belongsTo/hasOne → single or
// nil). The SAME RunRelationOp / DistributeToParent / dedupeKeys the TS eager path uses.
//
// #40 parallel-safe: the batch is grouped-then-distributed by key, so the hydrated result is
// deterministic regardless of query-completion order. Independent sibling relations may run in any
// order (bc RunPlan fan-out) and still produce the identical hydrated shape.

package litedbmodel_runtime

import (

	bc "github.com/foo-ogawa/behavior-contracts/go"
)

// RelationOp is the pre-compiled STATIC batch op read out of bundle.relations[name] (pure JSON).
// Single-key relations carry ParentKey/TargetKey; composite (#47 item 1) carry ParentKeys/TargetKeys.
type RelationOp struct {
	Name        string
	Kind        string // "belongsTo" | "hasMany" | "hasOne"
	ParentKey   string
	TargetKey   string
	ParentKeys  []string // composite: ordered parent key columns (nil for single-key)
	TargetKeys  []string // composite: ordered child key columns (nil for single-key)
	Dialect     string
	Connection  string // CROSS-DB (V0 R1): the target model's connection tag (empty for same-DB)
	SQL         string
	TargetTable string // the child (target) table name — the LimitExceededError.Model for a relation
	// HardLimit is the baked per-batch runaway cap (Phase E-2, epic #74; v1 _selectForRelation
	// hasManyHardLimit): when the batch fetches MORE than this TOTAL, runRelationOp throws
	// LimitExceededError (context "relation", EXACT count). nil ⇒ NO check (disabled, or an
	// intrinsic per-parent LIMIT-window relation whose fanout is already bounded — the artifact omits
	// the field). Caps come from the ARTIFACT ONLY (no config surface).
	HardLimit *int
}

func getStrJ(o *bc.JObj, k string) string {
	if v, ok := o.Get(k); ok {
		s, _ := v.(string)
		return s
	}
	return ""
}

// parentKeyCols / targetKeyCols return the ordered key columns (single-key → 1-element).
func (op RelationOp) parentKeyCols() []string {
	if op.ParentKeys != nil {
		return op.ParentKeys
	}
	return []string{op.ParentKey}
}

func (op RelationOp) targetKeyCols() []string {
	if op.TargetKeys != nil {
		return op.TargetKeys
	}
	return []string{op.TargetKey}
}

// The key-identity + dedupe + group + attach primitives are the SHARED grouping CORE (grouping.go) —
// the SINGLE source of truth this lazy/declarative path and the native leaf transport (leaf_transport.go)
// both consume: KeyIdentity / DedupeKeyTuples / GroupByKey / AttachToParent (no duplicated grouping).

// bindKeys binds the deduped keys to the op's params per dialect + arity (TS bindKeys). Composite:
// ONE JSON array-of-tuples string on EVERY dialect (#159) — PostgreSQL expands it server-side with
// json_array_elements, so the key set crosses as one param whatever its length and whatever its
// arity. Single-key: PG -> ONE scalar array param; MySQL/SQLite -> ONE JSON scalar-array string.
func bindKeys(op RelationOp, tuples [][]bc.Value) []any {
	if op.ParentKeys != nil {
		payload := make([]bc.Value, len(tuples))
		for i, t := range tuples {
			payload[i] = bc.Value([]bc.Value(t))
		}
		return []any{jsStringify(bc.Value(payload))}
	}
	if op.Dialect == "postgres" {
		colArr := make([]any, len(tuples))
		for i, t := range tuples {
			colArr[i] = toDriverParam(t[0])
		}
		return []any{colArr}
	}
	payload := make([]bc.Value, len(tuples))
	for i, t := range tuples {
		payload[i] = t[0]
	}
	return []any{jsStringify(bc.Value(payload))}
}

// RelationBatch is the child rows grouped for a batch: stringified target-key identity → child rows.
type RelationBatch map[keyID][]bc.Value

// RunRelationOp runs ONE relation batch op for a set of parent rows (port of TS runRelationOp).
// Dedup the parent-key tuples, resolve the deferred PG array cast(s) from the REAL keys (one per key
// column for composite) BEFORE the `?`→`$N` render; on a NON-empty key set execute binding the keys
// (single array / per-column arrays / JSON tuples) and group the child rows by target-key identity.
// An EMPTY key set issues NO query, matching TS.
//
// Backward-compat wrapper (§6): wraps `db` in a thin ExecutionContext and delegates to the
// ctx-threaded core, so an existing caller passing a raw db keeps its byte-identical behavior.
func RunRelationOp(op RelationOp, parents []bc.Value, db SQLDB) (RelationBatch, error) {
	return runRelationOpCtx(ContextForDB(db), op, parents)
}

// runRelationOpCtx runs ONE relation batch op through the CENTRAL SEAM (§2): the batched child SELECT
// funnels through Execute(ctx, …, intent) — the resolved connection is the tx-owned one when the
// relation runs inside a tx-scoped ctx, the op's NAMED database when it tags one, else the primary db.
// This is the ctx-threaded core.
func runRelationOpCtx(ctx *ExecutionContext, op RelationOp, parents []bc.Value) (RelationBatch, error) {
	pCols := op.parentKeyCols()
	keys := DedupeKeyTuples(parents, pCols)
	batch := RelationBatch{}
	sqlText := op.SQL
	var castArrays [][]bc.Value
	if op.Dialect == "postgres" {
		for col := range pCols {
			colVals := make([]bc.Value, len(keys))
			for i, t := range keys {
				colVals[i] = t[col]
			}
			castArrays = append(castArrays, colVals)
		}
	}
	sqlText = finalizeSQL(sqlText, castArrays, op.Dialect)
	if len(keys) == 0 {
		return batch, nil
	}
	tCols := op.targetKeyCols()
	// The batch's own DATABASE: the compiled op names it (RelationOp.Connection — the TARGET model's)
	// and the ctx owns the registry that resolves the name. They meet HERE, on the StatementIntent —
	// the only input ConnectionFor routes on, and the SAME channel the executeSQL leaf uses on the
	// codegen surface (leaf_transport.go). An untagged (same-DB) relation leaves DB empty ⇒ the
	// DEFAULT connection.
	rows, err := Execute(ctx, sqlText, bindKeys(op, keys), StatementIntent{Write: false, DB: op.Connection})
	if err != nil {
		return nil, err
	}
	// Phase E-2 (#74): post-fetch hard-limit runaway guard. When the batch TOTAL exceeds the baked
	// cap, throw with the EXACT count (the batch is fetched in full, no N+1) BEFORE grouping/hydration
	// so an over-cap read never assembles an unbounded result set. Field mapping: Model = the relation
	// TARGET TABLE, Relation = the relation name. Absent op.HardLimit ⇒ disabled / intrinsic-limit
	// relation ⇒ no check. One guard point, shared by every caller of the batch. The
	// SAME check the TS reference (runRelationOp) + the rust/py/php ports run off the same field.
	if op.HardLimit != nil {
		if err := checkHardLimit(*op.HardLimit, len(rows), LimitContextRelation, op.TargetTable, op.Name); err != nil {
			return nil, err
		}
	}
	// Group the fetched child rows by their target-key tuple identity via the shared CORE (GroupByKey).
	batch = GroupByKey(rows, tCols)
	return batch, nil
}

// DistributeToParent distributes a resolved batch onto ONE parent per cardinality (port of TS
// distributeToParent): hasMany → the child list ([] when none); belongsTo/hasOne → the single child
// (or nil), keyed by the parent's key-tuple identity. Delegates to the shared CORE (AttachToParent) —
// `single` = a non-hasMany cardinality (belongsTo/hasOne).
func DistributeToParent(op RelationOp, parent *bc.Obj, batch RelationBatch) bc.Value {
	return AttachToParent(parent, op.parentKeyCols(), batch, op.Kind != "hasMany")
}
