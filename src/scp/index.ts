/**
 * litedbmodel v2 SCP — public surface.
 *
 * The SQL-backend consumer layer over behavior-contracts (spec §1). litedbmodel supplies exactly four
 * things and nothing else:
 *
 *  1. **The leaf transport declaration** — `Db` (`@leaf static executeSQL / pluck / group`), the ONE
 *     `@leaf` catalog every authored / emitted model imports (`./leaf-transport`). `bc generate --from`
 *     reads it; there is no second declaration anywhere in the repo.
 *  2. **The leaf transport implementation** — `leafHandlers` / `leafHandlersAsync` (`./leaves`), the
 *     handler map a bc-generated TS module's `bind(handlers)` / `bindAsync(handlers)` consumes. This is
 *     the whole TS runtime seam: `bind(leafHandlers({ exec, dialect }))`.
 *  3. **The tuned SQL** — the `./makesql` subtree (dialect SELECT / INSERT / UPDATE / DELETE / relation
 *     / batch builders, byte-true to the v1 builders) and the write bundles + gate-first transaction
 *     plans built on it.
 *  4. **The language runtime** — the execution context (connection routing, middleware, transactions),
 *     the relation grouping core, the column-type de-box SoT, and the typed-object read surface.
 *
 * WIRING IS AUTOMATIC. A behavior is declared in TypeScript, bc compiles it, and the only per-language
 * hand-wiring is the harness calling the generated module's method with the handler map above. There is
 * no runtime IR, no programmatic compile, and no runtime behavior dispatch in this package.
 */

// ── CANONICAL: the LOCKED `makeSQL` bc integration (epic #43 / design #45). ──────────
export {
  MAKESQL,
  makeSqlCatalogEntry,
  LITEDBMODEL_MAKESQL_CATALOG,
  isMakeSQL,
  assembleMakeSQL,
  composeMakeSQL,
  renderPlaceholders,
  renderPorts,
  makeSqlHandler,
  makeSqlHandlerSync,
  compileWhere,
  whereClause,
  andTrailing,
  formatterFor,
  pgCastFormatter,
  noCastFormatter,
  compileSelect as compileSelectMakeSQL,
  builderFor,
  compileInsert as compileInsertMakeSQL,
  compileUpdateMany,
  compileUpdateSingle,
  compileDelete as compileDeleteMakeSQL,
  inferPgArrayType,
  resolvePgArrayCast,
  PG_ARRAY_CAST_TOKEN,
  compileSingleKeyUnlimited,
  compileSingleKeyLimited,
  compileCompositeKeyUnlimited,
  compileCompositeKeyStaticUnlimited,
  compileCompositeKeyLimited,
  configurePgDeboxTypeParsers,
  mysqlDeboxPoolOptions,
  pgConnectionPool,
  mysqlConnectionPool,
  pgPoolFactory,
  mysqlPoolFactory,
} from './makesql';
export type {
  MakeSQL,
  SqlParam,
  AssembledSql,
  Dialect as MakeSQLDialect,
  SqlExecutor,
  SqlExecutorSync,
  SelectDesc as MakeSQLSelectDesc,
  RelationCompileBase,
  PgPoolLike,
  MysqlPoolLike,
  PgTypesLike,
  PgModuleLike,
  Mysql2ModuleLike,
} from './makesql';

// The op-INDEPENDENT leaf transport. `Db` is the `@leaf static` DECLARATION every authored / emitted
// model imports (the single catalog `bc generate --from` reads); `leafHandlers`/`leafHandlersAsync` are
// its executable bodies, injected into a generated module's `bind`/`bindAsync`.
export { Db } from './leaf-transport';
// The two dynamic-WHERE control-port types live WITH the leaf catalog (the `--from` SSoT), not the
// runtime bodies; `ExecOptions` (the `opts` control record) and `CapGuard` (its `guard` struct) are
// emitter-internal — the emitted module writes the literal, so nothing downstream names the type.
export type { DynamicWhereFrag, DynamicWherePlan } from './leaf-transport';
export { executeSQL, executeSQLAsync, pluck, group, leafHandlers, leafHandlersAsync, LEAF_TRANSPORT_SYMBOLS, prepareSql, assembleDynamicWhere } from './leaves';
export type { LeafContext, AsyncLeafContext } from './leaves';

