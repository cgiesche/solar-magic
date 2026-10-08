// Misc. dialogs and actions: secondary entrances, ROM info/expansion, level save as/file/screens.

import type { App } from './app.ts';
import { h, modal, clear, hexInput, select, toast, downloadBytes, pickFile, choose, emptyState } from './dom.ts';
import { isBlank } from '../core/exitgraph.ts';
import { readSecondaryEntrance, type SecondaryEntrance, loadLevel, cloneLevel, insertScreen, deleteScreen, clearLevel, spriteId } from '../core/level.ts';
import { exportLevelFile, importLevelFile, LEVEL_FILE_EXT } from '../core/levelfile.ts';
import { ENTRANCE_ACTIONS, hex, objectName } from '../core/names.ts';
import { saveLevel } from '../core/save.ts';
import { hasEditorPatch, installEditorPatch, DM16_EXT, editorPatch, setLevelGfx, customPalette, setCustomPalette, bgBank } from '../core/patches.ts';
import { bgFromWram } from '../core/bg.ts';
import { STRUCT_EXT, hasStructs } from '../core/structs.ts';

// overview of all secondary entrances of the current level's bank: where each leads, which exits use it
export function openEntrancesDialog(app: App): void {
  const rom = app.rom;
  const bank = app.level.number & 0x100;
  const filter = h('select', null, h('option', { value: 'level' }, 'into this level'), h('option', { value: 'set' }, 'all set up'), h('option', { value: 'all' }, 'all (including free)'));
  const list = h('div', { class: 'gfx-list', style: 'height: 420px; min-width: 360px' });
  const detail = h('div', { class: 'ent-detail' });
  let sel = -1;
  const buildList = () => {
    clear(list);
    const g = app.exitGraph();
    const mine = new Set(g.entrancesOf(app.level.number));
    for (let i = bank; i < bank + 0x100; i++) {
      const e = readSecondaryEntrance(rom, i);
      const users = g.usersOfEntrance(i).length;
      const blank = isBlank(rom, i) && !users;
      if (filter.value === 'level' && !mine.has(i)) continue;
      if (filter.value === 'set' && blank) continue;
      const to = e.destLevel | bank;
      list.appendChild(h('div', { class: `level-item${i === sel ? ' current' : ''}${blank ? ' unused' : ''}`, onclick: () => { sel = i; buildList(); buildDetail(); } },
        `${hex(i, 3)} `, blank ? h('span', { class: 'lname' }, 'free') : h('span', null, `→ ${hex(to, 3)} `, h('span', { class: 'lname' }, `${g.name(to)} · ${users ? `${users} Exit${users > 1 ? 's' : ''}` : 'unused'}`))));
    }
    if (!list.firstChild) list.append(emptyState(filter.value === 'level' ? 'No secondary entrances into this level.' : 'No entries.'));
  };
  const buildDetail = () => {
    clear(detail);
    if (sel < 0) { detail.append(h('div', { class: 'hint' }, 'Select an entry. Edit and move it directly in the level in “Entrances/Exits” mode (key 4).')); return; }
    const e = readSecondaryEntrance(rom, sel);
    const g = app.exitGraph();
    const to = e.destLevel | bank;
    const blank = isBlank(rom, sel);
    const set = (label: string, f: (x: SecondaryEntrance) => void) => { app.editSecondaryEntrance(sel, `Secondary entrance ${hex(sel, 3)}: ${label}`, f, `sec-entrance-dlg:${sel}`); buildList(); buildDetail(); };
    const range = (n: number): [number, string][] => Array.from({ length: n }, (_, i) => [i, String(i)]);
    const users = g.usersOfEntrance(sel);
    detail.append(
      h('div', { class: 'prop-title' }, `Secondary entrance ${hex(sel, 3)}`),
      blank ? h('div', { class: 'hint' }, 'Free: no exit uses it.') : h('div', null, 'Leads to ', h('b', null, `level ${hex(to, 3)}`), ' ', h('span', { class: 'hint' }, g.name(to))),
      h('div', { class: 'prop' }, h('label', null, 'Target level (low digits)'), hexInput(e.destLevel, 2, (v) => set('Target level', (x) => (x.destLevel = v)))),
      h('div', { class: 'prop' }, h('label', null, 'Screen'), hexInput(e.screen, 2, (v) => set('Screen', (x) => (x.screen = v)), 0x1f)),
      h('div', { class: 'prop' }, h('label', null, 'X position'), select(range(8), e.entranceX, (v) => set('X', (x) => (x.entranceX = v)))),
      h('div', { class: 'prop' }, h('label', null, 'Y position'), select(range(16), e.entranceY, (v) => set('Y', (x) => (x.entranceY = v)))),
      h('div', { class: 'prop' }, h('label', null, 'Action'), select(ENTRANCE_ACTIONS.map((a, i) => [i, `${i} – ${a}`] as [number, string]), e.action, (v) => set('Action', (x) => (x.action = v)))),
      h('div', { class: 'prop' }, h('label', null, 'FG start Y'), select(range(4), e.fgInitY, (v) => set('FG start Y', (x) => (x.fgInitY = v)))),
      h('div', { class: 'prop' }, h('label', null, 'BG start Y'), select(range(4), e.bgInitY, (v) => set('BG start Y', (x) => (x.bgInitY = v)))),
      h('div', { class: 'hint' }, users.length ? `Used by: ${users.map((u) => `${hex(u.from, 3)} (screen ${hex(u.screen, 2)})`).join(', ')}` : 'No exit uses this entrance.'),
      h('div', { class: 'row' },
        blank ? '' : h('button', { onclick: () => { dlg.close(true); openTarget(to); } }, `Open level ${hex(to, 3)}`),
        h('button', { onclick: () => set('to current level', (x) => (x.destLevel = app.level.number & 0xff)) }, `Set to current level (${hex(app.level.number, 3)})`)),
      h('div', { class: 'hint' }, 'The high bit (0xx/1xx) comes from the level the exit is in. Changes can be undone with Ctrl+Z.'),
    );
  };
  const openTarget = (to: number) => {
    const idx = sel;
    if (to !== app.level.number) app.openLevel(to);
    if (app.mode !== 'exit') app.setMode('exit');
    app.exitMarker = { kind: 'sec', index: idx };
    app.revealMarker();
  };
  const newEntry = () => {
    const idx = app.exitGraph().freeEntrance(app.level.number);
    if (idx === null) { toast('No free secondary entrance left.', 'error'); return; }
    const s = app.level.secondary;
    app.editSecondaryEntrance(idx, `Secondary entrance ${hex(idx, 3)} created`, (x) => {
      x.destLevel = app.level.number & 0xff; x.screen = s.entranceScreen; x.entranceX = s.entranceX; x.entranceY = s.entranceY; x.action = s.entranceAction;
    });
    sel = idx;
    buildList();
    buildDetail();
  };
  filter.addEventListener('change', buildList);
  sel = app.exitGraph().entrancesOf(app.level.number)[0] ?? -1;
  if (sel < 0) filter.value = 'set';
  buildList();
  buildDetail();
  const dlg = modal(`Secondary entrances ${bank ? '100–1FF' : '000–0FF'}`, h('div', { class: 'ent-editor' },
    h('div', null, h('div', { class: 'row small' }, 'Show: ', filter, h('button', { title: 'Next free number, into the current level (at the main entrance)', onclick: newEntry }, '+ New')), list), detail),
  [{ label: 'Close', primary: true }], () => { app.romWritten(); });
}

