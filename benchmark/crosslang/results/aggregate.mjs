// Aggregate the committed raw per-iteration CSVs into the report. Reads ONLY the committed raw data —
// every printed number traces to a saved CSV line (reproducible, non-fabricated).
//
//   node benchmark/crosslang/results/aggregate.mjs
//
// Layout: `<lang>.<surface>.<dialect>.csv` at this directory's root is the scale-1 fixture (the one the
// ORM-vs-ORM bench measures against). A subdirectory named `scale-<factor>` holds the same files
// re-measured over a re-scaled fixture (`emit-setup.ts <factor>`); with two or more scales present, the
// per-op latency is regressed on the measured row count to split the FIXED per-call overhead (the
// intercept) from the PER-ROW cost (the slope) — #170.
//
// CSV rows: `cell,dialect,op,iter,us,rows`. `rows` is the number of rows the op moved across the
// DB→client boundary, measured by each cell at its own exec seam. It is the per-row normalization
// denominator, and — because every cell of every language runs byte-identical SQL over one shared
// fixture — cells that disagree on it are doing DIFFERENT work, which the fairness section reports
// loudly instead of averaging away.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OPS = ['findAll','filterPaginateSort','findFirst','findUnique','nestedFindAll','nestedFindFirst','nestedFindUnique','nestedRelations','compositeRelations','create','update','upsert','createMany','upsertMany','updateMany','nestedCreate','nestedUpsert','nestedUpdate','delete'];
const LANGS = ['typescript','go','rust','python','php'];
const DIALECTS = ['sqlite','postgres','mysql'];
const FILE_RE = /^([a-z]+)\.(native|sdk|v1)\.(sqlite|postgres|mysql)\.csv$/;

function p50(nums){ if(!nums.length) return null; const s=[...nums].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2? s[m] : (s[m-1]+s[m])/2; }

// key: scale|lang|surface|dialect|op -> {us:[…], rows:Set}
const data = new Map();
const scales = new Set();

function readDir(dir, scale) {
  for (const f of readdirSync(dir)) {
    const path = join(dir, f);
    if (statSync(path).isDirectory()) {
      const m = f.match(/^scale-([0-9.]+)$/);
      if (m) readDir(path, Number(m[1]));
      continue;
    }
    const m = f.match(FILE_RE);
    if (!m) continue;
    const [, lang, surface, dialect] = m;
    scales.add(scale);
    for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
      if (line.startsWith('cell,')) continue;
      const c = line.split(',');
      if (c.length < 5) continue;
      const [, dcol, op, , us, rows] = c;
      if (dcol !== dialect) continue; // guard: the CSV's own dialect column must match the filename
      const key = `${scale}|${lang}|${surface}|${dialect}|${op}`;
      let e = data.get(key);
      if (!e) data.set(key, (e = { us: [], rows: new Set() }));
      e.us.push(Number(us));
      // An empty `rows` field means the cell has no row-observing seam (TS v1 on SQLite reaches the DB
      // through the in-proc path, whose only hook carries the SQL text). Recorded as unknown, never 0.
      if (rows !== undefined && rows !== '') e.rows.add(Number(rows));
    }
  }
}
readDir(HERE, 1);

const at = (scale, lang, surface, dialect, op) => data.get(`${scale}|${lang}|${surface}|${dialect}|${op}`);
/** The rows an op moved, or null when unmeasured. Cells that disagree are reported, not reconciled. */
function rowsOf(e){ if(!e || e.rows.size !== 1) return null; return [...e.rows][0]; }
const fmt = (n, d = 0) => n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// ── ① absolute p50 + the native÷sdk ratio, with the rows each op moved ─────────────────────────────
for (const dialect of DIALECTS) {
  const present = LANGS.filter((l) => OPS.some((op) => at(1,l,'native',dialect,op) || at(1,l,'sdk',dialect,op)));
  if (!present.length) continue;
  console.log(`\n### ${dialect} — native_p50µs / sdk_p50µs (native÷sdk)\n`);
  console.log('| op | rows/op | ' + present.join(' | ') + ' |');
  console.log('|----|--------:|' + present.map(()=>'----').join('|') + '|');
  for (const op of OPS) {
    const rowSet = new Set(present.flatMap((l) => ['native','sdk'].map((s) => rowsOf(at(1,l,s,dialect,op)))).filter((r) => r !== null));
    const cells = present.map((l) => {
      const n = p50(at(1,l,'native',dialect,op)?.us ?? []);
      const s = p50(at(1,l,'sdk',dialect,op)?.us ?? []);
      if (n == null && s == null) return 'SKIP';
      const r = (n != null && s != null && s > 0) ? (n/s).toFixed(2)+'×' : '—';
      return `${n==null?'—':n.toFixed(0)}/${s==null?'—':s.toFixed(0)} (${r})`;
    });
    // More than one distinct value = the cells did different work; show them all rather than one of them.
    const rows = rowSet.size === 0 ? '—' : [...rowSet].sort((a,b)=>a-b).map((r)=>fmt(r)).join(' / ');
    console.log(`| ${op} | ${rows} | ` + cells.join(' | ') + ' |');
  }
}

