// Misc. dialogs: secondary entrances, ROM info/expansion, level copy.

import type { App } from './app.ts';
import { h, modal, clear, hexInput, select, toast, downloadBytes, pickFile } from './dom.ts';
import { readSecondaryEntrance, writeSecondaryEntrance, type SecondaryEntrance, loadLevel, cloneLevel, insertScreen, deleteScreen, clearLevel } from '../core/level.ts';
import { exportLevelFile, importLevelFile, LEVEL_FILE_EXT } from '../core/levelfile.ts';
import { ENTRANCE_ACTIONS, hex, objectName, spriteName } from '../core/names.ts';
import { saveLevel } from '../core/save.ts';
import { hasEditorPatch, installEditorPatch, DM16_EXT, editorPatch, setLevelGfx, customPalette, setCustomPalette, bgBank } from '../core/patches.ts';
import { bgFromWram } from '../core/bg.ts';
import { STRUCT_EXT, hasStructs } from '../core/structs.ts';

export function openEntrancesDialog(app: App): void {
  const rom = app.rom;
  let sel = 0;
  const filter = h('input', { type: 'checkbox', checked: true });
  const list = h('div', { class: 'gfx-list', style: 'height: 420px' });
  const detail = h('div', { class: 'ent-detail' });
  // which secondary exits point into this level (for "only this level")
  const buildList = () => {
    clear(list);
    const lvLow = app.level.number & 0xff;
    for (let i = 0; i < 0x200; i++) {
      const e = readSecondaryEntrance(rom, i);
      if (filter.checked && e.destLevel !== lvLow) continue;
      list.appendChild(h('div', { class: `level-item${i === sel ? ' current' : ''}`, onclick: () => { sel = i; buildList(); buildDetail(); } }, `${hex(i, 3)} → ${hex(e.destLevel, 2)}`));
    }
  };
  const buildDetail = () => {
    clear(detail);
    const e = readSecondaryEntrance(rom, sel);
    const set = (f: (x: SecondaryEntrance) => void) => { const x = readSecondaryEntrance(rom, sel); f(x); writeSecondaryEntrance(rom, sel, x); app.emu.syncRom(); buildList(); buildDetail(); };
    const range = (n: number): [number, string][] => Array.from({ length: n }, (_, i) => [i, String(i)]);
    detail.append(
      h('div', { class: 'prop-title' }, `Sekundärer Eingang ${hex(sel, 3)}`),
      h('div', { class: 'prop' }, h('label', null, 'Ziel-Level (low)'), hexInput(e.destLevel, 2, (v) => set((x) => (x.destLevel = v)))),
      h('div', { class: 'hint' }, 'Das High-Bit der Levelnummer (0xx/1xx) ergibt sich in Vanilla-SMW aus der Karte, auf der das Hauptlevel liegt.'),
      h('div', { class: 'prop' }, h('label', null, 'Screen'), hexInput(e.screen, 2, (v) => set((x) => (x.screen = v)), 0x1f)),
      h('div', { class: 'prop' }, h('label', null, 'X-Position'), select(range(8), e.entranceX, (v) => set((x) => (x.entranceX = v)))),
      h('div', { class: 'prop' }, h('label', null, 'Y-Position'), select(range(16), e.entranceY, (v) => set((x) => (x.entranceY = v)))),
      h('div', { class: 'prop' }, h('label', null, 'Aktion'), select(ENTRANCE_ACTIONS.map((a, i) => [i, `${i} – ${a}`] as [number, string]), e.action, (v) => set((x) => (x.action = v)))),
      h('div', { class: 'prop' }, h('label', null, 'FG Start-Y'), select(range(4), e.fgInitY, (v) => set((x) => (x.fgInitY = v)))),
      h('div', { class: 'prop' }, h('label', null, 'BG Start-Y'), select(range(4), e.bgInitY, (v) => set((x) => (x.bgInitY = v)))),
      h('button', { onclick: () => { const n = app.level.number & 0xff; set((x) => (x.destLevel = n)); } }, `Auf aktuelles Level (${hex(app.level.number & 0xff, 2)}) setzen`),
    );
  };
  filter.addEventListener('change', buildList);
  const first = (() => { for (let i = 0; i < 0x200; i++) if (readSecondaryEntrance(rom, i).destLevel === (app.level.number & 0xff)) return i; return 0; })();
  sel = first;
  buildList();
  buildDetail();
  modal('Sekundäre Eingänge', h('div', { class: 'ent-editor' },
    h('div', null, h('label', { class: 'row small' }, filter, ' nur Ziel = aktuelles Level'), list), detail),
  [{ label: 'Schließen', primary: true, onClick: () => { app.persist(); app.refresh(); } }]);
}

