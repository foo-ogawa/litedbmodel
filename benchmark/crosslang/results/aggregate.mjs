// Aggregate the committed raw per-iteration CSVs (results/<lang>.<surface>.<dialect>.csv, rows
// `cell,dialect,op,iter,us`) into the p50 µs matrix + native÷sdk ratios. Reads ONLY the committed raw
// data — every printed number traces to a saved CSV line (reproducible, non-fabricated).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OPS = ['findAll','filterPaginateSort','findFirst','findUnique','nestedFindAll','nestedFindFirst','nestedFindUnique','nestedRelations','compositeRelations','create','update','upsert','createMany','upsertMany','updateMany','nestedCreate','nestedUpsert','nestedUpdate','delete'];
const LANGS = ['typescript','go','rust','python','php'];
const DIALECTS = ['sqlite','postgres','mysql'];

function p50(nums){ if(!nums.length) return null; const s=[...nums].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2? s[m] : (s[m-1]+s[m])/2; }

// key: lang|surface|dialect|op -> [us...]
const data = new Map();
for (const f of readdirSync(HERE)) {
  const m = f.match(/^([a-z]+)\.(native|sdk)\.(sqlite|postgres|mysql)\.csv$/);
  if (!m) continue;
  const [,lang,surface,dialect] = m;
  const txt = readFileSync(join(HERE,f),'utf8').trim().split('\n');
  for (const line of txt) {
    if (line.startsWith('cell,')) continue;
    const c = line.split(',');
    if (c.length!==5) continue;
    const [, dcol, op, , us] = c;
    if (dcol!==dialect) continue; // guard: CSV's own dialect column must match the filename
    const key = `${lang}|${surface}|${dialect}|${op}`;
    if(!data.has(key)) data.set(key,[]);
    data.get(key).push(Number(us));
  }
}

function cell(lang,dialect,op){
  const n = p50(data.get(`${lang}|native|${dialect}|${op}`)||[]);
  const s = p50(data.get(`${lang}|sdk|${dialect}|${op}`)||[]);
  if(n==null && s==null) return 'SKIP';
  const nn = n==null?'—':n.toFixed(0);
  const ss = s==null?'—':s.toFixed(0);
  const r = (n!=null&&s!=null&&s>0)? (n/s).toFixed(2)+'×' : '—';
  return `${nn}/${ss} (${r})`;
}

// Emit a markdown table per dialect: rows=op, cols=lang, value = native/sdk (ratio) in µs.
for (const dialect of DIALECTS) {
  console.log(`\n### ${dialect} — native_p50µs / sdk_p50µs (native÷sdk)\n`);
  console.log('| op | ' + LANGS.join(' | ') + ' |');
  console.log('|----|' + LANGS.map(()=>'----').join('|') + '|');
  for (const op of OPS) {
    console.log('| '+op+' | ' + LANGS.map(l=>cell(l,dialect,op)).join(' | ') + ' |');
  }
}

// Coverage summary: which (lang,surface,dialect) actually have data.
console.log('\n### coverage (rows collected)\n');
const seen = new Map();
for (const key of data.keys()){ const [lang,surface,dialect]=key.split('|'); const k=`${lang}.${surface}.${dialect}`; seen.set(k,(seen.get(k)||0)+data.get(key).length); }
for (const lang of LANGS) for (const dialect of DIALECTS) for (const surface of ['native','sdk']){
  const k=`${lang}.${surface}.${dialect}`; const v=seen.get(k);
  console.log(`${k.padEnd(28)} ${v?('rows='+v):'SKIP (no data)'}`);
}