// ── ② per-row cost — the signal a 700-row fixture could not carry (#170) ───────────────────────────
for (const dialect of DIALECTS) {
  const present = LANGS.filter((l) => OPS.some((op) => at(1,l,'native',dialect,op)));
  if (!present.length) continue;
  console.log(`\n### ${dialect} — per-row cost, native / sdk (ns per row)\n`);
  console.log('> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;');
  console.log('> its cost is entirely the fixed per-call overhead in ①.\n');
  console.log('| op | rows/op | ' + present.join(' | ') + ' |');
  console.log('|----|--------:|' + present.map(()=>'----').join('|') + '|');
  for (const op of OPS) {
    const perRow = (l, s) => {
      const e = at(1,l,s,dialect,op);
      const rows = rowsOf(e);
      const us = p50(e?.us ?? []);
      if (!rows || us == null) return null;
      return (us * 1000) / rows;
    };
    const anyRows = present.some((l) => rowsOf(at(1,l,'native',dialect,op)) || rowsOf(at(1,l,'sdk',dialect,op)));
    if (!anyRows) continue;
    const rowSet = new Set(present.flatMap((l) => ['native','sdk'].map((s) => rowsOf(at(1,l,s,dialect,op)))).filter((r) => r !== null));
    const cells = present.map((l) => {
      const n = perRow(l,'native'), s = perRow(l,'sdk');
      if (n == null && s == null) return 'SKIP';
      return `${n==null?'—':fmt(n)}/${s==null?'—':fmt(s)}`;
    });
    console.log(`| ${op} | ${[...rowSet].sort((a,b)=>a-b).map((r)=>fmt(r)).join(' / ')} | ` + cells.join(' | ') + ' |');
  }
}

// ── ③ fixed overhead vs per-row cost, from the scale sweep ─────────────────────────────────────────
// With the fixture measured at 2+ scales, latency regressed on the MEASURED row count separates the two:
// intercept = the per-call cost an op pays at zero rows, slope = what each additional row costs. A
// single scale cannot do this, which is exactly why the old fixture hid a per-row regression (#170).
const sweep = [...scales].sort((a,b)=>a-b);
if (sweep.length >= 2) {
  console.log(`\n### fixed overhead vs per-row cost — regressed over scales ${sweep.join(', ')}\n`);
  console.log('| dialect | lang | surface | op | points (rows→p50µs) | fixed µs | µs per 1k rows |');
  console.log('|---------|------|---------|----|--------------------|---------:|---------------:|');
  for (const dialect of DIALECTS) for (const lang of LANGS) for (const surface of ['native','sdk']) for (const op of OPS) {
    const pts = sweep.map((sc) => { const e = at(sc,lang,surface,dialect,op); const r = rowsOf(e); const u = p50(e?.us ?? []); return (r && u != null) ? [r,u] : null; }).filter(Boolean);
    if (pts.length < 2) continue;
    const n = pts.length;
    const sx = pts.reduce((a,[x])=>a+x,0), sy = pts.reduce((a,[,y])=>a+y,0);
    const sxx = pts.reduce((a,[x])=>a+x*x,0), sxy = pts.reduce((a,[x,y])=>a+x*y,0);
    const den = n*sxx - sx*sx;
    if (den === 0) continue;
    const slope = (n*sxy - sx*sy)/den;
    const intercept = (sy - slope*sx)/n;
    const shown = pts.map(([x,y])=>`${fmt(x)}→${y.toFixed(0)}`).join(', ');
    console.log(`| ${dialect} | ${lang} | ${surface} | ${op} | ${shown} | ${intercept.toFixed(1)} | ${(slope*1000).toFixed(1)} |`);
  }
} else {
  console.log(`\n### fixed overhead vs per-row cost\n`);
  console.log(`Not separable from ONE scale (${sweep.join(', ')}). Re-emit the fixture at another scale and`);
  console.log('re-run the cells into `results/scale-<factor>/`:\n');
  console.log('```bash');
  console.log('npx tsx benchmark/crosslang/emit-setup.ts 0.1   # then re-run the cells → results/scale-0.1/');
  console.log('```');
}

// ── ④ fairness — the cells must move the SAME rows, and be honest where they cannot say ────────────
console.log('\n### fairness — rows/op agreement across cells\n');
const disagree = [];
const unmeasured = [];
for (const dialect of DIALECTS) for (const op of OPS) {
  const seen = new Map(); // rows -> [cell…]
  for (const lang of LANGS) for (const surface of ['native','sdk','v1']) {
    const e = at(1,lang,surface,dialect,op);
    if (!e) continue;
    const r = rowsOf(e);
    if (r === null) { unmeasured.push(`${dialect}/${op}: ${lang}.${surface}`); continue; }
    if (!seen.has(r)) seen.set(r, []);
    seen.get(r).push(`${lang}.${surface}`);
  }
  if (seen.size > 1) disagree.push({ dialect, op, seen });
}
if (!disagree.length) console.log('Every cell that can observe rows reports the SAME rows/op for every op × dialect.');
else {
  console.log('CELLS DISAGREE on the rows an op moves — they are NOT running the same work:\n');
  console.log('| dialect | op | rows → cells |');
  console.log('|---------|----|--------------|');
  for (const d of disagree) console.log(`| ${d.dialect} | ${d.op} | ` + [...d.seen].map(([r,cs])=>`**${fmt(r)}**: ${cs.join(', ')}`).join('; ') + ' |');
}
if (unmeasured.length) console.log(`\nNo row-observing seam (reported as \`—\`, never as 0): ${[...new Set(unmeasured.map((u)=>u.split(': ')[1]))].join(', ')}`);

// ── ⑤ coverage: which (lang, surface, dialect) actually have data ──────────────────────────────────
console.log('\n### coverage (rows collected)\n');
const seenCells = new Map();
for (const key of data.keys()){ const [scale,lang,surface,dialect]=key.split('|'); const k=`${lang}.${surface}.${dialect} @scale ${scale}`; seenCells.set(k,(seenCells.get(k)||0)+data.get(key).us.length); }
for (const scale of sweep) for (const lang of LANGS) for (const dialect of DIALECTS) for (const surface of ['native','sdk']){
  const k=`${lang}.${surface}.${dialect} @scale ${scale}`; const v=seenCells.get(k);
  console.log(`${k.padEnd(40)} ${v?('samples='+v):'SKIP (no data)'}`);
}
