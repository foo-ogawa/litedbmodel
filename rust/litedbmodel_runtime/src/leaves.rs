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
//! bare [`Driver`]: the ctx is what carries the connection ROUTING (reader/writer split, named DB,
//! writer-sticky), so this — the only path a bc typed-native module reaches a connection by — is where
//! a routed consumer configuration has to arrive. Synthesizing the ctx inside the leaf instead
//! (`exec_context::for_driver`, whose `routing` is `None`) left every routed setup inert (#214). This
//! is the rust analogue of the TS `LeafContext.exec` bc injects at `bindBehaviors` time (C4 — never on
//! the IR).

use std::cell::Cell;

use behavior_contracts::Value;

use crate::driver::Driver;
use crate::exec_context::{self, ExecutionContext, StatementIntent};
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
// via `execute_sql` and returns `Result`. THIS wrapper brackets that runner in a transaction using the
// EXISTING tx primitives ([`Driver::begin_tx`] issues BEGIN; [`TxConnection::commit`]/[`rollback`] issue
// COMMIT/ROLLBACK on the owned connection) and the EXISTING ambient mechanism
// ([`with_ambient_context`]) — no new tx execution engine, no parallel exec path. Statement execution
// stays the ONE seam ([`execute_sql`] → [`exec_context`]); only the tx-control is added around it.

/// A [`Driver`] adapter over a tx's OWNED [`TxConnection`]: it forwards every prepared statement to the
/// pinned tx connection, so a covered runner's `execute_sql` (which resolves the ambient context and runs
/// through the central seam) executes ON the transaction. Wrapped in the ambient context installed for
/// the span of the tx body by [`with_ambient_transaction`]. `dialect` mirrors the underlying driver so
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

/// Run `body` inside a transaction on `ctx`, threading the tx connection as the ambient context so a
/// covered runner's `execute_sql` executes on it: [`Driver::begin_tx`] (BEGIN) → run `body` under the
/// tx-pinned ambient → COMMIT on `Ok` / ROLLBACK on `Err` (the atomicity guarantee). A body error rolls
/// back and re-raises; a COMMIT that itself fails rolls back and surfaces the error. This is the covered
/// plane's tx boundary — the runtime owns it (the generated runner emits NO BEGIN/COMMIT).
///
/// WHICH connection the transaction opens on is the ctx's answer, not this function's:
/// [`ExecutionContext::tx_driver`] is the one resolver for it (the WRITER pool of the default
/// connection under a routing config, the single primary driver without one).
pub fn with_ambient_transaction<R>(
    ctx: &ExecutionContext,
    body: impl FnOnce() -> Result<R, BehaviorError>,
) -> Result<R, BehaviorError> {
    let driver = ctx.tx_driver(None).map_err(sql_failure_to_behavior_error)?;
    let tx = driver.begin_tx().map_err(sql_failure_to_behavior_error)?; // BEGIN issued on the owned connection
    let tx_driver = TxDriver {
        tx: std::cell::RefCell::new(tx),
        dialect: driver.dialect(),
    };
    let result = {
        // The tx-pinned ambient: every statement the body issues resolves THIS connection.
        let tx_ctx = exec_context::for_driver(&tx_driver);
        with_ambient_context(&tx_ctx, body)
    };
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

/// Move port `name` OUT of the payload (no clone). Fail-closed: an absent port is a loud failure.
fn take_port(payload: &mut WireRow, name: &str) -> Result<WireValue, BehaviorError> {
    match payload.entries.iter().position(|(k, _)| k == name) {
        Some(i) => Ok(payload.entries.swap_remove(i).1),
        None => Err(port_absent(name)),
    }
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

/// Read the `whereDynamic` field of the control record — a wire row `{frags: [...]}`. A wire NULL ⇒
/// `None` ⇒ no dynamic WHERE (the statement passes through unchanged): only a read that declares an
/// OPTIONAL predicate carries a plan (CLAUDE.md §2). An ABSENT KEY is LOUD ([`take_opt_row`]), because a
/// plan read as "no plan" erases the call's SKIP predicates. PRESENT but wrong-variant, or a malformed
/// fragment, is equally loud.
fn port_dynamic_where(opts: &mut WireRow) -> Result<Option<Vec<DynamicWhereFrag>>, BehaviorError> {
    let row = match take_opt_row(opts, "whereDynamic")? {
        None => return Ok(None),
        Some(r) => r,
    };
    let frags = match row.entries.into_iter().find(|(k, _)| k == "frags") {
        Some((_, WireValue::List(l))) => l.items,
        Some((_, other)) => return Err(port_mismatch("whereDynamic.frags", "list", &other)),
        None => return Err(port_absent("whereDynamic.frags")),
    };
    frags
        .into_iter()
        .map(parse_where_frag)
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
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
    write: Option<WriteMode>,
    where_frags: Option<Vec<DynamicWhereFrag>>,
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
        write: port_write_mode(&mut row)?,
        where_frags: port_dynamic_where(&mut row)?,
        guard: port_relation_guard(&mut row)?,
    })
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

/// The SQL keywords that may follow a WHERE clause (leaves.ts `WHERE_TAIL_RE`
/// `/\s+(GROUP BY|ORDER BY|LIMIT|OFFSET|FOR UPDATE|RETURNING)\b/i`). The dynamic WHERE splices in
/// BEFORE the first of them, so it lands at exactly the position a bounded WHERE occupies.
const WHERE_TAIL_KEYWORDS: [&str; 6] = [
    "GROUP BY",
    "ORDER BY",
    "LIMIT",
    "OFFSET",
    "FOR UPDATE",
    "RETURNING",
];

/// An ASCII whitespace byte (RE2 `\s`: space, tab, LF, FF, CR — the corpus SQL uses only these).
fn is_ascii_ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | 0x0c | b'\r')
}

