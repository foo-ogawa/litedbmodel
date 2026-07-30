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
//! ## Ambient execution context — the leaves are free functions, the CONTEXT is scoped
//!
//! The covered runner (the generated `<method>()` entry) takes NO context argument — it calls the leaf
//! transport symbols as free functions with ONE generic `WireRow` payload each (the node's ports as
//! named fields). `execute_sql` resolves the [`ExecutionContext`] from a thread-scoped ambient set by
//! [`with_ambient_context`] (the consumer brackets each op call). The ambient is the CONTEXT, not a
//! bare [`Driver`](crate::driver::Driver): the ctx is what carries the connection ROUTING (reader/writer split, named DB,
//! writer-sticky), so this — the only path a bc typed-native module reaches a connection by — is where
//! a routed consumer configuration has to arrive. Synthesizing the ctx inside the leaf instead
//! (`exec_context::for_driver`, whose `routing` is `None`) left every routed setup inert (#214). This
//! is the rust analogue of the TS `LeafContext.exec` bc injects at `bindBehaviors` time (C4 — never on
//! the IR).

use std::cell::Cell;

use behavior_contracts::Value;

use crate::exec_context::{self, ExecutionContext, StatementIntent, TxDecision};
use crate::sql_render::finalize_sql;
use crate::wire::{BehaviorError, Probe, WireList, WireRow, WireValue};

// ── Ambient execution context (thread-scoped) ────────────────────────────────────────────────────

/// A type-erased pointer to the ambient [`ExecutionContext`]. Set only for the duration of a
/// [`with_ambient_context`] scope (which brackets the whole covered-op call), then restored — so the
/// pointer never outlives the borrow it was made from.
#[derive(Clone, Copy)]
struct CtxPtr(*const ExecutionContext<'static, 'static>);

thread_local! {
    static AMBIENT_CTX: Cell<Option<CtxPtr>> = const { Cell::new(None) };
}

/// Run `f` with `ctx` installed as the thread's ambient [`ExecutionContext`] (the covered runner's
/// `execute_sql` transport resolves it). The previous ambient is restored on return / unwind, so
/// scopes nest. The consumer brackets each covered-op call with this (the context argument the
/// op-agnostic leaves no longer take explicitly) — and because it is the CONTEXT that is installed, a
/// routed one ([`exec_context::for_routing`]) carries its reader/writer split, named-DB registry and
/// writer-sticky clock all the way into the leaf's `connection_for` resolution.
pub fn with_ambient_context<R>(ctx: &ExecutionContext, f: impl FnOnce() -> R) -> R {
    // SAFETY: the raw pointer is installed ONLY for the span of `f` and cleared before this function
    // returns (the `Restore` guard runs on normal return AND on unwind), so it can never be
    // dereferenced after `ctx`'s borrow ends. The lifetimes are erased to `'static` to store it in
    // the thread-local; every read (`current_context`) reborrows it with a shorter, call-scoped
    // lifetime bounded by this frame.
    let erased = std::ptr::from_ref(ctx).cast::<ExecutionContext<'static, 'static>>();
    let prev = AMBIENT_CTX.with(|c| c.replace(Some(CtxPtr(erased))));

    struct Restore(Option<CtxPtr>);
    impl Drop for Restore {
        fn drop(&mut self) {
            AMBIENT_CTX.with(|c| c.set(self.0));
        }
    }
    let _restore = Restore(prev);
    f()
}

/// The current ambient [`ExecutionContext`], or a fail-closed [`BehaviorError`] if none is installed
/// (the consumer must bracket the op call with [`with_ambient_context`]). The returned reference is
/// bounded by the caller's frame (SAFETY note on [`with_ambient_context`]).
fn current_context() -> Result<&'static ExecutionContext<'static, 'static>, BehaviorError> {
    AMBIENT_CTX.with(|c| c.get()).map(|p| unsafe { &*p.0 }).ok_or_else(|| {
        BehaviorError::new(
            "NO_AMBIENT_CONTEXT",
            "scp leaf: execute_sql called with no ambient execution context — bracket the op with with_ambient_context",
        )
    })
}

// ── Transaction scope for the covered plane (the CONSUMER's tx-boundary responsibility) ────────────
//
// The DB transaction boundary (BEGIN/COMMIT/ROLLBACK + atomicity) is litedbmodel's job, NOT a bc
// feature and NOT emitted into the generated runner — the covered runner just runs its body statements
// via `execute_sql` and returns `Result`. THIS wrapper brackets that runner in the runtime's ONE
// transaction ([`exec_context::with_transaction_decided`]) and swaps the ambient for the tx-scoped ctx
// that boundary derives — no second tx engine, no parallel exec path. Statement execution stays the
// ONE seam ([`execute_sql`] → [`exec_context`]); this only decides WHERE the body runs.

/// Run `body` inside a transaction on `ctx`, with the tx-scoped ctx installed as the ambient so a
/// covered runner's `execute_sql` executes ON the transaction: `Ok` ⇒ COMMIT, `Err` ⇒ ROLLBACK + the
/// body error re-raised (the atomicity guarantee). This is the covered plane's tx boundary — the
/// runtime owns it (the generated runner emits NO BEGIN/COMMIT).
///
/// The transaction itself is the CENTRAL one ([`exec_context::with_transaction_decided`], the same
/// mechanism the public [`exec_context::transaction`] boundary drives), so the covered plane gets what
/// running its own BEGIN/COMMIT never did: the owned connection is acquired from the ctx's WRITER pool
/// ([`ExecutionContext::tx_driver`] → `acquire_tx`), the tx-control is issued THROUGH the seam (a
/// registered middleware OBSERVES the BEGIN/COMMIT/ROLLBACK), the connection is released — destroyed
/// when poisoned — and a successful COMMIT arms the writer-sticky clock, so reads after a covered tx
/// route to the writer (read-your-writes). Duplicating any of that here is what #215 removed.
///
/// The body's failure is a [`BehaviorError`] and the boundary transports [`SqlFailure`], so a body
/// error rides out as the boundary's non-error [`TxDecision::Rollback`] value: the ROLLBACK is
/// seam-issued exactly as an `Err` would issue it and nothing commits. The ORIGINAL error is what
/// surfaces — ALWAYS, and that is why it is also held HERE: the boundary DISCARDS a `Rollback` value
/// when the seam-issued ROLLBACK itself fails (right for the gate short-circuit that arm was written
/// for, where that failure is the only error there is), which would otherwise let a broken connection
/// MASK the failure the covered plane must re-raise. go returns `bodyErr` whatever its ROLLBACK did
/// (`exec_context.go:676-683`) and the TS rethrows the caught `error` (`exec-context.ts:594-601`); the
/// covered plane says the same thing in all three. A failure of the tx-control itself (BEGIN / COMMIT /
/// ROLLBACK) with NO body error arrives as a `SqlFailure` and is mapped to the leaf transport's one
/// error channel.
pub fn with_ambient_transaction<R>(
    ctx: &ExecutionContext,
    body: impl FnOnce() -> Result<R, BehaviorError>,
) -> Result<R, BehaviorError> {
    let mut rolled_back_for: Option<BehaviorError> = None;
    let outcome = exec_context::with_transaction_decided(ctx, |tx_ctx| {
        // The tx-scoped ctx is the ambient: `connection_for` resolves its pinned owned connection
        // (STEP 1) for every statement the body issues through `execute_sql` that belongs to the tx's own
        // database — one naming a DIFFERENT database is rejected rather than run on the pin.
        Ok(match with_ambient_context(tx_ctx, body) {
            Ok(r) => TxDecision::Commit(Ok(r)),
            Err(e) => {
                rolled_back_for = Some(e.clone());
                TxDecision::Rollback(Err(e))
            }
        })
    });
    match outcome {
        Ok(body_result) => body_result,
        // The tx-control failed. If it was the ROLLBACK of a FAILED body, the body's error is the truth.
        Err(e) => Err(rolled_back_for.unwrap_or_else(|| sql_failure_to_behavior_error(e))),
    }
}

// ── WireValue ↔ Value boundary codec (the ONLY place the two value models meet) ───────────────────