// ── The decorator → SCP LOWERING (CLAUDE.md §1): declared endpoints + `@column`/`@hasMany` metadata
// → the SCP-restricted TS `bc generate --from` reads. The emitter builds no SQL of its own — it renders
// what `makesql` / `compileRelationOp` / `deriveReadRow` produce.
export { emitBehaviorModule } from './emit';
export type {
  EmitSpec,
  EmitResult,
  EmittedEndpoint,
  ComparisonOp,
  ComparePredicate,
  InPredicate,
  TupleInPredicate,
  NullPredicate,
  CorrelationTerm,
  ExistsPredicate,
  SubqueryPredicate,
  Predicate,
  RelationSelection,
  QueryView,
  PageBound,
  ReadEndpoint,
  ValueBinding,
  CreateEndpoint,
  UpdateEndpoint,
  DeleteEndpoint,
  CreateManyEndpoint,
  UpdateManyEndpoint,
  DeleteManyEndpoint,
  Endpoint,
  EndpointSet,
} from './emit';


// Dialect strategy table (WS6, #26 — the SSoT for PG/MySQL/SQLite SQL divergences + `?`→`$N`).
export { dialectFor, toDollarPlaceholders, SQLITE, POSTGRES, MYSQL } from './dialect';
export type { Dialect, DialectName } from './dialect';



// Error Mapping (spec §11 item 5): driver error → SCP Failure + Policy Kind.
export { mapSqliteError, SqlFailure, LimitExceededError } from './errors';
export type { SqlFailureKind, LimitExceededContext } from './errors';

// Hard-limit runaway prevention (Phase E-2, epic #74; v1 `setLimitConfig`/`LimitExceededError`
// parity): the global find/hasMany hard-limit config. Read at COMPILE time to bake the effective
// caps onto the portable artifacts (the ReadGraph `findGuard` + each RelationOp `hardLimit`); the
// TS runtime + the native ports throw `LimitExceededError` post-fetch when a read / relation batch
// exceeds its cap. `null` disables; a per-relation `hardLimit` override wins; a relation with an
// intrinsic per-parent `limit` window skips the batch-total check.
export { setLimitConfig, getLimitConfig, resetLimitConfig, resolveFindHardLimit, resolveHasManyHardLimit, assertFindHardLimit } from './limit-config';
export type { LimitConfig } from './limit-config';


// Column type system (spec §4.1; #58): SQL type → bc outType scalar, and the schema/DDL SoT
// resolver that types a SELECT projection for typed (de-boxed) codegen. Fail-closed throughout.
export { sqlTypeToBcScalar, sqlTypeToMaterializeClass, materializeCell, materializeClassOrUndefined, parseSchemaColumnTypes, schemaColumnTypeResolver, materializeResolverFromColumnMap, failClosedMaterializeResolverFromColumnMap, columnTypeResolverFromColumnMap } from './coltype';
export type { BcScalar, MaterializeClass, ColumnTypeResolver, MaterializeResolver } from './coltype';

// The write bundle surface: a compiled write + its derived, gate-first transaction plan (pure JSON,
// executed identically by all five language runtimes).
export type { SqliteDb, ExecuteOptions, SqlBundle } from './write-bundle';

// ── Phase A (#75): the ExecutionContext + central execute/run seam + per-execution connection
// ownership. The CONTRACT-DEFINING artifact the native ports (#76-79) follow. All runtime SQL
// (read/write/tx/relation) funnels through `execute`/`run`; `contextForDriver` is the backward-
// compat wrapper (raw driver ⇒ single-DB, empty-middleware ctx) keeping conformance byte-identical.
export {
  execute,
  executeSafe,
  run,
  executeAsync,
  runAsync,
  runGuarded,
  runGuardedAsync,
  contextForDriver,
  contextForConnection,
  connectionForDriver,
  MiddlewareChain,
  PooledAsyncContext,
  withTransactionAsync,
  transaction,
  runWithPinnedAsyncConnection,
  currentPinnedAsyncConnection,
} from './exec-context';
export type {
  ExecutionContext,
  AsyncExecutionContext,
  StatementIntent,
  Rows,
  RunInfo,
  SyncConnection,
  AsyncConnection,
  AsyncConnectionPool,
  PinnedTx,
  Middleware,
  MiddlewareStackSource,
  SeamNext,
  SqliteDriver,
  TxOptions,
} from './exec-context';