export function openRomInfo(app: App): void {
  const rom = app.rom;
  const rats = rom.scanRats();
  const used = rats.reduce((a, b) => a + b.size + 8, 0);
  const expanded = Math.max(0, rom.size - 0x80000);
  const body = h('div', null,
    h('div', { class: 'prop' }, h('label', null, 'Title'), h('span', null, rom.title())),
    h('div', { class: 'prop' }, h('label', null, 'Size'), h('span', null, `${rom.size / 1024} KB${rom.smcHeader ? ' (+512 byte copier header)' : ''}`)),
    h('div', { class: 'prop' }, h('label', null, 'Expanded area'), h('span', null, `${expanded / 1024} KB, ${(used / 1024).toFixed(1)} KB of it in use (${rats.length} RATS blocks)`)),
    h('div', { class: 'prop' }, h('label', null, 'Editor data'), h('span', null, rom.extra.size ? `${(rom.extraSize / 1024).toFixed(1)} KB (${rom.extra.size} source archives) – not in the ROM, saved with “Save project”` : 'none')),
    h('div', { class: 'prop' }, h('label', null, 'Editor patch'), h('span', null, hasEditorPatch(rom) ? 'installed' : 'not installed')),
  );
  modal('ROM information', body, [{ label: 'Close', primary: true }]);
}

export function openExpandDialog(app: App): void {
  const rom = app.rom;
  const body = h('div', null,
    h('p', { class: 'hint' }, `Currently ${rom.size / 1024} KB. More room for levels, graphics, music etc. Saving expands automatically when needed. At most 4 MB (LoROM).`),
    h('div', { class: 'row' }, [0x100000, 0x200000, 0x400000].map((sz) => h('button', {
      disabled: rom.size >= sz,
      onclick: () => { rom.expand(sz); app.romWritten(); toast(`ROM expanded to ${sz / 1048576} MB`); dlg.close(); },
    }, `${sz / 1048576} MB`))),
  );
  const dlg = modal('Expand ROM', body, [{ label: 'Cancel' }]);
}

