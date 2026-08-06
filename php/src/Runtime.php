<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime;

/**
 * litedbmodel v2 SCP — PHP runtime version SSoT (WS7d, #33).
 *
 * The self-built `SqlBundle`/`ReadGraph`/tx-plan execution was deleted (#227): the only execution
 * path is the bc-generated native module bound to the leaf transport ({@see Leaves::makeHandlers} →
 * `executeSQL`/`pluck`/`group` → the central execute/run/runGuarded seam in {@see ExecutionContext}).
 * This class now carries only the in-source version mirror that `scripts/sync-versions.mjs` keeps in
 * lockstep with `package.json` (the Packagist git-tag mirror).
 */
final class Runtime
{
    /** Version mirrored from package.json by scripts/sync-versions.mjs (SSoT). */
    public const VERSION = '2.2.6';
}
