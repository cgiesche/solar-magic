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
  const filter = h('select', null, h('option', { value: 'level' }, 'in dieses Level'), h('option', { value: 'set' }, 'alle angelegten'), h('option', { value: 'all' }, 'alle (auch freie)'));
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
        `${hex(i, 3)} `, blank ? h('span', { class: 'lname' }, 'frei') : h('span', null, `→ ${hex(to, 3)} `, h('span', { class: 'lname' }, `${g.name(to)} · ${users ? `${users} Exit${users > 1 ? 's' : ''}` : 'unbenutzt'}`))));
    }
    if (!list.firstChild) list.append(emptyState(filter.value === 'level' ? 'Keine sekundären Eingänge in dieses Level.' : 'Keine Einträge.'));
  };
  const buildDetail = () => {
    clear(detail);
    if (sel < 0) { detail.append(h('div', { class: 'hint' }, 'Einen Eintrag wählen. Bearbeiten und Verschieben geht direkt im Level im Modus „Ein-/Ausgänge“ (Taste 4).')); return; }
    const e = readSecondaryEntrance(rom, sel);
    const g = app.exitGraph();
    const to = e.destLevel | bank;
    const blank = isBlank(rom, sel);
    const set = (label: string, f: (x: SecondaryEntrance) => void) => { app.editSecondaryEntrance(sel, `Sekundärer Eingang ${hex(sel, 3)}: ${label}`, f, `sec-entrance-dlg:${sel}`); buildList(); buildDetail(); };
    const range = (n: number): [number, string][] => Array.from({ length: n }, (_, i) => [i, String(i)]);
    const users = g.usersOfEntrance(sel);
    detail.append(
      h('div', { class: 'prop-title' }, `Sekundärer Eingang ${hex(sel, 3)}`),
      blank ? h('div', { class: 'hint' }, 'Frei: kein Exit benutzt ihn.') : h('div', null, 'Führt in ', h('b', null, `Level ${hex(to, 3)}`), ' ', h('span', { class: 'hint' }, g.name(to))),
      h('div', { class: 'prop' }, h('label', null, 'Ziel-Level (untere Stellen)'), hexInput(e.destLevel, 2, (v) => set('Ziellevel', (x) => (x.destLevel = v)))),
      h('div', { class: 'prop' }, h('label', null, 'Screen'), hexInput(e.screen, 2, (v) => set('Screen', (x) => (x.screen = v)), 0x1f)),
      h('div', { class: 'prop' }, h('label', null, 'X-Position'), select(range(8), e.entranceX, (v) => set('X', (x) => (x.entranceX = v)))),
      h('div', { class: 'prop' }, h('label', null, 'Y-Position'), select(range(16), e.entranceY, (v) => set('Y', (x) => (x.entranceY = v)))),
      h('div', { class: 'prop' }, h('label', null, 'Aktion'), select(ENTRANCE_ACTIONS.map((a, i) => [i, `${i} – ${a}`] as [number, string]), e.action, (v) => set('Aktion', (x) => (x.action = v)))),
      h('div', { class: 'prop' }, h('label', null, 'FG Start-Y'), select(range(4), e.fgInitY, (v) => set('FG Start-Y', (x) => (x.fgInitY = v)))),
      h('div', { class: 'prop' }, h('label', null, 'BG Start-Y'), select(range(4), e.bgInitY, (v) => set('BG Start-Y', (x) => (x.bgInitY = v)))),
      h('div', { class: 'hint' }, users.length ? `Benutzt von: ${users.map((u) => `${hex(u.from, 3)} (Screen ${hex(u.screen, 2)})`).join(', ')}` : 'Kein Exit benutzt diesen Eingang.'),
      h('div', { class: 'row' },
        blank ? '' : h('button', { onclick: () => { dlg.close(true); openTarget(to); } }, `Level ${hex(to, 3)} öffnen`),
        h('button', { onclick: () => set('auf aktuelles Level', (x) => (x.destLevel = app.level.number & 0xff)) }, `Auf aktuelles Level (${hex(app.level.number, 3)}) setzen`)),
      h('div', { class: 'hint' }, 'Das obere Bit (0xx/1xx) kommt vom Level, in dem der Exit liegt. Änderungen sind mit Strg+Z rückgängig zu machen.'),
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
    if (idx === null) { toast('Kein freier sekundärer Eingang mehr.', 'error'); return; }
    const s = app.level.secondary;
    app.editSecondaryEntrance(idx, `Sekundärer Eingang ${hex(idx, 3)} angelegt`, (x) => {
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
  const dlg = modal(`Sekundäre Eingänge ${bank ? '100–1FF' : '000–0FF'}`, h('div', { class: 'ent-editor' },
    h('div', null, h('div', { class: 'row small' }, 'Zeigen: ', filter, h('button', { title: 'Nächste freie Nummer, ins aktuelle Level (am Haupteingang)', onclick: newEntry }, '+ Neu')), list), detail),
  [{ label: 'Schließen', primary: true }], () => { app.persist(); });
}

export function openRomInfo(app: App): void {
  const rom = app.rom;
  const rats = rom.scanRats();
  const used = rats.reduce((a, b) => a + b.size + 8, 0);
  const expanded = Math.max(0, rom.size - 0x80000);
  const body = h('div', null,
    h('div', { class: 'prop' }, h('label', null, 'Titel'), h('span', null, rom.title())),
    h('div', { class: 'prop' }, h('label', null, 'Größe'), h('span', null, `${rom.size / 1024} KB${rom.smcHeader ? ' (+512 Byte Copier-Header)' : ''}`)),
    h('div', { class: 'prop' }, h('label', null, 'Erweiterter Bereich'), h('span', null, `${expanded / 1024} KB, davon ${(used / 1024).toFixed(1)} KB belegt (${rats.length} RATS-Blöcke)`)),
    h('div', { class: 'prop' }, h('label', null, 'Editor-Patch'), h('span', null, hasEditorPatch(rom) ? 'installiert' : 'nicht installiert')),
  );
  modal('ROM-Informationen', body, [{ label: 'Schließen', primary: true }]);
}

export function openExpandDialog(app: App): void {
  const rom = app.rom;
  const body = h('div', null,
    h('p', { class: 'hint' }, `Aktuell ${rom.size / 1024} KB. Mehr Platz für Levels, Grafiken, Musik usw. Beim Speichern wird automatisch erweitert, wenn nötig. Maximal 4 MB (LoROM).`),
    h('div', { class: 'row' }, [0x100000, 0x200000, 0x400000].map((sz) => h('button', {
      disabled: rom.size >= sz,
      onclick: () => { rom.expand(sz); app.emu.syncRom(); app.persist(); toast(`ROM auf ${sz / 1048576} MB erweitert`); dlg.close(); },
    }, `${sz / 1048576} MB`))),
  );
  const dlg = modal('ROM erweitern', body, [{ label: 'Abbrechen' }]);
}

export async function installEditorPatchAction(app: App): Promise<void> {
  const ok = await choose('Editor-Patch installieren', 'Der Editor-Patch erlaubt Sprite-Daten in beliebigen Banks, 256 Grafikdateien (ExGFX, auch unkomprimiert als 4bpp), Grafik-Zuordnung pro Level und das "Direct Map16"-Objekt (beliebige Map16-Tiles platzieren). Er wird bei Bedarf auch automatisch installiert.',
    [{ label: 'Abbrechen' }, { label: 'Installieren', primary: true }]);
  if (ok !== 1) return;
  try { installEditorPatch(app.rom); app.emu.syncRom(); app.persist(); toast('Editor-Patch installiert'); app.refresh(); app.emit('patch'); } catch (e) { toast(String(e), 'error'); }
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
    h('p', { class: 'hint', style: 'max-width:420px' }, `Level ${hex(lv.number, 3)} (mit allen aktuellen Änderungen) unter einer anderen Nummer speichern. Das Ziel wird überschrieben.`),
    h('div', { class: 'row' }, h('label', null, 'Ziel-Level '), hexInput(target, 3, (v) => (target = v), 0x1ff)));
  modal(`Level ${hex(lv.number, 3)} speichern unter`, body, [{ label: 'Abbrechen' }, { label: 'Speichern', primary: true, onClick: () => saveAs(app, target) }]);
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
  const dir = app.vertical ? 'nach unten' : 'nach rechts';
  const body = h('div', null,
    h('p', { class: 'hint', style: 'max-width:420px' }, op === 'insert'
      ? `Alles ab dem gewählten Screen wird um einen Screen ${dir} verschoben (Objekte, Sprites, Exits, Eingang, Zwischenziel). Sekundäre Eingänge bleiben unverändert.`
      : `Der gewählte Screen wird entfernt, alles dahinter rückt einen Screen zurück (Objekte, Sprites, Exits, Eingang, Zwischenziel). Sekundäre Eingänge bleiben unverändert.`),
    h('div', { class: 'row' }, h('label', null, op === 'insert' ? 'Leeren Screen einfügen vor Screen ' : 'Screen '), select(screenOpts, screen, (v) => (screen = v))));
  modal(op === 'insert' ? 'Screen einfügen' : 'Screen löschen', body, [
    { label: 'Abbrechen' },
    { label: op === 'insert' ? 'Einfügen' : 'Löschen', primary: true, onClick: () => levelEdit(app, () => (op === 'insert' ? insertScreen : deleteScreen)(app.rom, app.level, screen)) },
  ]);
}

export async function clearLevelConfirm(app: App): Promise<void> {
  const r = await choose(`Level ${hex(app.level.number, 3)} leeren`, 'Alle Objekte, Sprites und Exits entfernen? (rückgängig machbar)', [{ label: 'Abbrechen' }, { label: 'Leeren', danger: true }]);
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
    app.emu.syncRom();
    app.persist();
    toast(`Gespeichert als Level ${hex(target, 3)}: ${log.join(' · ')}`);
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
    // graphics slots and palette live in the ROM: an undoable ROM edit (Strg+Z takes them back first)
    if (data.gfx || editorPatch(rom) || data.palette || customPalette(rom, n)) app.romEdit(`${f.name}: Grafik-Slots/Palette von Level ${hex(n, 3)}`, () => {
      if (data.gfx || editorPatch(rom)) setLevelGfx(rom, n, data.gfx ?? new Array(8).fill(0xff));
      if (data.palette || customPalette(rom, n)) setCustomPalette(rom, n, data.palette);
    });
    app.emu.syncRom();
    app.persist();
    app.selection.clear();
    app.changed();
    app.emit('level-header');
    app.palettesChanged();
    toast(`${f.name} als Level ${hex(n, 3)} importiert (noch nicht gespeichert).`);
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
      h('div', { class: 'prop' }, h('label', null, 'Nummer'), hexInput(num, 2, (v) => { num = v; showName(); }, kind === 0 ? 0x3f : 0xff)),
      kind === 0 ? h('div', { class: 'prop' }, h('label', null, 'Größe/Einstellung'), hexInput(size, 2, (v) => (size = v))) : '',
      kind === 2 ? h('div', { class: 'prop' }, h('label', null, 'Extra-Bits'), hexInput(extra, 1, (v) => { extra = v; showName(); }, 3)) : '',
      kind === 2 ? h('div', { class: 'hint' }, 'Extra-Bits 2/3: Custom Sprite (PIXI) ohne/mit Extra-Bit') : '',
      name,
    );
  };
  const body = h('div', null,
    h('div', { class: 'prop' }, h('label', null, 'Typ'), select([[0, 'Objekt'], [1, 'Erweitertes Objekt'], [2, 'Sprite']], kind, (v) => { kind = v as 0 | 1 | 2; build(); })),
    fields,
    h('div', { class: 'hint' }, `Position X ${hex(tx, 2)} · Y ${hex(ty, 2)}`),
  );
  build();
  const insert = () => {
    if (kind === 2) {
      app.insertAt(tx, ty, { kind: 'spr', num, extra });
    } else {
      if (app.mode !== 'l1' && app.mode !== 'l2') app.setMode('l1');
      if (kind === 0 && num === 0) { toast('Objekt 00 gibt es nicht – erweiterte Objekte über „Erweitertes Objekt“.', 'error'); return false; }
      if (kind === 1 && num === DM16_EXT) { toast('Direct-Map16 bitte über den Map16-Reiter der Palette platzieren.', 'error'); return false; }
      if (kind === 1 && num === STRUCT_EXT && hasStructs(app.rom)) { toast('Strukturen bitte über den Strukturen-Reiter der Palette platzieren.', 'error'); return false; }
      app.insertAt(tx, ty, kind === 0 ? { kind: 'obj', num, ext: 0, size } : { kind: 'obj', num: 0, ext: num, size: 0 });
    }
  };
  const dlg = modal('Einfügen nach Nummer', body, [{ label: 'Abbrechen' }, { label: 'Einfügen', primary: true, onClick: insert }]);
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    (e.target as HTMLElement).dispatchEvent(new Event('change')); // commit the field being edited
    if (insert() !== false) dlg.close();
  });
  setTimeout(() => (fields.querySelector('input') as HTMLInputElement | null)?.select(), 0);
}
