// Custom sprites (PIXI format): the Sprites view of the Packages workspace, a configuration view – assigns the
// sprites packages brought to numbers (list.txt entries); the project's files with their settings,
// export as a PIXI folder (.zip).

import type { App } from './app.ts';
import { h, clear, toast, hexInput, select, type Child } from './dom.ts';
import { projectPane, type Pane, type PartRow } from './projectpane.ts';
import type { PartContext } from './pkginspect.ts';
import { hex } from '../core/names.ts';
import {
  loadPixiProject, savePixiProject, projectToZip, spriteConfig, numberRange, assignSprite,
  FOLDER, KIND_LABEL, type PixiProject,
} from '../core/pixi.ts';
import type { SpriteFolder } from '../core/pixirt.ts';
import { icon } from './icons.ts';

const KINDS = Object.keys(FOLDER) as SpriteFolder[];

export function pixiPane(app: App, changed: () => void, part?: PartContext): Pane {
  let kind: SpriteFolder = 'sprites';
  let num = 0;

  function content(proj: PixiProject, change: () => void, origin: (file: string) => HTMLElement, row: PartRow): Child[] {
    const filesFor = (k: SpriteFolder) => [...proj.files.keys()].filter((f) => f.startsWith(FOLDER[k]) && (k === 'sprites' || k === 'shooters' || k === 'generators' ? /\.(json|cfg)$/i.test(f) : /\.asm$/i.test(f) && !/_header\.asm$/i.test(f))).sort();
    const fileSel = h('span');
    let file = '';
    const numIn = hexInput(num, 2, (v) => (num = v));
    const addBtn = h('button', { onclick: () => add() }, 'Assign');
    const buildFiles = () => {
      const fs = filesFor(kind);
      file = fs[0] ?? '';
      const [lo, hi] = numberRange(kind);
      num = Math.max(lo, Math.min(hi, num));
      numIn.value = hex(num, 2);
      numIn.title = `${KIND_LABEL[kind]}: ${hex(lo, 2)}–${hex(hi, 2)}`;
      addBtn.disabled = !fs.length;
      clear(fileSel).append(fs.length ? select(fs.map((f, i) => [i, f.slice(FOLDER[kind].length)] as [number, string]), 0, (i) => (file = fs[i])) : h('span', { class: 'hint' }, `no files in ${FOLDER[kind]}`));
    };
    const add = () => {
      const [lo, hi] = numberRange(kind);
      if (num < lo || num > hi) { toast(`${KIND_LABEL[kind]}: number ${hex(lo, 2)}–${hex(hi, 2)}`, 'error'); return; }
      assignSprite(proj, { kind, num, file });
      change();
    };
    const label = (e: { kind: SpriteFolder; file: string }) => {
      try { const c = spriteConfig(proj, { ...e, num: 0 }); return c.names[0]?.name ?? ''; } catch (err) { return `Error: ${err instanceof Error ? err.message : err}`; }
    };
    const asmOf = (e: { kind: SpriteFolder; file: string }) => { try { return spriteConfig(proj, { ...e, num: 0 }).asm ?? e.file; } catch { return e.file; } };
    const rows = [...proj.list].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.num - b.num).map((e) => h('tr', row(`${e.kind}/${e.num}`, () => ({
      kind: KIND_LABEL[e.kind], title: [h('span', { class: 'mono' }, hex(e.num, 2)), ' ', label(e) || e.file.slice(FOLDER[e.kind].length)], file: asmOf(e),
      facts: [['Number', hex(e.num, 2)], ['File', e.file]],
      hint: 'To insert: sprite mode, custom sprite with the number.',
    })),
      h('td', null, KIND_LABEL[e.kind]),
      h('td', { class: 'mono' }, hex(e.num, 2)),
      h('td', { class: proj.files.has(e.file) ? '' : 'err', title: proj.files.has(e.file) ? e.file : `${e.file} is missing from the project` }, e.file.slice(FOLDER[e.kind].length)),
      h('td', null, label(e)),
      h('td', null, origin(e.file)),
      h('td', { class: 'actions' }, h('button', { class: 'icon-btn', title: 'Remove entry (the sprite stays)', onclick: () => { proj.list = proj.list.filter((x) => x !== e); change(); } }, icon('close')))));
    const out = [
      rows.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Type'), h('th', null, 'No.'), h('th', null, 'File'), h('th', null, 'Name'), h('th', null, 'Package'), h('th')), rows)
        : h('p', { class: 'hint' }, 'No custom sprites yet – “Upload package …” above installs a sprite package; its sprites get the next free numbers.'),
      proj.files.size ? h('div', { class: 'row uber-add' },
        select(KINDS.map((k, i) => [i, KIND_LABEL[k]] as [number, string]), KINDS.indexOf(kind), (i) => { kind = KINDS[i]; num = numberRange(kind)[0]; buildFiles(); }),
        h('label', null, 'No.'), numIn,
        fileSel,
        addBtn) : '',
    ];
    buildFiles();
    return out;
  }

  return projectPane<PixiProject>(app, {
    title: 'Sprites',
    tool: 'sprite',
    intro: 'Sprites, shooters, generators and the other sprite types of PIXI.',
    format: 'PIXI format: sprites (00–BF), shooters (C0–CF) and generators (D0–DF) with .json/.cfg, the other types as .asm. Shared routines like %GetDrawInfo() are built in; your own in routines/ take precedence.',
    load: () => loadPixiProject(app.rom),
    empty: () => ({ files: new Map(), list: [] }),
    save: (p) => savePixiProject(app.rom, p),
    toZip: projectToZip,
    zipName: 'pixi.zip',
    content,
    applied: (p) => `Custom sprites applied (${p.list.length})`,
  }, changed, part);
}