export function openRomInfo(app: App): void {
  const rom = app.rom;
  const body = h('div');
  const build = () => {
    clear(body);
    const rats = rom.scanRats();
    const used = rats.reduce((a, b) => a + b.size + 8, 0);
    const expanded = Math.max(0, rom.size - 0x80000);
    body.append(
      h('div', { class: 'prop' }, h('label', null, 'Titel'), h('span', null, rom.title())),
      h('div', { class: 'prop' }, h('label', null, 'Größe'), h('span', null, `${rom.size / 1024} KB${rom.smcHeader ? ' (+512 Byte Copier-Header)' : ''}`)),
      h('div', { class: 'prop' }, h('label', null, 'Erweiterter Bereich'), h('span', null, `${expanded / 1024} KB, davon ${(used / 1024).toFixed(1)} KB belegt (${rats.length} RATS-Blöcke)`)),
      h('div', { class: 'prop' }, h('label', null, 'Editor-Patch'), h('span', null, hasEditorPatch(rom) ? 'installiert' : 'nicht installiert')),
      h('h3', null, 'ROM erweitern'),
      h('p', { class: 'hint' }, 'Mehr Platz für Levels, Grafiken, Musik usw. Beim Speichern wird automatisch erweitert, wenn nötig. Maximal 4 MB (LoROM).'),
      h('div', { class: 'row' }, [0x100000, 0x200000, 0x400000].map((sz) => h('button', {
        disabled: rom.size >= sz,
        onclick: () => { rom.expand(sz); app.emu.syncRom(); app.persist(); toast(`ROM auf ${sz / 1048576} MB erweitert`); build(); },
      }, `${sz / 1048576} MB`))),
      h('h3', null, 'Patches'),
      h('p', { class: 'hint' }, 'Der Editor-Patch erlaubt Sprite-Daten in beliebigen Banks, 256 Grafikdateien (ExGFX, auch unkomprimiert als 4bpp), Grafik-Zuordnung pro Level und das "Direct Map16"-Objekt (beliebige Map16-Tiles platzieren). Er wird bei Bedarf automatisch installiert.'),
      h('div', { class: 'row' }, h('button', {
        disabled: hasEditorPatch(rom),
        onclick: () => { try { installEditorPatch(rom); app.emu.syncRom(); app.persist(); toast('Editor-Patch installiert'); app.refresh(); app.emit('patch'); } catch (e) { toast(String(e), 'error'); } build(); },
      }, 'Editor-Patch installieren')),
    );
  };
  build();
  modal('ROM-Informationen', body, [{ label: 'Schließen', primary: true }]);
}

