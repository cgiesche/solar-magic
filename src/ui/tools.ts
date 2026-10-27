// Misc. dialogs and actions: secondary entrances, ROM info/expansion, level save as/file/screens.

import type { App } from './app.ts';
import { h, modal, clear, hexInput, select, toast, choose, emptyState, checkbox } from './dom.ts';
import { downloadBytes, pickFile } from './platform.ts';
import { isBlank } from '../core/exitgraph.ts';
import {
  type SecondaryEntrance, loadLevel, cloneLevel, insertScreen, deleteScreen, clearLevel, spriteId, secondarySpot, spotTile,
} from '../core/level.ts';
import { overworldFields } from './owexit.ts';
import { overworldExitText } from '../core/owteleport.ts';
import { tileFields, cameraFields, optionFields } from './entrancefields.ts';
import { newEntranceIn } from './exitpanel.ts';
import { exportLevelFile, importLevelFile, LEVEL_FILE_EXT } from '../core/levelfile.ts';
import { ENTRANCE_ACTIONS, hex } from '../core/names.ts';
import { saveLevel } from '../core/save.ts';
import { DM16_EXT, setLevelGfx, customPalette, setCustomPalette, bgBank } from '../core/patches.ts';
import { bgFromWram } from '../core/bg.ts';
import { PREFAB_EXT } from '../core/prefabs.ts';

