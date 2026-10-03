// "Paket zuordnen": a package that is more than one resource (e.g. Retry System) is taken apart by hand –
// each folder or file of the package goes into a folder of the UberASM project or is left out, the
// resource files get their list.txt numbers. Opens with a suggestion derived from the package (see
// core/pkgmap.ts); applying adds everything to the ROM's UberASM project in one step.

import type { App } from './app.ts';
import { h, clear, modal, toast, hexInput } from './dom.ts';
import { loadProject, emptyProject, saveProject } from '../core/uberproject.ts';
import { ALL, CONTEXT_SIZE, type UberContext } from '../core/uberasm.ts';
import { folders, placed, suggestCalls, type PkgRules } from '../core/pkgmap.ts';
import type { ApplyResult } from '../core/patchapply.ts';
import { romChanged, logView, errorText } from './projectpane.ts';

const CTX_LABEL: Record<UberContext, string> = { level: 'Level', gamemode: 'Game Mode', overworld: 'Overworld-Karte' };
const INHERIT = '\u0000inherit';
const IGNORE = '\u0000ignore';

interface CallState { on: boolean; num: number; all: boolean }

export function openPkgMapDialog(app: App, name: string, files: Map<string, Uint8Array>, rules: PkgRules, onDone: () => void): void {
  const paths = [...files.keys()].sort();
  const dirs = folders(paths);
  const open = new Set<string>(['']);
  for (const n of rules.keys()) for (let d = n.replace(/[^/]*\/?$/, ''); d; d = d.replace(/[^/]*\/$/, '')) open.add(d);
  const calls = new Map<string, CallState>(); // by project path, kept while the mapping changes
  const fallback: Record<UberContext, number> = { level: app.level.number, gamemode: 0x14, overworld: 0 };
  let existing: Map<string, Uint8Array> = new Map();
  try { existing = loadProject(app.rom)?.files ?? new Map(); } catch { /* shown when applying */ }

  const treeBox = h('div', { class: 'pkg-tree' });
  const callBox = h('div');
  const summary = h('p', { class: 'hint' });
  const log = h('div');

  const options = (node: string): [string, string][] => {
    const isDir = node === '' || node.endsWith('/');
    const own = isDir && node ? node.replace(/\/$/, '').split('/').pop()! + '/' : null;
    const out: [string, string][] = [];
    if (node !== '') out.push([INHERIT, 'wie der Ordner darüber']);
    out.push([IGNORE, 'nicht übernehmen']);
    if (own && !['level/', 'gamemode/', 'overworld/', 'library/', 'routines/', 'other/'].includes(own)) out.push([own, `→ ${own} (als eigener Ordner)`]);
    out.push(['', `→ oberster Ordner`]);
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
    const toggle = isDir && node ? h('button', { class: 'icon-btn', title: open.has(node) ? 'Zuklappen' : 'Aufklappen', onclick: () => { if (open.has(node)) open.delete(node); else open.add(node); render(); } }, open.has(node) ? '▾' : '▸') : h('span', { class: 'pkg-indent' });
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
    if (!sugg.length) return h('p', { class: 'hint' }, 'Keine Dateien in level/, gamemode/ oder overworld/ – nichts zuzuordnen.');
    return h('table', { class: 'uber-table' },
      h('tr', null, h('th'), h('th', null, 'Datei'), h('th', null, 'läuft in'), h('th', null, 'Nr.'), h('th')),
      sugg.map((s) => {
        let st = calls.get(s.file);
        if (!st) { st = { on: true, num: s.num === ALL ? fallback[s.ctx] : s.num, all: s.num === ALL }; calls.set(s.file, st); }
        const c = st;
        const digits = s.ctx === 'level' ? 3 : s.ctx === 'gamemode' ? 2 : 1;
        const numIn = hexInput(c.num, digits, (v) => (c.num = v), CONTEXT_SIZE[s.ctx] - 1);
        numIn.disabled = c.all;
        const allBox = h('input', { type: 'checkbox', checked: c.all, onchange: () => { c.all = allBox.checked; numIn.disabled = c.all; } });
        return h('tr', null,
          h('td', null, h('input', { type: 'checkbox', checked: c.on, title: 'list.txt-Eintrag anlegen', onchange: (e: Event) => (c.on = (e.target as HTMLInputElement).checked) })),
          h('td', { class: 'mono' }, s.file),
          h('td', null, CTX_LABEL[s.ctx]),
          h('td', { class: 'row' }, numIn, h('label', { class: 'row small' }, allBox, 'alle (*)')),
          h('td', { class: 'hint' }, s.fromDocs ? 'laut Anleitung' : ''));
      }));
  }

  function render(): void {
    const place = placed(paths, rules);
    const replaced = [...place.values()].filter((d) => existing.has(d)).length;
    clear(treeBox).append(...tree(place));
    clear(callBox).appendChild(callRows(place));
    summary.textContent = `${place.size} von ${paths.length} Dateien werden übernommen${replaced ? `, ${replaced} davon ersetzen vorhandene Projektdateien` : ''}.`;
  }

  const apply = (): boolean => {
    if (app.dirty) app.saveLevel(true);
    const place = placed(paths, rules);
    if (!place.size) { clear(log).appendChild(logView({ ok: false, errors: ['Nichts ausgewählt.'], warnings: [], prints: [] })); return false; }
    let r: ApplyResult;
    const added: string[] = [];
    try {
      const proj = loadProject(app.rom) ?? emptyProject();
      for (const [from, to] of place) proj.files.set(to, files.get(from)!);
      for (const s of suggestCalls(files, place, fallback)) {
        const c = calls.get(s.file);
        if (!c?.on) continue;
        const key = c.all ? ALL : c.num;
        const list = proj.list[s.ctx].get(key) ?? [];
        if (!list.some((x) => x.file === s.file)) list.push({ file: s.file, bytes: [] });
        proj.list[s.ctx].set(key, list);
        added.push(`${s.file} (${CTX_LABEL[s.ctx]} ${c.all ? '*' : c.num.toString(16).toUpperCase()})`);
      }
      r = saveProject(app.rom, proj);
    } catch (e) { r = { ok: false, errors: [errorText(e)], warnings: [], prints: [] }; }
    if (!r.ok) { clear(log).appendChild(logView(r)); return false; }
    romChanged(app);
    toast(`„${name}“ ins UberASM-Projekt übernommen: ${place.size} Datei(en)${added.length ? `, läuft in ${added.join(', ')}` : ''}.`);
    if (r.warnings.length || r.prints.length) modal(`Ausgabe: ${name}`, logView(r), [{ label: 'OK', primary: true }]);
    onDone();
    return true;
  };

  render();
  modal(`Paket zuordnen: ${name}`, h('div', { class: 'patch-apply pkg-map' },
    h('p', null, `„${name}“ enthält mehr als eine Ressource. Ordner und Dateien des Pakets lassen sich hier Ordnern des UberASM-Projekts zuordnen – wie beim Kopieren in den UberASM-Tool-Ordner laut Anleitung. Ein Ordner gibt seine Zuordnung an alles darin weiter.`),
    treeBox,
    summary,
    h('h3', null, 'list.txt'),
    callBox,
    h('p', { class: 'hint' }, 'Zuordnungen, Einstellungen und Dateien lassen sich danach im Tab UberASM ändern.'),
    log,
  ), [
    { label: 'Abbrechen' },
    { label: 'Übernehmen', primary: true, onClick: apply },
  ]);
}
