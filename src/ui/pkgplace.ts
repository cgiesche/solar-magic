// The placement part of the upload preview (ADR 0002): where the package's Map16 tiles, blocks and
// ExGFX go in this ROM and how they link up – which block each Map16 tile shows, which slot each ExGFX
// file is for – as planUpload works it out, changeable before installing; the level setup for the
// current level (its slots and colors), which can be unchecked; and the sample level in its place.

import type { App } from './app.ts';
import { h, clear, hexInput } from './dom.ts';
import { hex } from '../core/names.ts';
import { planUpload, type ReadyPreview, type InstallOptions } from '../core/packages.ts';
import { editPlan, tileBlocks, type PackagePlan, type PlanEdits } from '../core/pkgplan.ts';
import { map16Targets } from '../core/map16file.ts';
import { levelColors, GFX_SLOTS } from '../core/levelgfx.ts';
import { altFileName, levelAltFile } from '../core/exanim.ts';
import { errorText } from './projectpane.ts';
import { gfxNumberField } from './gfxnum.ts';

const file = (f: string) => f.split('/').pop()!;

export interface Placement {
  el: HTMLElement;
  // the install options it stands for; throws when the edits don't fit together
  read(): Pick<InstallOptions, 'plan' | 'setup' | 'cgram' | 'wram' | 'sample'>;
}

// null: the package has nothing to place (no blocks, no graphics)
export function placementEditor(app: App, p: ReadyPreview, blank: number[]): Placement | null {
  if (!p.parts.some((x) => x.kind === 'block' || (x.kind === 'graphics' && x.type !== 'palmask')) && !p.sample) return null;
  const lvl = hex(app.level.number, 3);
  let plan: PackagePlan;
  try { plan = planUpload(app.rom, p, blank); } catch (e) {
    const msg = errorText(e);
    return { el: h('p', { class: 'hint error' }, `Cannot place the package: ${msg}`), read: () => { throw new Error(msg); } };
  }
  const edits: PlanEdits = { map16At: plan.map16?.at, tileBlocks: tileBlocks(plan), blockTiles: new Map(), gfx: plan.gfx.map((g) => ({ num: g.num, slot: g.slot })) };
  // blocks (also) on tiles off the .map16
  const mapTiles = plan.map16 ? map16Targets(plan.map16.data, plan.map16.at) : [];
  for (const b of plan.blocks) { const off = b.tiles.filter((t) => !mapTiles.includes(t)); if (off.length) edits.blockTiles!.set(b.file, off); }
  let setup = true, sample = false;
  const status = h('div');
  const tileCells: HTMLElement[] = [];
  const current = (): PackagePlan => editPlan(plan, edits);
  const refresh = () => {
    if (plan.map16) map16Targets(plan.map16.data, edits.map16At!).forEach((t, i) => (tileCells[i].textContent = hex(t, 3)));
    clear(status);
    try {
      const c = current();
      const slots = c.gfx.filter((g) => g.slot && GFX_SLOTS.includes(g.slot)).map((g) => `${g.slot} = ExGFX ${hex(g.num, 2)}`);
      const colors = c.palettes.filter((x) => !x.layer3).map((x) => `${x.colors.length} color(s) from ${file(x.file)}`);
      const anim = c.exanim.length ? [`${c.exanim.length} animation(s) with their frames in ${altFileName(levelAltFile(app.rom, app.level.number))}`] : [];
      setupText.textContent = slots.length || colors.length || anim.length ? ` Set up level ${lvl}: ${[...slots, ...anim, ...colors].join(', ')}` : ` Level ${lvl}: nothing to set up`;
    } catch (e) { status.appendChild(h('p', { class: 'hint error' }, errorText(e))); }
  };
  const blockOptions = (sel: string | null) => [h('option', { value: '', selected: sel === null }, '(no block)'),
    ...plan.blocks.map((b) => h('option', { value: b.file, selected: b.file === sel }, file(b.file)))];
  const setupText = h('span');
  const el = h('div', null,
    h('h3', null, 'Placement'),
    plan.map16 ? [
      h('div', { class: 'prop' }, h('label', { title: plan.map16.file }, 'Map16 tiles'),
        h('span', null, `${plan.map16.data.tiles.length} from tile `), hexInput(plan.map16.at, 3, (v) => { edits.map16At = v; refresh(); }, 0xfff),
        h('span', { class: 'hint' }, plan.map16.at !== plan.map16.from ? ` (made at ${hex(plan.map16.from, 3)}, taken here)` : '')),
      plan.blocks.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Tile'), h('th', null, 'Block on it')),
        map16Targets(plan.map16.data, plan.map16.at).map((t, i) => {
          const cell = h('td', { class: 'mono' }, hex(t, 3));
          tileCells.push(cell);
          return h('tr', null, cell, h('td', null, h('select', { onchange: (e: Event) => { edits.tileBlocks![i] = (e.target as HTMLSelectElement).value || null; refresh(); } }, blockOptions(edits.tileBlocks![i]))));
        })) : '',
    ] : '',
    [...edits.blockTiles!].map(([f, tiles]) => h('div', { class: 'prop' }, h('label', { title: f }, file(f)),
      h('span', null, 'on tile '), hexInput(tiles[0] ?? 0x200, 3, (v) => { edits.blockTiles!.set(f, [v, ...tiles.slice(1)]); refresh(); }, 0xfff),
      tiles.length > 1 ? h('span', { class: 'hint' }, ` and ${tiles.slice(1).map((t) => hex(t, 3)).join(', ')}`) : '')),
    plan.gfx.map((g, i) => h('div', { class: 'prop' }, h('label', { title: g.file }, file(g.file)),
      h('span', null, 'as ExGFX '), gfxNumberField(app.rom, g.num, {
        file: () => ({ slot: edits.gfx![i].slot, size: g.size }), taken: () => new Set(edits.gfx!.filter((_, k) => k !== i).map((o) => o.num)),
        onChange: (v) => { edits.gfx![i].num = v; refresh(); }, author: g.lmNum, by: 'package' }),
      h('span', null, ' for '),
      h('select', { onchange: (e: Event) => { edits.gfx![i].slot = (e.target as HTMLSelectElement).value || null; refresh(); } },
        h('option', { value: '', selected: !g.slot }, '(no slot)'),
        ...[...GFX_SLOTS, ...(g.slot && !GFX_SLOTS.includes(g.slot) ? [g.slot] : [])].map((s) => h('option', { value: s, selected: s === g.slot }, GFX_SLOTS.includes(s) ? s : `${s} (not supported)`))),
    )),
    h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: true, onchange: (e: Event) => { setup = (e.target as HTMLInputElement).checked; } }), setupText),
    p.sample ? h('label', { class: 'row small' }, h('input', { type: 'checkbox', onchange: (e: Event) => { sample = (e.target as HTMLInputElement).checked; } }),
      ` Replace level ${lvl} by the sample level (${file(p.sample)}): layer 1, layer 2, sprites, header and colors, its tiles and sprites where the package's went; the screen exits of level ${lvl} stay`) : '',
    plan.notes.length ? h('ul', { class: 'hint' }, plan.notes.map((t) => h('li', null, t))) : '',
    status);
  refresh();
  return { el, read: () => ({ plan: current(), setup, cgram: levelColors(app.render), wram: app.render.wram, sample: sample ? app.level : undefined }) };
}