// overview of all secondary entrances (000-1FF): where each leads, which exits use it
export function openEntrancesDialog(app: App): void {
  const rom = app.rom;
  const filter = h('select', null, h('option', { value: 'level' }, 'of this level'), h('option', { value: 'set' }, 'all set up'), h('option', { value: 'all' }, 'all (including free)'));
  const list = h('div', { class: 'gfx-list', style: 'height: 420px; min-width: 360px' });
  const detail = h('div', { class: 'ent-detail' });
  let sel = -1;
  const buildList = () => {
    clear(list);
    const g = app.entrances.graph();
    const mine = new Set(app.entrances.ownedBy(app.level.number));
    for (let i = 0; i < 0x200; i++) {
      const e = app.entrances.get(i);
      const users = g.usersOfEntrance(i).length;
      const blank = isBlank(rom, i) && !users;
      if (filter.value === 'level' && !mine.has(i)) continue;
      if (filter.value === 'set' && blank) continue;
      const to = e.destLevel;
      const use = users ? `${users} Exit${users > 1 ? 's' : ''}` : 'unused';
      list.appendChild(h('div', { class: `level-item${i === sel ? ' current' : ''}${blank ? ' unused' : ''}`, onclick: () => { sel = i; buildList(); buildDetail(); } },
        `${hex(i, 3)} `, blank ? h('span', { class: 'lname' }, 'free')
          : e.overworld ? h('span', null, `→ Overworld [${hex(to, 3)}] `, h('span', { class: 'lname' }, `${overworldExitText(rom, e.overworld)} · ${use}`))
          : h('span', null, `→ ${hex(to, 3)} `, h('span', { class: 'lname' }, `${g.name(to)} · ${use}`))));
    }
    if (!list.firstChild) list.append(emptyState(filter.value === 'level' ? 'No secondary entrances into this level.' : 'No entries.'));
  };
  const buildDetail = () => {
    clear(detail);
    if (sel < 0) { detail.append(h('div', { class: 'hint' }, 'Select an entry. Edit and move it directly in the level in “Entrances/Exits” mode (key 4).')); return; }
    const e = app.entrances.get(sel);
    const g = app.entrances.graph();
    const to = e.destLevel;
    const blank = isBlank(rom, sel);
    const set = (label: string, f: (x: SecondaryEntrance) => void) => { app.entrances.edit(sel, label, f, 'dlg'); buildList(); buildDetail(); };
    const range = (n: number): [number, string][] => Array.from({ length: n }, (_, i) => [i, String(i)]);
    const prop = (label: string, el: HTMLElement) => h('div', { class: 'prop' }, h('label', null, label), el);
    const users = g.usersOfEntrance(sel);
    // Lunar Magic's "Exit to overworld": on, passing the level with the normal exit; off, into its level at the main entrance
    const toOverworld = (on: boolean) => { app.entrances.setOverworld(sel, on); buildList(); buildDetail(); };
    const used = h('div', { class: 'hint' }, users.length ? `Used by: ${users.map((u) => `${hex(u.from, 3)} (screen ${hex(u.screen, 2)})`).join(', ')}` : 'No exit uses this entrance.');
    const owSwitch = h('div', { class: 'prop' }, h('label', null, 'Exit'), checkbox('To the overworld', 'Mario goes back to the overworld instead of into a level (Lunar Magic\'s “Exit to overworld”)', !!e.overworld, toOverworld));
    if (e.overworld) {
      detail.append(
        h('div', { class: 'prop-title' }, `Secondary entrance ${hex(sel, 3)}`),
        h('div', null, 'Leads to the ', h('b', null, 'overworld'), ' ', h('span', { class: 'hint' }, overworldExitText(rom, e.overworld))),
        h('div', { class: 'prop', title: 'The level it belongs to (Lunar Magic: the level whose .mwl it is exported with)' }, h('label', null, 'Level'), hexInput(e.destLevel, 3, (v) => set('Level', (x) => (x.destLevel = v)), 0x1ff)),
        owSwitch,
        ...overworldFields(app, sel, e.overworld, (l, f) => set(l, (x) => f(x.overworld!)), () => { buildList(); buildDetail(); }).map(([l, el]) => prop(l, el)),
        used,
        h('div', { class: 'hint' }, 'Changes can be undone with Ctrl+Z.'),
      );
      return;
    }
    detail.append(
      h('div', { class: 'prop-title' }, `Secondary entrance ${hex(sel, 3)}`),
      blank ? h('div', { class: 'hint' }, 'Free: no exit uses it.') : h('div', null, 'Leads to ', h('b', null, `level ${hex(to, 3)}`), ' ', h('span', { class: 'hint' }, g.name(to))),
      h('div', { class: 'prop' }, h('label', null, 'Target level'), hexInput(e.destLevel, 3, (v) => set('Target level', (x) => (x.destLevel = v)), 0x1ff)),
      owSwitch,
      h('div', { class: 'prop' }, h('label', null, 'Screen'), hexInput(e.screen, 2, (v) => set('Screen', (x) => (x.screen = v)), 0x1f)),
      ...(e.entranceTile ? tileFields(spotTile(secondarySpot(e)), set).map(([l, el]) => prop(l, el)) : [
        h('div', { class: 'prop' }, h('label', null, 'X position'), select(range(8), e.entranceX, (v) => set('X', (x) => (x.entranceX = v)))),
        h('div', { class: 'prop' }, h('label', null, 'Y position'), select(range(16), e.entranceY, (v) => set('Y', (x) => (x.entranceY = v)))),
      ]),
      h('div', { class: 'prop' }, h('label', null, 'Action'), select(ENTRANCE_ACTIONS.map((a, i) => [i, `${i} – ${a}`] as [number, string]), e.action, (v) => set('Action', (x) => (x.action = v)))),
      ...cameraFields(e, set, app.entrances.relativeCamera(to)).map(([l, el]) => prop(l, el)),
      ...optionFields(e, set).map(([l, el]) => prop(l, el)),
      used,
      h('div', { class: 'row' },
        blank ? '' : h('button', { onclick: () => { dlg.close(true); openTarget(to); } }, `Open level ${hex(to, 3)}`),
        h('button', { onclick: () => set('to current level', (x) => (x.destLevel = app.level.number)) }, `Set to current level (${hex(app.level.number, 3)})`)),
      h('div', { class: 'hint' }, 'Changes can be undone with Ctrl+Z.'),
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
    const idx = newEntranceIn(app, app.level.number);
    if (idx === null) return;
    sel = idx;
    buildList();
    buildDetail();
  };
  filter.addEventListener('change', buildList);
  sel = app.entrances.graph().entrancesOf(app.level.number)[0] ?? -1;
  if (sel < 0) filter.value = 'set';
  buildList();
  buildDetail();
  const dlg = modal('Secondary entrances', h('div', { class: 'ent-editor' },
    h('div', null, h('div', { class: 'row small' }, 'Show: ', filter, h('button', { title: 'Next free number, into the current level (at the main entrance)', onclick: newEntry }, '+ New')), list), detail),
  [{ label: 'Close', primary: true }]);
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
  );
  modal('ROM information', body, [{ label: 'Close', primary: true }]);
}

