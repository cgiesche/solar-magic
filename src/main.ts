import './style.css';
import { Rom } from './core/rom.ts';
import { disableUnsafeExtGfx, hasEditorPatch } from './core/patches.ts';
import { App, type EditMode } from './ui/app.ts';
import { h, clear, toast, downloadBytes, pickFile, modal } from './ui/dom.ts';
import { kvGet, kvSet } from './ui/storage.ts';
import { LevelView } from './ui/levelview.ts';
import { LevelList, Palette, Properties } from './ui/panels.ts';
import { openHeaderDialog } from './ui/headerdialog.ts';
import { hex } from './core/names.ts';
import { GfxWorkspace, type WsTab } from './ui/gfxworkspace.ts';
import { openEntrancesDialog, openRomInfo, openInsertDialog, openExpandDialog, installEditorPatchAction, openSaveAsDialog, exportLevel, importLevel, openScreenDialog, clearLevelConfirm } from './ui/tools.ts';
import { openUberDialog } from './ui/uberdialog.ts';
import { openBlockDialog } from './ui/blockdialog.ts';
import { menuBar, menuButton, closeMenus, type MenuItem } from './ui/menu.ts';
import { LEVEL_FILE_EXT } from './core/levelfile.ts';
import { openPatchManager } from './ui/patchmanager.ts';
import { OverworldView } from './ui/overworld.ts';
import { openTestPlay } from './ui/testplay.ts';
import { openMessagesDialog } from './ui/messagedialog.ts';

const root = document.getElementById('app')!;

function welcome(): void {
  clear(root);
  const drop = h('div', { class: 'welcome' },
    h('h1', null, 'SMW Level Editor'),
    h('p', null, 'Super-Mario-World-ROM (US, .smc/.sfc, mit oder ohne Header) öffnen oder hierher ziehen.'),
    h('button', { class: 'primary big', onclick: async () => { const f = await pickFile('.smc,.sfc,.bin'); if (f) openFile(f); } }, 'ROM öffnen …'),
    h('p', { class: 'hint' }, 'Die ROM bleibt lokal im Browser (IndexedDB). Nichts wird hochgeladen.'),
  );
  root.appendChild(drop);
}

async function openFile(f: File): Promise<void> {
  const data = new Uint8Array(await f.arrayBuffer());
  startWith(new Rom(data), f.name);
  kvSet('rom', { name: f.name, data: new Rom(data).data, header: new Rom(data).smcHeader }).catch(() => {});
}

function startWith(rom: Rom, name: string): void {
  if (disableUnsafeExtGfx(rom)) {
    kvSet('rom', { name, data: rom.output(false), header: rom.smcHeader }).catch(() => {});
    toast('BG2/BG3-Grafik wurde abgeschaltet: sie überschrieb die Layer-1-Tilemap (kaputter Hintergrund). Die Zuordnungen bleiben gespeichert und gelten wieder, sobald der VRAM-Patch verfügbar ist.', 'error');
  }
  if (!rom.title().startsWith('SUPER MARIOWORLD')) {
    toast(`Unerwarteter ROM-Titel "${rom.title()}" – versuche es trotzdem.`, 'error');
  }
  let app: App;
  try {
    app = new App(rom, name);
  } catch (e) {
    toast(`Emulator-Start fehlgeschlagen: ${e}`, 'error');
    return;
  }
  (window as unknown as { app: App }).app = app;
  buildUi(app);
  app.openLevel(0x105);
}

// spinner pill for background analyses; shown after a short delay so quick jobs don't flicker,
// ignores the mouse so the editor stays usable underneath
function busyIndicator(app: App): HTMLElement {
  const label = h('span');
  const el = h('div', { class: 'busy' }, h('span', { class: 'busy-spin' }), label);
  let timer = 0;
  app.on('busy', () => {
    label.textContent = [...app.busy.values()].join(' · ') + ' …';
    el.title = label.textContent;
    if (!app.busy.size) { clearTimeout(timer); timer = 0; el.classList.remove('show'); }
    else if (!timer && !el.classList.contains('show')) timer = window.setTimeout(() => { timer = 0; if (app.busy.size) el.classList.add('show'); }, 200);
  });
  return el;
}

