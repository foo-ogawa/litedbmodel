//! litedbmodel v2 SCP — the op-INDEPENDENT runtime leaves (#141 / #164), Rust wire-passthrough port
//! of `src/scp/leaves.ts`.
//!
//! The whole per-DSL execution surface is THREE op-agnostic leaves — the transport symbols the
//! native codegen calls DIRECTLY at each covered node (`execute_sql` / `pluck_keys` /
//! `group_children`, matching `LEAF_TRANSPORT_SYMBOLS` in leaves.ts). They are NOT per-op and own NO
//! grouping logic of their own: `pluck_keys` / `group_children` delegate to the shared grouping CORE
//! ([`crate::grouping`]) — the SAME SSoT the runtime lazy/relation path ([`crate::relation`])
//! consumes (no duplicated dedupe/grouping). `execute_sql` funnels through the central execute/run
//! seam ([`crate::exec_context`]) — the ONLY driver contact.
//!
//! ## Wire-passthrough (#164) — the leaves speak `WireValue` end-to-end
//!
//! Under #164 the covered runner holds intermediate node results as RAW wire (`Vec<WireValue>`) and
//! NEVER de-boxes them; only the terminal node de-boxes to its concrete outType. The READ RESULT is
//! materialized DIRECTLY as [`WireValue`] by the driver ([`crate::driver`] / [`crate::livedb`]) — one
//! pass, no bc [`Value`] detour — so `execute_sql` returns those rows verbatim and the grouping core
//! ([`crate::grouping`]) keys on `WireValue` too. The ONLY place a `WireValue` becomes a bc [`Value`]
//! is the handful of SQL bind PARAMS (`wire_to_value`), because the driver's param binder takes
//! [`Value`]; no read datum ever round-trips through `Value`.
//!
//! ## Ambient driver — the leaves are free functions, the driver is scoped
//!
//! The covered runner (the generated `<method>()` entry) takes NO driver argument — it calls the leaf
//! transport symbols as free functions with ONE generic `WireRow` payload each (the node's ports as
//! named fields). `execute_sql` resolves the driver from a thread-scoped
//! ambient set by [`with_ambient_driver`] (the consumer brackets each op call). This is the rust
//! analogue of the TS `LeafContext.exec` bc injects at `bindBehaviors` time (C4 — never on the IR).

use std::cell::Cell;

use behavior_contracts::Value;

use crate::driver::Driver;
use crate::exec_context::{self, StatementIntent};
use crate::sql_render::render_placeholders;
use crate::wire::{BehaviorError, Probe, WireList, WireRow, WireValue};

// ── Ambient driver (thread-scoped) ───────────────────────────────────────────────────────────────