export async function installEditorPatchAction(app: App): Promise<void> {
  const ok = await choose('Install editor patch', 'The editor patch allows sprite data in any bank, 256 graphics files (ExGFX, also uncompressed as 4bpp), graphics assignment per level and the "Direct Map16" object (place any Map16 tiles). It is also installed automatically when needed.',
    [{ label: 'Cancel' }, { label: 'Install', primary: true }]);
  if (ok !== 1) return;
  try { installEditorPatch(app.rom); app.romWritten(); toast('Editor patch installed'); app.refresh(); } catch (e) { toast(String(e), 'error'); }
}

// one undoable structural edit of the current level
function levelEdit(app: App, f: () => void): boolean {
  app.checkpoint();
  try { f(); } catch (e) { app.undoStack.pop(); toast(String(e instanceof Error ? e.message : e), 'error'); return false; }
  app.selection.clear();
  app.changed();
  app.emit('level-header');
  return true;
}

export function openSaveAsDialog(app: App): void {
  const lv = app.level;
  let target = lv.number;
  const body = h('div', null,
    h('p', { class: 'hint', style: 'max-width:420px' }, `Save level ${hex(lv.number, 3)} (with all current changes) under another number. The target is overwritten.`),
    h('div', { class: 'row' }, h('label', null, 'Target level '), hexInput(target, 3, (v) => (target = v), 0x1ff)));
  modal(`Save level ${hex(lv.number, 3)} as`, body, [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => saveAs(app, target) }]);
}

export function exportLevel(app: App): void {
  const lv = app.level;
  const bg = lv.bg ?? (!lv.layer2Objects && bgBank(app.rom, lv.number) ? bgFromWram(app.render.wram) : null);
  downloadBytes(`level-${hex(lv.number, 3)}${LEVEL_FILE_EXT}`, new TextEncoder().encode(exportLevelFile(app.rom, lv, bg)), 'application/json');
}

export function openScreenDialog(app: App, op: 'insert' | 'delete'): void {
  const lv = app.level;
  let screen = 0;
  const screenOpts: [number, string][] = Array.from({ length: lv.header.screens }, (_, i) => [i, hex(i, 2)]);
  const dir = app.vertical ? 'down' : 'to the right';
  const body = h('div', null,
    h('p', { class: 'hint', style: 'max-width:420px' }, op === 'insert'
      ? `Everything from the chosen screen on is moved one screen ${dir} (objects, sprites, exits, entrance, midway). Secondary entrances stay unchanged.`
      : `The chosen screen is removed; everything after it moves back one screen (objects, sprites, exits, entrance, midway). Secondary entrances stay unchanged.`),
    h('div', { class: 'row' }, h('label', null, op === 'insert' ? 'Insert empty screen before screen ' : 'Screen '), select(screenOpts, screen, (v) => (screen = v))));
  modal(op === 'insert' ? 'Insert screen' : 'Delete screen', body, [
    { label: 'Cancel' },
    { label: op === 'insert' ? 'Insert' : 'Delete', primary: true, onClick: () => levelEdit(app, () => (op === 'insert' ? insertScreen : deleteScreen)(app.rom, app.level, screen)) },
  ]);
}

export async function clearLevelConfirm(app: App): Promise<void> {
  const r = await choose(`Clear level ${hex(app.level.number, 3)}`, 'Remove all objects, sprites and exits? (undoable)', [{ label: 'Cancel' }, { label: 'Clear', danger: true }]);
  if (r === 1) levelEdit(app, () => clearLevel(app.level));
}

function saveAs(app: App, target: number): void {
  const copy = cloneLevel(app.level);
  const dst = loadLevel(app.rom, target);
  // an edited BG belongs to its level (bank table entry): the copy gets its own data
  if (!copy.layer2Objects && !copy.bg && bgBank(app.rom, app.level.number)) copy.bg = bgFromWram(app.render.wram);
  copy.number = target;
  // write into fresh space: pretend old data of target is the destination
  copy.l1Addr = dst.l1Addr; copy.l1Size = 0; copy.l2Size = 0; copy.sprAddr = dst.sprAddr; copy.sprSize = 0;
  try {
    const log = saveLevel(app.rom, copy);
    app.romWritten();
    toast(`Saved as level ${hex(target, 3)}: ${log.join(' · ')}`);
    app.emit('level');
  } catch (e) {
    toast(String(e), 'error');
  }
}

