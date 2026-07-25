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
 * The ports are declared `WireValue` / `WireValue[]` — bc's OPAQUE wire type. A binding annotated
 * `WireValue[]` stays opaque (wire passthrough), so an intermediate result flows leaf→leaf with no
 * typed↔generic round-trip; the SINGLE de-box happens at the one binding that declares a CONCRETE row
 * type. A relation op therefore runs `executeSQL → pluck → executeSQL → … → group` entirely on the
 * wire plane and materializes the whole nested typed graph exactly once, at the end.
 */

import { leaf, type WireValue } from 'behavior-contracts';

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

/**
 * The three OP-AGNOSTIC leaf transports. The bodies are declaration stubs — `bc generate --from`
 * reads this source and derives the catalog from the signatures; the executable side is the handler
 * map in `./leaves` (TS) and the per-language runtime transports (`execute_sql` / `pluck_keys` /
 * `group_children`, see {@link import('./leaves').LEAF_TRANSPORT_SYMBOLS}).
 */
export class Db {
  /**
   * The SOLE SQL transport: bind `params` and run `sql` through the central execute/run seam.
   * `write` selects `run` (INSERT/UPDATE/DELETE) vs `execute` (SELECT / RETURNING); `returning` keeps
   * a RETURNING write on the row path; `bigint` runs the read in exact-integer mode. A non-returning
   * write yields the one-row `[{changes, lastInsertRowid}]` summary so the output shape is uniform.
   */
  @leaf static executeSQL(sql: string, params: WireValue[], write: boolean, returning: boolean, bigint: boolean, whereDynamic?: WireValue | null): WireValue[] { return declarationStub('executeSQL', [sql, params, write, returning, bigint, whereDynamic]); }

  /** Relation key extraction: the deduped, non-null key set over the ordered key-column tuple `col`. */
  @leaf static pluck(rows: WireValue[], col: string[]): WireValue[] { return declarationStub('pluck', [rows, col]); }

  /** Relation shaping: nest `children` under each parent's `into`, matching `child[fk]` to `parent[pk]`. */
  @leaf static group(parents: WireValue[], children: WireValue[], pk: string[], fk: string[], into: string, single: boolean): WireValue[] { return declarationStub('group', [parents, children, pk, fk, into, single]); }
}
