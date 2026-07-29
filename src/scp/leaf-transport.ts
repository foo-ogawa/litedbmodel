/**
 * litedbmodel v2 SCP — the op-INDEPENDENT leaf transport DECLARATION (the `@leaf static` SSoT).
 *
 * The whole per-DSL execution surface is THREE op-agnostic leaves. This module DECLARES them on
 * behavior-contracts' native TS authoring surface and NOTHING else: it imports only
 * `behavior-contracts`, holds no implementation, and is READ by `bc generate --from` (the bodies are
 * never executed — bc derives each leaf's catalog entry from the signature alone).
 *
 * Every authored / emitted litedbmodel model imports `Db` FROM HERE, so there is exactly one leaf
 * catalog in the repo: change a port here and every generated module in every language follows. The
 * runtime side of the same three symbols lives in `./leaves` (the handler bodies + the native
 * transport symbol map); it is deliberately a DIFFERENT module so a `--from` typecheck of an authored
 * model pulls in the declaration only, never the driver stack.
 *
 * ## The port vocabulary
 *
 * The DATA ports are declared `WireValue` / `WireValue[]` — bc's OPAQUE wire type. A binding annotated
 * `WireValue[]` stays opaque (wire passthrough), so an intermediate result flows leaf→leaf with no
 * typed↔generic round-trip; the SINGLE de-box happens at the one binding that declares a CONCRETE row
 * type. A relation op therefore runs `executeSQL → pluck → executeSQL → … → group` entirely on the
 * wire plane and materializes the whole nested typed graph exactly once, at the end.
 *
 * Everything a statement carries BESIDES its text and its bound values rides in ONE optional CONTROL
 * struct, {@link ExecOptions} (`opts`): how to run it (`write` / `returning`) and the two CONCRETE
 * control structs — {@link DynamicWherePlan} (`whereDynamic`) and {@link CapGuard} (`guard`) — the
 * emitter CONSTRUCTS at the call site from the endpoint's own parameters (not leaf→leaf wire values),
 * so a native-codegen emitter builds them as typed structs. It is ONE argument because a mode flag is a
 * NAMED FIELD there: a positional list grows a new slot per fact and every call site's remaining
 * arguments shift (#193), and a trailing optional port can only be reached by passing a filler for the
 * one before it. A PLAIN READ omits `opts` entirely (native-clean — the payload carries `sql`/`params`
 * and nothing else); every other statement spells the whole record, so absence is `null` (a fact) and
 * never a stand-in value. bc typed-native lowers a NON-NULL struct into an `opt<named>` port via
 * `optSome` (bc#275), so a concrete optional port is native — no boxing. The fragment vocabulary is
 * CLAUDE.md §2's: SQL + params + a SKIP FLAG (a homogeneous `{skipped, sql, params}` struct), assembled
 * by the leaf at run — never a `cond`-to-null variant element (which the native-codegen emitters reject).
 */

import { leaf, type Int, type WireValue } from 'behavior-contracts';

/**
 * The body of every declaration below. A `@leaf` body is never lowered and never executed — bc derives
 * the catalog entry from the SIGNATURE alone — so calling a leaf on the TS plane is a wiring bug, and
 * this throws rather than returning a plausible empty result. Taking `args` keeps every declared
 * parameter genuinely referenced (they are the PORT NAMES; they may not be renamed or dropped).
 */
function declarationStub(leafName: string, args: readonly unknown[]): never {
  void args;
  throw new Error(
    `litedbmodel Db.${leafName} is a leaf DECLARATION read by \`bc generate\` — it has no TS body. ` +
      `The executable transport is the handler map \`leafHandlers\` / \`leafHandlersAsync\` in ./leaves.`,
  );
}

// ── the two CONCRETE control-port structs (the leaf-contract SSoT; read by `bc generate --from`) ─────

/**
 * ONE dynamic-WHERE fragment — always an OPTIONAL predicate's, never a bounded one's (a bounded
 * predicate is lowered into the statement's static WHERE at emit, CLAUDE.md §2). The fragment
 * vocabulary that §2 fixes: the fragment's SQL text, its bound `params`, and a SKIP FLAG — nothing
 * else. `skipped` carries the per-call SKIP decision as DATA (`param === null`), so every element of a
 * plan is the SAME struct — never a `cond`-to-null variant, which the native-codegen emitters reject.
 * `params` rides opaque (`WireValue[]`) exactly like the base `params` port; the leaf binds them in
 * order. The runtime side ({@link import('./leaves')}) READS this struct — it never constructs one — so
 * the one definition serves both the emitter's authored literal and the leaf's runtime assembly.
 */
export interface DynamicWhereFrag {
  readonly skipped: boolean;
  readonly sql: string;
  /**
   * The fragment's bound params (`WireValue`), the SAME order the fragment's `?`s appear. The predicate
   * binds its own parameter, which is `null` exactly when the fragment is SKIPPED — so the element is
   * `WireValue | null`; a skipped fragment's params are never bound (the leaf drops it), so the null is
   * inert.
   */
  readonly params: (WireValue | null)[];
}