function buildUi(app: App): void {
  clear(root);
  const status = h('div', { class: 'statusbar' });
  const view = new LevelView(app, status);
  const levels = new LevelList(app);
  const palette = new Palette(app);
  const props = new Properties(app);

  let workspace: 'level' | 'ow' | 'gfx' = 'level';
  let ow: OverworldView | null = null;
  let ws: GfxWorkspace | null = null;
  const inLevel = () => workspace !== 'ow';

  // ---- level context bar: mode, view, zoom
  const modeBtn = (m: EditMode, label: string, key: string) => h('button', { class: 'mode', 'data-mode': m, title: `${label} (${key})`, onclick: () => app.setMode(m) }, label);
  const modes = h('div', { class: 'btn-group' },
    modeBtn('l1', 'Layer 1', '1'), modeBtn('l2', 'Layer 2', '2'), modeBtn('spr', 'Sprites', '3'), modeBtn('exit', 'Exits', '4'), modeBtn('bg', 'BG', '5'));
  const show = (k: keyof App['show'], label: string, title?: string, shortcut?: string): MenuItem => ({
    label, title, shortcut, checked: () => app.show[k],
    onToggle: (v) => {
      app.show[k] = v;
      if (k === 'anim') { app.refresh(); app.emit('show-anim'); }
      else if (k === 'layer1' || k === 'layer2' || k === 'layer3' || k === 'ghost') app.recomposite(); else view.paint();
    },
  });
  // view-only game state (re-runs the level load)
  const gameState = (k: keyof App['switches'], label: string, title: string): MenuItem => ({
    label, title, checked: () => app.switches[k], onToggle: (v) => { app.switches[k] = v; app.refresh(); },
  });
  const levelTitle = h('span', { class: 'level-title' });
  const zoomLabel = h('span', { class: 'zoom' });
  const levelBar = h('div', { class: 'ctxbar' },
    levelTitle,
    h('button', { onclick: () => openHeaderDialog(app), title: 'Level-Header (H)' }, 'Header …'),
    h('span', { class: 'sep' }),
    modes,
    h('span', { class: 'sep' }),
    menuButton({ label: 'Ansicht', items: [
      { heading: 'Ebenen' },
      show('layer1', 'Layer 1'), show('layer2', 'Layer 2 / BG'), show('layer3', 'Layer 3', 'Layer 3 (Flut, Layer-3-Bilder) – Vorschau, Scrollen angenähert'),
      show('sprites', 'Sprites'), show('exits', 'Exits'),
      { heading: 'Hilfen' },
      show('screens', 'Screen-Grenzen'), show('grid', 'Raster', undefined, 'G'),
      show('ghost', 'Inaktive Ebene durchscheinend', 'Nicht bearbeitete Objektebene halbtransparent (nur Level mit Layer-2-Objekten)'),
      show('items', 'Block-Inhalte', 'Inhalt von Blöcken (per Emulation ermittelt) halbtransparent über den Blöcken, Pfeile an betretbaren Blöcken (Pipes, Türen)'),
      show('anim', 'Animation', 'Animierte Tiles und Paletten abspielen'),
      { heading: 'Spielzustand' },
      gameState('palaces', '!-Blöcke gedrückt', 'Ansicht: alle Switch-Paläste gedrückt'),
      gameState('onOff', 'ON/OFF auf OFF', 'Ansicht: ON/OFF-Schalter auf OFF'),
    ] }),
    h('span', { class: 'sep' }),
    h('div', { class: 'row zoom-ctl' },
      h('button', { onclick: () => view.setZoom(app.zoom / 2), title: 'Verkleinern (Strg+Mausrad)' }, '−'), zoomLabel,
      h('button', { onclick: () => view.setZoom(app.zoom * 2), title: 'Vergrößern (Strg+Mausrad)' }, '+')),
  );

  // ---- app bar: menus, workspace switcher, main actions
  const testHere = () => { const hv = view.hover; openTestPlay(app, hv ? { tx: hv.tx, ty: hv.ty } : undefined); };
  const insertHere = () => { const hv = view.hover, c = view.centerTile(); openInsertDialog(app, hv ? hv.tx : c.tx, hv ? hv.ty : c.ty); };
  const menus = menuBar([
    { label: 'Datei', items: [
      { label: 'ROM öffnen …', onClick: async () => { const f = await pickFile('.smc,.sfc,.bin'); if (f) openFile(f); } },
      { label: 'ROM exportieren', title: 'ROM mit allen gespeicherten Änderungen herunterladen', onClick: () => { if (ow?.dirty) ow.save(); exportRom(app); } },
      'sep',
      { label: 'Level-Datei importieren …', title: 'Ersetzt das aktuelle Level (rückgängig machbar; Palette/Grafik-Bypass werden direkt in die ROM geschrieben)', disabled: () => !inLevel(), onClick: () => importLevel(app) },
      { label: 'Level-Datei exportieren …', title: `Level als ${LEVEL_FILE_EXT}-Datei (Objekte, Sprites, Exits, Header, Grafik-Bypass, eigene Palette)`, disabled: () => !inLevel(), onClick: () => exportLevel(app) },
      { label: 'Level als PNG …', title: 'Sichtbare Ebenen und Sprites in Originalgröße', disabled: () => !inLevel(), onClick: () => view.exportPng() },
    ] },
    { label: 'Level', disabled: () => !inLevel(), items: [
      { label: 'Speichern', shortcut: 'Strg+S', onClick: () => app.saveLevel() },
      { label: 'Speichern unter …', onClick: () => openSaveAsDialog(app) },
      { label: 'Header …', shortcut: 'H', onClick: () => openHeaderDialog(app) },
      { label: 'Testen', shortcut: 'T', onClick: () => openTestPlay(app) },
      'sep',
      { label: 'Einfügen nach Nummer …', shortcut: 'I', onClick: insertHere },
      { label: 'Screen einfügen …', disabled: () => app.level.header.screens >= 32, onClick: () => openScreenDialog(app, 'insert') },
      { label: 'Screen löschen …', disabled: () => app.level.header.screens <= 1, onClick: () => openScreenDialog(app, 'delete') },
      { label: 'Level leeren …', onClick: () => clearLevelConfirm(app) },
      'sep',
      { label: 'Sekundäre Eingänge …', onClick: () => openEntrancesDialog(app) },
    ] },
    { label: 'ROM', items: [
      { label: 'ROM-Informationen …', onClick: () => openRomInfo(app) },
      { label: 'ROM erweitern …', disabled: () => app.rom.size >= 0x400000, onClick: () => openExpandDialog(app) },
      'sep',
      { label: 'Patches …', title: 'ASM-Patches (Asar) anwenden und verwalten', onClick: () => openPatchManager(app) },
      { label: 'UberASM …', onClick: () => openUberDialog(app) },
      { label: 'Custom Blocks …', onClick: () => openBlockDialog(app) },
      { label: 'Editor-Patch installieren …', disabled: () => hasEditorPatch(app.rom), onClick: () => installEditorPatchAction(app) },
      'sep',
      { label: 'Nachrichtenboxen …', onClick: () => openMessagesDialog(app) },
    ] },
    { label: 'Hilfe', items: [
      { label: 'Tastenkürzel …', shortcut: '?', onClick: () => showHelp() },
    ] },
  ]);
  const wsBtn = (w: typeof workspace, label: string, key: string) => h('button', { 'data-ws': w, title: `${label} (${key})`, onclick: () => setWorkspace(w) }, label);
  const wsSwitch = h('div', { class: 'btn-group ws-switch' }, wsBtn('level', 'Level', 'Esc'), wsBtn('ow', 'Overworld', 'O'), wsBtn('gfx', 'Grafik', 'M / P / A'));
  const undoBtn = h('button', { onclick: () => (workspace === 'ow' ? ow?.undo() : app.undo()), title: 'Rückgängig (Strg+Z)' }, '↶');
  const redoBtn = h('button', { onclick: () => (workspace === 'ow' ? ow?.redo() : app.redo()), title: 'Wiederholen (Strg+Y)' }, '↷');
  const saveBtn = h('button', { class: 'primary', onclick: () => (workspace === 'ow' ? ow?.save() : app.saveLevel()) });
  const testBtn = h('button', { onclick: () => openTestPlay(app), title: 'Level im eingebauten Emulator testen (T, Shift+T: ab Mausposition)' }, '▶ Testen');
  const appbar = h('header', { class: 'appbar' },
    h('span', { class: 'brand' }, 'SMW Editor'),
    menus,
    h('span', { class: 'spacer' }),
    wsSwitch,
    h('span', { class: 'spacer' }),
    undoBtn, redoBtn, saveBtn, testBtn,
  );

  const updateToolbar = () => {
    for (const b of modes.querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === app.mode);
    const btnL2 = modes.querySelector('[data-mode="l2"]') as HTMLButtonElement;
    btnL2.disabled = !app.level?.layer2Objects;
    (modes.querySelector('[data-mode="bg"]') as HTMLButtonElement).disabled = !app.level || !app.canEditBg();
    if (app.level) levelTitle.textContent = `Level ${hex(app.level.number, 3)}${app.dirty ? ' *' : ''}`;
    zoomLabel.textContent = `${Math.round(app.zoom * 100)}%`;
    for (const b of wsSwitch.querySelectorAll('button')) b.classList.toggle('active', b.dataset.ws === workspace);
    const inOw = workspace === 'ow' && ow;
    saveBtn.textContent = inOw ? `Overworld speichern${ow!.dirty ? ' *' : ''}` : `Level speichern${app.dirty ? ' *' : ''}`;
    saveBtn.title = inOw ? 'Overworld in ROM schreiben (Strg+S)' : 'Level in ROM schreiben (Strg+S)';
    undoBtn.disabled = inOw ? !ow!.canUndo : false;
    redoBtn.disabled = inOw ? !ow!.canRedo : false;
    testBtn.disabled = workspace === 'ow';
    testBtn.title = workspace === 'ow' ? 'Testen gibt es im Level-Editor' : 'Level im eingebauten Emulator testen (T, Shift+T: ab Mausposition)';
    menus.refresh();
  };
  app.on('mode', updateToolbar);
  app.on('change', updateToolbar);
  app.on('level', updateToolbar);
  app.on('zoom', updateToolbar);
  app.on('level-header', () => { palette.invalidate(); app.ensureSpriteImages(); });
  app.on('palettes', () => palette.invalidate());

  const left = h('div', { class: 'left' }, levels.root);
  const center = h('div', { class: 'center' }, view.root, status);
  const right = h('div', { class: 'right' }, palette.root, props.root);
  const layout = h('div', { class: 'layout' }, appbar, levelBar, left, center, right, busyIndicator(app));
  root.append(layout);
  const owRight = h('div', { class: 'right' });
  const showLayout = (bar: HTMLElement, l: HTMLElement, main: HTMLElement, side: HTMLElement) => layout.replaceChildren(appbar, bar, l, main, side);

  // switches between the level editor, the overworld editor and the graphics workspace (palettes, Map16, GFX);
  // gfx: tab to open (default: the last one), Map16 tile to show
  // false: the user chose to stay (unsaved overworld)
  const setWorkspace = async (w: typeof workspace, gfx?: { tab?: WsTab; tile?: number; bg?: boolean }): Promise<boolean> => {
    closeMenus();
    if (w === workspace) {
      if (w === 'gfx' && gfx?.tab) {
        ws!.open(gfx.tab);
        if (gfx.tab === 'map16' && gfx.tile !== undefined) ws!.showMap16(gfx.tile, gfx.bg);
      }
      return true;
    }
    // leave the current workspace
    if (workspace === 'ow') {
      if (ow && !(await ow.confirmLeave())) return false;
      layout.classList.remove('ow-mode');
    } else if (workspace === 'gfx') {
      ws!.leave();
      layout.classList.remove('gfx-mode');
    }
    const from = workspace;
    workspace = w;
    if (from === 'ow') app.refresh();
    if (w === 'ow') {
      if (app.dirty) app.saveLevel(true);
      if (!ow) {
        ow = new OverworldView(app);
        ow.onChange = updateToolbar;
        ow.onOpenLevel = async (n) => { if (await setWorkspace('level')) app.openLevel(n); };
      }
      owRight.replaceChildren(ow.side);
      showLayout(ow.bar, ow.left, ow.root, owRight);
      layout.classList.add('ow-mode');
      ow.show();
    } else if (w === 'gfx') {
      if (!ws) ws = new GfxWorkspace(app);
      showLayout(ws.bar, left, ws.root, ws.side);
      layout.classList.add('gfx-mode');
      // the level view is only up to date when coming from it
      const hv = from === 'level' ? view.hover : null;
      ws.enter(gfx?.tab ?? ws.tab, hv ? { tx: hv.tx, ty: hv.ty } : view.centerTile());
      if (gfx?.tab === 'map16' && gfx.tile !== undefined) ws.showMap16(gfx.tile, gfx.bg);
    } else {
      showLayout(levelBar, left, center, right);
      view.layout();
    }
    updateToolbar();
    return true;
  };
  app.on('show-level-view', () => setWorkspace('level'));
  app.on('open-map16', () => setWorkspace('gfx', { tab: 'map16', tile: app.wsTile, bg: app.wsTileBg }));
  app.on('open-gfx', () => setWorkspace('gfx', { tab: 'gfx' }));

  window.onkeydown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (document.querySelector('.modal-back')) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === 'F1' || k === '?') { e.preventDefault(); showHelp(); return; }
    if (k === 'o' || k === 'O') { setWorkspace(workspace === 'ow' ? 'level' : 'ow'); return; }
    if (workspace === 'gfx' && ws) {
      if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) app.redo(); else app.undo(); return; }
      if (ctrl && k.toLowerCase() === 'y') { e.preventDefault(); app.redo(); return; }
      if (ctrl && k.toLowerCase() === 's') { e.preventDefault(); app.saveLevel(); return; }
      if (ws.key(e)) { e.preventDefault(); return; }
      if (k === 'Escape') setWorkspace('level');
      return;
    }
    if (workspace === 'ow') {
      if (ow?.key(e)) e.preventDefault();
      else if (k === 'Escape') void setWorkspace('level');
      return;
    }
    if (ctrl && k.toLowerCase() === 's') { e.preventDefault(); app.saveLevel(); return; }
    if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) app.redo(); else app.undo(); return; }
    if (ctrl && k.toLowerCase() === 'y') { e.preventDefault(); app.redo(); return; }
    if (ctrl && k.toLowerCase() === 'c') { app.copy(); return; }
    if (ctrl && k.toLowerCase() === 'v') { const hv = view.hover; if (hv) app.paste(hv.tx, hv.ty); return; }
    if (ctrl && k.toLowerCase() === 'd') { e.preventDefault(); app.copy(); const s = app.mode === 'spr' ? app.selectedSprites() : app.selectedObjects(); if (s[0]) app.paste(s[0].x + 1, s[0].y + 1); return; }
    if (ctrl && k.toLowerCase() === 'a') { e.preventDefault(); const items = app.mode === 'spr' ? app.level.sprites : app.currentObjects(); app.selection = new Set(items.map((o) => o.uid)); app.emit('change'); return; }
    if (k === 'Delete' || k === 'Backspace') { app.deleteSelection(); return; }
    if (k === 'Escape') { app.selection.clear(); app.emit('change'); return; }
    if (k === '1') app.setMode('l1');
    else if (k === '2') app.setMode('l2');
    else if (k === '3') app.setMode('spr');
    else if (k === '4') app.setMode('exit');
    else if (k === '5') app.setMode('bg');
    else if (k === 'h' || k === 'H') openHeaderDialog(app);
    else if ((k === 't' || k === 'T') && e.shiftKey) testHere();
    else if (k === 't' || k === 'T') openTestPlay(app);
    else if (k === 'Insert' || k === 'i' || k === 'I') { e.preventDefault(); insertHere(); }
    else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      if (!app.selection.size) return;
      e.preventDefault();
      const dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0;
      if (e.altKey) app.resizeSelection(dx, dy);
      else app.moveSelection(dx, dy);
    } else if (k === '+' || k === '=') app.resizeSelection(1, 0);
    else if (k === '-' || k === '_') app.resizeSelection(-1, 0);
    else if (k === '*') app.resizeSelection(0, 1);
    else if (k === '/') app.resizeSelection(0, -1);
    else if (k === 'PageUp') app.reorderSelection('front');
    else if (k === 'PageDown') app.reorderSelection('back');
    else if (k === 'g' || k === 'G') { app.show.grid = !app.show.grid; view.paint(); }
    else if (k === 'm' || k === 'M') setWorkspace('gfx', { tab: 'map16', tile: view.hover ? hoverTile(app, view.hover.tx, view.hover.ty) : undefined });
    else if (k === 'p' || k === 'P') setWorkspace('gfx', { tab: 'pal' });
    else if (k === 'a' || k === 'A') setWorkspace('gfx', { tab: 'anim' });
  };
  window.onbeforeunload = (e) => { if (app.dirty || ow?.dirty) { e.preventDefault(); } };
  updateToolbar();
  levels.build();
}

