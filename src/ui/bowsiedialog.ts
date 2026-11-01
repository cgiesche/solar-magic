// Overworld sprites (BOWSIE): the Overworld sprites tab of the Packages dialog, a configuration view – assigns the
// overworld sprites packages brought to numbers (list.txt entries, 01–7E); the project's files with their settings,
// export as a BOWSIE folder (.zip).

import type { App } from './app.ts';
import { h, toast, hexInput, select, type Child } from './dom.ts';
import { projectPane, type Pane } from './projectpane.ts';
import { hex } from '../core/names.ts';
import { definesButton } from './defineedit.ts';
import {
  loadBowsieProject, saveBowsieProject, bowsieToZip, bowsieSpriteInfo, assignOwSprite, isBowsieSprite, BOWSIE_FIRST, BOWSIE_LAST, type BowsieProject,
} from '../core/bowsie.ts';

export function bowsiePane(app: App, changed: () => void): Pane {
  let num = BOWSIE_FIRST;

  function content(proj: BowsieProject, change: () => void, origin: (file: string) => HTMLElement): Child[] {
    const dec = new TextDecoder();
    const sprites = [...proj.files.keys()].filter((f) => /\.asm$/i.test(f) && isBowsieSprite(dec.decode(proj.files.get(f)!))).sort();
    let file = sprites[0] ?? '';
    const numIn = hexInput(num, 2, (v) => (num = v));
    numIn.title = `Overworld sprite: ${hex(BOWSIE_FIRST, 2)}–${hex(BOWSIE_LAST, 2)}`;
    const add = () => {
      if (num < BOWSIE_FIRST || num > BOWSIE_LAST) { toast(`Overworld sprites: number ${hex(BOWSIE_FIRST, 2)}–${hex(BOWSIE_LAST, 2)}`, 'error'); return; }
      proj.list = proj.list.filter((e) => e.file !== file); // a file under one number
      assignOwSprite(proj, { num, file });
      change();
    };
    const rows = [...proj.list].sort((a, b) => a.num - b.num).map((e) => {
      const info = bowsieSpriteInfo(proj, e);
      return h('tr', null,
        h('td', { class: 'mono' }, hex(e.num, 2)),
        h('td', { class: proj.files.has(e.file) ? '' : 'err', title: proj.files.has(e.file) ? e.file : `${e.file} is missing from the project` }, e.file.replace(/^sprites\//, '')),
        h('td', { title: info.description }, info.name),
        h('td', { class: 'mono' }, String(info.extra)),
        h('td', null, origin(e.file)),
        h('td', { class: 'actions' }, definesButton(proj.files, e.file, change), h('button', { class: 'icon-btn', title: 'Remove entry (the sprite stays)', onclick: () => { proj.list = proj.list.filter((x) => x !== e); change(); } }, '✕')));
    });
    return [
      rows.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'No.'), h('th', null, 'File'), h('th', null, 'Name'), h('th', null, 'Extra bytes'), h('th', null, 'Package'), h('th')), rows)
        : h('p', { class: 'hint' }, 'No overworld sprites yet – “Upload package …” above installs custom overworld sprites in BOWSIE\'s format; each gets the next free number.'),
      sprites.length ? h('div', { class: 'row uber-add' },
        h('label', null, 'No.'), numIn,
        select(sprites.map((f, i) => [i, f.replace(/^sprites\//, '')] as [number, string]), 0, (i) => (file = sprites[i])),
        h('button', { onclick: add }, 'Assign')) : '',
    ];
  }

  return projectPane<BowsieProject>(app, {
    title: 'Overworld sprites',
    tool: 'owsprite',
    intro: 'Custom overworld sprites in BOWSIE\'s format; placed in the overworld editor\'s Sprites mode.',
    format: 'BOWSIE format (Arinsu): an .asm per sprite with the labels init and main (ending with RTL), its extra bytes as !extra (0–8, 2 when not set), a .json next to it with a tooltip. BOWSIE\'s shared routines like %get_draw_info() are built in. Numbers 01–7E. Placed sprites are kept in Lunar Magic\'s custom overworld sprite table.',
    load: () => loadBowsieProject(app.rom),
    empty: () => ({ files: new Map(), list: [] }),
    save: (p) => saveBowsieProject(app.rom, p),
    toZip: bowsieToZip,
    zipName: 'bowsie.zip',
    content,
    applied: (p) => `Overworld sprites applied (${p.list.length})`,
  }, changed);
}
