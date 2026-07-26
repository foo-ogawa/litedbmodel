// What every TypeScript bench mode presents to the runner, and the ONE seed-SSoT reader.
//
// The cell has three modes (#162) because TypeScript is the only language with three real execution
// paths: `codegen` (the bc-generated module over litedbmodel's leaf transport — the twin of the other
// languages' native cells), `v1` (the imperative DBModel path, which builds its SQL at run time), and
// `sdk` (raw better-sqlite3 / pg / mysql2 — the baseline). One `Cell` shape lets the runner time all
// three identically.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const DIALECTS = ['sqlite', 'postgres', 'mysql'];
export const MODES = ['codegen', 'v1', 'sdk'];
const HERE = dirname(fileURLToPath(import.meta.url));
// The bench's connection targets, from the same TEST_* environment the conformance live legs use —
// the TypeScript member of the per-language bench config set (go: `lm_bench/setup/dsn.go`, rust:
// `orm_bench_common`), so each language's cell owns its connection config next to itself.
//
// The cell imports litedbmodel the way a CONSUMER does — `litedbmodel` and `litedbmodel/scp`, resolved
// through the package's own exports map to the built bundles — not through relative paths into `src/`.
// That is both more faithful (the other cells all consume built runtimes: a go module, a crate, an
// installed package) and necessary: behavior-contracts publishes only an `import` condition, and `src/`
// sits under the CJS root package, so a plain node/tsx entry cannot load it. Loading through the
// exports map is also what caught #169 — the root entry did not load at all until it was fixed.
const env = (k, d) => process.env[k] || d;
export const PG_CONFIG = {
    host: env('TEST_DB_HOST', 'localhost'),
    port: Number(env('TEST_DB_PORT', '5433')),
    database: env('TEST_DB_NAME', 'testdb'),
    user: env('TEST_DB_USER', 'testuser'),
    password: env('TEST_DB_PASSWORD', 'testpass'),
};
export const MYSQL_CONFIG = {
    host: env('TEST_MYSQL_HOST', '127.0.0.1'),
    port: Number(env('TEST_MYSQL_PORT', '3307')),
    database: env('TEST_MYSQL_DB', 'testdb'),
    user: env('TEST_MYSQL_USER', 'testuser'),
    password: env('TEST_MYSQL_PASSWORD', 'testpass'),
};
export const SQLITE_CONFIG = { database: ':memory:', driver: 'sqlite' };
export function setupFor(dialect) {
    const path = join(HERE, '..', '.setup', `${dialect}.json`);
    return JSON.parse(readFileSync(path, 'utf8'));
}
