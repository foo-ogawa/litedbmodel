//! Native shared runtime for the typed-native codegen path: Driver/exec seam, the BC-owned Wire
//! types, the op-agnostic leaves (execute_sql/pluck_keys/group_children), and the grouping SSoT.
//! rust is native-codegen ONLY — there is no IR-exec interpreter.

pub mod connection_routing;
pub mod dialect;
pub mod driver;
pub mod errors;
pub mod exec_context;
pub mod grouping;
pub mod leaves;
pub mod middleware;
pub mod sql_render;
pub mod tx_options;
pub mod value_codec;
pub mod wire;

/// WS7g (#36) live PostgreSQL / MySQL drivers — behind the `livedb` feature so the default
/// conformance build (SQLite bar) needs neither the `postgres` nor `mysql` crate.
#[cfg(feature = "livedb")]
pub mod livedb;

/// Version mirrored from package.json by scripts/sync-versions.mjs (SSoT).
pub const VERSION: &str = "2.2.5";

// ── public surface (mirrors the Python `__all__`) ──────────────────────────────
pub use connection_routing::{
    build_routing_config, resolve_pool, session_reset_statements, session_statements, BuiltPool,
    Clock, ConfigDialect, ConnectionConfig, ConnectionRegistry, ConnectionRegistryBuilder,
    ConnectionSetup, ManualClock, PoolFactory, PoolRole, ReaderWriterPools,
    ResolvedConnectionConfig, RoutingConfig, RoutingHandle, StickyOptions, SystemClock,
    WriterStickyClock, DEFAULT_CONNECTION,
};
#[cfg(feature = "livedb")]
pub use connection_routing::{mysql_pool_factory, pg_pool_factory};
pub use dialect::{dialect_for, to_dollar_placeholders, Dialect};
pub use driver::{ConfiguredDriver, Driver, PreparedStatement, RunInfo, SqliteDriver};
pub use errors::{
    check_find_hard_limit, map_sqlite_error, re_error_to_sql_failure, LimitExceededError,
    RuntimeError, SqlFailure, LIMIT_CONTEXT_FIND, LIMIT_CONTEXT_RELATION,
};
pub use exec_context::{
    execute as seam_execute, for_driver, for_routing, run as seam_run, run_guarded, transaction,
    transaction_decided, transaction_decided_on, transaction_on, with_transaction,
    with_transaction_decided, with_transaction_decided_isolated, Connection, DriverConnection, Dyn,
    ExecutionContext, Middleware, MiddlewareChain, SeamResult, SessionConnection, StatementIntent,
    TxConnection, TxConnectionRef, TxDecision,
};
// Phase D (#93) — the middleware layer (SQL-level `execute` hook + method-level hooks + Logger +
// raw execute/query), mirroring the TS `src/scp/middleware.ts` API reference.
#[cfg(feature = "livedb")]
pub use livedb::{MysqlDriver, PostgresDriver};
pub use middleware::{
    active_sql_empty, active_sql_hooks, clear_middlewares, create_middleware, logger, raw_execute,
    raw_query, register_method_hook, register_middleware, run_method, use_middleware,
    with_middleware_scope, with_middleware_scope_opts, LogEntry, LoggerState, MethodHook,
    MethodKind, MethodNext, MiddlewareDescriptor, MiddlewareHandle, RawResult, SqlHook, SqlHookFn,
    SqlNext, StateAny,
};
// The shared relation-grouping CORE (#141) — the ONE Value-based grouping SSoT (twin of the TS
// `src/scp/grouping.ts`), consumed by the op-agnostic wire leaves.
pub use grouping::{attach_to_parent, dedupe_key_tuples, group_by_key, key_identity};
// The op-agnostic wire LEAVES (#141/#164) — the THREE transport symbols the native codegen calls
// directly (`execute_sql`/`pluck_keys`/`group_children`, leaves.ts `LEAF_TRANSPORT_SYMBOLS`), plus
// the ambient-CONTEXT scope the covered runner resolves them against (the ctx is what carries the
// connection routing into the leaf). They consume the grouping CORE.
pub use leaves::{
    execute_sql, group_children, pluck_keys, with_ambient_context, with_ambient_transaction,
};
// The BC-OWNED shared wire + error-value types (#164/#165 `--shared-types-import`) the leaves BUILD
// and the generated covered runners de-box (stand-in for post-#165 bc regen — see `wire.rs`).
pub use sql_render::{finalize_sql, render_placeholders};
pub use tx_options::{
    begin_statements, check_write_allowed, is_connection_error, is_retryable_tx_error,
    isolation_prelude, write_in_read_only, write_outside_transaction, Dialect as TxDialect,
    IsolationLevel, TransactionOptions,
};
// The wire types AND the probe classifiers. A generated module reaches them through
// `use litedbmodel_runtime::*` (`--shared-types-import litedbmodel_runtime`), so every symbol the
// generated de-box calls must be re-exported here — the probes became free functions when they stopped
// cloning (they CONSUME the wire value), and omitting them leaves the generated module uncompilable.
pub use wire::{
    probe_bool_at, probe_float_at, probe_int_at, probe_list_at, probe_row_at, probe_string_at,
    BehaviorError, ErrorDetail, ErrorKind, Probe, WireList, WireRow, WireValue,
};

/// The bc runtime value used by native driver, wire, parameter, and relation primitives.
pub use behavior_contracts::Value;
