import './style.css';
import { Rom } from './core/rom.ts';
import { disableUnsafeExtGfx } from './core/patches.ts';
import { App, type EditMode } from './ui/app.ts';
import { h, clear, toast, downloadBytes, pickFile, modal } from './ui/dom.ts';
import { kvGet, kvSet } from './ui/storage.ts';
import { LevelView } from './ui/levelview.ts';
import { LevelList, Palette, Properties } from './ui/panels.ts';
import { openHeaderDialog } from './ui/headerdialog.ts';
import { hex } from './core/names.ts';
import { GfxWorkspace, type WsTab } from './ui/gfxworkspace.ts';
import { openEntrancesDialog, openRomInfo, openLevelTools, openInsertDialog } from './ui/tools.ts';
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

  const modeBtn = (m: EditMode, label: string, key: string) => h('button', { class: 'mode', 'data-mode': m, title: `${label} (${key})`, onclick: () => app.setMode(m) }, label);
  const modes = h('div', { class: 'btn-group' },
    modeBtn('l1', 'Layer 1', '1'), modeBtn('l2', 'Layer 2', '2'), modeBtn('spr', 'Sprites', '3'), modeBtn('exit', 'Exits', '4'), modeBtn('bg', 'BG', '5'));
  const toggle = (k: keyof App['show'], label: string) => {
    const cb = h('input', { type: 'checkbox', checked: app.show[k] });
    cb.addEventListener('change', () => {
      app.show[k] = cb.checked;
      if (k === 'layer1' || k === 'layer2' || k === 'layer3' || k === 'ghost') app.recomposite(); else view.paint();
    });
    return h('label', { class: 'toggle' }, cb, label);
  };
  // view-only game state (re-runs the level load)
  const switchToggle = (k: keyof App['switches'], label: string, title: string) => {
    const cb = h('input', { type: 'checkbox', checked: app.switches[k] });
    cb.addEventListener('change', () => { app.switches[k] = cb.checked; app.refresh(); });
    return h('label', { class: 'toggle', title }, cb, label);
  };
  const levelTitle = h('span', { class: 'level-title' });
  const zoomLabel = h('span', { class: 'zoom' });
  const toolbar = h('div', { class: 'toolbar' },
    h('span', { class: 'brand' }, 'SMW Editor'),
    h('button', { onclick: async () => { const f = await pickFile('.smc,.sfc,.bin'); if (f) openFile(f); }, title: 'Andere ROM öffnen' }, 'Öffnen'),
    h('button', { onclick: () => exportRom(app), title: 'ROM herunterladen' }, 'ROM exportieren'),
    h('span', { class: 'sep' }),
    levelTitle,
    h('button', { class: 'primary', onclick: () => app.saveLevel(), title: 'Level in ROM schreiben (Strg+S)' }, 'Level speichern'),
    h('button', { onclick: () => openHeaderDialog(app), title: 'Level-Header (H)' }, 'Header …'),
    h('button', { onclick: () => openTestPlay(app), title: 'Level im eingebauten Emulator testen (T)' }, '▶ Testen'),
    h('button', { onclick: () => app.undo(), title: 'Rückgängig (Strg+Z)' }, '↶'),
    h('button', { onclick: () => app.redo(), title: 'Wiederholen (Strg+Y)' }, '↷'),
    h('span', { class: 'sep' }),
    modes,
    h('span', { class: 'sep' }),
    toggle('layer1', 'L1'), toggle('layer2', 'L2/BG'), h('span', { title: 'Layer 3 (Flut, Layer-3-Bilder) – Vorschau, Scrollen angenähert' }, toggle('layer3', 'L3')), toggle('sprites', 'Sprites'), toggle('exits', 'Exits'), toggle('screens', 'Screens'), toggle('grid', 'Raster'),
    h('span', { title: 'Nicht bearbeitete Objektebene halbtransparent (nur Level mit Layer-2-Objekten)' }, toggle('ghost', 'Ghost')),
    h('span', { title: 'Inhalt von Blöcken (per Emulation ermittelt) halbtransparent über den Blöcken, Pfeile an betretbaren Blöcken (Pipes, Türen)' }, toggle('items', 'Items')),
    (() => {
      const cb = h('input', { type: 'checkbox', checked: app.show.anim });
      cb.addEventListener('change', () => { app.show.anim = cb.checked; app.refresh(); app.emit('show-anim'); });
      app.on('show-anim', () => (cb.checked = app.show.anim));
      return h('label', { class: 'toggle', title: 'Animierte Tiles und Paletten abspielen' }, cb, 'Anim.');
    })(),
    switchToggle('palaces', '!-Blöcke', 'Ansicht: alle Switch-Paläste gedrückt'),
    switchToggle('onOff', 'OFF', 'Ansicht: ON/OFF-Schalter auf OFF'),
    h('span', { class: 'sep' }),
    h('button', { onclick: () => view.setZoom(app.zoom / 2) }, '−'), zoomLabel, h('button', { onclick: () => view.setZoom(app.zoom * 2) }, '+'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'ow-toggle', onclick: () => toggleOw(), title: 'Zwischen Level- und Overworld-Editor wechseln (O)' }, 'Overworld'),
    h('button', { class: 'gfx-toggle', onclick: () => toggleGfx(), title: 'Grafik-Bereich: Paletten, Map16-Tiles, Grafiken (M / P, zurück mit Esc)' }, 'Grafik'),
    h('button', { onclick: () => openEntrancesDialog(app), title: 'Sekundäre Eingänge' }, 'Eingänge'),
    h('button', { onclick: () => openMessagesDialog(app), title: 'Nachrichtenboxen bearbeiten' }, 'Texte'),
    h('button', { onclick: () => openLevelTools(app, () => view.exportPng()), title: 'Speichern unter, Export/Import, PNG, Screens einfügen/löschen, Level leeren' }, 'Level …'),
    h('button', { onclick: () => openRomInfo(app), title: 'ROM-Info, Erweiterung, Patches' }, 'ROM'),
    h('button', { onclick: () => openPatchManager(app), title: 'ASM-Patches (Asar) anwenden und verwalten' }, 'Patches'),
    h('button', { onclick: () => showHelp(), title: 'Tastenkürzel' }, '?'),
  );
  const updateToolbar = () => {
    for (const b of modes.querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === app.mode);
    const btnL2 = modes.querySelector('[data-mode="l2"]') as HTMLButtonElement;
    btnL2.disabled = !app.level?.layer2Objects;
    (modes.querySelector('[data-mode="bg"]') as HTMLButtonElement).disabled = !app.level || !app.canEditBg();
    if (app.level) levelTitle.textContent = `Level ${hex(app.level.number, 3)}${app.dirty ? ' *' : ''}`;
    zoomLabel.textContent = `${Math.round(app.zoom * 100)}%`;
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
  const layout = h('div', { class: 'layout' }, toolbar, left, center, right, busyIndicator(app));
  root.append(layout);
  let ow: OverworldView | null = null;
  let owActive = false;
  const owRight = h('div', { class: 'right' });
  const toggleOw = () => {
    owActive = !owActive;
    if (owActive) {
      if (app.dirty) app.saveLevel(true);
      if (!ow) ow = new OverworldView(app);
      owRight.replaceChildren(ow.side);
      layout.replaceChildren(toolbar, left, ow.root, owRight);
      layout.classList.add('ow-mode');
      ow.show();
    } else {
      if (ow?.dirty && confirm('Overworld-Änderungen speichern?')) ow.save();
      layout.replaceChildren(toolbar, left, center, right);
      layout.classList.remove('ow-mode');
      app.refresh();
      view.layout();
    }
    (toolbar.querySelector('.ow-toggle') as HTMLButtonElement).textContent = owActive ? 'Level-Editor' : 'Overworld';
  };
  app.on('show-level-view', () => { if (owActive) toggleOw(); if (ws?.active) toggleGfx(); });

  // graphics workspace (palettes, Map16, GFX) in place of the level view
  let ws: GfxWorkspace | null = null;
  const toggleGfx = (tab?: WsTab, tile?: number, bg = false) => {
    if (!ws) ws = new GfxWorkspace(app);
    const btn = toolbar.querySelector('.gfx-toggle') as HTMLButtonElement;
    if (ws.active && tab === undefined) {
      ws.leave();
      layout.replaceChildren(toolbar, left, center, right);
      layout.classList.remove('gfx-mode');
      btn.classList.remove('active');
      view.layout();
      return;
    }
    if (owActive) toggleOw();
    if (!ws.active) {
      layout.replaceChildren(toolbar, left, ws.root, ws.side);
      layout.classList.add('gfx-mode');
      btn.classList.add('active');
      const hv = view.hover;
      ws.enter(tab ?? ws.tab, hv ? { tx: hv.tx, ty: hv.ty } : view.centerTile());
    } else if (tab) ws.open(tab);
    if (tab === 'map16' && tile !== undefined) ws.showMap16(tile, bg);
  };
  app.on('open-map16', () => toggleGfx('map16', app.wsTile, app.wsTileBg));
  app.on('open-gfx', () => toggleGfx('gfx'));

  window.onkeydown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (document.querySelector('.modal-back')) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === 'o' || k === 'O') { toggleOw(); return; }
    if (ws?.active) {
      if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) app.redo(); else app.undo(); return; }
      if (ctrl && k.toLowerCase() === 'y') { e.preventDefault(); app.redo(); return; }
      if (ctrl && k.toLowerCase() === 's') { e.preventDefault(); app.saveLevel(); return; }
      if (ws.key(e)) { e.preventDefault(); return; }
      if (k === 'Escape') toggleGfx();
      return;
    }
    if (owActive) {
      if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); ow?.undoOnce(); }
      if (ctrl && k.toLowerCase() === 's') { e.preventDefault(); ow?.save(); }
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
    else if ((k === 't' || k === 'T') && e.shiftKey) { const hv = view.hover; openTestPlay(app, hv ? { tx: hv.tx, ty: hv.ty } : undefined); }
    else if (k === 't' || k === 'T') openTestPlay(app);
    else if (k === 'Insert' || k === 'i' || k === 'I') {
      e.preventDefault();
      const hv = view.hover;
      const c = view.centerTile();
      openInsertDialog(app, hv ? hv.tx : c.tx, hv ? hv.ty : c.ty);
    }
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
    else if (k === 'm' || k === 'M') toggleGfx('map16', view.hover ? hoverTile(app, view.hover.tx, view.hover.ty) : undefined);
    else if (k === 'p' || k === 'P') toggleGfx('pal');
  };
  window.onbeforeunload = (e) => { if (app.dirty) { e.preventDefault(); } };
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
  const rows: [string, string][] = [
    ['Klick', 'Objekt/Sprite auswählen (Strg: zur Auswahl hinzufügen)'],
    ['Ziehen', 'Auswahl verschieben / Rahmen aufziehen'],
    ['Griff unten rechts', 'Objektgröße ändern'],
    ['Rechtsklick / Shift+Klick', 'Palettenelement einfügen'],
    ['BG: Klick / Ziehen', 'Tile bzw. Tile-Block als Pinsel aufnehmen'],
    ['BG: Rechtsklick / Shift+Klick (Ziehen)', 'mit dem Pinsel malen'],
    ['Einfg / I', 'Objekt/Sprite nach Nummer einfügen (an Mausposition)'],
    ['M / Z / S-Markierung ziehen', 'Haupteingang / Zwischenziel-Screen / sekundären Eingang verschieben'],
    ['Pfeiltasten', 'Auswahl um 1 Tile verschieben'],
    ['+ / − · * / ÷', 'Breite ändern · Höhe ändern'],
    ['Alt+Pfeiltasten', 'Größe ändern'],
    ['Entf', 'Auswahl löschen'],
    ['Strg+C / Strg+V / Strg+D', 'Kopieren / Einfügen an Maus / Duplizieren'],
    ['Bild↑ / Bild↓', 'Nach vorne / hinten (Zeichenreihenfolge)'],
    ['1 / 2 / 3 / 4 / 5', 'Modus Layer 1 / Layer 2 / Sprites / Exits / BG (Hintergrund malen)'],
    ['H', 'Level-Header'],
    ['T', 'Level testen (eingebauter Emulator)'],
    ['Shift+T', 'Level testen, Mario startet an der Mausposition'],
    ['O', 'Overworld-Editor ein/aus'],
    ['M / P', 'Grafik-Bereich: Map16-Tiles (Tile unter der Maus) / Paletten'],
    ['Grafik-Bereich: P / M / G', 'Tab Paletten / Map16-Tiles / Grafiken; Esc zurück zum Level'],
    ['Map16: X / Y / 1–8 / Q', 'Viertel spiegeln / Palette / nächstes Viertel; Pfeile: anderes Tile'],
    ['Grafiken: B / F / I / S / 0–9', 'Stift / Füllen / Pipette / Auswahl / Farbe; Rechtsklick malt transparent'],
    ['Strg+C / Strg+V (Grafik-Bereich)', 'Palettenzeile, Map16-Tiles bzw. Pixel kopieren / einfügen'],
    ['G', 'Raster ein/aus'],
    ['Strg+Mausrad', 'Zoom'],
    ['Strg+S', 'Level in ROM speichern'],
    ['Strg+Z / Strg+Y', 'Rückgängig / Wiederholen (Level und Grafik-Änderungen)'],
  ];
  modal('Tastenkürzel', h('table', { class: 'help' }, rows.map(([a, b]) => h('tr', null, h('td', null, h('kbd', null, a)), h('td', null, b)))), [{ label: 'OK', primary: true }]);
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
