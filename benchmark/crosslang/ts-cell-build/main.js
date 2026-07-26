// The TypeScript ORM-bench cell (#162) — the harness. It opens one mode against one dialect, proves
// the statement counts, and times each op into the flat CSV the collector aggregates.
//
//   tsx benchmark/crosslang/ts-cell/main.ts <mode> <dialect> [reps] [warmup]
//   tsx benchmark/crosslang/ts-cell/main.ts safety <mode> <dialect>
//
// <mode> = codegen | v1 | sdk   <dialect> = sqlite | postgres | mysql
//
// TypeScript is the only language with three real execution paths, so the CSV's `cell` column carries
// the mode: `native` for codegen (the same surface the other languages' native cells measure), `v1`
// for the imperative path, `sdk` for the raw-driver baseline. Connection targets come from the TEST_*
// environment, like every other cell.
import { ORM_OPS } from '../contract.js';
import { EXPECTED_STATEMENTS, TX_OPS } from './inputs.js';
import { DIALECTS, MODES } from './cell.js';
import { openCodegen } from './mode-codegen.js';
import { openSdk } from './mode-sdk.js';
import { openV1 } from './mode-v1.js';
const OPS = ORM_OPS.map((o) => o.id);
/** The CSV `cell` label per mode — `native` keeps codegen comparable with the other languages' rows. */
const CSV_CELL = { codegen: 'native', v1: 'v1', sdk: 'sdk' };
function open(mode, dialect) {
    switch (mode) {
        case 'codegen':
            return openCodegen(dialect);
        case 'v1':
            return openV1(dialect);
        case 'sdk':
            return openSdk(dialect);
    }
}
/** Run one op. A sync cell is called directly so its measurement is not charged a microtask. */
async function step(cell, op, it) {
    if (cell.sync)
        cell.run(op, it);
    else
        await cell.run(op, it);
}
async function safety(mode, dialect) {
    const cell = await open(mode, dialect);
    const expected = cell.expectedStatements ?? EXPECTED_STATEMENTS;
    let failed = 0;
    try {
        for (const op of OPS) {
            if (cell.unsupported?.[op]) {
                console.log(`${op.padEnd(20)} NOT SUPPORTED — ${cell.unsupported[op]}`);
                continue;
            }
            await cell.seed();
            cell.resetStatements();
            await step(cell, op, 0);
            const got = cell.statements();
            const want = expected[op];
            const kind = TX_OPS.has(op) ? 'statements (BEGIN + body + COMMIT)' : 'statements';
            if (got !== want) {
                console.log(`${op.padEnd(20)} ${kind}=${got} MISMATCH (expect ${want})`);
                failed++;
            }
            else {
                console.log(`${op.padEnd(20)} ${kind}=${got} (expect ${want})`);
            }
        }
    }
    finally {
        await cell.close();
    }
    return failed;
}
async function measure(mode, dialect, reps, warmup) {
    const cell = await open(mode, dialect);
    const label = CSV_CELL[mode];
    try {
        console.log('cell,dialect,op,iter,us');
        for (const op of OPS) {
            if (cell.unsupported?.[op]) {
                console.error(`  skipping ${op}: ${cell.unsupported[op]}`);
                continue;
            }
            await cell.seed(); // clean fixture per op (as every other cell does)
            for (let it = 0; it < warmup; it++)
                await step(cell, op, it);
            for (let it = 0; it < reps; it++) {
                const g = it + warmup;
                const t = process.hrtime.bigint();
                await step(cell, op, g);
                const us = Number((process.hrtime.bigint() - t) / 1000n);
                console.log(`${label},${dialect},${op},${it},${us}`);
            }
        }
    }
    finally {
        await cell.close();
    }
}
function parseMode(v) {
    if (!v || !MODES.includes(v))
        throw new Error(`mode must be one of ${MODES.join(' | ')} (got ${v ?? 'nothing'})`);
    return v;
}
function parseDialect(v) {
    if (!v || !DIALECTS.includes(v))
        throw new Error(`dialect must be one of ${DIALECTS.join(' | ')} (got ${v ?? 'nothing'})`);
    return v;
}
const argv = process.argv.slice(2);
if (argv[0] === 'safety') {
    const failed = await safety(parseMode(argv[1]), parseDialect(argv[2]));
    if (failed > 0) {
        console.error(`\nFAILED: ${failed} op(s) mismatched.`);
        process.exit(1);
    }
    console.error('\nOK: statement counts exact — relations N+1-free, batch writes one statement, tx atomic.');
}
else {
    await measure(parseMode(argv[0]), parseDialect(argv[1]), Number(argv[2] ?? 300), Number(argv[3] ?? 30));
}
