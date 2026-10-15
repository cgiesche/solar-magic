// Level import (see CONTEXT.md): a Lunar Magic level file (.mwl, usually with .map16, ExGFX, .pal and
// .palmask, as graphics downloads on SMWCentral come) applied to the current level – background, FG Map16
// tiles, graphics slots and colors. It changes a level rather than installing content, so it is offered
// in the level editor (Level → Import LM level file …) and is never a package. Undoable like level edits.

import type { App } from './app.ts';
import { h, modal, toast, hexInput, logTool } from './dom.ts';
import { pickFile } from './platform.ts';
import { hex } from '../core/names.ts';
import { planBgPack, importLevelFile, isLevelImport, type BgPackResult } from '../core/bgpack.ts';
import { levelColors } from '../core/levelgfx.ts';
import { altFileName, levelAltFile } from '../core/exanim.ts';
import { LT3_DESTS, LT3_SIZES } from '../core/layer3gfx.ts';
import { uploadFiles } from '../core/patchpkg.ts';
import { map16Source } from '../core/render.ts';
import { errorText } from './projectpane.ts';

// picks a level file (.mwl, or a .zip holding one) and opens the import for the current level
export async function openLevelImport(app: App): Promise<void> {
  const f = await pickFile('.mwl,.zip');
  if (!f) return;
  let files: Map<string, Uint8Array>;
  try { files = uploadFiles(f.name, new Uint8Array(await f.arrayBuffer())); } catch (e) { toast(errorText(e), 'error'); return; }
  // (one with code or songs is a package, its level file a sample level)
  if (!isLevelImport(files)) { toast(`“${f.name}” is no level import: it holds no Lunar Magic level file (.mwl), or it holds code or songs – a package, uploaded under Packages.`, 'error'); return; }
  openLevelImportDialog(app, f.name, files);
}

// what the level file brings into the current level: its background, its FG Map16 tiles to place, its
// layer 3 graphics and tilemap, the graphics slots and colors they need
export function openLevelImportDialog(app: App, fileName: string, files: Map<string, Uint8Array>): void {
  const name = fileName.replace(/\.[^.]*$/, '').split(/[\\/]/).pop()!;
  const lvl = hex(app.level.number, 3);
  const blank = map16Source(app.rom, app.render).fg(0x025);
  const plan = planBgPack(app.rom, name, files, blank);
  const canBg = !!plan.level.bg && app.canEditBg();
  if (!canBg && !plan.fg && !plan.layer3) {
    modal(`Import level file: ${name}`, h('p', null, plan.level.bg
      ? `“${name}” has a background (BG tilemap). But level ${lvl} has layer 2 objects instead of a BG background – open a level with a BG first.`
      : `“${name}” has neither a BG background, FG Map16 tiles nor layer 3 graphics to take over.`), [{ label: 'OK', primary: true }]);
    return;
  }
  let at = plan.at, fgAt = plan.fgAt, useBg = canBg, useFg = !!plan.fg, use3 = !!plan.layer3;
  // layer 3 colors (0-31) are offered with layer 3 and taken over only with it
  const usePal = plan.palettes.map((p) => !p.layer3 || use3);
  const l3 = plan.gfx.filter((g) => g.parts.includes('layer3')), lt3 = l3.find((g) => g.slot === 'LT3');
  const n16 = plan.map16 ? plan.map16.data.tiles.length : 0;
  const file = (f: string) => f.split('/').pop()!;
  const check = (on: boolean, set: (v: boolean) => void, disabled = false) =>
    h('input', { type: 'checkbox', checked: on, disabled, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) });
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
    plan.layer3 ? h('label', { class: 'row small' }, check(use3, (v) => (use3 = v)),
      ` Layer 3: ${l3.map((g) => g.slot === 'LT3' ? 'the tilemap' : g.slot).join(', ')}${lt3 ? ` (tilemap: ${LT3_DESTS[plan.layer3.dest].toLowerCase()}, 0x${hex(LT3_SIZES[plan.layer3.size], 4)} bytes)` : ''}`) : '',
    ...plan.gfx.map((g) => g.file
      ? h('div', { class: 'prop' }, h('label', null, `${g.slot}: ${file(g.file)}`),
        h('span', null, 'as ExGFX '), hexInput(g.num, 2, (v) => (g.num = v), 0xfe),
        g.lmNum > 0xff ? h('span', { class: 'hint' }, ` (Lunar Magic: ${hex(g.lmNum, 3)})`) : '')
      : h('div', { class: 'prop' }, h('label', null, g.slot), h('span', { class: 'hint' }, `ROM graphics file ${hex(g.num, 2)}`))),
    ...plan.palettes.map((p, i) => h('label', { class: 'row small' }, check(usePal[i], (v) => (usePal[i] = v)),
      ` Colors from ${file(p.file)}: ${p.colors.length} color(s)${p.back ? ' and the background color' : ''} (custom palette for level ${lvl})`,
      p.layer3 ? h('span', { class: 'hint' }, ' – layer 3 colors') : '')),
    plan.exanim.length ? h('p', { class: 'hint' }, `Animations: ${plan.exanim.length} slot(s) animating its tiles go into the list of level ${lvl}; their frames are copied into ${altFileName(levelAltFile(app.rom, app.level.number))}, which all levels using it share.`) : '',
    plan.notes.length ? h('ul', { class: 'hint' }, plan.notes.map((t) => h('li', null, t))) : '');
  modal(`Import level file: ${name}`, body, [
    { label: 'Cancel' },
    { label: 'Import', primary: true, onClick: () => {
      let r: BgPackResult;
      try {
        r = app.romEdit(`Level import “${name}” into level ${lvl}`, () =>
          importLevelFile(app.rom, app.level, files, plan, { bg: useBg, fg: useFg, layer3: use3, at, fgAt, palettes: usePal.map((v, i) => v && (use3 || !plan.palettes[i].layer3)), cgram: levelColors(app.render), wram: app.render.wram, blank }));
      } catch (e) { r = { ok: false, errors: [errorText(e)], notes: [], bg: null }; }
      if (!r.ok) { logTool(`Level import “${name}”`, { errors: r.errors, warnings: [] }); return false; }
      const bg = r.bg;
      if (bg) app.editLevel(() => { app.level.bg = bg; });
      toast(`“${name}” imported into level ${lvl}: ${r.notes.join(' · ')}${r.bg ? ' – level not saved yet' : ''}`);
      return true;
    } },
  ]);
}