// ── Phase D (#92): the MIDDLEWARE layer on the Phase A seam. The API REFERENCE the native ports
// (#93-96) mirror: registration (`use`/`createMiddleware`), the SQL-level `execute(next, sql, params)`
// chain contract + applied order (first-registered = outermost), method-level hooks keyed by op kind
// (`runMethod`), per-execution-scope isolation (`withMiddlewareScope`, TS AsyncLocalStorage), the
// standard `Logger`, and the raw `execute`/`query` API that goes THROUGH the seam. An unregistered
// chain is a byte-identical passthrough (conformance/livedb register none ⇒ unchanged).
export {
  Registry,
  currentRegistry,
  withMiddlewareScope,
  activeSqlMiddlewares,
  register,
  use,
  createMiddleware,
  runMethod,
  Logger,
  rawExecute,
  rawExecuteAsync,
  rawQuery,
  rawQueryAsync,
  clearMiddlewares,
} from './middleware';
export type {
  SqlHook,
  MethodKind,
  MethodHook,
  MethodNext,
  MiddlewareDescriptor,
  MiddlewareHandle,
  MiddlewareConfig,
  MethodHookFn,
  SqlNext,
  LogEntry,
  LoggerOptions,
  RawResult,
} from './middleware';

// ── Phase C (#87): connection routing + config. The API REFERENCE the native ports (#88-91) mirror.
// Completes `connectionFor(intent)`'s resolution (§3 steps 2-4): reader/writer separation + writer-
// sticky + `withWriter` (C1), a multi-DB name→pools registry + named routing (C2), and the setConfig
// surface (queryTimeout/keepAlive/pool sizing/searchPath/charset) + closeAllPools (C3). A single-pool
// `PooledAsyncContext` synthesizes a default-only registry (reader === writer, sticky off) ⇒ byte-
// identical to Phase A/B; a `buildRoutingConfig`-driven ctx gets the full routing.
export {
  ConnectionRegistry,
  ConnectionRegistryBuilder,
  WriterStickyClock,
  DEFAULT_CONNECTION,
  withWriter,
  inWriterScope,
  resolvePool,
  resolveConnectionConfig,
  sessionStatements,
  sessionResetStatements,
  configuredPool,
  singlePoolPair,
  readerWriterPair,
  buildRoutingConfig,
} from './connection-routing';
export type {
  ConnectionConfig,
  ResolvedConnectionConfig,
  ReaderWriterPools,
  RoutingConfig,
  ConnectionSetup,
  PoolCloser,
  PoolFactory,
} from './connection-routing';

// The tx-completeness contract (Phase B-1 / #81): TransactionOptions shape + defaults, the
// isolation-level enum + per-dialect BEGIN mapping, the retryable-error classifier, the write=tx
// guards (`checkWriteAllowed` + `withReadOnly` / `runInTransactionScope` scope markers). The API
// REFERENCE the 4 native ports (rust #82 / go #83 / py #84 / php #85) mirror.
export {
  isolationPhrase,
  beginStatements,
  resolveTxOptions,
  isRetryableTxError,
  sleep,
  runInTransactionScope,
  withReadOnly,
  isInTransaction,
  isReadOnly,
  checkWriteAllowed,
  WriteOutsideTransactionError,
  WriteInReadOnlyContextError,
} from './tx-options';
export type { IsolationLevel, TransactionOptions, ResolvedTxOptions } from './tx-options';


// Write-time relations (WS5, #25 — spec §6): entityWrites/edgeWrites declaration vocabulary,
// the gate-first transaction-plan derivation, and the 1-tx real-SQLite runtime.
export {
  entityWrites,
  edgeWrites,
  lifecycleFor,
  parseEffectPath,
  ENTITY_ROOT,
} from './writes';
export type {
  PathRoot,
  EffectPath,
  RequiresEffect,
  UniqueEffect,
  DeriveEffect,
  EdgeEffect,
  EmitEffect,
  IdempotencyEffect,
  LifecycleEffects,
  LifecycleContract,
  WriteLifecyclePhase,
  EntityWritesDefinition,
  EntityWritesShape,
  WriteRecorder,
} from './writes';