// Level tools: save as, export/import file, insert/delete screens, clear
export function openLevelTools(app: App, exportPng: () => void): void {
  const lv = app.level;
  let target = lv.number;
  let screen = 0;
  const vert = app.vertical;
  const screenOpts: [number, string][] = Array.from({ length: lv.header.screens }, (_, i) => [i, hex(i, 2)]);
  const edit = (f: () => void) => {
    app.checkpoint();
    try { f(); } catch (e) { app.undoStack.pop(); toast(String(e instanceof Error ? e.message : e), 'error'); return false; }
    app.selection.clear();
    app.changed();
    app.emit('level-header');
    dlg.close();
  };
  const body = h('div', { class: 'level-tools' },
    h('h3', null, 'Speichern unter'),
    h('p', { class: 'hint' }, `Level ${hex(lv.number, 3)} (mit allen aktuellen Änderungen) unter einer anderen Nummer speichern. Das Ziel wird überschrieben.`),
    h('div', { class: 'row' }, h('label', null, 'Ziel-Level '), hexInput(target, 3, (v) => (target = v), 0x1ff),
      h('button', { onclick: () => { saveAs(app, target); } }, 'Speichern')),
    h('h3', null, 'Datei'),
    h('p', { class: 'hint' }, `Level als ${LEVEL_FILE_EXT}-Datei (Objekte, Sprites, Exits, Header, Grafik-Bypass, eigene Palette). Beim Import wird das aktuelle Level ersetzt (rückgängig machbar; Palette/Grafik-Bypass werden direkt in die ROM geschrieben).`),
    h('div', { class: 'row' },
      h('button', { onclick: () => {
        const bg = lv.bg ?? (!lv.layer2Objects && bgBank(app.rom, lv.number) ? bgFromWram(app.render.wram) : null);
        downloadBytes(`level-${hex(lv.number, 3)}${LEVEL_FILE_EXT}`, new TextEncoder().encode(exportLevelFile(app.rom, lv, bg)), 'application/json');
      } }, 'Exportieren …'),
      h('button', { onclick: () => importLevel(app).then((ok) => { if (ok) dlg.close(); }) }, 'Importieren …'),
      h('button', { onclick: exportPng, title: 'Sichtbare Ebenen und Sprites in Originalgröße' }, 'Als PNG …')),
    h('h3', null, 'Screens'),
    h('p', { class: 'hint' }, `Alles ab dem gewählten Screen wird um einen Screen ${vert ? 'nach unten' : 'nach rechts'} bzw. zurück verschoben (Objekte, Sprites, Exits, Eingang, Zwischenziel). Sekundäre Eingänge bleiben unverändert.`),
    h('div', { class: 'row' }, h('label', null, 'Screen '), select(screenOpts, screen, (v) => (screen = v)),
      h('button', { disabled: lv.header.screens >= 32, onclick: () => edit(() => insertScreen(app.rom, app.level, screen)) }, 'Leeren Screen davor einfügen'),
      h('button', { disabled: lv.header.screens <= 1, onclick: () => edit(() => deleteScreen(app.rom, app.level, screen)) }, 'Screen löschen')),
    h('h3', null, 'Leeren'),
    h('div', { class: 'row' }, h('button', { onclick: () => edit(() => clearLevel(app.level)) }, 'Alle Objekte, Sprites und Exits entfernen')),
  );
  const dlg = modal(`Level ${hex(lv.number, 3)} – Werkzeuge`, body, [{ label: 'Schließen', primary: true }]);
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

async function importLevel(app: App): Promise<boolean> {
  const f = await pickFile(`${LEVEL_FILE_EXT},.json`);
  if (!f) return false;
  try {
    const rom = app.rom, n = app.level.number;
    const data = importLevelFile(rom, await f.text(), app.level);
    app.checkpoint();
    app.level = data.level;
    if (data.gfx || editorPatch(rom)) setLevelGfx(rom, n, data.gfx ?? new Array(8).fill(0xff));
    if (data.palette || customPalette(rom, n)) setCustomPalette(rom, n, data.palette);
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
  const showName = () => (name.textContent = kind === 2 ? spriteName(num) : kind === 1 ? objectName(0, num) : objectName(num, 0));
  const build = () => {
    clear(fields);
    if (kind === 0) num = Math.max(1, Math.min(0x3f, num));
    showName();
    fields.append(
      h('div', { class: 'prop' }, h('label', null, 'Nummer'), hexInput(num, 2, (v) => { num = v; showName(); }, kind === 0 ? 0x3f : 0xff)),
      kind === 0 ? h('div', { class: 'prop' }, h('label', null, 'Größe/Einstellung'), hexInput(size, 2, (v) => (size = v))) : '',
      kind === 2 ? h('div', { class: 'prop' }, h('label', null, 'Extra-Bits'), hexInput(extra, 1, (v) => (extra = v), 3)) : '',
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