export function openExpandDialog(app: App): void {
  const rom = app.rom;
  const body = h('div', null,
    h('p', { class: 'hint' }, `Currently ${rom.size / 1024} KB. More room for levels, graphics, music etc. Saving expands automatically when needed. At most 4 MB (LoROM).`),
    h('div', { class: 'row' }, [0x100000, 0x200000, 0x400000].map((sz) => h('button', {
      // not undoable: the step would hold two whole ROM copies
      disabled: rom.size >= sz,
      onclick: () => { app.romEdit(`ROM expanded to ${sz / 1048576} MB`, () => rom.expand(sz), { record: false }); toast(`ROM expanded to ${sz / 1048576} MB`); dlg.close(); },
    }, `${sz / 1048576} MB`))),
  );
  const dlg = modal('Expand ROM', body, [{ label: 'Cancel' }]);
}

// one undoable structural edit of the current level
function levelEdit(app: App, f: () => void): boolean {
  try { app.editLevel(() => { f(); app.selection.clear(); }); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); return false; }
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

export function openScreenDialog(app: App, op: 'insert' | 'delete', screen = 0): void {
  const lv = app.level;
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
    const log = app.romEdit(`Level ${hex(app.level.number, 3)} saved as ${hex(target, 3)}`, () => saveLevel(app.rom, copy));
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
    const text = await f.text();
    // prefabs, graphics slots and palette live in the ROM: an undoable ROM edit, then the level (not
    // saved yet) as a level edit (Ctrl+Z takes that back first)
    const data = app.romEdit(`${f.name}: prefabs, graphics slots/palette of level ${hex(n, 3)}`, () => {
      const d = importLevelFile(rom, text, app.level);
      setLevelGfx(rom, n, d.gfx ?? new Array(8).fill(0xff));
      if (d.palette || customPalette(rom, n)) setCustomPalette(rom, n, d.palette);
      return d;
    });
    app.replaceLevel(data.level);
    toast(`${f.name} imported as level ${hex(n, 3)} (not saved yet).`);
    return true;
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e), 'error');
    return false;
  }
}

// Insert by number (like Lunar Magic's manual insert): object, extended object or sprite at tile (tx, ty)
export function openInsertDialog(app: App, tx: number, ty: number): void {
  const p = app.pickedItem;
  let kind: 0 | 1 | 2 = app.mode === 'spr' ? 2 : p?.kind === 'obj' && p.num === 0 ? 1 : 0;
  let num = p?.kind === 'spr' ? (kind === 2 ? p.num : 1) : p ? (p.num || p.ext) : 1;
  let size = p?.kind === 'obj' ? p.size : 0;
  let extra = p?.kind === 'spr' ? p.extra : 0;
  const name = h('div', { class: 'hint' });
  const fields = h('div');
  const showName = () => (name.textContent = kind === 2 ? app.spriteLabel(spriteId({ num, extra })) : kind === 1 ? app.objectName(0, num) : app.objectName(num, 0));
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
      if (kind === 1 && num === DM16_EXT) { toast('Please place Direct Map16 via the picker\'s Map16 tab.', 'error'); return false; }
      if (kind === 1 && num === PREFAB_EXT) { toast('Please place prefabs via the picker\'s Objects tab (Prefabs).', 'error'); return false; }
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
