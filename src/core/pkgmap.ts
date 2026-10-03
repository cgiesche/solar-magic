// Packages that are more than one resource, like Retry System: UberASM Tool folders (library/, gamemode/,
// …) somewhere inside, next to folders they include, docs and optional extras. The user assigns parts of
// the package to folders of the UberASM project; a suggestion is derived from the package itself: folders
// named like UberASM Tool's, the folders their code includes, and list.txt lines quoted in the docs.

import { ALL, type UberContext } from './uberasm.ts';

// project folders a part can go into; '' = the project's top folder
export const UBER_DIRS = ['level/', 'gamemode/', 'overworld/', 'library/', 'routines/', 'other/'] as const;
const CONTEXTS: UberContext[] = ['level', 'gamemode', 'overworld'];

// node → destination folder of its contents, null = not taken; a node is a folder ('a/b/', '' = the
// package root) or a file; nodes without a rule inherit their folder's
export type PkgRules = Map<string, string | null>;

export interface PkgSuggestion {
  rules: PkgRules;
  root: string; // the folder holding the tool folders
  extra: string[]; // folders put at the top as they are included from there (e.g. retry_config/)
}

const dec = new TextDecoder();
const parentOf = (p: string) => p.replace(/[^/]*\/?$/, '');
const baseOf = (p: string) => p.replace(/\/$/, '').split('/').pop()!;

// the folders of a package ('' included), each ending with '/'
export function folders(files: Iterable<string>): string[] {
  const out = new Set<string>(['']);
  for (const f of files) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/') + '/'); }
  return [...out].sort();
}

// the rule deciding over a node: its own, else the nearest folder's
export function ruleOf(rules: PkgRules, node: string): { at: string; dest: string | null } {
  for (let n = node; ; n = parentOf(n)) {
    if (rules.has(n)) return { at: n, dest: rules.get(n)! };
    if (n === '') return { at: '', dest: null };
  }
}

// package path → project path of every file taken
export function placed(files: Iterable<string>, rules: PkgRules): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const { at, dest } = ruleOf(rules, f);
    if (dest === null) continue;
    out.set(f, dest + (at === f ? baseOf(f) : f.slice(at.length)));
  }
  return out;
}

// UberASM Tool folders inside the package and the folders their code includes
export function suggestMapping(files: Map<string, Uint8Array>): PkgSuggestion | null {
  const all = [...files.keys()];
  const dirs = folders(all);
  // candidate roots: folders with tool folders holding .asm files directly
  const score = new Map<string, number>();
  for (const d of dirs) {
    if (!UBER_DIRS.includes(d.slice(parentOf(d.slice(0, -1)).length) as (typeof UBER_DIRS)[number])) continue;
    if (!all.some((f) => f.startsWith(d) && !f.slice(d.length).includes('/') && /\.asm$/i.test(f))) continue;
    const r = parentOf(d.slice(0, -1));
    score.set(r, (score.get(r) ?? 0) + 1);
  }
  if (!score.size) return null;
  const root = [...score].sort((a, b) => b[1] - a[1] || a[0].split('/').length - b[0].split('/').length)[0][0];
  const rules: PkgRules = new Map([['', null]]);
  for (const d of UBER_DIRS) if (dirs.includes(root + d)) rules.set(root + d, d);
  // sibling folders included from the taken code (by name in a path: "../retry_config/…")
  const extra: string[] = [];
  const siblings = dirs.filter((d) => d !== root && parentOf(d.slice(0, -1)) === root && !rules.has(d));
  for (let grew = true; grew;) {
    grew = false;
    const texts = [...placed(all, rules).keys()].filter((f) => /\.(asm|asar)$/i.test(f)).map((f) => dec.decode(files.get(f)!));
    for (const s of siblings) {
      if (rules.has(s)) continue;
      const name = baseOf(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|["'/<\\s])${name}/`, 'm');
      if (texts.some((t) => re.test(t))) { rules.set(s, baseOf(s) + '/'); extra.push(s); grew = true; }
    }
  }
  return { rules, root, extra };
}

// readme files and HTML docs, most relevant first (a top-level readme, then docs/index.html, …)
export function docFiles(files: Map<string, Uint8Array>): string[] {
  const depth = (p: string) => p.split('/').length;
  const docs = [...files.keys()].filter((p) => /\.(txt|md|html?)$/i.test(p) && !/(^|\/)list\.txt$/i.test(p)
    && (/(^|\/)(readme|liesmich|anleitung|instructions?|manual|index|getting[_ ]started)[^/]*$/i.test(p) || depth(p) <= 2 && /\.(txt|md)$/i.test(p)));
  const rank = (p: string) => (/readme|liesmich/i.test(p) ? 0 : /index\.html?$/i.test(p) ? 1 : 2);
  return docs.sort((a, b) => depth(a) - depth(b) || rank(a) - rank(b) || a.localeCompare(b));
}

// plain text of a doc (HTML without tags and entities)
export function docText(data: Uint8Array, path: string): string {
  const t = dec.decode(data);
  if (!/\.html?$/i.test(path)) return t;
  return t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// a list.txt assignment for a resource file the package puts into level/, gamemode/ or overworld/
export interface CallSuggestion { file: string; ctx: UberContext; num: number; fromDocs: boolean }

// resource files among the placed ones, each with the number quoted for it in the docs ("* retry_gm.asm",
// "105 file.asm"), else `fallback`
export function suggestCalls(files: Map<string, Uint8Array>, place: Map<string, string>, fallback: Record<UberContext, number>): CallSuggestion[] {
  const texts = docFiles(files).concat([...files.keys()].filter((p) => /\.(txt|md|html?)$/i.test(p)))
    .filter((p, i, a) => a.indexOf(p) === i).map((p) => docText(files.get(p)!, p));
  const out: CallSuggestion[] = [];
  for (const dest of [...place.values()].sort()) {
    const ctx = CONTEXTS.find((c) => dest.startsWith(c + '/'));
    if (!ctx || !/\.asm$/i.test(dest) || dest.slice(ctx.length + 1).includes('/')) continue;
    const name = dest.slice(ctx.length + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^\\s*(\\*|[0-9a-f]{1,3})\\s+(?:[^\\s,]+\\.asm\\s*,\\s*)*${name}\\b`, 'im');
    let num: number | null = null;
    for (const t of texts) { const m = re.exec(t); if (m) { num = m[1] === '*' ? ALL : parseInt(m[1], 16); break; } }
    out.push({ file: dest, ctx, num: num ?? fallback[ctx], fromDocs: num !== null });
  }
  return out;
}

// the parts of a package not taken (top-level entries below the package root or the tool root), for the
// list of further steps
export function untaken(files: Map<string, Uint8Array>, rules: PkgRules): string[] {
  const taken = placed(files.keys(), rules);
  const out = new Set<string>();
  for (const f of files.keys()) {
    if (taken.has(f)) continue;
    // the shallowest folder holding only untaken files
    const parts = f.split('/');
    let node = f;
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/') + '/';
      if (![...taken.keys()].some((t) => t.startsWith(d))) { node = d; break; }
    }
    out.add(node);
  }
  return [...out].sort();
}
