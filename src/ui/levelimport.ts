// Level import (see CONTEXT.md): a Lunar Magic level file (.mwl, usually with .map16, ExGFX, .pal and
// .palmask, as graphics downloads on SMWCentral come) applied to the current level – background, FG Map16
// tiles, graphics slots and colors. It changes a level rather than installing content, so it is offered
// in the level editor (Level → Import LM level file …) and is never a package. Undoable like level edits.

import type { App } from './app.ts';
import { h, modal, clear, toast, hexInput } from './dom.ts';
import { pickFile } from './platform.ts';
import { hex } from '../core/names.ts';
import { planBgPack, importLevelFile, isLevelImport, levelColors, type BgPackResult } from '../core/bgpack.ts';
import { extGfxAvailable } from '../core/patches.ts';
import { uploadFiles } from '../core/patchpkg.ts';
import { map16Source } from '../core/render.ts';
import { logView, errorText } from './projectpane.ts';

// picks a level file (.mwl, or a .zip holding one) and opens the import for the current level
export async function openLevelImport(app: App): Promise<void> {
  const f = await pickFile('.mwl,.zip');
  if (!f) return;
  let files: Map<string, Uint8Array>;
  try { files = uploadFiles(f.name, new Uint8Array(await f.arrayBuffer())); } catch (e) { toast(errorText(e), 'error'); return; }
  if (!isLevelImport(files)) { toast(`“${f.name}” holds no Lunar Magic level file (.mwl).`, 'error'); return; }
  openLevelImportDialog(app, f.name, files);
}

// what the level file brings into the current level: its background, its FG Map16 tiles to place, the
// graphics slots and colors they need
export function openLevelImportDialog(app: App, fileName: string, files: Map<string, Uint8Array>): void {
  const name = fileName.replace(/\.[^.]*$/, '').split(/[\\/]/).pop()!;
  const lvl = hex(app.level.number, 3);
  const blank = map16Source(app.rom, app.render).fg(0x025);
  const plan = planBgPack(app.rom, name, files, blank);
  const canBg = !!plan.level.bg && app.canEditBg();
  if (!canBg && !plan.fg) {
    modal(`Import level file: ${name}`, h('p', null, plan.level.bg
      ? `“${name}” has a background (BG tilemap). But level ${lvl} has layer 2 objects instead of a BG background – open a level with a BG first.`
      : `“${name}” has neither a BG background nor FG Map16 tiles to take over.`), [{ label: 'OK', primary: true }]);
    return;
  }
  let at = plan.at, fgAt = plan.fgAt, useBg = canBg, useFg = !!plan.fg;
  const usePal = plan.palettes.map((p) => !p.layer3);
  const n16 = plan.map16 ? plan.map16.data.tiles.length : 0;
  const ext = plan.gfx.some((g) => g.slot === 'BG2' || g.slot === 'BG3');
  const file = (f: string) => f.split('/').pop()!;
  const check = (on: boolean, set: (v: boolean) => void, disabled = false) =>
    h('input', { type: 'checkbox', checked: on, disabled, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) });
  const log = h('div');
  const body = h('div', { class: 'patch-apply' },
    h('p', null, `“${name}” is a Lunar Magic level file (${file(plan.mwl)}). Taken over into level ${lvl}: what is checked below, the graphics slots its tiles use and the colors per .palmask. Layer 1, sprites and header of level ${lvl} stay.`),
    plan.level.bg ? h('label', { class: 'row small' }, check(useBg, (v) => (useBg = v), !canBg),
      canBg ? ` Background: the BG tilemap${n16 ? ` and ${n16} BG Map16 tiles` : ''}` : ` Background – not possible: level ${lvl} has layer 2 objects instead of a BG background`) : '',
    plan.map16 && canBg ? h('div', { class: 'prop' }, h('label', { title: file(plan.map16.file) }, 'BG Map16'),
      h('span', null, `${n16} tiles from BG tile `), hexInput(at, 3, (v) => (at = v), 0xfff),
      h('span', { class: 'hint' }, at !== plan.map16.from ? ` (from ${hex(plan.map16.from, 3)} in the level file, already in use here)` : '')) : '',
    plan.fg ? h('label', { class: 'row small' }, check(useFg, (v) => (useFg = v)), ` Foreground: ${plan.fg.data.tiles.length} FG Map16 tiles (${file(plan.fg.file)}) to place in levels`) : '',
    plan.fg ? h('div', { class: 'prop' }, h('label', null, 'FG Map16'),
      h('span', null, 'from tile '), hexInput(fgAt, 3, (v) => (fgAt = v), 0xfff),
      h('span', { class: 'hint' }, fgAt !== plan.fg.from ? ` (from ${hex(plan.fg.from, 3)} in the level file, already in use here)` : '')) : '',
    ...plan.gfx.map((g) => g.file
      ? h('div', { class: 'prop' }, h('label', null, `${g.slot}: ${file(g.file)}`),
        h('span', null, 'as ExGFX '), hexInput(g.num, 2, (v) => (g.num = v), 0xfe),
        g.lmNum > 0xff ? h('span', { class: 'hint' }, ` (Lunar Magic: ${hex(g.lmNum, 3)})`) : '')
      : h('div', { class: 'prop' }, h('label', null, g.slot), h('span', { class: 'hint' }, `ROM graphics file ${hex(g.num, 2)}`))),
    ...plan.palettes.map((p, i) => h('label', { class: 'row small' }, check(usePal[i], (v) => (usePal[i] = v)),
      ` Colors from ${file(p.file)}: ${p.colors.length} color(s)${p.back ? ' and the background color' : ''} (custom palette for level ${lvl})`,
      p.layer3 ? h('span', { class: 'hint' }, ' – layer 3 colors') : '')),
    plan.layer3.length ? h('p', { class: 'hint' }, `Layer 3 (${plan.layer3.map(file).join(', ')}) is not taken over – Lunar Magic's layer 3 tilemaps are not supported yet.`) : '',
    ext && !extGfxAvailable(app.rom) ? h('p', { class: 'hint' }, 'For the BG2/BG3 slots the VRAM patch is installed.') : '',
    plan.notes.length ? h('ul', { class: 'hint' }, plan.notes.map((t) => h('li', null, t))) : '',
    log);
  modal(`Import level file: ${name}`, body, [
    { label: 'Cancel' },
    { label: 'Import', primary: true, onClick: () => {
      let r: BgPackResult;
      try {
        r = app.romEdit(`Level import “${name}” into level ${lvl}`, () =>
          importLevelFile(app.rom, app.level, files, plan, { bg: useBg, fg: useFg, at, fgAt, palettes: usePal, cgram: levelColors(app.render), blank }));
      } catch (e) { r = { ok: false, errors: [errorText(e)], notes: [], bg: null }; }
      if (!r.ok) { clear(log).appendChild(logView({ ok: false, errors: r.errors, warnings: [], prints: [] })); return false; }
      const bg = r.bg;
      if (bg) app.editLevel(() => { app.level.bg = bg; });
      app.emit('level-header');
      toast(`“${name}” imported into level ${lvl}: ${r.notes.join(' · ')}${r.bg ? ' – level not saved yet' : ''}`);
      return true;
    } },
  ]);
}

