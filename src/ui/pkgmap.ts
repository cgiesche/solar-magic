// The manual assignment inside the upload preview: a package of several tool folders (e.g. Retry
// System) is taken apart by hand – each folder or file of the package goes into a folder of the UberASM
// project or is left out, the resource files get their list.txt numbers. Starts from the suggestion
// derived from the package (see core/pkgmap.ts); "Install" installs it with this assignment.

import type { App } from './app.ts';
import { h, clear, hexInput } from './dom.ts';
import { loadProject } from '../core/uberproject.ts';
import { ALL, CONTEXT_SIZE, type UberContext } from '../core/uberasm.ts';
import { folders, placed, suggestCalls } from '../core/pkgmap.ts';
import type { ManualPreview, ManualAssignment } from '../core/packages.ts';
import { icon } from './icons.ts';

const CTX_LABEL: Record<UberContext, string> = { level: 'Level', gamemode: 'Game Mode', overworld: 'Overworld map' };
const INHERIT = '\u0000inherit';
const IGNORE = '\u0000ignore';

interface CallState { on: boolean; num: number; all: boolean }

export function assignmentEditor(app: App, p: ManualPreview): { el: HTMLElement; read(): ManualAssignment } {
  const { name, files } = p;
  const rules = new Map(p.suggestion.rules);
  const paths = [...files.keys()].sort();
  const dirs = folders(paths);
  const open = new Set<string>(['']);
  for (const n of rules.keys()) for (let d = n.replace(/[^/]*\/?$/, ''); d; d = d.replace(/[^/]*\/$/, '')) open.add(d);
  const callsState = new Map<string, CallState>(); // by project path, kept while the mapping changes
  const fallback: Record<UberContext, number> = { level: app.level.number, gamemode: 0x14, overworld: 0 };
  let existing: Map<string, Uint8Array> = new Map();
  try { existing = loadProject(app.rom)?.files ?? new Map(); } catch { /* shown when installing */ }

  const treeBox = h('div', { class: 'pkg-tree' });
  const callBox = h('div');
  const summary = h('p', { class: 'hint' });

  const options = (node: string): [string, string][] => {
    const isDir = node === '' || node.endsWith('/');
    const own = isDir && node ? node.replace(/\/$/, '').split('/').pop()! + '/' : null;
    const out: [string, string][] = [];
    if (node !== '') out.push([INHERIT, 'like the folder above']);
    out.push([IGNORE, 'leave out']);
    if (own && !['level/', 'gamemode/', 'overworld/', 'library/', 'routines/', 'other/'].includes(own)) out.push([own, `→ ${own} (as its own folder)`]);
    out.push(['', `→ top folder`]);
    for (const d of ['level/', 'gamemode/', 'overworld/', 'library/', 'routines/', 'other/']) out.push([d, `→ ${d}`]);
    return out;
  };
  const value = (node: string) => (rules.has(node) ? rules.get(node) ?? IGNORE : node === '' ? IGNORE : INHERIT);
  const setRule = (node: string, v: string) => {
    if (v === INHERIT) rules.delete(node);
    else rules.set(node, v === IGNORE ? null : v);
    render();
  };

  function nodeRow(node: string, label: string, depth: number, isDir: boolean, place: Map<string, string>): HTMLElement {
    const sel = h('select', { onchange: () => setRule(node, sel.value) },
      options(node).map(([v, l]) => h('option', { value: v, selected: v === value(node) }, l)));
    const dest = isDir ? null : place.get(node);
    const toggle = isDir && node ? h('button', { class: 'icon-btn', title: open.has(node) ? 'Collapse' : 'Expand', onclick: () => { if (open.has(node)) open.delete(node); else open.add(node); render(); } }, icon(open.has(node) ? 'chevron-down' : 'chevron-right')) : h('span', { class: 'pkg-indent' });
    return h('div', { class: 'row pkg-node' + (rules.has(node) ? ' ruled' : '') + (isDir || dest ? '' : ' off'), style: `padding-left: ${depth * 14}px` },
      toggle,
      h('span', { class: 'mono grow', title: node || name }, label),
      isDir ? null : h('span', { class: 'mono hint pkg-dest', title: dest ?? '' }, dest ?? '–'),
      sel);
  }

  function tree(place: Map<string, string>): HTMLElement[] {
    const rows: HTMLElement[] = [nodeRow('', name, 0, true, place)];
    const walk = (dir: string, depth: number) => {
      const subdirs = dirs.filter((d) => d !== dir && d.startsWith(dir) && !d.slice(dir.length, -1).includes('/'));
      const here = paths.filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/'));
      for (const d of subdirs) {
        const n = paths.filter((p) => p.startsWith(d)).length;
        rows.push(nodeRow(d, `${d.slice(dir.length)} (${n})`, depth, true, place));
        if (open.has(d)) walk(d, depth + 1);
      }
      for (const f of here) rows.push(nodeRow(f, f.slice(dir.length), depth, false, place));
    };
    walk('', 1);
    return rows;
  }

  function callRows(place: Map<string, string>): HTMLElement {
    const sugg = suggestCalls(files, place, fallback);
    if (!sugg.length) return h('p', { class: 'hint' }, 'No files in level/, gamemode/ or overworld/ – nothing to assign.');
    return h('table', { class: 'uber-table' },
      h('tr', null, h('th'), h('th', null, 'File'), h('th', null, 'runs in'), h('th', null, 'No.'), h('th')),
      sugg.map((s) => {
        let st = callsState.get(s.file);
        if (!st) { st = { on: true, num: s.num === ALL ? fallback[s.ctx] : s.num, all: s.num === ALL }; callsState.set(s.file, st); }
        const c = st;
        const digits = s.ctx === 'level' ? 3 : s.ctx === 'gamemode' ? 2 : 1;
        const numIn = hexInput(c.num, digits, (v) => (c.num = v), CONTEXT_SIZE[s.ctx] - 1);
        numIn.disabled = c.all;
        const allBox = h('input', { type: 'checkbox', checked: c.all, onchange: () => { c.all = allBox.checked; numIn.disabled = c.all; } });
        return h('tr', null,
          h('td', null, h('input', { type: 'checkbox', checked: c.on, title: 'Create list.txt entry', onchange: (e: Event) => (c.on = (e.target as HTMLInputElement).checked) })),
          h('td', { class: 'mono' }, s.file),
          h('td', null, CTX_LABEL[s.ctx]),
          h('td', { class: 'row' }, numIn, h('label', { class: 'row small' }, allBox, 'all (*)')),
          h('td', { class: 'hint' }, s.fromDocs ? 'per manual' : ''));
      }));
  }

  function render(): void {
    const place = placed(paths, rules);
    const replaced = [...place.values()].filter((d) => existing.has(d)).length;
    clear(treeBox).append(...tree(place));
    clear(callBox).appendChild(callRows(place));
    summary.textContent = `${place.size} of ${paths.length} files are taken over${replaced ? `, ${replaced} of them replace existing project files` : ''}.`;
  }

  const read = (): ManualAssignment => {
    const place = placed(paths, rules);
    const calls: ManualAssignment['calls'] = [];
    for (const x of suggestCalls(files, place, fallback)) {
      const c = callsState.get(x.file);
      if (c?.on) calls.push({ file: x.file, ctx: x.ctx, num: c.all ? ALL : c.num });
    }
    return { rules: new Map(rules), calls };
  };

  render();
  return {
    el: h('div', { class: 'pkg-map' },
      h('p', null, `“${name}” has UberASM Tool folders next to folders their code includes. Assign its folders and files to folders of the UberASM project – like copying them into the UberASM Tool folder as its manual says. A folder passes its assignment on to everything in it.`),
      treeBox,
      summary,
      h('h3', null, 'list.txt'),
      callBox,
      h('p', { class: 'hint' }, 'Assignments, settings and files can be changed afterwards under UberASM in the Packages workspace.')),
    read,
  };
}
