// The UI's design tokens (#473): every custom property the stylesheet or the UI code reads is defined – in :root,
// on an element of the stylesheet, or set by the code (setProperty) – and no rule of the stylesheet outside the
// token blocks writes a color as a literal (black shadows and overlays on pictures excepted).
// node tools/testtokens.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const css = readFileSync('src/style.css', 'utf8');
const ts: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    if (f.isDirectory()) walk(join(d, f.name));
    else if (f.name.endsWith('.ts')) ts.push(readFileSync(join(d, f.name), 'utf8'));
  }
};
walk('src');
const code = ts.join('\n');

const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
for (const m of code.matchAll(/setProperty\('(--[a-z0-9-]+)'/g)) defined.add(m[1]);
const used = new Set([
  ...[...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]),
  ...[...code.matchAll(/'(--[a-z0-9-]+)'/g)].map((m) => m[1]),
]);
const missing = [...used].filter((v) => !defined.has(v));
check(missing.length === 0, `every token used is defined (${missing.join(', ') || 'all'})`);

// the stylesheet without its token blocks (:root, the start page's own) has no color literals but black ones
const rules = css.replace(/:root\s*\{[^}]*\}/g, '');
const literals = [...rules.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0])
  .filter((c) => !/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)]/.test(c) && !/^#000[0-9a-fA-F]?$/.test(c));
check(literals.length === 0, `no color literals outside the tokens (${literals.join(', ') || 'none'})`);

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