/// A BC-owned [`WireValue`] → bc [`Value`] for the SQL bind PARAMS ONLY (the driver's param binder
/// takes [`Value`]). The wire carries a number natively, so an `Int` maps to the driver's INTEGER model
/// and a `Float` to its REAL model with nothing parsed. Read RESULTS never use this — they stay
/// `WireValue`.
fn wire_to_value(w: &WireValue) -> Value {
    match w {
        WireValue::Str(s) => Value::Str(s.to_string()),
        WireValue::Int(i) => Value::Int(*i),
        WireValue::Float(f) => Value::Float(*f),
        WireValue::Bool(b) => Value::Bool(*b),
        WireValue::Null => Value::Null,
        WireValue::Row(r) => Value::Obj(
            r.entries
                .iter()
                .map(|(k, v)| (k.to_string(), wire_to_value(v)))
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

/// The fail-closed ABSENT failure — the ONE place "this key is not there" is spelled, for every port and
/// every nested field (the twin of [`port_mismatch`], which spells the wrong-variant half).
fn port_absent(name: &str) -> BehaviorError {
    BehaviorError::new(
        "LEAF_PORT",
        format!("scp leaf: port `{name}` is absent from the payload"),
    )
}

/// Move field `key` OUT of `payload` (no clone), reporting an absence as `at`. Fail-closed: an absent
/// port is a loud failure. `at` is what the failure NAMES — the same as `key` for a top-level port, and
/// the QUALIFIED path (`whereDynamic.tail`) for a field of a nested struct, which would otherwise not
/// say where the ABI break is.
fn take_port_as(payload: &mut WireRow, key: &str, at: &str) -> Result<WireValue, BehaviorError> {
    match payload.entries.iter().position(|(k, _)| k == key) {
        Some(i) => Ok(payload.entries.swap_remove(i).1),
        None => Err(port_absent(at)),
    }
}

/// Move a TOP-LEVEL port OUT of the payload — [`take_port_as`] where the port names itself.
fn take_port(payload: &mut WireRow, name: &str) -> Result<WireValue, BehaviorError> {
    take_port_as(payload, name, name)
}

/// The fail-closed wrong-variant failure. The ACTUAL wire tag is read off the BC-owned probe
/// classifier (`probe_string_at`'s `actual_wire_type`), so the tag rendering stays bc's. The probe
/// consumes its value, so the error path clones — errors are not the hot path.
fn port_mismatch(name: &str, expected: &str, got: &WireValue) -> BehaviorError {
    let actual = match crate::wire::probe_string_at(Some(got.clone())) {
        Probe::Got(_) => "S".to_string(),
        Probe::Wrong {
            actual_wire_type, ..
        }
        | Probe::Null {
            actual_wire_type, ..
        } => actual_wire_type.to_string(),
        Probe::Absent => "ABSENT".to_string(),
    };
    BehaviorError::new(
        "LEAF_PORT",
        format!("scp leaf: port `{name}` expected a wire {expected}, got {actual}"),
    )
}

/// A `bool` port (the control record's `write` / `returning`, or `group_children`'s `single`).
fn port_bool(payload: &mut WireRow, name: &str) -> Result<bool, BehaviorError> {
    match take_port(payload, name)? {
        WireValue::Bool(b) => Ok(b),
        other => Err(port_mismatch(name, "bool", &other)),
    }
}

/// A `string` port (`sql` / `into`).
fn port_string(payload: &mut WireRow, name: &str) -> Result<String, BehaviorError> {
    match take_port(payload, name)? {
        WireValue::Str(s) => Ok(s.into_owned()),
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

/// Take a NULLABLE STRUCT field out of a struct that IS present. A wire `Null` is the declared ABSENCE
/// (no cap / no plan / a read); an ABSENT KEY is an ABI BREAK, and the two must not collapse: bc types
/// a port by the literal wired into it and REJECTS a partial struct, so a generated module ALWAYS
/// spells every field (`null` is how absence is spelled). A key that is not there did not come from
/// one, and reading it as null would silently drop a relation cap, erase a SKIP predicate, or run a
/// write as a read (#205).
fn take_opt_row(row: &mut WireRow, name: &str) -> Result<Option<WireRow>, BehaviorError> {
    match take_port(row, name)? {
        WireValue::Null => Ok(None),
        WireValue::Row(r) => Ok(Some(r)),
        other => Err(port_mismatch(name, "row", &other)),
    }
}

/// The unboxed `guard` port: the relation runaway cap the emitter baked onto a guarded relation child
/// fetch, plus the identity the raised error reports (the Rust twin of the litedbmodel `RelationGuard`
/// record). On the WIRE `model`'s key is always spelled — bc types a port by the literal wired into it
/// and rejects a partial struct — so "no model" rides as a wire null (`None` ⇒ "unknown" in the error),
/// and the key itself is read fail-closed rather than defaulted when absent.
struct RelationGuard {
    limit: i64,
    model: Option<String>,
    relation: String,
}

/// Read the `guard` field of the control record. A wire NULL ⇒ `None` ⇒ the statement is uncapped and NO
/// check runs; an ABSENT KEY is LOUD ([`take_opt_row`]), because a guard read as "no cap" is the runaway
/// the cap exists to stop. PRESENT but malformed is equally loud, never a silently dropped guard — a
/// guard that fails to unbox is a runaway that would otherwise sail through.
fn port_relation_guard(opts: &mut WireRow) -> Result<Option<RelationGuard>, BehaviorError> {
    let row = match take_opt_row(opts, "guard")? {
        None => return Ok(None),
        Some(r) => r,
    };
    let field = |name: &str| row.entries.iter().find(|(k, _)| k == name).map(|(_, v)| v);
    let limit = match field("limit") {
        Some(WireValue::Int(n)) => *n,
        Some(other) => return Err(port_mismatch("guard.limit", "int", other)),
        None => return Err(port_absent("guard.limit")),
    };
    let relation = match field("relation") {
        Some(WireValue::Str(s)) => s.to_string(),
        Some(other) => return Err(port_mismatch("guard.relation", "string", other)),
        None => return Err(port_absent("guard.relation")),
    };
    let model = match field("model") {
        Some(WireValue::Str(s)) => Some(s.to_string()),
        Some(WireValue::Null) => None,
        Some(other) => return Err(port_mismatch("guard.model", "string", other)),
        None => return Err(port_absent("guard.model")),
    };
    Ok(Some(RelationGuard {
        limit,
        model,
        relation,
    }))
}

/// One unboxed dynamic-WHERE fragment (leaves.ts `DynamicWhereFrag`): its SQL text, its bound params
/// (wire), and the per-call SKIP flag. The homogeneous fragment vocabulary CLAUDE.md §2 fixes — SQL
/// text + params + a SKIP flag — a skipped fragment is PRESENT with `skipped` true, never a null element.
struct DynamicWhereFrag {
    skipped: bool,
    sql: String,
    params: Vec<WireValue>,
}

/// The unboxed `whereDynamic` plan: the fragments plus the three facts that FINISH the statement.
/// `lead` is the connector the first surviving fragment joins the head with (`"AND"` when the head
/// already ends in a static WHERE, `"WHERE"` when it does not); `tail` is the text that follows the WHERE
/// region (` ORDER BY …` / the page / the row lock, `""` when the statement ends there) and `tail_params`
/// its own bound values. They come from the emitter's SELECT builder, which is what put the WHERE in the
/// statement — so assembly is a CONCATENATION and no scan of the base SQL is involved. Rust twin of the
/// TS `DynamicWherePlan`.
struct DynamicWherePlan {
    frags: Vec<DynamicWhereFrag>,
    lead: String,
    tail: String,
    tail_params: Vec<WireValue>,
}

/// A `string` field of the dynamic-WHERE plan, named QUALIFIED in any failure.
fn plan_string(row: &mut WireRow, name: &str) -> Result<String, BehaviorError> {
    let at = format!("whereDynamic.{name}");
    match take_port_as(row, name, &at)? {
        WireValue::Str(s) => Ok(s.into_owned()),
        other => Err(port_mismatch(&at, "string", &other)),
    }
}

/// A `list` field of the dynamic-WHERE plan, named QUALIFIED in any failure.
fn plan_list(row: &mut WireRow, name: &str) -> Result<Vec<WireValue>, BehaviorError> {
    let at = format!("whereDynamic.{name}");
    match take_port_as(row, name, &at)? {
        WireValue::List(l) => Ok(l.items),
        other => Err(port_mismatch(&at, "list", &other)),
    }
}

/// Read the `whereDynamic` field of the control record — a wire row `{frags, lead, tail, tailParams}`. A
/// wire NULL ⇒ `None` ⇒ no dynamic WHERE (the statement passes through unchanged): only a read that
/// declares an OPTIONAL predicate carries a plan (CLAUDE.md §2). An ABSENT KEY is LOUD ([`take_opt_row`]),
/// because a plan read as "no plan" erases the call's SKIP predicates. PRESENT but wrong-variant, or a
/// malformed fragment, is equally loud — and so is a missing `lead` / `tail` / `tailParams`: defaulting
/// `lead` opens a second WHERE (or continues an absent one), and defaulting the tail DROPS the statement's
/// ORDER BY and page while still returning rows.
fn port_dynamic_where(opts: &mut WireRow) -> Result<Option<DynamicWherePlan>, BehaviorError> {
    let mut row = match take_opt_row(opts, "whereDynamic")? {
        None => return Ok(None),
        Some(r) => r,
    };
    let frags = plan_list(&mut row, "frags")?
        .into_iter()
        .map(parse_where_frag)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(DynamicWherePlan {
        frags,
        lead: plan_string(&mut row, "lead")?,
        tail: plan_string(&mut row, "tail")?,
        tail_params: plan_list(&mut row, "tailParams")?,
    }))
}

/// Unbox ONE dynamic-WHERE fragment row `{skipped, sql, params}`. Fail-closed: a missing or mistyped
/// field is a LOUD failure (the fragment vocabulary is fixed, never partial).
fn parse_where_frag(frag: WireValue) -> Result<DynamicWhereFrag, BehaviorError> {
    let row = match frag {
        WireValue::Row(r) => r,
        other => return Err(port_mismatch("whereDynamic.frags element", "row", &other)),
    };
    let (mut skipped, mut sql, mut params): (Option<bool>, Option<String>, Option<Vec<WireValue>>) =
        (None, None, None);
    for (k, v) in row.entries {
        match (k.as_ref(), v) {
            ("skipped", WireValue::Bool(b)) => skipped = Some(b),
            ("sql", WireValue::Str(s)) => sql = Some(s.into_owned()),
            ("params", WireValue::List(l)) => params = Some(l.items),
            _ => {}
        }
    }
    match (skipped, sql, params) {
        (Some(skipped), Some(sql), Some(params)) => Ok(DynamicWhereFrag {
            skipped,
            sql,
            params,
        }),
        _ => Err(BehaviorError::new(
            "LEAF_PORT",
            "scp leaf: a whereDynamic fragment must be {skipped: bool, sql: string, params: list}",
        )),
    }
}

/// The UNBOXED control record of one statement (the `opts` port — the TS `ExecOptions`): how to run it
/// plus the two optional control structs. Everything the transport branches on besides the statement
/// itself lives here, so a new fact is a new FIELD and no call site's arguments shift (#193). The
/// default is the PLAIN READ the absent port denotes.
#[derive(Default)]
struct ExecOptions {
    /// The NAMED connection (database) the statement runs on — `None` ⇒ the DEFAULT connection. Baked
    /// at emit from the statement's model (the litedbmodel `connectionOf`), or, for a relation child
    /// fetch, from the compiled op's TARGET model. It reaches the router as [`StatementIntent::db`].
    db: Option<String>,
    write: Option<WriteMode>,
    where_plan: Option<DynamicWherePlan>,
    guard: Option<RelationGuard>,
}

/// The unboxed `write` field: `None` ⇒ the statement is a READ, `Some` ⇒ a write carrying its OWN
/// `returning`. ONE field with three values, so "returns rows but is not a write" is not a state this
/// transport can be handed (#206) — there is nothing to reject at run time because it cannot exist.
struct WriteMode {
    returning: bool,
}

/// Read the `write` field of the control record. A wire NULL ⇒ `None` ⇒ a READ; an ABSENT KEY is LOUD
/// ([`take_opt_row`]), and PRESENT but malformed is equally loud — a write read as a read runs an INSERT
/// on the read seam.
fn port_write_mode(opts: &mut WireRow) -> Result<Option<WriteMode>, BehaviorError> {
    let mut row = match take_opt_row(opts, "write")? {
        None => return Ok(None),
        Some(r) => r,
    };
    Ok(Some(WriteMode {
        returning: port_bool(&mut row, "returning")?,
    }))
}

/// Read the OPTIONAL `opts` control record. ABSENT (or null) ⇒ the DEFAULT record — a plain READ with no
/// dynamic WHERE and no cap, which is the ONE statement shape that omits the port (such a payload
/// carries `sql` and `params` alone). PRESENT ⇒ every field is read FAIL-CLOSED: the record is what
/// says whether the statement writes, so a missing field is an ABI break, never a default.
fn port_exec_options(payload: &mut WireRow) -> Result<ExecOptions, BehaviorError> {
    let mut row = match payload.entries.iter().position(|(k, _)| k == "opts") {
        None => return Ok(ExecOptions::default()),
        Some(i) => match payload.entries.swap_remove(i).1 {
            WireValue::Null => return Ok(ExecOptions::default()),
            WireValue::Row(r) => r,
            other => return Err(port_mismatch("opts", "row", &other)),
        },
    };
    Ok(ExecOptions {
        db: port_named_db(&mut row)?,
        write: port_write_mode(&mut row)?,
        where_plan: port_dynamic_where(&mut row)?,
        guard: port_relation_guard(&mut row)?,
    })
}

/// Read the `db` field of the control record — the NAMED connection the statement runs on. A wire NULL
/// ⇒ `None` ⇒ the DEFAULT connection; an ABSENT KEY is LOUD, exactly like every other field of a struct
/// the generator wrote, because a name read as "no name" runs the statement against a DIFFERENT database
/// than its model declares (#217). It is the only control field that is a bare nullable STRING rather
/// than a struct, so it does not go through [`take_opt_row`].
fn port_named_db(opts: &mut WireRow) -> Result<Option<String>, BehaviorError> {
    match take_port(opts, "db")? {
        WireValue::Null => Ok(None),
        WireValue::Str(s) => Ok(Some(s.into_owned())),
        other => Err(port_mismatch("db", "string", &other)),
    }
}

/// A `{arr:'string'}` port — the ordered key-column TUPLE (`col` / `pk` / `fk`). Every element must be
/// a wire string (a key column NAME); anything else is an ABI break, not a data case.
fn port_strings(payload: &mut WireRow, name: &str) -> Result<Vec<String>, BehaviorError> {
    port_list(payload, name)?
        .into_iter()
        .map(|c| match c {
            WireValue::Str(s) => Ok(s.into_owned()),
            other => Err(port_mismatch(name, "string element", &other)),
        })
        .collect()
}

// ── the DYNAMIC (SKIP) WHERE: assembled by the transport, at execution time (leaves.ts) ─────────────

/// Assemble the effective (sql, params) from the dynamic-WHERE plan (leaves.ts
/// `assembleDynamicWhere`): DROP the skipped fragments, join the survivors with ` AND `, and CONCATENATE
/// the three pieces already in hand — the statement's HEAD (which ends at its WHERE region), the
/// assembled clause, and the plan's tail. The params follow the same order: the head's, the survivors',
/// the tail's.
///
/// Nothing is LOCATED here. The emitter's SELECT builder is what puts the WHERE in the statement, so it
/// hands the boundary over on the plan (`lead` says whether the head already ends in a WHERE, `tail` /
/// `tail_params` are what follows it) instead of leaving five transports to rediscover it by scanning: a
/// scan took a NESTED statement's tail keyword for the outer statement's (#198), counted a QUOTED `?` the
/// placeholder render skips (#202), and produced a byte offset that is not the same number in five
/// languages. A plan whose fragments are all skipped leaves the emitted statement exactly as it was
/// compiled (head + tail, no clause).
fn assemble_dynamic_where(
    head: &str,
    head_params: Vec<WireValue>,
    plan: DynamicWherePlan,
) -> (String, Vec<WireValue>) {
    let mut clause = String::new();
    let mut params = head_params;
    for f in plan.frags {
        if f.skipped {
            continue;
        }
        if clause.is_empty() {
            clause.push(' ');
            clause.push_str(&plan.lead);
            clause.push(' ');
        } else {
            clause.push_str(" AND ");
        }
        clause.push_str(&f.sql);
        params.extend(f.params);
    }
    params.extend(plan.tail_params);
    (format!("{head}{clause}{}", plan.tail), params)
}

// ── execute_sql — the SOLE op-independent SQL transport ────────────────────────────────────────────

/// The seam INTENT a statement's RUN MODE reduces to: a write mode PRESENT ⇒ a WRITE (the writer / tx
/// connection), absent ⇒ a READ. It is the input
/// [`connection_for`](crate::exec_context::ExecutionContext) routes on
/// ([`crate::connection_routing::resolve_pool`]), and it is NOT the seam selector: the seam is chosen by
/// `returning` (a RETURNING write runs on [`exec_context::execute`]), the CONNECTION by the statement's
/// own mode. Conflating the two sent `INSERT … RETURNING` to the READ REPLICA (#207). Same rule in all
/// five languages (TS `prepareSql`, go `ExecuteSQL`).
///
/// The NAMED database rides on the SAME intent, because `resolve_pool` resolves both together: it picks
/// the named connection's reader/writer PAIR first, then the write/sticky split within it. `None` ⇒ the
/// default connection, i.e. the intent every single-DB statement has always carried.
fn statement_intent(write: Option<&WriteMode>, db: Option<&str>) -> StatementIntent {
    StatementIntent {
        write: write.is_some(),
        db: db.map(str::to_string),
    }
}

/// The SOLE SQL transport leaf (leaves.ts `executeSQL`). Binds `params` and runs `sql` through the
/// central seam ([`exec_context::execute`] / [`exec_context::run`]) on the AMBIENT context — the ONLY
/// connection contact. `opts.write` selects `run` (INSERT/UPDATE/DELETE) vs `execute` (SELECT / RETURNING)
/// and, through [`statement_intent`], the READ/WRITE intent the connection is resolved from;
/// a non-returning write returns a one-row `[{changes,lastInsertRowid}]` summary so the leaf output
/// shape is uniform (a `List` of `Row`). `?`→`$N` is rendered here (the transport's placeholder SSoT,
/// matching the TS `prepareSql`); an array param (a relation key set) rides as [`Value::Arr`], which
/// the driver encodes per dialect (json_each / native array). The DYNAMIC (SKIP) WHERE
/// ([`assemble_dynamic_where`]) is assembled FIRST — the final statement shape is only known here, so
/// the `?`→`$N` render must follow it (CLAUDE.md §2). `opts.guard` is the RELATION runaway cap of a
/// guarded relation child fetch (absent ⇒ uncapped): the raw rows are asserted against it here
/// ([`crate::errors::LimitExceededError::check`]) because past [`group_children`] the graph is already
/// nested. The whole control surface is ONE optional record, so ports ride in the payload as
/// `{opts?, params, sql}` — a bounded read carries `sql` and `params` alone.
pub fn execute_sql(mut payload: WireRow) -> Result<WireValue, BehaviorError> {
    let params_port = port_list(&mut payload, "params")?;
    let sql_port = port_string(&mut payload, "sql")?;
    let opts = port_exec_options(&mut payload)?;
    // Assemble the DYNAMIC (SKIP) WHERE FIRST when a plan is present: drop the skipped fragments and
    // concatenate the statement's HEAD (which the `sql` port carries when there IS a plan), the surviving
    // clause and the plan's tail — the effective statement the `?`→`$N` render (`finalize_sql`, below)
    // then operates on. An ABSENT plan means `sql`/`params` are the WHOLE statement (pass-through).
    let (sql, params) = match opts.where_plan {
        None => (sql_port, params_port),
        Some(plan) => assemble_dynamic_where(&sql_port, params_port, plan),
    };
    let ctx = current_context()?;
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
    // The placeholder style is a CONNECTION property, read off the ctx's driver (the spelling
    // [`Driver::dialect`] documents for this seam).
    let rendered = finalize_sql(&sql, &value_params, ctx.driver().dialect());
    let intent = statement_intent(opts.write.as_ref(), opts.db.as_deref());
    if opts.write.as_ref().is_some_and(|w| !w.returning) {
        let info = exec_context::run(ctx, &rendered, &value_params, &intent)
            .map_err(sql_failure_to_behavior_error)?;
        // The affected-write summary row (uniform `items` output shape — TS `writeSummary`).
        Ok(WireValue::List(WireList {
            items: vec![WireValue::Row(WireRow {
                entries: vec![
                    ("changes".into(), WireValue::int(info.changes)),
                    (
                        "lastInsertRowid".into(),
                        WireValue::int(info.last_insert_rowid),
                    ),
                ],
            })],
        }))
    } else {
        // The driver materialized the rows DIRECTLY as `WireValue` (one pass) — return them verbatim
        // as the leaf's `List` output. NO second per-cell pass (the retired `value_to_wire` map): the
        // read path never boxes into bc's `Value`.
        let rows = exec_context::execute(ctx, &rendered, &value_params, &intent)
            .map_err(sql_failure_to_behavior_error)?;
        // The RELATION runaway guard, on the RAW child rows — the only point they are visible (past
        // `group_children` the graph is already nested) and the reason the cap rides on this transport.
        // The comparison + the byte-identical message come from the shared
        // [`crate::errors::LimitExceededError::check`] SSoT, so this path cannot drift from the TS
        // reference. It surfaces as a `BehaviorError` because that is the leaf transport's ONE error
        // channel (the same way a `SqlFailure` does), under its own stable code.
        if let Some(g) = opts.guard {
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
    let (fk, into, parents, pk): (&[String], &str, &[WireValue], &[String]) =
        (&fk_port, &into_port, &parents_port, &pk_port);
    // The grouping core keys DIRECTLY on `WireValue` (no `WireValue`↔`Value` conversion) and OWNS the
    // children: each is moved into its bucket, and the bucket is moved into the parent it belongs to. No
    // row is copied.
    let mut by_key = crate::grouping::group_by_key(children_port, fk);
    // Resolve the parent `pk` indices + the `into` insert position ONCE (all parents share column
    // order) — the per-parent path then carries NO index scan, even when `parents` is a large nested
    // relation level (a 3-level chain groups the middle level as parents too).
    let pk_idx = crate::grouping::resolve_key_indices(parents, pk);
    // How many parents claim each key: the last claimant MOVES its bucket, an earlier one clones (so
    // parents sharing a key all still get the children).
    let mut remaining = crate::grouping::count_parent_keys(parents, pk, &pk_idx);
    let into_pos = parents.iter().find_map(|p| match p {
        WireValue::Row(r) => r.entries.iter().position(|(k, _)| k == into),
        _ => None,
    });
    let out: Vec<WireValue> = parents
        .iter()
        .map(|p| {
            let nested = crate::grouping::attach_to_parent(
                p,
                pk,
                &pk_idx,
                &mut by_key,
                &mut remaining,
                single,
            );
            match p {
                // {...p, [into]: nested}: shallow-copy the parent's entries, then set an existing `into`
                // in place (keeps its position) or append a new one — the TS `{...par, [into]: …}` spread.
                WireValue::Row(r) => {
                    let mut entries = r.entries.clone();
                    match into_pos {
                        Some(i) if entries.get(i).is_some_and(|(k, _)| k == into) => {
                            entries[i].1 = nested
                        }
                        _ => entries.push((into.to_string().into(), nested)),
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
    // The tests drive concrete drivers (`SqliteDriver`) directly, so they need the trait in scope;
    // the transport itself only ever holds a `dyn Driver` behind the ctx (#215 removed its last
    // `impl Driver`).
    use crate::driver::Driver;

    // The ports of ONE leaf call, named — the shape every payload in these tests is assembled as.
    type Ports<'a> = Vec<(&'a str, WireValue)>;

    fn wrow(pairs: &[(&str, WireValue)]) -> WireValue {
        WireValue::Row(WireRow {
            entries: pairs
                .iter()
                .map(|(k, v)| (k.to_string().into(), v.clone()))
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
    fn payload(ports: Ports<'_>) -> WireRow {
        WireRow {
            entries: ports
                .into_iter()
                .map(|(k, v)| (k.to_string().into(), v))
                .collect(),
        }
    }
    fn wlist(items: Vec<WireValue>) -> WireValue {
        WireValue::List(WireList { items })
    }
    // The `opts` control record port — the `ExecOptions` record the covered runner assembles: how to run
    // the statement plus its two optional control structs (`WireValue::Null` ⇒ the record's null field,
    // which is how ABSENCE is spelled now that nothing is positional). A plain READ omits the port.
    fn opts(
        db: WireValue,
        write: WireValue,
        where_dynamic: WireValue,
        guard: WireValue,
    ) -> (&'static str, WireValue) {
        (
            "opts",
            wrow(&[
                ("db", db),
                ("guard", guard),
                ("whereDynamic", where_dynamic),
                ("write", write),
            ]),
        )
    }
    // The `write` field's WriteMode row — a write, and whether it yields rows. A READ passes
    // `WireValue::Null` instead, so a read cannot carry a `returning` of its own (#206).
    fn write_mode(returning: bool) -> WireValue {
        wrow(&[("returning", WireValue::Bool(returning))])
    }
    // A key-column tuple port (`col`/`pk`/`fk`) — the ordered column names as wire strings.
    fn cols(c: &[&str]) -> WireValue {
        wlist(
            c.iter()
                .map(|s| WireValue::Str((*s).to_string().into()))
                .collect(),
        )
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
                opts(
                    WireValue::Null,
                    write_mode(false),
                    WireValue::Null,
                    WireValue::Null,
                ),
                (
                    "params",
                    wlist(vec![
                        WireValue::int(id),
                        WireValue::Str(v.to_string().into()),
                    ]),
                ),
                (
                    "sql",
                    WireValue::Str("INSERT INTO t (id, v) VALUES (?, ?)".into()),
                ),
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
                    Some(WireValue::Int(n)) => *n,
                    _ => panic!("unexpected count cell"),
                },
                _ => panic!("unexpected count row"),
            }
        };

        // Ok body: two inserts on the tx connection → COMMIT → both rows persist.
        with_ambient_transaction(&exec_context::for_driver(&d), || {
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
        let outcome: Result<(), BehaviorError> =
            with_ambient_transaction(&exec_context::for_driver(&d), || {
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
        assert!(matches!(&ks[0], WireValue::Int(2)));
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
            ("into", WireValue::Str("posts".into())),
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
            // The runaway cap rides as the `guard` FIELD of the control record; an UNCAPPED read
            // carries no record at all (the emitter omits the port entirely).
            let mut ports = vec![
                ("params", wlist(vec![])),
                (
                    "sql",
                    WireValue::Str("SELECT id, v FROM t ORDER BY id".into()),
                ),
            ];
            if let Some(g) = guard {
                ports.push(opts(WireValue::Null, WireValue::Null, WireValue::Null, g));
            }
            with_ambient_context(&exec_context::for_driver(&d), || {
                execute_sql(payload(ports.clone()))
            })
        };
        let cap = |limit: i64| {
            wrow(&[
                ("limit", WireValue::int(limit)),
                ("model", WireValue::Str("t".into())),
                ("relation", WireValue::Str("things".into())),
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

    // The DYNAMIC (SKIP) WHERE assembled by execute_sql (leaves.ts assembleDynamicWhere), proven
    // end-to-end against a real in-memory sqlite: a surviving fragment joins the HEAD with the plan's
    // `lead` (` WHERE …` here) and the plan's ` ORDER BY` tail is appended after it, its params bind
    // BEFORE the tail params, and a `skipped` fragment is DROPPED (its param never binds). The rust leg
    // of the five-language SKIP-WHERE parity.
    #[test]
    fn dynamic_where_assembles_and_drops_skipped() {
        use crate::driver::SqliteDriver;
        let d = SqliteDriver::in_memory(&[
            "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)".to_string(),
            "INSERT INTO t (id, v) VALUES (1,'a'), (2,'b'), (3,'c')".to_string(),
        ])
        .unwrap();
        let frag = |skipped: bool, sql: &str, p: WireValue| {
            wrow(&[
                ("skipped", WireValue::Bool(skipped)),
                ("sql", WireValue::Str(sql.to_string().into())),
                ("params", wlist(vec![p])),
            ])
        };
        // frag 0 survives (`id > 1`); frag 1 is skipped (`v = 'zzz'`) — its param must NEVER bind. The
        // plan carries what finishes the statement: no static WHERE in the head ⇒ `lead: "WHERE"` (the
        // survivor OPENS one), and the ` ORDER BY id` tail. The transport concatenates head + clause +
        // tail — it never scans for the boundary.
        let plan = wrow(&[
            (
                "frags",
                wlist(vec![
                    frag(false, "id > ?", WireValue::int(1)),
                    frag(true, "v = ?", WireValue::Str("zzz".into())),
                ]),
            ),
            ("lead", WireValue::Str("WHERE".into())),
            ("tail", WireValue::Str(" ORDER BY id".into())),
            ("tailParams", wlist(vec![])),
        ]);
        let out = with_ambient_context(&exec_context::for_driver(&d), || {
            execute_sql(payload(vec![
                opts(WireValue::Null, WireValue::Null, plan, WireValue::Null),
                ("params", wlist(vec![])),
                ("sql", WireValue::Str("SELECT id FROM t".into())),
            ]))
        })
        .unwrap();
        // WHERE id > 1 → ids {2,3}; the skipped `v = ?` fragment was dropped (else a bind-count error
        // or 0 rows). Proves splice position, skip-drop, and the single surviving param binding.
        assert_eq!(items(&out).len(), 2);
    }

    // #205 — a field ABSENT from a PRESENT struct, or present as the WRONG VARIANT, is an ABI BREAK,
    // never an absent VALUE. bc types a port by the literal wired into it and REJECTS a partial struct,
    // so a generated module always spells every field of every struct it wires, with the type the port
    // declares (`null` is how absence is spelled). Neither shape came from one, and reading it anyway
    // would silently drop a relation cap, erase a SKIP predicate, or run a write as a read. The five
    // languages must agree; this is the rust leg.
    #[test]
    fn a_missing_or_mistyped_field_of_a_present_struct_is_loud() {
        use crate::driver::SqliteDriver;
        let d = SqliteDriver::in_memory(&[
            "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)".to_string(),
            "INSERT INTO t (id, v) VALUES (1,'a'), (2,'b'), (3,'c')".to_string(),
        ])
        .unwrap();
        let base = || {
            vec![
                ("params", wlist(vec![])),
                (
                    "sql",
                    WireValue::Str("SELECT id, v FROM t ORDER BY id".into()),
                ),
            ]
        };
        let run = |ports: Ports<'_>| -> Result<WireValue, BehaviorError> {
            with_ambient_context(&exec_context::for_driver(&d), || {
                execute_sql(payload(ports.clone()))
            })
        };
        // An `opts` record whose `whereDynamic` carries ONE fragment (the #209 cases).
        let plan_of = |frag: WireValue| -> Ports<'static> {
            let mut p = base();
            p.push(opts(
                WireValue::Null,
                WireValue::Null,
                wrow(&[("frags", wlist(vec![frag]))]),
                WireValue::Null,
            ));
            p
        };
        let cap = wrow(&[
            ("limit", WireValue::int(2)),
            ("model", WireValue::Str("t".into())),
            ("relation", WireValue::Str("things".into())),
        ]);

        // Each case breaks exactly ONE declared field of a struct that is present — by DROPPING it
        // first…
        let cases: Vec<(&str, Ports, &str)> = vec![
            (
                "payload without sql",
                vec![("params", wlist(vec![]))],
                "`sql` is absent",
            ),
            (
                "payload without params",
                vec![(
                    "sql",
                    WireValue::Str("SELECT id, v FROM t ORDER BY id".into()),
                )],
                "`params` is absent",
            ),
            (
                "record without db",
                vec![
                    ("params", wlist(vec![])),
                    (
                        "sql",
                        WireValue::Str("SELECT id, v FROM t ORDER BY id".into()),
                    ),
                    (
                        "opts",
                        wrow(&[
                            ("guard", WireValue::Null),
                            ("whereDynamic", WireValue::Null),
                            ("write", WireValue::Null),
                        ]),
                    ),
                ],
                "`db` is absent",
            ),
            (
                "record without write",
                vec![
                    ("params", wlist(vec![])),
                    (
                        "sql",
                        WireValue::Str("SELECT id, v FROM t ORDER BY id".into()),
                    ),
                    (
                        "opts",
                        wrow(&[
                            ("db", WireValue::Null),
                            ("guard", WireValue::Null),
                            ("whereDynamic", WireValue::Null),
                        ]),
                    ),
                ],
                "`write` is absent",
            ),
            (
                "record without whereDynamic",
                vec![
                    ("params", wlist(vec![])),
                    (
                        "sql",
                        WireValue::Str("SELECT id, v FROM t ORDER BY id".into()),
                    ),
                    (
                        "opts",
                        wrow(&[
                            ("db", WireValue::Null),
                            ("guard", WireValue::Null),
                            ("write", WireValue::Null),
                        ]),
                    ),
                ],
                "`whereDynamic` is absent",
            ),
            (
                "record without guard",
                vec![
                    ("params", wlist(vec![])),
                    (
                        "sql",
                        WireValue::Str("SELECT id, v FROM t ORDER BY id".into()),
                    ),
                    (
                        "opts",
                        wrow(&[
                            ("db", WireValue::Null),
                            ("whereDynamic", WireValue::Null),
                            ("write", WireValue::Null),
                        ]),
                    ),
                ],
                "`guard` is absent",
            ),
            (
                "write mode without returning",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        wrow(&[]),
                        WireValue::Null,
                        WireValue::Null,
                    ));
                    p
                },
                "`returning` is absent",
            ),
            (
                "guard without model",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        WireValue::Null,
                        wrow(&[
                            ("limit", WireValue::int(2)),
                            ("relation", WireValue::Str("things".into())),
                        ]),
                    ));
                    p
                },
                "`guard.model` is absent",
            ),
            // An absent `guard.limit` / `guard.relation` reports ABSENT, not "expected an int, got NULL":
            // #205/#210's whole point is that a wire null and a missing key are different failures, and
            // a reader that names the wrong one sends the next reader looking for a null that was never
            // there.
            (
                "guard without limit",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        WireValue::Null,
                        wrow(&[
                            ("model", WireValue::Str("t".into())),
                            ("relation", WireValue::Str("things".into())),
                        ]),
                    ));
                    p
                },
                "`guard.limit` is absent",
            ),
            (
                "guard without relation",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        WireValue::Null,
                        wrow(&[
                            ("limit", WireValue::int(2)),
                            ("model", WireValue::Str("t".into())),
                        ]),
                    ));
                    p
                },
                "`guard.relation` is absent",
            ),
            // …and the PLAN and its FRAGMENTS, one level further down (#209).
            (
                "plan without frags",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        wrow(&[]),
                        WireValue::Null,
                    ));
                    p
                },
                "`whereDynamic.frags` is absent",
            ),
            // The plan's OWN three fields (#198/#202): without `lead` the clause cannot know whether it
            // OPENS a WHERE or CONTINUES one, and without `tail`/`tailParams` the statement loses its
            // ORDER BY and page — a different, unbounded row set that still looks like a successful read.
            (
                "plan without lead",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        wrow(&[
                            ("frags", wlist(vec![])),
                            ("tail", WireValue::Str("".into())),
                            ("tailParams", wlist(vec![])),
                        ]),
                        WireValue::Null,
                    ));
                    p
                },
                "`whereDynamic.lead` is absent",
            ),
            (
                "plan without tail",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        wrow(&[
                            ("frags", wlist(vec![])),
                            ("lead", WireValue::Str("WHERE".into())),
                            ("tailParams", wlist(vec![])),
                        ]),
                        WireValue::Null,
                    ));
                    p
                },
                "`whereDynamic.tail` is absent",
            ),
            (
                "plan without tailParams",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        wrow(&[
                            ("frags", wlist(vec![])),
                            ("lead", WireValue::Str("WHERE".into())),
                            ("tail", WireValue::Str("".into())),
                        ]),
                        WireValue::Null,
                    ));
                    p
                },
                "`whereDynamic.tailParams` is absent",
            ),
            (
                "plan lead not a string",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        wrow(&[
                            ("frags", wlist(vec![])),
                            ("lead", WireValue::int(42)),
                            ("tail", WireValue::Str("".into())),
                            ("tailParams", wlist(vec![])),
                        ]),
                        WireValue::Null,
                    ));
                    p
                },
                "`whereDynamic.lead` expected a wire string",
            ),
            (
                "plan tailParams not a list",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        wrow(&[
                            ("frags", wlist(vec![])),
                            ("lead", WireValue::Str("WHERE".into())),
                            ("tail", WireValue::Str("".into())),
                            ("tailParams", WireValue::Str("z".into())),
                        ]),
                        WireValue::Null,
                    ));
                    p
                },
                "`whereDynamic.tailParams` expected a wire list",
            ),
            (
                "fragment without skipped",
                plan_of(wrow(&[
                    ("params", wlist(vec![WireValue::Str("zzz".into())])),
                    ("sql", WireValue::Str("v = ?".into())),
                ])),
                "must be {skipped: bool, sql: string, params: list}",
            ),
            (
                "fragment without sql",
                plan_of(wrow(&[
                    ("params", wlist(vec![WireValue::Str("zzz".into())])),
                    ("skipped", WireValue::Bool(false)),
                ])),
                "must be {skipped: bool, sql: string, params: list}",
            ),
            (
                "fragment without params",
                plan_of(wrow(&[
                    ("skipped", WireValue::Bool(false)),
                    ("sql", WireValue::Str("v = ?".into())),
                ])),
                "must be {skipped: bool, sql: string, params: list}",
            ),
            // A SKIPPED fragment is unboxed too — it is spelled in full like any other.
            (
                "skipped fragment without sql",
                plan_of(wrow(&[
                    ("params", wlist(vec![])),
                    ("skipped", WireValue::Bool(true)),
                ])),
                "must be {skipped: bool, sql: string, params: list}",
            ),
            // …and then by giving it the WRONG VARIANT, which is the same ABI break in every one of
            // those positions: bc emits the literal the port's type says, so nothing else can arrive
            // from a generated module, and reading it anyway is how a `returning` that is not a bool
            // would run an INSERT on the READ seam and a `skipped` that is not a bool would apply a
            // predicate the call SKIPPED — the #209 failure modes, reached by another route.
            (
                "payload sql not a string",
                vec![("params", wlist(vec![])), ("sql", WireValue::int(42))],
                "`sql` expected a wire string",
            ),
            (
                "payload params not a list",
                vec![
                    ("params", WireValue::Str("x".into())),
                    (
                        "sql",
                        WireValue::Str("SELECT id, v FROM t ORDER BY id".into()),
                    ),
                ],
                "`params` expected a wire list",
            ),
            (
                "opts not a row",
                {
                    let mut p = base();
                    p.push(("opts", WireValue::Str("nope".into())));
                    p
                },
                "`opts` expected a wire row",
            ),
            (
                "write not a row",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Str("nope".into()),
                        WireValue::Null,
                        WireValue::Null,
                    ));
                    p
                },
                "`write` expected a wire row",
            ),
            (
                "returning not a bool",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        wrow(&[("returning", WireValue::Str("nope".into()))]),
                        WireValue::Null,
                        WireValue::Null,
                    ));
                    p
                },
                "`returning` expected a wire bool",
            ),
            (
                "whereDynamic not a row",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        WireValue::Str("nope".into()),
                        WireValue::Null,
                    ));
                    p
                },
                "`whereDynamic` expected a wire row",
            ),
            (
                "frags not a list",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        wrow(&[("frags", WireValue::Str("nope".into()))]),
                        WireValue::Null,
                    ));
                    p
                },
                "`whereDynamic.frags` expected a wire list",
            ),
            (
                "fragment not a row",
                plan_of(WireValue::Str("nope".into())),
                "`whereDynamic.frags element` expected a wire row",
            ),
            (
                "fragment skipped not a bool",
                plan_of(wrow(&[
                    ("params", wlist(vec![])),
                    ("skipped", WireValue::Str("no".into())),
                    ("sql", WireValue::Str("v = ?".into())),
                ])),
                "must be {skipped: bool, sql: string, params: list}",
            ),
            (
                "fragment sql not a string",
                plan_of(wrow(&[
                    ("params", wlist(vec![])),
                    ("skipped", WireValue::Bool(false)),
                    ("sql", WireValue::int(42)),
                ])),
                "must be {skipped: bool, sql: string, params: list}",
            ),
            (
                "fragment params not a list",
                plan_of(wrow(&[
                    ("params", WireValue::Str("z".into())),
                    ("skipped", WireValue::Bool(false)),
                    ("sql", WireValue::Str("v = ?".into())),
                ])),
                "must be {skipped: bool, sql: string, params: list}",
            ),
            (
                "guard not a row",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        WireValue::Null,
                        WireValue::Str("nope".into()),
                    ));
                    p
                },
                "`guard` expected a wire row",
            ),
            (
                "guard limit not an int",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        WireValue::Null,
                        wrow(&[
                            ("limit", WireValue::Str("nope".into())),
                            ("model", WireValue::Str("t".into())),
                            ("relation", WireValue::Str("things".into())),
                        ]),
                    ));
                    p
                },
                "`guard.limit` expected a wire int",
            ),
            (
                "guard model not a string",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        WireValue::Null,
                        wrow(&[
                            ("limit", WireValue::int(2)),
                            ("model", WireValue::int(42)),
                            ("relation", WireValue::Str("things".into())),
                        ]),
                    ));
                    p
                },
                "`guard.model` expected a wire string",
            ),
            (
                "guard relation not a string",
                {
                    let mut p = base();
                    p.push(opts(
                        WireValue::Null,
                        WireValue::Null,
                        WireValue::Null,
                        wrow(&[
                            ("limit", WireValue::int(2)),
                            ("model", WireValue::Str("t".into())),
                            ("relation", WireValue::int(42)),
                        ]),
                    ));
                    p
                },
                "`guard.relation` expected a wire string",
            ),
        ];
        for (name, ports, want) in cases {
            match run(ports) {
                Ok(_) => panic!("{name}: must be loud, got Ok"),
                Err(e) => assert!(
                    e.message.contains(want),
                    "{name}: message {:?} does not name the broken field ({want})",
                    e.message
                ),
            }
        }

        // The LEGAL absences stay silent: an omitted record is a plain read, and a null FIELD is how an
        // absent write mode / plan / cap is spelled.
        assert_eq!(items(&run(base()).unwrap()).len(), 3);
        let mut all_null = base();
        all_null.push(opts(
            WireValue::Null,
            WireValue::Null,
            WireValue::Null,
            WireValue::Null,
        ));
        assert_eq!(items(&run(all_null).unwrap()).len(), 3);
        // …and a cap that IS spelled still trips (the fail-closed reads did not disarm it).
        let mut capped = base();
        capped.push(opts(WireValue::Null, WireValue::Null, WireValue::Null, cap));
        match run(capped) {
            Err(e) => assert_eq!(e.code, "LIMIT_EXCEEDED"),
            Ok(_) => panic!("a relation batch over its cap must still raise"),
        }
    }

    // #192 — a MIXED read as the emitter now lowers it (CLAUDE.md §2): the BOUNDED predicate is the
    // statement's own static WHERE and the page count binds after it, so the surviving fragment has to
    // CONTINUE that WHERE with ` AND ` (a second ` WHERE ` is a syntax error) and its param has to bind
    // BETWEEN the bounded value and the count (any other order binds `id > 'c'` / `v = 1` and returns
    // nothing). Proven end-to-end against a real sqlite: only the correct assembly yields row 3.
    #[test]
    fn dynamic_where_continues_a_bounded_where() {
        use crate::driver::SqliteDriver;
        let d = SqliteDriver::in_memory(&[
            "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)".to_string(),
            "INSERT INTO t (id, v) VALUES (1,'a'), (2,'b'), (3,'c')".to_string(),
        ])
        .unwrap();
        // With a plan the `sql` port is the statement's HEAD (up to its WHERE region) and the plan
        // carries what finishes it: `lead: "AND"` (the head ends in a static WHERE), the
        // ` ORDER BY id LIMIT ?` tail and the tail's own bound count.
        let plan = wrow(&[
            (
                "frags",
                wlist(vec![wrow(&[
                    ("skipped", WireValue::Bool(false)),
                    ("sql", WireValue::Str("v = ?".into())),
                    ("params", wlist(vec![WireValue::Str("c".into())])),
                ])]),
            ),
            ("lead", WireValue::Str("AND".into())),
            ("tail", WireValue::Str(" ORDER BY id LIMIT ?".into())),
            ("tailParams", wlist(vec![WireValue::int(2)])),
        ]);
        let out = with_ambient_context(&exec_context::for_driver(&d), || {
            execute_sql(payload(vec![
                opts(WireValue::Null, WireValue::Null, plan, WireValue::Null),
                ("params", wlist(vec![WireValue::int(1)])),
                (
                    "sql",
                    WireValue::Str("SELECT id FROM t WHERE id > ?".into()),
                ),
            ]))
        })
        .unwrap();
        let rows = items(&out);
        assert_eq!(rows.len(), 1, "id > 1 AND v = 'c' selects exactly one row");
        match &rows[0] {
            WireValue::Row(r) => match r.entries.iter().find(|(k, _)| k == "id").map(|(_, v)| v) {
                Some(WireValue::Int(n)) => assert_eq!(*n, 3),
                _ => panic!("unexpected id cell"),
            },
            _ => panic!("unexpected row"),
        }
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

        // The SAME two failures on the OTHER pluck port, so both are pinned on both — the TS / python /
        // php legs pin all four, and a parity that holds on 6 of 8 is a parity nobody is watching.
        let e = failure(pluck_keys(payload(vec![("rows", wlist(vec![]))])));
        assert_eq!(e.code, "LEAF_PORT");
        assert!(
            e.message.contains("`col`") && e.message.contains("absent"),
            "{}",
            e.message
        );

        // `col` present but ONE bare column name, not the ordered TUPLE the port declares.
        let e = failure(pluck_keys(payload(vec![
            ("col", WireValue::Str("id".into())),
            ("rows", wlist(vec![])),
        ])));
        assert_eq!(e.code, "LEAF_PORT");
        assert!(
            e.message.contains("`col`") && e.message.contains("list"),
            "{}",
            e.message
        );

        // #213 — the SAME discipline on `group_children`'s six ports. A silent default here does not
        // corrupt a value, it changes the SHAPE of the graph: `single` read loosely FLIPS the relation's
        // cardinality (a hasMany nesting ONE child), `into` read loosely nests the children under a
        // stringified number. rust was already loud on all six; this pins it against the TS / python /
        // php legs that were not.
        let group_ports = |skip: &str, over: Option<(&'static str, WireValue)>| {
            let mut ports: Ports = vec![
                ("children", wlist(vec![])),
                ("fk", cols(&["post_id"])),
                ("into", WireValue::Str("kids".into())),
                ("parents", wlist(vec![])),
                ("pk", cols(&["id"])),
                ("single", WireValue::Bool(false)),
            ]
            .into_iter()
            .filter(|(k, _)| *k != skip)
            .collect();
            if let Some(o) = over {
                ports.push(o);
            }
            payload(ports)
        };
        for name in ["children", "fk", "into", "parents", "pk", "single"] {
            let e = failure(group_children(group_ports(name, None)));
            assert_eq!(e.code, "LEAF_PORT");
            assert!(
                e.message.contains(&format!("`{name}`")) && e.message.contains("absent"),
                "an absent `{name}` port must name itself: {}",
                e.message
            );
        }
        for (name, val, want) in [
            ("single", WireValue::Str("yes".into()), "bool"), // the CARDINALITY flip
            ("into", WireValue::int(42), "string"),           // the nest key
            ("pk", wlist(vec![WireValue::int(1)]), "string element"), // a key column that is not a NAME
            ("fk", WireValue::Str("post_id".into()), "list"),         // the tuple, not one column
            ("parents", WireValue::int(7), "list"),
            ("children", WireValue::Str("x".into()), "list"),
        ] {
            let e = failure(group_children(group_ports(name, Some((name, val)))));
            assert_eq!(e.code, "LEAF_PORT");
            assert!(
                e.message.contains(&format!("`{name}`")) && e.message.contains(want),
                "a mistyped `{name}` port must name the port and its declared wire kind: {}",
                e.message
            );
        }
        // The LEGAL shape stays silent.
        assert!(
            group_children(group_ports("", None)).is_ok(),
            "a well-formed group payload must pass"
        );
    }

    // #217 R1 — INSIDE a transaction, a statement's named database must AGREE with the one the
    // transaction opened on, or be LOUD. The pin is resolved BEFORE routing (per-execution ownership
    // depends on it), so `intent.db` used to be dropped unread: a `db:"B"` statement inside a tx on the
    // DEFAULT connection ran on the DEFAULT one, silently, and an UNREGISTERED name never surfaced at all.
    // A transaction is ONE connection on ONE database, so the two cannot both be honored.
    //
    // The whole matrix is asserted, the NORMAL cases included: an unnamed in-body statement, and one
    // naming the tx's OWN database, must NOT become loud. The rust leg; twins in TS / go / python / php.
    #[test]
    fn named_db_inside_a_transaction_must_agree() {
        use crate::connection_routing::test_support::{failing_stub, recording_stub, SeamLog};
        use crate::connection_routing::{
            ConnectionRegistry, ReaderWriterPools, RoutingConfig, StickyOptions, WriterStickyClock,
        };
        use std::sync::{Arc, Mutex};

        // The DEFAULT connection's driver REFUSES this statement (the stand-in for "that table is not
        // here"), B's serves it — so a silently mis-routed statement is told apart from a LOUD refusal.
        const SQL: &str = "SELECT id, name FROM named_users ORDER BY id";
        let log: SeamLog = Arc::new(Mutex::new(Vec::new()));
        let routing = RoutingConfig {
            registry: ConnectionRegistry::from_default(ReaderWriterPools::single(failing_stub(
                "A", &log, SQL,
            )))
            .add("B", ReaderWriterPools::single(recording_stub("B", &log)))
            .build()
            .unwrap(),
            sticky: WriterStickyClock::new(StickyOptions {
                use_writer_after_transaction: false,
                ..Default::default()
            }),
        };
        let base = exec_context::for_routing(&routing).unwrap();
        let read = |db: WireValue| {
            execute_sql(payload(vec![
                ("params", wlist(vec![])),
                ("sql", WireValue::Str(SQL.into())),
                opts(db, WireValue::Null, WireValue::Null, WireValue::Null),
            ]))
        };
        let err_of = |r: Result<WireValue, BehaviorError>, what: &str| -> String {
            match r {
                Err(e) => e.message,
                Ok(_) => panic!("{what} must FAIL"),
            }
        };

        // A transaction on the DEFAULT connection (the ctx names none).
        with_ambient_transaction(&base, || {
            // A statement naming ANOTHER database is LOUD. Before this it ran on the tx's own (DEFAULT)
            // connection — which is what `refuses` below would have said instead.
            let e = err_of(
                read(WireValue::Str("B".into())),
                r#"db "B" inside a default tx"#,
            );
            assert!(
                e.contains("transaction opened on 'default'"),
                "a disagreeing name inside a tx must be loud about the tx: {e}"
            );
            // An UNREGISTERED name is loud too (the pin used to swallow it whole).
            let g = err_of(
                read(WireValue::Str("ghost".into())),
                r#"db "ghost" inside a tx"#,
            );
            assert!(g.contains("names connection 'ghost'"), "{g}");
            Ok(())
        })
        .unwrap();

        // A transaction on "B": the statement naming "B" AGREES and runs on the pin, and the UNNAMED
        // in-body statement does too — neither may become loud.
        log.lock().unwrap().clear();
        let on_b = base.with_connection_name(Some("B"));
        with_ambient_transaction(&on_b, || {
            read(WireValue::Str("B".into())).map(|_| ())?;
            read(WireValue::Null).map(|_| ())?;
            // …and 'default' now disagrees, in the other direction.
            let e = err_of(
                read(WireValue::Str("default".into())),
                "db default in a B tx",
            );
            assert!(e.contains("transaction opened on 'B'"), "{e}");
            Ok(())
        })
        .unwrap();
        // The transcript, READ rather than merely wired: ONE checkout, on B, serving both AGREEING
        // statements; the rejected one never reached a driver at all. (This log used to be threaded into
        // both stubs and never read — an instrument that looks like a gate and checks nothing.)
        let seen = log.lock().unwrap().clone();
        assert_eq!(
            seen,
            vec![
                "B:checkout".to_string(), // the tx's ONE connection
                "B:run".to_string(),      // BEGIN
                "B:all".to_string(),      // db="B" — agrees, served by the pin
                "B:all".to_string(),      // unnamed — served by the pin
                "B:run".to_string(),      // COMMIT
            ],
            "the agreeing statements ran on B's ONE checkout; the rejected one reached no driver: {seen:?}"
        );
    }

    // #217 R2 — a NON-ROUTED ctx rejects a named statement IDENTICALLY inside a transaction and outside
    // it. The guard used to sit BEFORE the pin on the TS/php planes and AFTER it here, so "a named
    // statement in a non-routed tx" threw in two languages and ran silently in three.
    #[test]
    fn named_db_on_a_non_routed_context_is_loud_inside_a_transaction_too() {
        use crate::driver::SqliteDriver;
        let d = SqliteDriver::in_memory(&["CREATE TABLE t (id INTEGER PRIMARY KEY)".to_string()])
            .unwrap();
        let ctx = exec_context::for_driver(&d);
        let stmt = |db: WireValue| {
            execute_sql(payload(vec![
                ("params", wlist(vec![])),
                ("sql", WireValue::Str("SELECT id FROM t".into())),
                opts(db, WireValue::Null, WireValue::Null, WireValue::Null),
            ]))
        };
        let loud = |r: Result<WireValue, BehaviorError>, what: &str| match r {
            Err(e) => assert!(
                e.message.contains("names connection 'analytics'"),
                "{what}: {}",
                e.message
            ),
            Ok(_) => panic!("{what} must be LOUD"),
        };
        with_ambient_context(&ctx, || {
            loud(stmt(WireValue::Str("analytics".into())), "outside a tx")
        });
        with_ambient_transaction(&ctx, || {
            loud(
                stmt(WireValue::Str("analytics".into())),
                "inside a tx (must match the outside outcome)",
            );
            // …and the ordinary unnamed statement still runs on the pin.
            stmt(WireValue::Null).map(|_| ())
        })
        .unwrap();
    }

    // #217 (2nd remand) — the READ-ONLY / WRITER DERIVATION of a tx-scoped ctx must carry the
    // transaction's connection NAME. Such a derivation keeps the PIN, so dropping the name leaves a ctx
    // that still resolves the transaction's connection while claiming to be on another database: a
    // statement naming the tx's OWN database gets a FALSE LOUD, and one naming the other database RUNS on
    // the pinned connection. php was the language that dropped it; rust carries it in `with_read_only` /
    // `with_writer` — this pins that, because the R1 gates only used the ctx the tx boundary hands the
    // body DIRECTLY. Driven through the central seam, which is where `connection_for` is called.
    #[test]
    fn named_db_agreement_survives_the_read_only_and_writer_derivations() {
        use crate::connection_routing::test_support::{recording_stub, SeamLog};
        use crate::connection_routing::{
            ConnectionRegistry, ReaderWriterPools, RoutingConfig, StickyOptions, WriterStickyClock,
        };
        use crate::exec_context::{execute, StatementIntent, TxDecision};
        use std::sync::{Arc, Mutex};

        let log: SeamLog = Arc::new(Mutex::new(Vec::new()));
        let routing = RoutingConfig {
            registry: ConnectionRegistry::from_default(ReaderWriterPools::single(recording_stub(
                "A", &log,
            )))
            .add("B", ReaderWriterPools::single(recording_stub("B", &log)))
            .build()
            .unwrap(),
            sticky: WriterStickyClock::new(StickyOptions {
                use_writer_after_transaction: false,
                ..Default::default()
            }),
        };
        let base = exec_context::for_routing(&routing).unwrap();
        let on_b = base.with_connection_name(Some("B"));
        exec_context::with_transaction_decided(&on_b, |tx_ctx| {
            let ro = tx_ctx.with_read_only();
            let wr = tx_ctx.with_writer();
            let both = ro.with_writer();
            for (what, ctx) in [
                ("the tx ctx itself", tx_ctx),
                ("with_read_only()", &ro),
                ("with_writer()", &wr),
                ("with_read_only().with_writer()", &both),
            ] {
                // NO FALSE LOUD: the tx's OWN database still runs on the pinned connection, and so does an
                // UNNAMED statement (the ordinary in-body one).
                for intent in [
                    StatementIntent {
                        write: false,
                        db: Some("B".to_string()),
                    },
                    StatementIntent::read(),
                ] {
                    assert!(
                        execute(ctx, "SELECT 1", &[], &intent).is_ok(),
                        "{what}: a statement of the tx's own db must NOT be rejected"
                    );
                }
                // …and a DIFFERENT database is still LOUD (it would otherwise run on B's pinned conn).
                let e = match execute(
                    ctx,
                    "SELECT 1",
                    &[],
                    &StatementIntent {
                        write: false,
                        db: Some("default".to_string()),
                    },
                ) {
                    Err(e) => e,
                    Ok(_) => panic!("{what}: a different db must stay rejected"),
                };
                assert!(
                    e.message.contains("transaction opened on 'B'"),
                    "{what}: {}",
                    e.message
                );
            }
            Ok(TxDecision::Commit(()))
        })
        .unwrap();
        // Every statement of the whole transaction — the seam-issued BEGIN/COMMIT included — ran on B, and
        // NOTHING on the default: the derivations did not divert an in-body statement to another
        // connection. (`recording_stub` logs one entry per statement it serves, so this is the transcript.)
        // ONE checkout for the whole transaction, on B — the derivations did not turn an in-body statement
        // into a second connection. The COUNT is the load-bearing half: `all(starts_with("B:"))` alone stays
        // green even when the pin is lost, because a statement that ROUTES still lands on B's driver.
        // `:checkout` comes from the stub's `acquire_tx`/`begin_tx` hook, which is rust's checkout.
        let seen = log.lock().unwrap().clone();
        assert_eq!(
            seen.iter().filter(|e| e.ends_with(":checkout")).count(),
            1,
            "ONE checkout for the whole tx: {seen:?}"
        );
        assert!(
            seen.iter().all(|e| e.starts_with("B:")) && !seen.is_empty(),
            "the whole tx must run on B: {seen:?}"
        );
    }

    // #217 (the TRANSACTION half, the rust twin of go's #215) — WHICH database a COVERED transaction
    // opens on is the CTX's answer. A statement names its db in its own `StatementIntent`; a transaction
    // has no statement to carry one, and this boundary takes only a body — so the name rides on the ctx
    // (`with_connection_name`) and the ONE acquire point reads it (`tx_driver`). It used to be a
    // PARAMETER of a second `…_isolated_on` entry point that `with_transaction_decided` called with
    // `None`, so EVERY covered transaction opened on the DEFAULT connection's writer however the ctx was
    // built — rust alone, since go (`WithConnectionName`), python (`with_connection_name`), TS
    // (`withTransactionAsync(…, connection?)`) and php (`routedTransaction(…, ?string)`) all name it.
    //
    // The transcript is the proof: the whole BEGIN…COMMIT envelope, the body's statement included, runs
    // on the NAMED connection and the default sees NOTHING.
    #[test]
    fn a_covered_transaction_opens_on_the_db_the_ctx_names() {
        use crate::connection_routing::test_support::{recording_stub, SeamLog};
        use crate::connection_routing::{
            ConnectionRegistry, ReaderWriterPools, RoutingConfig, StickyOptions, WriterStickyClock,
        };
        use std::sync::{Arc, Mutex};

        let transcript = |name: Option<&str>| -> Vec<String> {
            let log: SeamLog = Arc::new(Mutex::new(Vec::new()));
            let routing = RoutingConfig {
                registry: ConnectionRegistry::from_default(ReaderWriterPools::single(
                    recording_stub("A", &log),
                ))
                .add("B", ReaderWriterPools::single(recording_stub("B", &log)))
                .build()
                .unwrap(),
                sticky: WriterStickyClock::new(StickyOptions {
                    use_writer_after_transaction: false,
                    ..Default::default()
                }),
            };
            let base = exec_context::for_routing(&routing).unwrap();
            let ctx = base.with_connection_name(name);
            with_ambient_transaction(&ctx, || {
                execute_sql(payload(vec![
                    ("params", wlist(vec![])),
                    ("sql", WireValue::Str("SELECT 1".into())),
                ]))
                .map(|_| ())
            })
            .unwrap();
            let seen = log.lock().unwrap().clone();
            seen
        };

        // NAMED ⇒ the whole envelope on B; the default connection is never touched.
        let named = transcript(Some("B"));
        assert!(
            named.iter().all(|e| e.starts_with("B:")),
            "a named covered tx must run entirely on that db: {named:?}"
        );
        assert_eq!(
            named,
            vec![
                "B:checkout".to_string(), // the tx takes ONE connection out of B — and only one
                "B:run".to_string(),      // BEGIN, seam-issued
                "B:all".to_string(),      // the body's statement
                "B:run".to_string(),      // COMMIT, seam-issued
            ],
            "ONE checkout on B, then BEGIN + the body statement + COMMIT on it: {named:?}"
        );
        // UNNAMED (the other side of the same rule) ⇒ the DEFAULT connection. A `B:` here would mean the
        // name leaked from somewhere other than the ctx.
        let unnamed = transcript(None);
        assert!(
            unnamed.iter().all(|e| e.starts_with("A:")),
            "an unnamed covered tx must run on the default connection: {unnamed:?}"
        );
    }

    // #217 — the statement's own NAMED DATABASE reaches the router. The `db` field of the control
    // record is the ONLY thing that decides WHICH registered connection serves the statement; a single-DB
    // setup cannot tell a honored name from a dropped one, which is exactly why the defect survived the
    // single-DB conformance and livedb suites.
    //
    // The two connections are made DISJOINT the way two real databases are: the DEFAULT connection's
    // driver REFUSES this statement (a `failing_stub` — the stand-in for "that table does not exist
    // here"), `B`'s serves it. So the negative control is IN PLACE rather than reasoned about: with the
    // name dropped to a wire null (the pre-#217 lowering) the SAME statement lands on the default and
    // fails, which is what a cross-DB relation did against its parent's database.
    //
    // The rust leg of "the same behaviour in all five languages": the twin of the TS `leaves.test.ts`
    // #217 tests, the go `TestExecuteSQL_NamedDBRoutesTheStatement`, the python
    // `test_named_db_routes_the_statement` and the php `NamedDbRoutingTest`.
    #[test]
    fn named_db_routes_the_statement() {
        use crate::connection_routing::test_support::{failing_stub, recording_stub, SeamLog};
        use crate::connection_routing::{
            ConnectionRegistry, ReaderWriterPools, RoutingConfig, StickyOptions, WriterStickyClock,
        };
        use std::sync::{Arc, Mutex};

        const SQL: &str = "SELECT id, name FROM named_users ORDER BY id";
        let log: SeamLog = Arc::new(Mutex::new(Vec::new()));
        let routing = RoutingConfig {
            registry: ConnectionRegistry::from_default(ReaderWriterPools::single(failing_stub(
                "A", &log, SQL,
            )))
            .add("B", ReaderWriterPools::single(recording_stub("B", &log)))
            .build()
            .unwrap(),
            sticky: WriterStickyClock::new(StickyOptions {
                use_writer_after_transaction: false,
                ..Default::default()
            }),
        };
        let ctx = exec_context::for_routing(&routing).unwrap();
        let read = |db: WireValue| {
            with_ambient_context(&ctx, || {
                execute_sql(payload(vec![
                    ("params", wlist(vec![])),
                    ("sql", WireValue::Str(SQL.into())),
                    opts(db, WireValue::Null, WireValue::Null, WireValue::Null),
                ]))
            })
        };

        // NAMED ⇒ B served it (and B alone — the default would have refused).
        assert!(
            read(WireValue::Str("B".into())).is_ok(),
            "a `db: \"B\"` statement must be served by the B connection"
        );
        assert_eq!(*log.lock().unwrap(), vec!["B:all".to_string()]);

        // NEGATIVE CONTROL — the name DROPPED (a wire null, the pre-#217 lowering) sends the SAME
        // statement to the DEFAULT connection, which cannot serve it.
        let e = match read(WireValue::Null) {
            Err(e) => e,
            Ok(_) => {
                panic!("a `db: null` statement must land on the DEFAULT connection and fail there")
            }
        };
        assert!(
            e.message.contains("refuses"),
            "the dropped name must reach the DEFAULT connection: {}",
            e.message
        );
        assert_eq!(
            *log.lock().unwrap(),
            vec!["B:all".to_string(), "A:all".to_string()],
            "the log must show the second statement served by A, not B"
        );

        // An UNREGISTERED name is LOUD, never a silent fall back to the default.
        let g = match read(WireValue::Str("ghost".into())) {
            Err(e) => e,
            Ok(_) => panic!("an unregistered connection name must be LOUD"),
        };
        assert!(
            g.message
                .contains("no connection registered under name 'ghost'"),
            "unknown-name failure = {}",
            g.message
        );
    }

    // A named statement on a NON-ROUTED ctx (the base `for_driver` path) has no registry to resolve the
    // name against, so it must be LOUD. Running it on the single driver anyway is the silent
    // wrong-database execution named-DB lowering exists to prevent.
    #[test]
    fn named_db_on_a_non_routed_context_is_loud() {
        use crate::driver::SqliteDriver;
        let d = SqliteDriver::in_memory(&["CREATE TABLE t (id INTEGER PRIMARY KEY)".to_string()])
            .unwrap();
        let ctx = exec_context::for_driver(&d);
        let read = |db: WireValue| {
            with_ambient_context(&ctx, || {
                execute_sql(payload(vec![
                    ("params", wlist(vec![])),
                    ("sql", WireValue::Str("SELECT id FROM t".into())),
                    opts(db, WireValue::Null, WireValue::Null, WireValue::Null),
                ]))
            })
        };
        let e = match read(WireValue::Str("analytics".into())) {
            Err(e) => e,
            Ok(_) => panic!("a named statement on a non-routed ctx must be LOUD"),
        };
        assert!(
            e.message
                .contains("a statement names connection 'analytics'"),
            "non-routed named failure = {}",
            e.message
        );
        // The DEFAULT connection is the single-driver case itself and still runs.
        assert!(read(WireValue::Null).is_ok());
    }

    // #207 — the leaf hands the central seam ONE `StatementIntent`, derived from the statement's RUN
    // MODE, and `connection_for` resolves the CONNECTION from it (`resolve_pool`: write ⇒ the writer
    // pool). The branch that selects the SEAM is a DIFFERENT question: a RETURNING write runs on the ROW
    // seam (`exec_context::execute`) and is still a write. Deriving the intent from the branch — which is
    // what this transport did — sent `INSERT … RETURNING` to the READ REPLICA. The conformance/livedb
    // setups run reader === writer, which is why no cross-language leg saw it.
    //
    // The gate drives the PRODUCTION function: a routed ctx over a SPLIT reader/writer pair is installed
    // as the ambient the way a consumer installs one (`with_ambient_context`, reachable since #214), and
    // each pool records the statements it served. What comes back is where `execute_sql` actually sent
    // them — not where a re-derivation of the rule says it should have. Composing `statement_intent` with
    // `resolve_pool` in the test instead proved only that those two agree with each other: it stayed
    // green with `execute_sql`'s intent handoff reverted to the #207 shape, which is no gate at all.
    #[test]
    fn the_run_mode_not_the_seam_branch_picks_the_pool() {
        use crate::connection_routing::test_support::{recording_stub, SeamLog};
        use crate::connection_routing::{
            ConnectionRegistry, ReaderWriterPools, RoutingConfig, StickyOptions, WriterStickyClock,
        };
        use std::sync::{Arc, Mutex};

        let log: SeamLog = Arc::new(Mutex::new(Vec::new()));
        let routing = RoutingConfig {
            registry: ConnectionRegistry::from_default(ReaderWriterPools {
                reader: recording_stub("reader", &log),
                writer: recording_stub("writer", &log),
            })
            .build()
            .unwrap(),
            sticky: WriterStickyClock::new(StickyOptions {
                use_writer_after_transaction: false,
                ..Default::default()
            }),
        };
        let ctx = exec_context::for_routing(&routing).unwrap();
        let issue = |write: Option<bool>, sql: &str| {
            // A READ carries NO control record at all (the emitter omits the port); a write carries the
            // run mode, whose `returning` picks the SEAM.
            let mut ports = vec![
                ("params", wlist(vec![])),
                ("sql", WireValue::Str(sql.to_string().into())),
            ];
            if let Some(returning) = write {
                ports.push(opts(
                    WireValue::Null,
                    wrow(&[("returning", WireValue::Bool(returning))]),
                    WireValue::Null,
                    WireValue::Null,
                ));
            }
            with_ambient_context(&ctx, || execute_sql(payload(ports))).unwrap();
        };
        issue(None, "SELECT id FROM users");
        issue(
            Some(true),
            "INSERT INTO users (name) VALUES (?) RETURNING id",
        );
        issue(Some(false), "INSERT INTO users (name) VALUES (?)");
        // A READ → the READER; BOTH write modes → the WRITER. The RETURNING one is the #207 case: with
        // the intent taken from the seam BRANCH it landed on the reader. And the trailing seam name
        // shows the two decisions are INDEPENDENT rather than accidentally aligned — the RETURNING write
        // is on the WRITER *and* on the ROW seam (`all`), the plain write on the WRITE seam (`run`).
        assert_eq!(
            log.lock().unwrap().as_slice(),
            ["reader:all", "writer:all", "writer:run"],
        );

        // The shape that pairs with those seams, end-to-end on a real sqlite: a RETURNING write returns
        // its ROWS, a non-returning one the `[{changes,lastInsertRowid}]` summary.
        use crate::driver::SqliteDriver;
        let d = SqliteDriver::in_memory(&[
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)".to_string(),
        ])
        .unwrap();
        let insert = |returning: bool, sql: &str| {
            let ports = vec![
                opts(
                    WireValue::Null,
                    wrow(&[("returning", WireValue::Bool(returning))]),
                    WireValue::Null,
                    WireValue::Null,
                ),
                ("params", wlist(vec![WireValue::Str("A".into())])),
                ("sql", WireValue::Str(sql.to_string().into())),
            ];
            with_ambient_context(&exec_context::for_driver(&d), || {
                execute_sql(payload(ports))
            })
            .unwrap()
        };
        let returning = insert(true, "INSERT INTO users (name) VALUES (?) RETURNING id");
        match &items(&returning)[0] {
            WireValue::Row(r) => assert!(
                r.entries.iter().any(|(k, _)| k == "id"),
                "a RETURNING write must return ROWS, not the write summary"
            ),
            _ => panic!("the RETURNING write's result element is not a row"),
        }
        let summary = insert(false, "INSERT INTO users (name) VALUES (?)");
        match &items(&summary)[0] {
            WireValue::Row(r) => assert!(
                r.entries.iter().any(|(k, _)| k == "changes"),
                "a non-returning write must return the affected-rows summary"
            ),
            _ => panic!("the write summary element is not a row"),
        }
    }

    // #215 — a covered-plane transaction is the runtime's ONE transaction. `with_ambient_transaction`
    // ran its own BEGIN/COMMIT on a driver it fetched itself, which looked equivalent and was not: the
    // central boundary ALSO seam-issues its tx-control (so a middleware sees it) and marks the
    // writer-sticky clock on COMMIT (so the reads AFTER a covered write are read-your-writes). Neither
    // happened, and the single-pool conformance/livedb setups cannot tell — reader IS writer there.
    //
    // The gate runs a covered tx on a routed ctx over a SPLIT pair and reads back three transcripts:
    // WHICH pool each statement went to, WHAT a registered middleware saw, and where the read AFTER the
    // tx landed. All three come from the PRODUCTION functions (`with_ambient_transaction` +
    // `execute_sql` through `with_ambient_context`) — nothing here re-derives a rule.
    #[test]
    fn a_covered_transaction_runs_through_the_central_boundary() {
        use crate::connection_routing::test_support::{recording_stub, SeamLog};
        use crate::connection_routing::{
            ConnectionRegistry, ManualClock, ReaderWriterPools, RoutingConfig, StickyOptions,
            WriterStickyClock,
        };
        use crate::middleware::{
            create_middleware, use_middleware, with_middleware_scope, SqlHookFn, SqlNext,
        };
        use std::sync::{Arc, Mutex};

        let pools: SeamLog = Arc::new(Mutex::new(Vec::new()));
        let routing = RoutingConfig {
            registry: ConnectionRegistry::from_default(ReaderWriterPools {
                reader: recording_stub("reader", &pools),
                writer: recording_stub("writer", &pools),
            })
            .build()
            .unwrap(),
            // Writer-sticky ENABLED on a manual clock (the instrument the sticky-expiry test already
            // uses): the read after the commit is inside the 5s window, so "armed" and "not armed" are
            // distinguishable deterministically.
            sticky: WriterStickyClock::new(StickyOptions {
                use_writer_after_transaction: true,
                clock: Arc::new(ManualClock::new(1_000_000)),
                ..StickyOptions::default()
            }),
        };
        let ctx = exec_context::for_routing(&routing).unwrap();
        let read = || {
            with_ambient_context(&ctx, || {
                execute_sql(payload(vec![
                    ("params", wlist(vec![])),
                    ("sql", WireValue::Str("SELECT id FROM users".into())),
                ]))
            })
        };

        // Before any transaction: a read is a plain read ⇒ the READER (the sticky clock is unarmed).
        read().unwrap();
        assert_eq!(pools.lock().unwrap().as_slice(), ["reader:all"]);

        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed = Arc::clone(&seen);
        with_middleware_scope(|| {
            let mw = create_middleware::<(), _, fn() -> ()>(
                Some(SqlHookFn(
                    move |sql: &str, params: &[Value], next: &SqlNext| {
                        observed.lock().unwrap().push(sql.to_string());
                        next(sql, params)
                    },
                )),
                None,
            );
            use_middleware(&mw);
            with_ambient_transaction(&ctx, || {
                // A READ inside the tx: its intent says READER, but the tx PIN wins — this is the
                // "a read in a transaction sticks to the tx connection" half.
                execute_sql(payload(vec![
                    ("params", wlist(vec![])),
                    ("sql", WireValue::Str("SELECT id FROM users".into())),
                ]))?;
                execute_sql(payload(vec![
                    opts(
                        WireValue::Null,
                        write_mode(false),
                        WireValue::Null,
                        WireValue::Null,
                    ),
                    ("params", wlist(vec![])),
                    (
                        "sql",
                        WireValue::Str("INSERT INTO users (name) VALUES (?)".into()),
                    ),
                ]))
                .map(|_| ())
            })
            .unwrap();
        });

        // (1) the BEGIN is drawn from the WRITER pool, and (2) BOTH body statements — the READ included
        // — ran on that same tx connection, never on the reader.
        assert_eq!(
            pools.lock().unwrap().as_slice(),
            [
                "reader:all",      // the pre-tx read
                "writer:checkout", // the tx's ONE connection, taken out of the WRITER pool
                "writer:run",      // BEGIN, on that connection
                "writer:all",      // the body's READ — the tx pin wins over its read intent
                "writer:run",      // the body's write
                "writer:run",      // COMMIT, on the same pinned connection
            ]
        );
        // (3) the tx-control is SEAM-issued, so a registered middleware observes the whole envelope.
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            [
                "BEGIN",
                "SELECT id FROM users",
                "INSERT INTO users (name) VALUES (?)",
                "COMMIT",
            ]
        );

        // (2, continued) the COMMIT armed the writer-sticky clock: the SAME plain read that opened this
        // test on the reader now routes to the WRITER (read-your-writes).
        pools.lock().unwrap().clear();
        read().unwrap();
        assert_eq!(pools.lock().unwrap().as_slice(), ["writer:all"]);
    }

    // A body error surfaces UNMASKED even when the seam-issued ROLLBACK ALSO fails. The covered plane
    // transports a body failure as the boundary's `TxDecision::Rollback` value, and the boundary drops
    // that value when its ROLLBACK errors (correct for the gate short-circuit that arm serves — there
    // the ROLLBACK failure IS the only error), so without the leaf holding the body error a broken
    // connection would rewrite the caller's failure into a driver message. go returns `bodyErr`
    // whatever its ROLLBACK did (`exec_context.go:676-683`) and the TS rethrows the caught error
    // (`exec-context.ts:594-601`) — all three say the same thing here.
    #[test]
    fn a_failing_rollback_does_not_mask_the_body_error() {
        use crate::connection_routing::test_support::{failing_stub, SeamLog};
        use std::sync::{Arc, Mutex};

        let log: SeamLog = Arc::new(Mutex::new(Vec::new()));
        let driver = failing_stub("solo", &log, "ROLLBACK");
        let ctx = exec_context::for_driver(driver.as_ref());

        let outcome: Result<(), BehaviorError> =
            with_ambient_transaction(&ctx, || Err(BehaviorError::new("BOOM", "mid-tx failure")));
        let err = outcome.expect_err("a body error must propagate");
        assert_eq!(err.code, "BOOM", "the leaf surfaced {:?}", err.message);
        assert_eq!(err.message, "mid-tx failure");
        // The ROLLBACK really was attempted (and really did fail) — the transcript, not a claim.
        assert_eq!(
            log.lock().unwrap().as_slice(),
            ["solo:checkout", "solo:run", "solo:run"]
        );
    }
}