/// A type-erased pointer to the ambient [`Driver`]. Set only for the duration of a
/// [`with_ambient_driver`] scope (which brackets the whole covered-op call), then restored — so the
/// pointer never outlives the borrow it was made from.
#[derive(Clone, Copy)]
struct DriverPtr(*const (dyn Driver + 'static));

thread_local! {
    static AMBIENT_DRIVER: Cell<Option<DriverPtr>> = const { Cell::new(None) };
}

/// Run `f` with `driver` installed as the thread's ambient driver (the covered runner's
/// `execute_sql` transport resolves it). The previous ambient is restored on return / unwind, so
/// scopes nest. The consumer brackets each covered-op call with this (the driver argument the
/// op-agnostic leaves no longer take explicitly).
pub fn with_ambient_driver<R>(driver: &dyn Driver, f: impl FnOnce() -> R) -> R {
    // SAFETY: the raw pointer is installed ONLY for the span of `f` and cleared before this function
    // returns (the `Restore` guard runs on normal return AND on unwind), so it can never be
    // dereferenced after `driver`'s borrow ends. The lifetime is erased to `'static` to store it in
    // the thread-local; every read (`current_driver`) reborrows it with a shorter, call-scoped
    // lifetime bounded by this frame.
    let erased: *const (dyn Driver + 'static) =
        unsafe { std::mem::transmute::<*const dyn Driver, *const (dyn Driver + 'static)>(driver) };
    let prev = AMBIENT_DRIVER.with(|c| c.replace(Some(DriverPtr(erased))));

    struct Restore(Option<DriverPtr>);
    impl Drop for Restore {
        fn drop(&mut self) {
            AMBIENT_DRIVER.with(|c| c.set(self.0));
        }
    }
    let _restore = Restore(prev);
    f()
}

/// The current ambient driver, or a fail-closed [`BehaviorError`] if none is installed (the consumer
/// must bracket the op call with [`with_ambient_driver`]). The returned reference is bounded by the
/// caller's frame (SAFETY note on [`with_ambient_driver`]).
fn current_driver() -> Result<&'static dyn Driver, BehaviorError> {
    AMBIENT_DRIVER.with(|c| c.get()).map(|p| unsafe { &*p.0 }).ok_or_else(|| {
        BehaviorError::new(
            "NO_AMBIENT_DRIVER",
            "scp leaf: execute_sql called with no ambient driver — bracket the op with with_ambient_driver",
        )
    })
}

// ── Transaction scope for the covered plane (the CONSUMER's tx-boundary responsibility) ────────────
//
// The DB transaction boundary (BEGIN/COMMIT/ROLLBACK + atomicity) is litedbmodel's job, NOT a bc
// feature and NOT emitted into the generated runner — the covered runner just runs its body statements
// via `execute_sql` and returns `Result`. THIS wrapper brackets that runner in a transaction using the
// EXISTING tx primitives ([`Driver::begin_tx`] issues BEGIN; [`TxConnection::commit`]/[`rollback`] issue
// COMMIT/ROLLBACK on the owned connection) and the EXISTING ambient-driver mechanism
// ([`with_ambient_driver`]) — no new tx execution engine, no parallel exec path. Statement execution
// stays the ONE seam ([`execute_sql`] → [`exec_context`]); only the tx-control is added around it.

/// A [`Driver`] adapter over a tx's OWNED [`TxConnection`]: it forwards every prepared statement to the
/// pinned tx connection, so a covered runner's `execute_sql` (which resolves the ambient driver and runs
/// through the central seam) executes ON the transaction. Installed as the ambient driver for the span
/// of the tx body by [`with_ambient_transaction`]. `dialect` mirrors the underlying driver so
/// `execute_sql`'s `?`→`$N` placeholder render is unchanged.
struct TxDriver<'a> {
    tx: std::cell::RefCell<Box<dyn crate::exec_context::TxConnection + 'a>>,
    dialect: &'static str,
}

/// A [`PreparedStatement`] over the tx connection: `all`/`run` forward the (already placeholder-rendered)
/// SQL to the pinned tx connection ([`crate::exec_context::TxConnection`]). The tx connection is the ONE
/// connection the whole BEGIN…COMMIT runs on (the owned-connection contract).
struct TxPrepared<'a, 'd> {
    driver: &'d TxDriver<'a>,
    sql: String,
}

impl crate::driver::PreparedStatement for TxPrepared<'_, '_> {
    fn all(&mut self, params: &[Value]) -> Result<Vec<WireValue>, crate::errors::SqlFailure> {
        self.driver.tx.borrow_mut().execute(&self.sql, params)
    }
    fn run(
        &mut self,
        params: &[Value],
    ) -> Result<crate::driver::RunInfo, crate::errors::SqlFailure> {
        self.driver.tx.borrow_mut().run(&self.sql, params)
    }
}

impl Driver for TxDriver<'_> {
    fn dialect(&self) -> &'static str {
        self.dialect
    }
    fn prepare(&self, sql: &str) -> Box<dyn crate::driver::PreparedStatement + '_> {
        Box::new(TxPrepared {
            driver: self,
            sql: sql.to_string(),
        })
    }
    // A covered tx body never opens a NESTED transaction (the ambient IS the tx); fail closed rather
    // than silently begin a second BEGIN on the same connection.
    fn begin_tx(
        &self,
    ) -> Result<Box<dyn crate::exec_context::TxConnection + '_>, crate::errors::SqlFailure> {
        Err(nested_tx_unsupported())
    }
    fn acquire_tx(
        &self,
    ) -> Result<Box<dyn crate::exec_context::TxConnection + '_>, crate::errors::SqlFailure> {
        Err(nested_tx_unsupported())
    }
}

/// A tx-pinned driver has no nested-tx path (the ambient IS the open transaction) — fail closed.
fn nested_tx_unsupported() -> crate::errors::SqlFailure {
    crate::errors::SqlFailure {
        kind: "driver_error".into(),
        policy: "fail".into(),
        sqlite_code: None,
        message: "scp tx-scope: nested transaction on a tx-pinned driver is not supported".into(),
    }
}

/// Run `body` inside a transaction on `driver`, threading the tx connection as the ambient driver so a
/// covered runner's `execute_sql` executes on it: [`Driver::begin_tx`] (BEGIN) → run `body` under the
/// tx-pinned ambient → COMMIT on `Ok` / ROLLBACK on `Err` (the atomicity guarantee). A body error rolls
/// back and re-raises; a COMMIT that itself fails rolls back and surfaces the error. This is the covered
/// plane's tx boundary — the runtime owns it (the generated runner emits NO BEGIN/COMMIT).
pub fn with_ambient_transaction<R>(
    driver: &dyn Driver,
    body: impl FnOnce() -> Result<R, BehaviorError>,
) -> Result<R, BehaviorError> {
    let tx = driver.begin_tx().map_err(sql_failure_to_behavior_error)?; // BEGIN issued on the owned connection
    let tx_driver = TxDriver {
        tx: std::cell::RefCell::new(tx),
        dialect: driver.dialect(),
    };
    let result = with_ambient_driver(&tx_driver, body);
    let tx = tx_driver.tx.into_inner();
    match result {
        Ok(r) => tx
            .commit()
            .map(|_| r)
            .map_err(sql_failure_to_behavior_error),
        Err(e) => {
            let _ = tx.rollback(); // best-effort; surface the ORIGINAL body error
            Err(e)
        }
    }
}