export { deriveTransactionPlan, executeTransaction, executeTransactionAsync, countingDriver, renderTxStatement, compileWriteNode, mysqlPkHint, stripMysqlPkHint } from './makesql';
export type {
  TxExpr,
  TxOp,
  StatementRole,
  GateRule,
  TxStatement,
  TransactionPlan,
  IdempotentHitPolicy,
  BaseWrite,
  TransactionResult,
  ShortCircuitReason,
  WriteExecOptions,
} from './makesql';

// The Command bundle + 1-tx execution surface (WS5 — the write path of §2.3 / §6).
export { compileWriteBundle, executeTransactionBundle } from './write-bundle';

// Composite (multi-write) Command surface (WS8a, #28 — spec §6 nested write / §14 tx-DAG derivation):
// several named base writes with data dependencies → ONE topologically-ordered gate-first tx plan.
export { compileCompositeWriteBundle } from './write-bundle';
export type { CompositeWriteEntry } from './write-bundle';

// Batch writes (createMany / updateMany / deleteMany): ONE logical op → N grouped statements lowered
// to a gate-free tx plan (executed by the SAME multi-statement tx loop in all 5 runtimes). The
// batch SQL is byte-copied from the v1 builders (compileInsertMany/compileUpdateMany/compileDeleteMany).
export { compileCreateManyBundle, compileUpdateManyBundle, compileDeleteManyBundle } from './write-bundle';
export { compileDeleteMany, compileInsertMany } from './makesql';
// dbCast: the column-type cast marker the makeSQL compilers thread into WHERE/SET (spec §4.1).
// Re-exported so a bundle consumer builds the SAME DBCast instance the inlined compilers recognise
// (a standalone dist/DBValues copy is a DIFFERENT class → the compiler would not honour the cast).
export { dbCast, dbCastIn } from '../DBValues';

// Read relations (WS4, #24): pre-compiled batch relation ops + staged batch resolution.
// BOTH the declarative-select and the lazy surface resolve through the SAME compiled op.
export {
  compileRelationOp,
  runRelationOp,
  distributeToParent,
  RELATION_KEYS_HEAD,
} from './relation';
export type {
  RelationKind,
  RelationDecl,
  RelationOp,
  RelationBatch,
  RelationDriver,
} from './relation';

// typed-object result + hydrate factory + lazy relation context (WS4, #24).
export {
  buildResultSet,
  readRelationContext,
  RelationContext,
  RELATION_CONTEXT,
} from './typed-object';
export type { HydrateFactory, ReadOptions } from './typed-object';

// ── Phase F-1 (#104): the decorator → SCP authoring ADAPTER. Translates the `@model` / `@column` /
// `@hasMany` decorator metadata into the SCP authoring it lowers to (columns → `static columns`;
// find/count → eager Select/Count; create/update/delete → write bundles; relations → RelationDecl →
// RelationOp). Standalone + unit-proven byte-identical to the hand-written SCP behavior; does NOT yet
// rewire DBModel's methods (F2). TS-only, zero BC. Mirrors graphddb's collector→define→compile.
export {
  deriveModelColumns,
  columnSqlType,
  tableNameOf,
  COLUMN_FAMILY_SQL_TYPE,
  DEFAULT_UNCAST_SQL_TYPE,
  compileCreateBundle,
  compileUpdateBundle,
  compileDeleteBundle,
  modelColumnResolver,
  relationKeyTypeResolver,
  deriveRelationDecls,
  relationDeclOf,
  compileRelationOps,
} from './decorator-adapter';
export type { ModelClassLike, DeriveColumnsOptions, ModelColumns, KeyTypeResolver } from './decorator-adapter';

// The bc AUTHORING markers, re-exported so a consumer declares its endpoints from one import. The
// bodies are ordinary TypeScript; `bc generate --from <file> --behavior <Class>` reads the source.
export { behavior, leaf, opt, refsConnection, AuthoringFailure } from 'behavior-contracts';
export type { Int, Float, WireValue, AuthoringFailureCode } from 'behavior-contracts';