/**
 * The dynamic-WHERE plan a SKIP read carries (OPTIONAL — a read with no optional predicate omits it): a
 * HOMOGENEOUS fragment list the leaf assembles at run, dropping the `skipped` fragments and continuing
 * the statement's static WHERE with the survivors.
 */
export interface DynamicWherePlan {
  readonly frags: readonly DynamicWhereFrag[];
}

/**
 * The relation runaway cap a GUARDED child fetch carries — the bc wire-construction twin of the runtime
 * {@link import('./limit-config').RelationGuard} (the emitter serializes the compiled op's resolved
 * guard into this shape; the leaf transport asserts the raw child-row count against it). It is a
 * SEPARATE type on purpose: `limit` is bc's `Int` brand so the native struct field is an integer (a
 * plain `number` would emit as a float and the wire int-probe would miss it), whereas the runtime
 * `RelationGuard` is `number`-typed because it is CONSTRUCTED from `resolveHasManyHardLimit`'s plain
 * numbers — the two cannot be one type. `model` is optional exactly as `LimitExceededError.model` is.
 */
export interface CapGuard {
  readonly limit: Int;
  readonly model?: string;
  readonly relation: string;
}

/**
 * EVERYTHING a statement carries besides its text and its bound values — the ONE optional control
 * argument of {@link Db.executeSQL}. A plain read OMITS it; every other statement spells the WHOLE
 * record, because bc types a port by the literal wired into it and rejects a partial one
 * (`the value wired into it has type obj{…}` — an omitted field is a different type, not a default).
 * That is the point: absence is the `null` VALUE of a NAMED field, so no call site ever passes a
 * stand-in value to reach the field after it.
 *
 * `write` and `returning` describe the STATEMENT, not the transport's branch: `write` is the
 * statement's intent (it selects the write seam and the write connection), `returning` says the write
 * yields ROWS. The transport reads them together — a write that does NOT return rows yields the
 * one-row `[{changes, lastInsertRowid}]` summary instead, which is what keeps the leaf's output shape
 * uniform. A read declares both `false`.
 */
export interface ExecOptions {
  /** The statement WRITES (INSERT/UPDATE/DELETE — the write seam + the write intent). */
  readonly write: boolean;
  /** The write yields ROWS (a RETURNING write) rather than the affected-rows summary. */
  readonly returning: boolean;
  /** The DYNAMIC (SKIP) WHERE plan — `null` unless the read declares an OPTIONAL predicate. */
  readonly whereDynamic: DynamicWherePlan | null;
  /** The RELATION runaway cap — `null` unless this is a GUARDED relation child fetch. */
  readonly guard: CapGuard | null;
}

/**
 * The three OP-AGNOSTIC leaf transports. The bodies are declaration stubs — `bc generate --from`
 * reads this source and derives the catalog from the signatures; the executable side is the handler
 * map in `./leaves` (TS) and the per-language runtime transports (`execute_sql` / `pluck_keys` /
 * `group_children`, see {@link import('./leaves').LEAF_TRANSPORT_SYMBOLS}).
 */
export class Db {
  /**
   * The SOLE SQL transport: bind `params` and run `sql` through the central execute/run seam. Its
   * whole control surface is the OPTIONAL {@link ExecOptions} record: `opts.write` selects `run`
   * (INSERT/UPDATE/DELETE) vs `execute` (SELECT / RETURNING) and `opts.returning` keeps a RETURNING
   * write on the row path — a non-returning write yields the one-row `[{changes, lastInsertRowid}]`
   * summary so the output shape is uniform. `opts.guard` is the RELATION runaway cap
   * ({@link CapGuard}, the compiled op's own resolved cap) a guarded relation child fetch carries: the
   * transport asserts the fetched row count against it and raises `LimitExceededError` when the batch
   * overruns. It rides HERE because this is where the RAW child rows exist — past `group` the graph is
   * already nested — and because SCP has no throw. `opts.whereDynamic` is the SKIP plan of a read that
   * declares an optional predicate (CLAUDE.md §2 "only actually-optional predicates accumulate a plan").
   *
   * A PLAIN READ omits `opts` (native-clean: the payload is `sql` + `params`); bc typed-native lowers a
   * non-null struct into the `opt<named>` port via `optSome` (bc#275), so the record is a native struct
   * literal in go / rust with no boxing.
   */
  @leaf static executeSQL(sql: string, params: WireValue[], opts?: ExecOptions | null): WireValue[] { return declarationStub('executeSQL', [sql, params, opts]); }

  /** Relation key extraction: the deduped, non-null key set over the ordered key-column tuple `col`. */
  @leaf static pluck(rows: WireValue[], col: string[]): WireValue[] { return declarationStub('pluck', [rows, col]); }

  /** Relation shaping: nest `children` under each parent's `into`, matching `child[fk]` to `parent[pk]`. */
  @leaf static group(parents: WireValue[], children: WireValue[], pk: string[], fk: string[], into: string, single: boolean): WireValue[] { return declarationStub('group', [parents, children, pk, fk, into, single]); }
}
