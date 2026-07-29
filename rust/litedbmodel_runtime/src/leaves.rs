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
use crate::sql_render::finalize_sql;
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

/// The unboxed `guard` port: the relation runaway cap the emitter baked onto a guarded relation child
/// fetch, plus the identity the raised error reports (the Rust twin of the litedbmodel `RelationGuard`
/// record). `model` is optional exactly as [`crate::errors::LimitExceededError::model`] is.
struct RelationGuard {
    limit: i64,
    model: Option<String>,
    relation: String,
}

/// Read the `guard` field of the control record. ABSENT (or null) ⇒ `None` ⇒ the statement is uncapped
/// and NO check runs. PRESENT but malformed is a LOUD port failure, never a silently dropped guard — a
/// guard that fails to unbox is a runaway that would otherwise sail through.
fn port_relation_guard(opts: &mut WireRow) -> Result<Option<RelationGuard>, BehaviorError> {
    let row = match opts.entries.iter().position(|(k, _)| k == "guard") {
        None => return Ok(None),
        Some(i) => match opts.entries.swap_remove(i).1 {
            WireValue::Null => return Ok(None),
            WireValue::Row(r) => r,
            other => return Err(port_mismatch("guard", "row", &other)),
        },
    };
    let field = |name: &str| row.entries.iter().find(|(k, _)| k == name).map(|(_, v)| v);
    let limit = match field("limit") {
        Some(WireValue::Int(n)) => *n,
        Some(other) => return Err(port_mismatch("guard.limit", "int", other)),
        None => return Err(port_mismatch("guard.limit", "int", &WireValue::Null)),
    };
    let relation = match field("relation") {
        Some(WireValue::Str(s)) => s.to_string(),
        Some(other) => return Err(port_mismatch("guard.relation", "string", other)),
        None => return Err(port_mismatch("guard.relation", "string", &WireValue::Null)),
    };
    let model = match field("model") {
        Some(WireValue::Str(s)) => Some(s.to_string()),
        _ => None,
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

/// Read the `whereDynamic` field of the control record — a wire row `{frags: [...]}`. ABSENT (or null)
/// ⇒ `None` ⇒ no dynamic WHERE (the statement passes through unchanged): only a read that declares an
/// OPTIONAL predicate carries a plan (CLAUDE.md §2). PRESENT but wrong-variant, or a malformed
/// fragment, is a LOUD failure.
fn port_dynamic_where(opts: &mut WireRow) -> Result<Option<Vec<DynamicWhereFrag>>, BehaviorError> {
    let row = match opts.entries.iter().position(|(k, _)| k == "whereDynamic") {
        None => return Ok(None),
        Some(i) => match opts.entries.swap_remove(i).1 {
            WireValue::Null => return Ok(None),
            WireValue::Row(r) => r,
            other => return Err(port_mismatch("whereDynamic", "row", &other)),
        },
    };
    let frags = match row.entries.into_iter().find(|(k, _)| k == "frags") {
        Some((_, WireValue::List(l))) => l.items,
        Some((_, other)) => return Err(port_mismatch("whereDynamic.frags", "list", &other)),
        None => {
            return Err(BehaviorError::new(
                "LEAF_PORT",
                "scp leaf: port `whereDynamic.frags` is absent from the plan",
            ))
        }
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
    write: bool,
    returning: bool,
    where_frags: Option<Vec<DynamicWhereFrag>>,
    guard: Option<RelationGuard>,
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
        write: port_bool(&mut row, "write")?,
        returning: port_bool(&mut row, "returning")?,
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

/// The SOLE SQL transport leaf (leaves.ts `executeSQL`). Binds `params` and runs `sql` through the
/// central seam ([`exec_context::execute`] / [`exec_context::run`]) on the AMBIENT driver — the ONLY
/// driver contact. `opts.write` selects `run` (INSERT/UPDATE/DELETE) vs `execute` (SELECT / RETURNING);
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
    let driver = current_driver()?;
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
    let rendered = finalize_sql(&sql, &value_params, driver.dialect());
    let ctx = exec_context::for_driver(driver);
    if opts.write && !opts.returning {
        let info = exec_context::run(&ctx, &rendered, &value_params, &StatementIntent::write())
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
        let rows = exec_context::execute(&ctx, &rendered, &value_params, &StatementIntent::read())
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
        write: bool,
        returning: bool,
        where_dynamic: WireValue,
        guard: WireValue,
    ) -> (&'static str, WireValue) {
        (
            "opts",
            wrow(&[
                ("guard", guard),
                ("returning", WireValue::Bool(returning)),
                ("whereDynamic", where_dynamic),
                ("write", WireValue::Bool(write)),
            ]),
        )
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
                opts(true, false, WireValue::Null, WireValue::Null),
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
                ports.push(opts(false, false, WireValue::Null, g));
            }
            with_ambient_driver(&d, || execute_sql(payload(ports.clone())))
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
        let out = with_ambient_driver(&d, || {
            execute_sql(payload(vec![
                opts(false, false, plan, WireValue::Null),
                ("params", wlist(vec![])),
                ("sql", WireValue::Str("SELECT id FROM t ORDER BY id".into())),
            ]))
        })
        .unwrap();
        // WHERE id > 1 → ids {2,3}; the skipped `v = ?` fragment was dropped (else a bind-count error
        // or 0 rows). Proves splice position, skip-drop, and the single surviving param binding.
        assert_eq!(items(&out).len(), 2);
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
        let out = with_ambient_driver(&d, || {
            execute_sql(payload(vec![
                opts(false, false, plan, WireValue::Null),
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
    }
}