/// An ASCII word byte (RE2/JS `\w`: `[A-Za-z0-9_]`).
fn is_ascii_word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// The byte index of the leading-whitespace run of the FIRST of `keywords` in `sql`, or `None`. Matches
/// the TS regexes (`WHERE_TAIL_RE` / `WHERE_RE`) WITHOUT a regex dependency: the leftmost run of one or
/// more whitespace bytes (`\s+`) immediately followed by one of the keywords (case-insensitive) that
/// ends on a word boundary (`\b` — end of string or a non-word byte). Scanning `i` ascending returns the
/// first whitespace of that run (a match starting mid-run would have matched one byte earlier). ONE
/// scanner for both keyword sets — the tail keywords and WHERE itself are the same lexical rule.
fn keyword_index(sql: &str, keywords: &[&str]) -> Option<usize> {
    let b = sql.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if !is_ascii_ws(b[i]) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < b.len() && is_ascii_ws(b[j]) {
            j += 1;
        }
        for kw in keywords {
            let k = kw.len();
            if j + k <= b.len()
                && b[j..j + k].eq_ignore_ascii_case(kw.as_bytes())
                && (j + k == b.len() || !is_ascii_word(b[j + k]))
            {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// Where a dynamic WHERE clause joins `base_sql` (port of leaves.ts `whereSplice`) — the ONE scan
/// [`assemble_dynamic_where`] makes, and everything it needs to place both the text and the values:
///
///  - `.0` — the end of the statement's WHERE region: before the first tail keyword, or the end of the
///    statement. The exact position a bounded WHERE occupies.
///  - `.1` — how the clause joins: `" AND "` when the statement already carries a WHERE (its BOUNDED
///    predicates, lowered at emit — CLAUDE.md §2), `" WHERE "` when it carries none.
///  - `.2` — how many base params bind AFTER the clause. Every `?` past the splice point is a page-tail
///    bound count (`LIMIT ?` / `OFFSET ?`) — the only placeholders the emitted SELECT carries after the
///    WHERE — so the surviving fragments' params bind before exactly that many of the base params, which
///    is the position their own `?`s occupy in the final statement. It counts a SUBSTRING's placeholders
///    and every placeholder binds one param, so it never exceeds `params.len()` for a statement that can
///    be bound at all.
fn where_splice(base_sql: &str) -> (usize, &'static str, usize) {
    let at = keyword_index(base_sql, &WHERE_TAIL_KEYWORDS).unwrap_or(base_sql.len());
    let keyword = if keyword_index(&base_sql[..at], &["WHERE"]).is_some() {
        " AND "
    } else {
        " WHERE "
    };
    (at, keyword, base_sql[at..].matches('?').count())
}

/// Assemble the effective (sql, params) from the dynamic-WHERE fragments (leaves.ts
/// `assembleDynamicWhere`): DROP the skipped fragments, join the survivors with ` AND `, splice the
/// clause at the statement's WHERE position — CONTINUING the bounded WHERE the emitter already lowered,
/// or opening one when there is none — and bind the survivors' params at the slot their `?`s occupy:
/// after the base params the clause follows, before the page tail's. A plan whose fragments are all
/// skipped leaves the emitted statement exactly as it was compiled.
fn assemble_dynamic_where(
    base_sql: &str,
    base_params: Vec<WireValue>,
    frags: Vec<DynamicWhereFrag>,
) -> (String, Vec<WireValue>) {
    let mut clause = String::new();
    let mut where_params: Vec<WireValue> = Vec::new();
    for f in frags {
        if f.skipped {
            continue;
        }
        if !clause.is_empty() {
            clause.push_str(" AND ");
        }
        clause.push_str(&f.sql);
        where_params.extend(f.params);
    }
    if clause.is_empty() {
        return (base_sql.to_string(), base_params);
    }
    let (at, keyword, tail) = where_splice(base_sql);
    let mut params = base_params;
    let page = params.split_off(params.len() - tail);
    params.extend(where_params);
    params.extend(page);
    (
        format!("{}{keyword}{clause}{}", &base_sql[..at], &base_sql[at..]),
        params,
    )
}

// ── execute_sql — the SOLE op-independent SQL transport ────────────────────────────────────────────

/// The seam INTENT a statement's RUN MODE reduces to: a write mode PRESENT ⇒ a WRITE (the writer / tx
/// connection), absent ⇒ a READ. It is the input
/// [`connection_for`](crate::exec_context::ExecutionContext) routes on
/// ([`crate::connection_routing::resolve_pool`]), and it is NOT the seam selector: the seam is chosen by
/// `returning` (a RETURNING write runs on [`exec_context::execute`]), the CONNECTION by the statement's
/// own mode. Conflating the two sent `INSERT … RETURNING` to the READ REPLICA (#207). Same rule in all
/// five languages (TS `prepareSql`, go `ExecuteSQL`).
fn statement_intent(write: Option<&WriteMode>) -> StatementIntent {
    match write {
        Some(_) => StatementIntent::write(),
        None => StatementIntent::read(),
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
    // Assemble the DYNAMIC (SKIP) WHERE FIRST when a plan is present: drop skipped fragments, splice the
    // survivors before the first tail keyword, and bind their params before the base params — the
    // effective statement the `?`→`$N` render (`finalize_sql`, below) then operates on. An ABSENT plan
    // leaves the bounded sql/params untouched (pass-through).
    let (sql, params) = match opts.where_frags {
        None => (sql_port, params_port),
        Some(frags) => assemble_dynamic_where(&sql_port, params_port, frags),
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
    let intent = statement_intent(opts.write.as_ref());
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
    fn payload(ports: Vec<(&str, WireValue)>) -> WireRow {
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
        write: WireValue,
        where_dynamic: WireValue,
        guard: WireValue,
    ) -> (&'static str, WireValue) {
        (
            "opts",
            wrow(&[
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
                opts(write_mode(false), WireValue::Null, WireValue::Null),
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
                ports.push(opts(WireValue::Null, WireValue::Null, g));
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

    // The DYNAMIC (SKIP) WHERE assembled by execute_sql (leaves.ts assembleDynamicWhere / whereSplice),
    // proven end-to-end against a real in-memory sqlite: a surviving fragment splices ` WHERE …` before
    // the first tail keyword (ORDER BY) — exactly a bounded WHERE's position — its params bind BEFORE
    // the base params, and a `skipped` fragment is DROPPED (its param never binds). The rust leg of the
    // five-language SKIP-WHERE parity.
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
        // frag 0 survives (`id > 1`); frag 1 is skipped (`v = 'zzz'`) — its param must NEVER bind.
        let plan = wrow(&[(
            "frags",
            wlist(vec![
                frag(false, "id > ?", WireValue::int(1)),
                frag(true, "v = ?", WireValue::Str("zzz".into())),
            ]),
        )]);
        let out = with_ambient_context(&exec_context::for_driver(&d), || {
            execute_sql(payload(vec![
                opts(WireValue::Null, plan, WireValue::Null),
                ("params", wlist(vec![])),
                ("sql", WireValue::Str("SELECT id FROM t ORDER BY id".into())),
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
        let run = |ports: Vec<(&str, WireValue)>| -> Result<WireValue, BehaviorError> {
            with_ambient_context(&exec_context::for_driver(&d), || {
                execute_sql(payload(ports.clone()))
            })
        };
        // An `opts` record whose `whereDynamic` carries ONE fragment (the #209 cases).
        let plan_of = |frag: WireValue| -> Vec<(&str, WireValue)> {
            let mut p = base();
            p.push(opts(
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
        let cases: Vec<(&str, Vec<(&str, WireValue)>, &str)> = vec![
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
                        wrow(&[("guard", WireValue::Null), ("write", WireValue::Null)]),
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
                    p.push(opts(wrow(&[]), WireValue::Null, WireValue::Null));
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
                    p.push(opts(WireValue::Null, wrow(&[]), WireValue::Null));
                    p
                },
                "`whereDynamic.frags` is absent",
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
        all_null.push(opts(WireValue::Null, WireValue::Null, WireValue::Null));
        assert_eq!(items(&run(all_null).unwrap()).len(), 3);
        // …and a cap that IS spelled still trips (the fail-closed reads did not disarm it).
        let mut capped = base();
        capped.push(opts(WireValue::Null, WireValue::Null, cap));
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
        let plan = wrow(&[(
            "frags",
            wlist(vec![wrow(&[
                ("skipped", WireValue::Bool(false)),
                ("sql", WireValue::Str("v = ?".into())),
                ("params", wlist(vec![WireValue::Str("c".into())])),
            ])]),
        )]);
        let out = with_ambient_context(&exec_context::for_driver(&d), || {
            execute_sql(payload(vec![
                opts(WireValue::Null, plan, WireValue::Null),
                ("params", wlist(vec![WireValue::int(1), WireValue::int(2)])),
                (
                    "sql",
                    WireValue::Str("SELECT id FROM t WHERE id > ? ORDER BY id LIMIT ?".into()),
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
            let mut ports: Vec<(&str, WireValue)> = vec![
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

    // #207 — the leaf hands the central seam ONE `StatementIntent`, derived from the statement's RUN
    // MODE, and `connection_for` resolves the CONNECTION from it (`resolve_pool`: write ⇒ the writer
    // pool). The branch that selects the SEAM is a DIFFERENT question: a RETURNING write runs on the ROW
    // seam (`exec_context::execute`) and is still a write. Deriving the intent from the branch — which is
    // what this transport did — sent `INSERT … RETURNING` to the READ REPLICA. The conformance/livedb
    // setups run reader === writer, which is why no cross-language leg saw it.
    //
    // The other four legs drive the leaf against a SPLIT reader/writer pair and record which pool served
    // the statement. This one cannot: rust's leaf resolves an ambient `&dyn Driver` and builds its ctx
    // with `exec_context::for_driver`, whose `routing` is `None` — so no routed ctx can reach
    // `execute_sql`, and the intent it hands the seam is inert THERE. The gate therefore joins the two
    // production halves directly: the intent `statement_intent` derives, resolved by the production
    // `resolve_pool` over a split pair.
    #[test]
    fn the_run_mode_not_the_seam_branch_picks_the_pool() {
        use crate::connection_routing::test_support::stub;
        use crate::connection_routing::{
            resolve_pool, ConnectionRegistry, ReaderWriterPools, RoutingConfig, StickyOptions,
            WriterStickyClock,
        };
        use std::sync::Arc;

        let (reader, writer) = (stub("reader"), stub("writer"));
        let routing = RoutingConfig {
            registry: ConnectionRegistry::from_default(ReaderWriterPools {
                reader: Arc::clone(&reader),
                writer: Arc::clone(&writer),
            })
            .build()
            .unwrap(),
            sticky: WriterStickyClock::new(StickyOptions {
                use_writer_after_transaction: false,
                ..Default::default()
            }),
        };
        let pool_of = |write: Option<&WriteMode>| -> &'static str {
            let p = resolve_pool(&statement_intent(write), &routing, false).unwrap();
            if Arc::ptr_eq(p, &writer) {
                "writer"
            } else if Arc::ptr_eq(p, &reader) {
                "reader"
            } else {
                "?"
            }
        };
        // A READ (no write mode) → the READER; BOTH write modes → the WRITER. The RETURNING one is the
        // #207 case: with the intent taken from the seam branch it resolved to the reader.
        assert_eq!(pool_of(None), "reader");
        assert_eq!(pool_of(Some(&WriteMode { returning: true })), "writer");
        assert_eq!(pool_of(Some(&WriteMode { returning: false })), "writer");

        // …and the two decisions are INDEPENDENT, not accidentally aligned: end-to-end on a real sqlite,
        // a RETURNING write takes the ROW seam (its rows come back), a non-returning one the
        // `[{changes,lastInsertRowid}]` summary.
        use crate::driver::SqliteDriver;
        let d = SqliteDriver::in_memory(&[
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)".to_string(),
        ])
        .unwrap();
        let insert = |returning: bool, sql: &str| {
            let ports = vec![
                opts(
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
}
