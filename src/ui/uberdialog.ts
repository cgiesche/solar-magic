// UberASM tab of the Packages dialog, a configuration view: assigns the UberASM code packages brought to
// levels, overworld maps and game modes, the global and status bar code; the project's files with their
// settings, export as an UberASM Tool folder (.zip).

import type { App } from './app.ts';
import { h, toast, hexInput, select } from './dom.ts';
import { loadProject, saveProject, emptyProject, projectToZip, addCall, type UberProject } from '../core/uberproject.ts';
import { resourceFiles, ALL, CONTEXT_SIZE, type UberContext } from '../core/uberasm.ts';
import { hex } from '../core/names.ts';
import { definesButton } from './defineedit.ts';
import { projectPane, type Pane } from './projectpane.ts';

const CTX_LABEL: Record<UberContext, string> = { level: 'Level', overworld: 'Overworld maps', gamemode: 'Game modes' };

function bytesText(b: number[]): string {
  return b.map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
function parseBytes(s: string): number[] {
  const t = s.trim();
  if (!t) return [];
  return t.split(/[\s,]+/).map((x) => {
    const v = parseInt(x.replace(/^\$/, ''), 16);
    if (Number.isNaN(v) || v < 0 || v > 255) throw new Error(`Invalid extra byte “${x}”`);
    return v;
  });
}

export type UberPane = Pane & { context(): UberContext };

export function uberPane(app: App, changed: () => void): UberPane {
  let ctx: UberContext = 'level';
  let otherOpen = false;
  let pane: Pane;

  function assignments(proj: UberProject, change: () => void, origin: (file: string) => HTMLElement): HTMLElement {
    const files = proj.files;
    const map = proj.list[ctx];
    const digits = ctx === 'level' ? 3 : 2;
    const rows = [...map.entries()].sort((a, b) => a[0] - b[0]).flatMap(([num, calls]) => calls.map((c, i) => h('tr', null,
      h('td', { class: 'mono' }, i === 0 ? (num === ALL ? '*' : hex(num, digits)) : ''),
      h('td', { class: files.has(c.file) ? '' : 'err', title: files.has(c.file) ? c.file : `${c.file} is missing from the project` }, c.file.replace(/^(level|overworld|gamemode)\//, '')),
      h('td', { class: 'mono' }, bytesText(c.bytes)),
      h('td', null, origin(c.file)),
      h('td', { class: 'actions' }, definesButton(files, c.file, change), h('button', { class: 'icon-btn', title: 'Remove assignment (the file stays)', onclick: () => { calls.splice(i, 1); if (!calls.length) map.delete(num); change(); } }, '✕')),
    )));
    // new assignment of a file already in the project
    let num = ctx === 'level' ? app.level.number : 0;
    let all = false;
    const res = resourceFiles(files, ctx);
    let file = res[0] ?? '';
    const numIn = hexInput(num, digits, (v) => (num = v), CONTEXT_SIZE[ctx] - 1);
    const bytesIn = h('input', { placeholder: 'e.g. 01 FF', title: 'Extra bytes (optional)', spellcheck: false, style: 'width: 8em' });
    const allBox = h('input', { type: 'checkbox', onchange: () => { all = allBox.checked; numIn.disabled = all; } });
    const add = () => {
      let bytes: number[];
      try { bytes = parseBytes(bytesIn.value); } catch (e) { toast(String((e as Error).message), 'error'); return; }
      addCall(proj, ctx, all ? ALL : num, file, bytes);
      change();
    };
    return h('div', null,
      rows.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'No.'), h('th', null, 'File'), h('th', null, 'Extra bytes'), h('th', null, 'Package'), h('th')), rows)
        : h('p', { class: 'hint' }, `No assignments for ${CTX_LABEL[ctx].toLowerCase()} yet – “Upload package …” above installs UberASM code; it runs in the current level.`),
      res.length ? h('div', { class: 'row uber-add' },
        numIn,
        ctx === 'level' ? h('label', { class: 'row small' }, allBox, 'all (*)') : null,
        select(res.map((f, i) => [i, f.slice(f.indexOf('/') + 1)] as [number, string]), 0, (i) => (file = res[i])),
        bytesIn,
        h('button', { onclick: add }, 'Assign')) : null,
    );
  }

  function other(proj: UberProject, change: () => void): HTMLElement {
    const opts = [...proj.files.keys()].filter((f) => /\.asm$/i.test(f) && f.startsWith('other/')).sort();
    const pick = (label: string, cur: string | null, set: (v: string | null) => void) => {
      const all: [number, string][] = [[-1, '(none)'], ...opts.map((f, i) => [i, f.slice(6)] as [number, string])];
      return h('div', { class: 'prop' }, h('label', null, label), select(all, cur ? opts.indexOf(cur) : -1, (i) => { set(i < 0 ? null : opts[i]); change(); }));
    };
    const d = h('details', { class: 'pane-adv', open: otherOpen, ontoggle: () => (otherOpen = d.open) },
      h('summary', null, 'Global, status bar, free RAM'),
      h('p', { class: 'hint' }, 'Files from other/ that packages brought.'),
      pick('Global (init)', proj.list.global, (v) => (proj.list.global = v)),
      pick('Status bar (main)', proj.list.statusbar, (v) => (proj.list.statusbar = v)),
      pick('Macro library', proj.list.macrolib, (v) => (proj.list.macrolib = v)),
      h('div', { class: 'prop' }, h('label', null, 'Free RAM (2 bytes)'), hexInput(proj.list.freeram, 6, (v) => { proj.list.freeram = v; change(); })),
    );
    return d;
  }

  pane = projectPane<UberProject>(app, {
    title: 'UberASM',
    tool: 'uberasm',
    intro: 'Code that runs every frame per level, overworld map or game mode.',
    format: 'UberASM Tool 2.x format: labels init/main/end/load/nmi, libraries (library/), shared routines (routines/), extra bytes. An existing UberASM Tool folder is uploaded as a package (.zip); the sources are kept with the editor data (saved with “Save project”).',
    load: () => loadProject(app.rom),
    empty: emptyProject,
    save: (p) => saveProject(app.rom, p),
    toZip: projectToZip,
    zipName: 'uberasm.zip',
    content: (proj, change, origin) => [
      h('div', { class: 'tabs seg sub-tabs' }, (['level', 'overworld', 'gamemode'] as UberContext[]).map((c) =>
        h('button', { class: c === ctx ? 'mode active' : 'mode', onclick: () => { ctx = c; pane.render(); } }, CTX_LABEL[c]))),
      assignments(proj, change, origin),
      other(proj, change),
    ],
    applied: () => 'UberASM applied',
  }, changed);
  return { ...pane, context: () => ctx };
}
