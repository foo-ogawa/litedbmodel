// The CODEGEN mode of the TypeScript cell — the TS twin of the go/rust/python/php native cells.
//
// `bc generate --lang typescript-native` (gen-native.sh) emits `behaviors_<dialect>.ts` from the SAME
// authored `@behavior` source every other language's module is generated from. TypeScript is
// type-erased, so the transport cannot be baked into the call the way `--leaf-transport-import` bakes
// it for go/rust; the emitted module takes it as `bindTyped(handlers)`. The handlers are litedbmodel's
// own `leafHandlers` (src/scp/leaves.ts) — the ONE op-agnostic transport, the same one the conformance
// harness wires (conformance/harness.ts). The cell writes no SQL and no node handler of its own.
import Database from 'better-sqlite3';
import { Pool as PgPool, types as pgTypes } from 'pg';
import mysql from 'mysql2/promise';
import { clearMiddlewares, configurePgDeboxTypeParsers, createMiddleware, connectionForDriver, contextForConnection, execute, executeAsync, leafHandlers, leafHandlersAsync, mysqlConnectionPool, mysqlDeboxPoolOptions, pgConnectionPool, PooledAsyncContext, runAsync, use, } from 'litedbmodel/scp';
import { inputFor } from './inputs.js';
import { MYSQL_CONFIG, PG_CONFIG, setupFor } from './cell.js';
export async function openCodegen(dialect) {
    const setup = setupFor(dialect);
    // Count at the runtime's own SQL middleware seam — the same place the go/rust cells count, and the
    // only point every read, write and tx-control statement funnels through.
    let count = 0;
    clearMiddlewares();
    use(createMiddleware({
        execute(next, sql, params) {
            count++;
            return next(sql, params);
        },
    }));
    const mod = (await import(`./behaviors_${dialect}.js`));
    if (dialect === 'sqlite') {
        const db = new Database(':memory:');
        for (const stmt of setup.schema)
            db.exec(stmt);
        const ctx = contextForConnection(connectionForDriver(db));
        const facade = mod.bindTyped(leafHandlers({ exec: ctx, dialect }));
        return {
            dialect,
            sync: true,
            seed: () => {
                const before = count;
                for (const stmt of [...setup.delete, ...setup.insert])
                    execute(ctx, stmt, []);
                count = before; // the fixture runs off the counted seam
            },
            run: (op, it) => {
                facade[op](inputFor(op, it));
            },
            close: () => {
                clearMiddlewares();
                db.close();
            },
            statements: () => count,
            resetStatements: () => {
                count = 0;
            },
        };
    }
    // The read-path de-box knobs the LIBRARY owns (#59): without them `pg` hands back a JS Date and
    // `mysql2` a JS Date for a TIMESTAMP column. They are part of the artifact, not cell convenience —
    // the conformance harness applies exactly these.
    const pool = dialect === 'postgres'
        ? pgConnectionPool((configurePgDeboxTypeParsers(pgTypes), new PgPool({ ...PG_CONFIG, max: 4 })))
        : mysqlConnectionPool(mysql.createPool({
            ...MYSQL_CONFIG,
            ...mysqlDeboxPoolOptions,
            connectionLimit: 4,
        }));
    const ctx = new PooledAsyncContext(pool);
    for (const stmt of setup.schema)
        await runAsync(ctx, stmt, []);
    const facade = mod.bindTypedAsync(leafHandlersAsync({ execAsync: ctx, dialect }));
    return {
        dialect,
        sync: false,
        seed: async () => {
            const before = count;
            for (const stmt of [...setup.delete, ...setup.insert])
                await executeAsync(ctx, stmt, []);
            count = before; // the fixture runs off the counted seam
        },
        run: async (op, it) => {
            await facade[op](inputFor(op, it));
        },
        close: async () => {
            clearMiddlewares();
            await pool.end?.();
        },
        statements: () => count,
        resetStatements: () => {
            count = 0;
        },
    };
}