// ── WireValue ↔ Value boundary codec (the ONLY place the two value models meet) ───────────────────

/// A BC-owned [`WireValue`] → bc [`Value`] for the SQL bind PARAMS ONLY (the driver's param binder
/// takes [`Value`]). A `Num` rides as raw text: an integral literal → [`Value::Int`] (the driver's
/// INTEGER model), else [`Value::Float`]. Read RESULTS never use this — they stay `WireValue`.
fn wire_to_value(w: &WireValue) -> Value {
    match w {
        WireValue::Str(s) => Value::Str(s.clone()),
        WireValue::Num(s) => {
            if let Ok(i) = s.parse::<i64>() {
                Value::Int(i)
            } else if let Ok(f) = s.parse::<f64>() {
                Value::Float(f)
            } else {
                Value::Str(s.clone())
            }
        }
        WireValue::Bool(b) => Value::Bool(*b),
        WireValue::Null => Value::Null,
        WireValue::Row(r) => Value::Obj(
            r.entries
                .iter()
                .map(|(k, v)| (k.clone(), wire_to_value(v)))
                .collect(),
        ),
        WireValue::List(l) => Value::Arr(l.items.iter().map(wire_to_value).collect()),
    }
}

/// Adapt a transport-level SQL failure to the shared [`BehaviorError`] the covered runner transports.
/// A SQL failure carries no de-box Error Value (that is the type-mismatch classifier's job), so
/// `detail` is `None`.
fn sql_failure_to_behavior_error(e: crate::errors::SqlFailure) -> BehaviorError {
    BehaviorError::new("SQL_FAILURE", e.message)
}

// ── Port unbox — the generic-wire payload → the leaf's declared ports ──────────────────────────────
//
// A leaf transport takes ONE generic `WireRow` payload whose fields ARE the node's ports (the covered
// runner assembles it by name; divergent port SETS across leaves are just different field lists, so
// ONE signature `<leaf>(payload: WireRow) -> Result<WireValue, BehaviorError>` serves every role).
// The transport OWNS the payload, so a port is MOVED out (`swap_remove`) — the large `rows` /
// `parents` / `children` lists transfer with NO clone. Unbox is FAIL-CLOSED: an absent or
// wrong-variant port is a loud failure, never a silent default (a port that is not there is an ABI
// break, not a data case).

/// Move port `name` OUT of the payload (no clone). Fail-closed: an absent port is a loud failure.
fn take_port(payload: &mut WireRow, name: &str) -> Result<WireValue, BehaviorError> {
    match payload.entries.iter().position(|(k, _)| k == name) {
        Some(i) => Ok(payload.entries.swap_remove(i).1),
        None => Err(BehaviorError::new(
            "LEAF_PORT",
            format!("scp leaf: port `{name}` is absent from the payload"),
        )),
    }
}

/// The fail-closed wrong-variant failure. The ACTUAL wire tag is read off the BC-owned probe
/// classifier ([`WireValue::as_string`]'s `actual_wire_type`), so the tag rendering stays bc's.
fn port_mismatch(name: &str, expected: &str, got: &WireValue) -> BehaviorError {
    let actual = match got.as_string() {
        Probe::Got(_) => "S".to_string(),
        Probe::Wrong {
            actual_wire_type, ..
        }
        | Probe::Null {
            actual_wire_type, ..
        } => actual_wire_type,
        Probe::Absent => "ABSENT".to_string(),
    };
    BehaviorError::new(
        "LEAF_PORT",
        format!("scp leaf: port `{name}` expected a wire {expected}, got {actual}"),
    )
}

/// A `bool` port (`write` / `returning` / `bigint` / `single`).
fn port_bool(payload: &mut WireRow, name: &str) -> Result<bool, BehaviorError> {
    match take_port(payload, name)? {
        WireValue::Bool(b) => Ok(b),
        other => Err(port_mismatch(name, "bool", &other)),
    }
}

/// A `string` port (`sql` / `into`).
fn port_string(payload: &mut WireRow, name: &str) -> Result<String, BehaviorError> {
    match take_port(payload, name)? {
        WireValue::Str(s) => Ok(s),
        other => Err(port_mismatch(name, "string", &other)),
    }
}

/// A list port (`params` / `rows` / `parents` / `children`), MOVED out as the transport's own `Vec`.
fn port_list(payload: &mut WireRow, name: &str) -> Result<Vec<WireValue>, BehaviorError> {
    match take_port(payload, name)? {
        WireValue::List(l) => Ok(l.items),
        other => Err(port_mismatch(name, "list", &other)),
    }
}