function hoverTile(app: App, tx: number, ty: number): number {
  const a = app.images.geom1.addr(tx, ty);
  return a < 0 ? 0 : app.render.wram[a] | (app.render.wram[a + 0x10000] << 8);
}

function exportRom(app: App): void {
  if (app.dirty) app.saveLevel(true);
  const withHeader = app.rom.smcHeader !== null;
  const out = app.rom.output(withHeader);
  const base = app.romName.replace(/\.(smc|sfc|bin)$/i, '');
  downloadBytes(`${base}.${withHeader ? 'smc' : 'sfc'}`, out);
  app.persist();
}

function showHelp(): void {
  const sections: [string, [string, string][]][] = [
    ['Allgemein', [
      ['Strg+S', 'Speichern (Level bzw. Overworld)'],
      ['Strg+Z / Strg+Y', 'Rückgängig / Wiederholen'],
      ['Esc / O / M · P · A', 'Bereich Level / Overworld / Grafik (Map16, Paletten, Animationen)'],
      ['Strg+Mausrad · Mittlere Maustaste ziehen', 'Zoom · Ansicht verschieben'],
      ['? / F1', 'Diese Übersicht'],
      ['Menüs: ↑ ↓ ← → / Enter / Esc', 'Eintrag wählen, Nachbarmenü / ausführen / schließen'],
    ]],
    ['Level', [
      ['1 / 2 / 3 / 4 / 5', 'Modus Layer 1 / Layer 2 / Sprites / Exits / BG'],
      ['Klick · Strg+Klick · Alt+Klick', 'Auswählen · zur Auswahl hinzufügen · darunterliegendes Element'],
      ['Ziehen', 'Auswahl verschieben / Rahmen aufziehen'],
      ['Griff unten rechts', 'Objektgröße ändern'],
      ['Rechtsklick / Shift+Klick', 'Gewähltes Element aus „Einfügen“ platzieren'],
      ['BG: Klick/Ziehen · Rechtsklick/Shift+Klick', 'Tile(s) als Pinsel aufnehmen · malen'],
      ['Einfg / I', 'Objekt/Sprite nach Nummer einfügen (an der Maus)'],
      ['M / Z / S-Markierung ziehen', 'Haupteingang / Zwischenziel-Screen / sekundären Eingang verschieben'],
      ['Pfeiltasten · Alt+Pfeiltasten', 'Auswahl um 1 Tile verschieben · Größe ändern'],
      ['+ / - · * / /', 'Breite ändern · Höhe ändern'],
      ['Entf / Rücktaste', 'Auswahl löschen'],
      ['Strg+A · Esc', 'Alles auswählen · Auswahl aufheben'],
      ['Strg+C / Strg+V / Strg+D', 'Kopieren / Einfügen an der Maus / Duplizieren'],
      ['Bild↑ / Bild↓', 'Nach vorne / hinten (Zeichenreihenfolge)'],
      ['H · G', 'Level-Header · Raster ein/aus'],
      ['T · Shift+T', 'Level testen · Mario startet an der Maus'],
    ]],
    ['Overworld', [
      ['1 / 2', 'Layer 1 (Wege/Level) / Layer 2 (Gelände)'],
      ['Klick/Ziehen · Rechtsklick/Shift+Klick', 'Tile(s) als Pinsel aufnehmen · malen'],
      ['Alt+Klick / Strg+Klick', 'Level-Info des Level-Tiles'],
      ['G', 'Raster ein/aus'],
    ]],
    ['Grafik', [
      ['P / M / G / A', 'Reiter Paletten / Map16-Tiles / Grafiken / Animationen; Esc zurück zum Level'],
      ['Strg+C / Strg+V', 'Palette, Map16-Tiles bzw. Pixel kopieren / einfügen'],
      ['Paletten: Pfeiltasten · Shift+Klick', 'Andere Farbe · Bereich markieren (für „Verlauf“)'],
      ['Map16: X / Y / 1–8 / Q', 'Viertel spiegeln / Palette 0–7 / nächstes Viertel; Pfeile: anderes Tile'],
      ['Map16: Doppelklick · Strg+Klick auf Palette', 'Viertel in „Grafiken“ bearbeiten · Palette in „Paletten“ öffnen'],
      ['Grafiken: B / F / I / S / 0–9', 'Stift / Füllen / Pipette / Auswahl / Farbe'],
      ['Grafiken: Rechtsklick · Alt+Klick', 'Transparent malen · Farbe aufnehmen'],
      ['Grafiken: Enter / Esc', 'Schwebende Auswahl absetzen / Auswahl aufheben'],
      ['Animationen: Entf / Esc', 'Animation löschen / Auswahl abbrechen'],
    ]],
  ];
  modal('Tastenkürzel', h('div', { class: 'help-cols' }, sections.map(([title, rows]) => h('section', null,
    h('h3', null, title),
    h('table', { class: 'help' }, rows.map(([a, b]) => h('tr', null, h('td', null, h('kbd', null, a)), h('td', null, b))))))),
  [{ label: 'Schließen', primary: true }]);
}

// drag & drop
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

(async () => {
  const q = new URLSearchParams(location.search).get('rom');
  if (q) {
    const res = await fetch(q);
    if (res.ok) {
      const data = new Uint8Array(await res.arrayBuffer());
      startWith(new Rom(data), q.split('/').pop() ?? 'rom.smc');
      return;
    }
  }
  try {
    const saved = await kvGet<{ name: string; data: Uint8Array; header: Uint8Array | null }>('rom');
    if (saved?.data) {
      let full = saved.data;
      if (saved.header) { full = new Uint8Array(saved.header.length + saved.data.length); full.set(saved.header); full.set(saved.data, saved.header.length); }
      startWith(new Rom(full), saved.name);
      return;
    }
  } catch (e) {
    console.warn(e);
  }
  welcome();
})();