export async function importLevel(app: App): Promise<boolean> {
  const f = await pickFile(`${LEVEL_FILE_EXT},.json`);
  if (!f) return false;
  try {
    const rom = app.rom, n = app.level.number;
    const data = importLevelFile(rom, await f.text(), app.level);
    app.checkpoint();
    app.level = data.level;
    // graphics slots and palette live in the ROM: an undoable ROM edit (Ctrl+Z takes them back first)
    if (data.gfx || editorPatch(rom) || data.palette || customPalette(rom, n)) app.romEdit(`${f.name}: graphics slots/palette of level ${hex(n, 3)}`, () => {
      if (data.gfx || editorPatch(rom)) setLevelGfx(rom, n, data.gfx ?? new Array(8).fill(0xff));
      if (data.palette || customPalette(rom, n)) setCustomPalette(rom, n, data.palette);
    });
    app.romWritten();
    app.selection.clear();
    app.changed();
    app.emit('level-header');
    app.palettesChanged();
    toast(`${f.name} imported as level ${hex(n, 3)} (not saved yet).`);
    return true;
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e), 'error');
    return false;
  }
}

// Insert by number (like Lunar Magic's manual insert): object, extended object or sprite at tile (tx, ty)
export function openInsertDialog(app: App, tx: number, ty: number): void {
  const p = app.paletteItem;
  let kind: 0 | 1 | 2 = app.mode === 'spr' ? 2 : p?.kind === 'obj' && p.num === 0 ? 1 : 0;
  let num = p?.kind === 'spr' ? (kind === 2 ? p.num : 1) : p ? (p.num || p.ext) : 1;
  let size = p?.kind === 'obj' ? p.size : 0;
  let extra = p?.kind === 'spr' ? p.extra : 0;
  const name = h('div', { class: 'hint' });
  const fields = h('div');
  const showName = () => (name.textContent = kind === 2 ? app.spriteLabel(spriteId({ num, extra })) : kind === 1 ? objectName(0, num) : objectName(num, 0));
  const build = () => {
    clear(fields);
    if (kind === 0) num = Math.max(1, Math.min(0x3f, num));
    showName();
    fields.append(
      h('div', { class: 'prop' }, h('label', null, 'Number'), hexInput(num, 2, (v) => { num = v; showName(); }, kind === 0 ? 0x3f : 0xff)),
      kind === 0 ? h('div', { class: 'prop' }, h('label', null, 'Size/setting'), hexInput(size, 2, (v) => (size = v))) : '',
      kind === 2 ? h('div', { class: 'prop' }, h('label', null, 'Extra bits'), hexInput(extra, 1, (v) => { extra = v; showName(); }, 3)) : '',
      kind === 2 ? h('div', { class: 'hint' }, 'Extra bits 2/3: custom sprite (PIXI) without/with extra bit') : '',
      name,
    );
  };
  const body = h('div', null,
    h('div', { class: 'prop' }, h('label', null, 'Type'), select([[0, 'Object'], [1, 'Extended object'], [2, 'Sprite']], kind, (v) => { kind = v as 0 | 1 | 2; build(); })),
    fields,
    h('div', { class: 'hint' }, `Position X ${hex(tx, 2)} · Y ${hex(ty, 2)}`),
  );
  build();
  const insert = () => {
    if (kind === 2) {
      app.insertAt(tx, ty, { kind: 'spr', num, extra });
    } else {
      if (app.mode !== 'l1' && app.mode !== 'l2') app.setMode('l1');
      if (kind === 0 && num === 0) { toast('There is no object 00 – use “Extended object” for extended objects.', 'error'); return false; }
      if (kind === 1 && num === DM16_EXT) { toast('Please place Direct Map16 via the palette\'s Map16 tab.', 'error'); return false; }
      if (kind === 1 && num === STRUCT_EXT && hasStructs(app.rom)) { toast('Please place structures via the palette\'s Structures tab.', 'error'); return false; }
      app.insertAt(tx, ty, kind === 0 ? { kind: 'obj', num, ext: 0, size } : { kind: 'obj', num: 0, ext: num, size: 0 });
    }
  };
  const dlg = modal('Insert by number', body, [{ label: 'Cancel' }, { label: 'Insert', primary: true, onClick: insert }]);
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    (e.target as HTMLElement).dispatchEvent(new Event('change')); // commit the field being edited
    if (insert() !== false) dlg.close();
  });
  setTimeout(() => (fields.querySelector('input') as HTMLInputElement | null)?.select(), 0);
}