/// The unboxed `guard` port: the relation runaway cap the emitter baked onto a guarded relation child
/// fetch, plus the identity the raised error reports (the Rust twin of the litedbmodel `RelationGuard`
/// record). `model` is optional exactly as [`crate::errors::LimitExceededError::model`] is.
struct RelationGuard {
    limit: i64,
    model: Option<String>,
    relation: String,
}

/// Read the OPTIONAL `guard` port. ABSENT (or an explicit null) ⇒ `None` ⇒ the statement is uncapped
/// and NO check runs. PRESENT but malformed is a LOUD port failure, never a silently dropped guard — a
/// guard that fails to unbox is a runaway that would otherwise sail through.
fn port_relation_guard(payload: &mut WireRow) -> Result<Option<RelationGuard>, BehaviorError> {
    let row = match payload.entries.iter().position(|(k, _)| k == "guard") {
        None => return Ok(None),
        Some(i) => match payload.entries.swap_remove(i).1 {
            WireValue::Null => return Ok(None),
            WireValue::Row(r) => r,
            other => return Err(port_mismatch("guard", "row", &other)),
        },
    };
    let field = |name: &str| row.entries.iter().find(|(k, _)| k == name).map(|(_, v)| v);
    let limit = match field("limit") {
        Some(WireValue::Num(n)) => n.parse::<i64>().map_err(|_| {
            BehaviorError::new(
                "LEAF_PORT",
                format!("scp leaf: port `guard.limit` is not an integer row cap: {n}"),
            )
        })?,
        Some(other) => return Err(port_mismatch("guard.limit", "number", other)),
        None => return Err(port_mismatch("guard.limit", "number", &WireValue::Null)),
    };
    let relation = match field("relation") {
        Some(WireValue::Str(s)) => s.clone(),
        Some(other) => return Err(port_mismatch("guard.relation", "string", other)),
        None => return Err(port_mismatch("guard.relation", "string", &WireValue::Null)),
    };
    let model = match field("model") {
        Some(WireValue::Str(s)) => Some(s.clone()),
        _ => None,
    };
    Ok(Some(RelationGuard {
        limit,
        model,
        relation,
    }))
}

/// A `{arr:'string'}` port — the ordered key-column TUPLE (`col` / `pk` / `fk`). Every element must be
/// a wire string (a key column NAME); anything else is an ABI break, not a data case.
fn port_strings(payload: &mut WireRow, name: &str) -> Result<Vec<String>, BehaviorError> {
    port_list(payload, name)?
        .into_iter()
        .map(|c| match c {
            WireValue::Str(s) => Ok(s),
            other => Err(port_mismatch(name, "string element", &other)),
        })
        .collect()
}

// ── execute_sql — the SOLE op-independent SQL transport ────────────────────────────────────────────

