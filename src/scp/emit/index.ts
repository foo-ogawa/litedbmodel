/**
 * litedbmodel v2 SCP — the decorator → SCP lowering (CLAUDE.md §1's middle step).
 *
 * `./endpoint` is the ORM user's abstract declaration vocabulary (no SQL); `./emitter` lowers a set of
 * those declarations, plus the model's `@column` / `@hasMany` metadata, into the SCP-restricted TS that
 * `bc generate --from` reads.
 */

export { emitBehaviorModule } from './emitter';
export type { EmitSpec, EmitResult, EmittedEndpoint } from './emitter';
export type {
  ComparisonOp,
  ComparePredicate,
  InPredicate,
  NullPredicate,
  CorrelationTerm,
  ExistsPredicate,
  SubqueryPredicate,
  Predicate,
  RelationSelection,
  QueryView,
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
} from './endpoint';
