#!/usr/bin/env node
// Adds this seed's rulebook tables (rulebook/*.fragment.json) to the project's rulebook.
// Dry run unless --write. Touches nothing that is already there; appends the new tables as
// text at the end of the file so the diff is only the new tables.
//
//   node scripts/merge-rulebook.mjs --rulebook ../effortless-rulebook/effortless-rulebook.json [--write] [seed flags]
//
// A seed that needs more than its tables (starter rows from a flag, say) ships rulebook/hooks.mjs:
//   export function prepare(tables, { values, flag }) -> { notes: [string] }   // may edit tables[name].data
// This script is the same in every seed that carries rulebook tables; keep the copies identical.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const values = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const rulebookPath = path.resolve(values('--rulebook')[0] || '../effortless-rulebook/effortless-rulebook.json');

const text = fs.readFileSync(rulebookPath, 'utf8');
const rulebook = JSON.parse(text);
const dir = path.join(here, '..', 'rulebook');
const fragments = fs.readdirSync(dir).filter((f) => f.endsWith('.fragment.json'));
const hooksFile = path.join(dir, 'hooks.mjs');
const hooks = fs.existsSync(hooksFile) ? await import(hooksFile) : {};

const line = (o) => JSON.stringify(o);
const fmt = (name, t) => {
  const rows = (arr) => arr.map((x) => `      ${line(x)}`).join(',\n');
  return `  ${line(name)}: {\n    "Description": ${line(t.Description)},\n    "schema": [\n${rows(t.schema)}\n    ],\n    "data": [${t.data.length ? '\n' + rows(t.data) + '\n    ' : ''}]\n  }`;
};

const added = []; const present = [];
for (const f of fragments) {
  const frag = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const [name, table] of Object.entries(frag)) {
    if (rulebook[name]) { present.push(name); continue; }
    added.push([name, table]);
  }
}

const notes = hooks.prepare ? (hooks.prepare(Object.fromEntries(added), { values, flag }) || {}).notes || [] : [];
for (const n of present) console.log(`= ${n} already in the rulebook: left alone`);
if (!added.length) { console.log('nothing to add'); process.exit(0); }
for (const [n, t] of added) console.log(`+ ${n}: ${t.schema.length} fields, ${t.data.length} rows`);
for (const n of notes) console.log(n);
if (!flag('--write')) { console.log('dry run: add --write to change', rulebookPath); process.exit(0); }

const end = text.lastIndexOf('}');
const out = text.slice(0, end).replace(/\s+$/, '') + ',\n' + added.map(([n, t]) => fmt(n, t)).join(',\n') + '\n}\n';
JSON.parse(out); // never write a rulebook that does not parse
fs.writeFileSync(rulebookPath, out);
console.log('written. Now run: effortless build');