/// The SOLE SQL transport leaf (leaves.ts `executeSQL`). Binds `params` and runs `sql` through the
/// central seam ([`exec_context::execute`] / [`exec_context::run`]) on the AMBIENT driver — the ONLY
/// driver contact. `write` selects `run` (INSERT/UPDATE/DELETE) vs `execute` (SELECT / RETURNING); a
/// non-returning write returns a one-row `[{changes,lastInsertRowid}]` summary so the leaf output
/// shape is uniform (a `List` of `Row`). `?`→`$N` is rendered here (the transport's placeholder SSoT,
/// matching the TS `prepareSql`); an array param (a relation key set) rides as [`Value::Arr`], which
/// the driver encodes per dialect (json_each / native array). The OPTIONAL `guard` port is the
/// RELATION runaway cap of a guarded relation child fetch: the raw rows are asserted against it here
/// ([`crate::errors::LimitExceededError::check`]) because past [`group_children`] the graph is already
/// nested. Ports ride in the payload as `{bigint, guard?, params, returning, sql, write}`.
pub fn execute_sql(mut payload: WireRow) -> Result<WireValue, BehaviorError> {
    let bigint = port_bool(&mut payload, "bigint")?;
    let params_port = port_list(&mut payload, "params")?;
    let returning = port_bool(&mut payload, "returning")?;
    let sql_port = port_string(&mut payload, "sql")?;
    let write = port_bool(&mut payload, "write")?;
    let guard = port_relation_guard(&mut payload)?;
    let (params, sql): (&[WireValue], &str) = (&params_port, &sql_port);
    // `bigint` is the better-sqlite3 #59 safe-integers toggle; rust/PG/MySQL return BIGINT natively
    // (i64), so there is no exact-integer read mode to select (see exec_context docs) — the port is
    // accepted for signature parity with the TS leaf and does not branch the rust seam.
    let _ = bigint;
    let driver = current_driver()?;
    let rendered = render_placeholders(sql, driver.dialect());
    // A composite relation key set (a list whose elements are key TUPLES) binds as ONE JSON
    // array-of-tuples string on EVERY dialect (#159) — PostgreSQL expands it server-side with
    // `json_array_elements`, and its native array binder would otherwise hand the server an
    // `int[][]` no cast can turn into json. Every other array is a list of SCALAR cells: PostgreSQL
    // binds it natively (`= ANY($1)`) and the MySQL / SQLite binders already JSON-encode it. Same
    // rule as TS `leaves.encodeParams`.
    let value_params: Vec<Value> = params
        .iter()
        .map(|p| {
            let v = wire_to_value(p);
            match &v {
                Value::Arr(items) if matches!(items.first(), Some(Value::Arr(_))) => {
                    Value::Str(crate::value_codec::array_param_json(items, false))
                }
                _ => v,
            }
        })
        .collect();
    let ctx = exec_context::for_driver(driver);
    if write && !returning {
        let info = exec_context::run(&ctx, &rendered, &value_params, &StatementIntent::write())
            .map_err(sql_failure_to_behavior_error)?;
        // The affected-write summary row (uniform `items` output shape — TS `writeSummary`).
        Ok(WireValue::List(WireList {
            items: vec![WireValue::Row(WireRow {
                entries: vec![
                    ("changes".to_string(), WireValue::int(info.changes)),
                    (
                        "lastInsertRowid".to_string(),
                        WireValue::int(info.last_insert_rowid),
                    ),
                ],
            })],
        }))
    } else {
        // The driver materialized the rows DIRECTLY as `WireValue` (one pass) — return them verbatim
        // as the leaf's `List` output. NO second per-cell pass (the retired `value_to_wire` map): the
        // read path never boxes into bc's `Value`.
        let rows = exec_context::execute(&ctx, &rendered, &value_params, &StatementIntent::read())
            .map_err(sql_failure_to_behavior_error)?;
        // The RELATION runaway guard, on the RAW child rows — the only point they are visible (past
        // `group_children` the graph is already nested) and the reason the cap rides on this transport.
        // The comparison + the byte-identical message come from the shared
        // [`crate::errors::LimitExceededError::check`] SSoT, so this path cannot drift from the TS
        // reference. It surfaces as a `BehaviorError` because that is the leaf transport's ONE error
        // channel (the same way a `SqlFailure` does), under its own stable code.
        if let Some(g) = guard {
            crate::errors::LimitExceededError::check(
                g.limit,
                rows.len() as i64,
                crate::errors::LIMIT_CONTEXT_RELATION,
                g.model,
                Some(g.relation),
            )
            .map_err(|e| BehaviorError::new("LIMIT_EXCEEDED", e.message))?;
        }
        Ok(WireValue::List(WireList { items: rows }))
    }
}

// ── pluck_keys — rows + column → the deduped key array (the `= ANY($1)` batch key set) ──────────────

/// Extract the deduped, non-null key array from `rows[col]` — the batch key set a relation child
/// fetch binds to `WHERE fk = ANY($1)` / `json_each(?)`. Insertion order preserved; a null/absent key
/// is dropped (no partial keys). Dedupe is the shared grouping core ([`crate::grouping::dedupe_key_tuples`])
/// — the SAME SSoT the runtime relation path uses (no duplicated grouping). `col` is the ordered
/// parent-key column TUPLE (single-key → 1 column; composite → the tuple): single-key emits a flat
/// scalar key array (`json_each` scalar `value`), composite emits an array-of-tuples (`json_each`
/// per-ordinal `$[i]`) — the SAME shape `relation.ts bindKeys` produces for the MySQL/SQLite JSON
/// param. Ports ride in the payload as `{col, rows}`.
pub fn pluck_keys(mut payload: WireRow) -> Result<WireValue, BehaviorError> {
    let col_port = port_strings(&mut payload, "col")?;
    let rows_port = port_list(&mut payload, "rows")?;
    let (col, rows): (&[String], &[WireValue]) = (&col_port, &rows_port);
    // The grouping core keys DIRECTLY on `WireValue` — no `WireValue`→`Value` conversion (the read path
    // never boxes into bc's `Value`). `col` is the ordered key-column tuple (an owned `Vec<String>`).
    let tuples = crate::grouping::dedupe_key_tuples(rows, col);
    let keys: Vec<WireValue> = if col.len() == 1 {
        tuples.into_iter().map(|mut t| t.remove(0)).collect()
    } else {
        tuples
            .into_iter()
            .map(|t| WireValue::List(WireList { items: t }))
            .collect()
    };
    Ok(WireValue::List(WireList { items: keys }))
}

// ── group_children — parents + flat children → each parent with its children nested ────────────────

/// Distribute a flat `children` list onto `parents` by matching `child[fk]` to `parent[pk]`, nesting
/// the result under `into`. `single == true` (belongsTo/hasOne) nests the one matching child (or
/// null); otherwise (hasMany) nests the child list (`[]` when none). Grouping is the shared core
/// ([`crate::grouping::group_by_key`] / [`crate::grouping::attach_to_parent`]) — the SAME SSoT the
/// runtime relation path uses (no duplicated grouping). `pk`/`fk` are the ordered parent/child key-
/// column TUPLES (single-key → 1 column; composite → the tuple) — the core keys on the WHOLE tuple
/// identity, so a composite relation nests by the full key (no scalar-collapse cartesian). Each parent
/// is shallow-copied before the own-key set (matching the TS `{...par, [into]: …}` spread — the input
/// is not mutated). Ports ride in the payload as `{children, fk, into, parents, pk, single}`.
pub fn group_children(mut payload: WireRow) -> Result<WireValue, BehaviorError> {
    let children_port = port_list(&mut payload, "children")?;
    let fk_port = port_strings(&mut payload, "fk")?;
    let into_port = port_string(&mut payload, "into")?;
    let parents_port = port_list(&mut payload, "parents")?;
    let pk_port = port_strings(&mut payload, "pk")?;
    let single = port_bool(&mut payload, "single")?;
    let (children, fk, into, parents, pk): (
        &[WireValue],
        &[String],
        &str,
        &[WireValue],
        &[String],
    ) = (
        &children_port,
        &fk_port,
        &into_port,
        &parents_port,
        &pk_port,
    );
    // The grouping core keys DIRECTLY on `WireValue` (no `WireValue`↔`Value` conversion). The buckets
    // hold REFERENCES into `children` — no per-child clone; a matched child is cloned exactly once, when
    // `attach_to_parent` nests it into a parent's output.
    let by_key = crate::grouping::group_by_key(children, fk);
    // Resolve the parent `pk` indices + the `into` insert position ONCE (all parents share column
    // order) — the per-parent path then carries NO index scan, even when `parents` is a large nested
    // relation level (a 3-level chain groups the middle level as parents too).
    let pk_idx = crate::grouping::resolve_key_indices(parents, pk);
    let into_pos = parents.iter().find_map(|p| match p {
        WireValue::Row(r) => r.entries.iter().position(|(k, _)| k == into),
        _ => None,
    });
    let out: Vec<WireValue> = parents
        .iter()
        .map(|p| {
            let nested = crate::grouping::attach_to_parent(p, pk, &pk_idx, &by_key, single);
            match p {
                // {...p, [into]: nested}: shallow-copy the parent's entries, then set an existing `into`
                // in place (keeps its position) or append a new one — the TS `{...par, [into]: …}` spread.
                WireValue::Row(r) => {
                    let mut entries = r.entries.clone();
                    match into_pos {
                        Some(i) if entries.get(i).is_some_and(|(k, _)| k == into) => {
                            entries[i].1 = nested
                        }
                        _ => entries.push((into.to_string(), nested)),
                    }
                    WireValue::Row(WireRow { entries })
                }
                // Records are rows by contract (SQL rows); a non-row passes through untouched.
                _ => p.clone(),
            }
        })
        .collect();
    Ok(WireValue::List(WireList { items: out }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrow(pairs: &[(&str, WireValue)]) -> WireValue {
        WireValue::Row(WireRow {
            entries: pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        })
    }
    fn items(w: &WireValue) -> Vec<WireValue> {
        match w {
            WireValue::List(l) => l.items.clone(),
            _ => panic!("not a list"),
        }
    }
    // The generic-wire PAYLOAD a covered runner hands a leaf: the node's ports as named fields.
    fn payload(ports: Vec<(&str, WireValue)>) -> WireRow {
        WireRow {
            entries: ports.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
        }
    }
    fn wlist(items: Vec<WireValue>) -> WireValue {
        WireValue::List(WireList { items })
    }
    // A key-column tuple port (`col`/`pk`/`fk`) — the ordered column names as wire strings.
    fn cols(c: &[&str]) -> WireValue {
        wlist(c.iter().map(|s| WireValue::Str((*s).to_string())).collect())
    }

    // ── with_ambient_transaction atomicity (#142): Ok → COMMIT (all rows persist), Err → ROLLBACK
    //    (NO rows persist). Proves the tx boundary the covered runner relies on is genuinely atomic. ──
    #[test]
    fn tx_commits_on_ok_and_rolls_back_on_err() {
        use crate::driver::SqliteDriver;
        let d = SqliteDriver::in_memory(&[
            "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)".to_string()
        ])
        .unwrap();
        let ins = |id: i64, v: &str| -> Result<(), BehaviorError> {
            execute_sql(payload(vec![
                ("bigint", WireValue::Bool(false)),
                (
                    "params",
                    wlist(vec![WireValue::int(id), WireValue::Str(v.to_string())]),
                ),
                ("returning", WireValue::Bool(false)),
                (
                    "sql",
                    WireValue::Str("INSERT INTO t (id, v) VALUES (?, ?)".to_string()),
                ),
                ("write", WireValue::Bool(true)),
            ]))
            .map(|_| ())
        };
        let row_count = |d: &SqliteDriver| -> i64 {
            let rows = d.prepare("SELECT COUNT(*) AS c FROM t").all(&[]).unwrap();
            // The driver materializes rows DIRECTLY as `WireValue::Row`; the COUNT cell is a `Num` (raw
            // decimal text). Match the wire shape (WireValue derives no Debug — assert structurally).
            match &rows[0] {
                WireValue::Row(r) => match r.entries.iter().find(|(k, _)| k == "c").map(|(_, v)| v)
                {
                    Some(WireValue::Num(n)) => n.parse().expect("count cell is an integer"),
                    _ => panic!("unexpected count cell"),
                },
                _ => panic!("unexpected count row"),
            }
        };

        // Ok body: two inserts on the tx connection → COMMIT → both rows persist.
        with_ambient_transaction(&d, || {
            ins(1, "a")?;
            ins(2, "b")?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            row_count(&d),
            2,
            "a committed tx must persist all its writes"
        );

        // Err body: insert row 3 then fail mid-tx → ROLLBACK → row 3 must NOT persist (still 2 rows).
        let outcome: Result<(), BehaviorError> = with_ambient_transaction(&d, || {
            ins(3, "c")?; // this write is issued inside the tx…
            Err(BehaviorError::new("BOOM", "mid-tx failure")) // …then the body errors → rollback
        });
        assert!(outcome.is_err(), "the body error must propagate");
        assert_eq!(
            row_count(&d),
            2,
            "a rolled-back tx must leave NO rows committed (row 3 gone)"
        );
    }

    // Single-key pluck emits a FLAT scalar key array (json_each scalar `value`).
    #[test]
    fn pluck_single_key_is_flat_scalars() {
        let rows = vec![
            wrow(&[("id", WireValue::int(2))]),
            wrow(&[("id", WireValue::int(1))]),
            wrow(&[("id", WireValue::int(2))]),
        ];
        let out = pluck_keys(payload(vec![("col", cols(&["id"])), ("rows", wlist(rows))])).unwrap();
        let ks = items(&out);
        assert_eq!(ks.len(), 2); // deduped, order preserved
        assert!(matches!(&ks[0], WireValue::Num(n) if n == "2"));
        assert!(!matches!(&ks[0], WireValue::List(_))); // scalar, NOT a 1-tuple
    }

    // Composite pluck emits an array-of-TUPLES (json_each per-ordinal `$[i]`).
    #[test]
    fn pluck_composite_key_is_tuples() {
        let rows = vec![
            wrow(&[
                ("tenant_id", WireValue::int(1)),
                ("user_id", WireValue::int(9)),
            ]),
            wrow(&[
                ("tenant_id", WireValue::int(1)),
                ("user_id", WireValue::int(9)),
            ]), // dup tuple
            wrow(&[
                ("tenant_id", WireValue::int(1)),
                ("user_id", WireValue::int(8)),
            ]),
        ];
        let out = pluck_keys(payload(vec![
            ("col", cols(&["tenant_id", "user_id"])),
            ("rows", wlist(rows)),
        ]))
        .unwrap();
        let ks = items(&out);
        assert_eq!(ks.len(), 2); // deduped on the whole tuple
        assert_eq!(items(&ks[0]).len(), 2); // each key is a 2-element tuple
    }

    // group_children keyed on a COMPOSITE tuple nests by the FULL key — NOT a cartesian cross. A parent
    // (t=1,u=9) must receive only its (t=1,u=9) child, never the (t=1,u=8) one (which a `''`-collapse or
    // first-column-only key would wrongly attach).
    #[test]
    fn group_composite_is_not_cartesian() {
        let parents = vec![
            wrow(&[
                ("tenant_id", WireValue::int(1)),
                ("user_id", WireValue::int(9)),
            ]),
            wrow(&[
                ("tenant_id", WireValue::int(1)),
                ("user_id", WireValue::int(8)),
            ]),
        ];
        let children = vec![
            wrow(&[
                ("tenant_id", WireValue::int(1)),
                ("user_id", WireValue::int(9)),
                ("title", WireValue::Str("p9".into())),
            ]),
            wrow(&[
                ("tenant_id", WireValue::int(1)),
                ("user_id", WireValue::int(8)),
                ("title", WireValue::Str("p8".into())),
            ]),
        ];
        let out = group_children(payload(vec![
            ("children", wlist(children)),
            ("fk", cols(&["tenant_id", "user_id"])),
            ("into", WireValue::Str("posts".to_string())),
            ("parents", wlist(parents)),
            ("pk", cols(&["tenant_id", "user_id"])),
            ("single", WireValue::Bool(false)),
        ]))
        .unwrap();
        let ps = items(&out);
        for p in &ps {
            let posts = match p {
                WireValue::Row(r) => r
                    .entries
                    .iter()
                    .find(|(k, _)| k == "posts")
                    .map(|(_, v)| v.clone())
                    .unwrap(),
                _ => panic!(),
            };
            // each parent nests EXACTLY its own one matching post (cartesian would nest both).
            assert_eq!(
                items(&posts).len(),
                1,
                "composite grouping must not be cartesian"
            );
        }
    }

    // The RELATION runaway guard (#160), on the RAW child rows of a guarded relation child fetch: over
    // the cap ⇒ a LOUD failure carrying the byte-identical `LimitExceededError` message and the EXACT
    // batch count; within the cap ⇒ the rows, unchanged; NO guard port ⇒ never checked (the
    // byte-unchanged uncapped path). The rust leg of "the same behaviour in all five languages" — the
    // twin of the go `TestExecuteSQL_RelationGuardOnRawChildRows` and the TS conformance guard vectors,
    // proven against a real in-memory sqlite rather than by inspection.
    #[test]
    fn relation_guard_trips_on_the_raw_child_rows() {
        use crate::driver::SqliteDriver;
        let d = SqliteDriver::in_memory(&[
            "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)".to_string(),
            "INSERT INTO t (id, v) VALUES (1,'a'), (2,'b'), (3,'c')".to_string(),
        ])
        .unwrap();
        let read = |guard: Option<WireValue>| -> Result<WireValue, BehaviorError> {
            let mut ports = vec![
                ("bigint", WireValue::Bool(false)),
                ("params", wlist(vec![])),
                ("returning", WireValue::Bool(false)),
                (
                    "sql",
                    WireValue::Str("SELECT id, v FROM t ORDER BY id".to_string()),
                ),
                ("write", WireValue::Bool(false)),
            ];
            if let Some(g) = guard {
                ports.push(("guard", g));
            }
            with_ambient_driver(&d, || execute_sql(payload(ports.clone())))
        };
        let cap = |limit: i64| {
            wrow(&[
                ("limit", WireValue::int(limit)),
                ("model", WireValue::Str("t".to_string())),
                ("relation", WireValue::Str("things".to_string())),
            ])
        };

        // 3 rows > cap 2 ⇒ the transport fails before the rows are handed on.
        let e = match read(Some(cap(2))) {
            Err(e) => e,
            Ok(_) => panic!("a relation batch over its cap must fail"),
        };
        assert_eq!(e.code, "LIMIT_EXCEEDED");
        assert_eq!(
            e.message,
            "Query limit exceeded: relation 'things' on t returned 3 records, but limit is 2. \
             This usually indicates a missing WHERE clause or an N+1 query pattern. Set a higher \
             limit or use pagination."
        );

        // 3 rows ≤ cap 3 ⇒ no failure, and the rows come back untouched.
        match read(Some(cap(3))) {
            Ok(out) => assert_eq!(
                items(&out).len(),
                3,
                "a batch within its cap returns its rows"
            ),
            Err(e) => panic!("a batch within its cap must pass: {}", e.message),
        }

        // No guard port at all ⇒ never checked (the uncapped statement is byte-unchanged).
        assert!(read(None).is_ok(), "an uncapped read must not be guarded");
    }

    // Port unbox is FAIL-CLOSED: an ABSENT port and a WRONG-VARIANT port both surface a loud
    // `LEAF_PORT` failure (never a silent default) — a port that is missing or mistyped is an ABI
    // break, and a default would corrupt the result rather than stop it.
    #[test]
    fn port_unbox_is_fail_closed() {
        // WireValue derives no Debug — take the failure structurally rather than via unwrap_err.
        fn failure(r: Result<WireValue, BehaviorError>) -> BehaviorError {
            match r {
                Err(e) => e,
                Ok(_) => panic!("a bad port must FAIL, not produce a result"),
            }
        }

        // absent `rows`
        let e = failure(pluck_keys(payload(vec![("col", cols(&["id"]))])));
        assert_eq!(e.code, "LEAF_PORT");
        assert!(
            e.message.contains("`rows`") && e.message.contains("absent"),
            "{}",
            e.message
        );

        // `rows` present but a NUMBER, not a list — the failure names the actual wire tag.
        let e = failure(pluck_keys(payload(vec![
            ("col", cols(&["id"])),
            ("rows", WireValue::int(7)),
        ])));
        assert_eq!(e.code, "LEAF_PORT");
        assert!(
            e.message.contains("`rows`") && e.message.contains("got N"),
            "{}",
            e.message
        );

        // a key-column tuple whose element is not a column NAME.
        let e = failure(pluck_keys(payload(vec![
            ("col", wlist(vec![WireValue::int(1)])),
            ("rows", wlist(vec![])),
        ])));
        assert_eq!(e.code, "LEAF_PORT");
        assert!(
            e.message.contains("`col`") && e.message.contains("string element"),
            "{}",
            e.message
        );
    }
}
