import './style.css';
import { Rom } from './core/rom.ts';
import { disableUnsafeExtGfx, hasEditorPatch } from './core/patches.ts';
import { App, type EditMode } from './ui/app.ts';
import { h, clear, toast, log, downloadBytes, pickFile, modal } from './ui/dom.ts';
import { LogBar } from './ui/logbar.ts';
import { kvGet, saveRom, romFromRecord, type RomRecord } from './ui/storage.ts';
import { migratePatchSources } from './core/patchreg.ts';
import { migratePackageFiles } from './core/pkgreg.ts';
import { LevelView } from './ui/levelview.ts';
import { LevelList, Palette, Properties } from './ui/panels.ts';
import { openHeaderDialog } from './ui/headerdialog.ts';
import { hex } from './core/names.ts';
import { GfxWorkspace, type WsTab } from './ui/gfxworkspace.ts';
import { openEntrancesDialog, openRomInfo, openInsertDialog, openExpandDialog, installEditorPatchAction, openSaveAsDialog, exportLevel, importLevel, openScreenDialog, clearLevelConfirm } from './ui/tools.ts';
import { menuBar, closeMenus } from './ui/menu.ts';
import { viewMenu } from './ui/viewmenu.ts';
import { LEVEL_FILE_EXT } from './core/levelfile.ts';
import { openResources } from './ui/resources.ts';
import { OverworldView } from './ui/overworld.ts';
import { openTestPlay } from './ui/testplay.ts';
import { openMessagesDialog } from './ui/messagedialog.ts';

const root = document.getElementById('app')!;

// errors nobody caught would otherwise only show up in the dev console
window.addEventListener('error', (e) => log(`Unexpected error: ${e.message}`, 'error'));
window.addEventListener('unhandledrejection', (e) => log(`Unexpected error: ${e.reason instanceof Error ? e.reason.message : e.reason}`, 'error'));

function welcome(): void {
  clear(root);
  const drop = h('div', { class: 'welcome' },
    h('h1', null, 'Solar Magic'),
    h('p', null, 'Open a Super Mario World ROM (US, .smc/.sfc, with or without header) or drop it here.'),
    h('button', { class: 'primary big', onclick: async () => { const f = await pickFile('.smc,.sfc,.bin,.smwproj'); if (f) openFile(f); } }, 'Open ROM …'),
    h('p', { class: 'hint' }, 'The ROM stays local in the browser (IndexedDB). Nothing is uploaded.'),
  );
  root.appendChild(drop);
}

async function openFile(f: File): Promise<void> {
  const data = new Uint8Array(await f.arrayBuffer());
  let rom: Rom;
  try { rom = Rom.fromFile(data); } catch (e) { toast(`Could not open “${f.name}”: ${e instanceof Error ? e.message : e}`, 'error'); return; }
  startWith(rom, f.name);
  saveRom(f.name, rom).catch(() => {});
}

function startWith(rom: Rom, name: string): void {
  log(`ROM “${name}” loaded (${Math.round(rom.size / 1024)} KB${rom.smcHeader ? ', with header' : ''}${rom.extra.size ? `, editor data ${Math.round(rom.extraSize / 1024)} KB` : ''})`);
  // sources older versions kept in the ROM go into the editor data, freeing the ROM space
  try {
    const moved = [migratePatchSources(rom), migratePackageFiles(rom)].some(Boolean);
    if (moved) { saveRom(name, rom).catch(() => {}); log('Sources of patches and packages moved out of the ROM into the editor data (saved with “Export project”).'); }
  } catch (e) { console.warn('migrating sources', e); }
  if (disableUnsafeExtGfx(rom)) {
    saveRom(name, rom).catch(() => {});
    toast('BG2/BG3 graphics were turned off: they overwrote the layer 1 tilemap (broken background). The assignments stay saved and apply again once the VRAM patch is available.', 'error');
  }
  if (!rom.title().startsWith('SUPER MARIOWORLD')) {
    toast(`Unexpected ROM title "${rom.title()}" – trying anyway.`, 'error');
  }
  let app: App;
  try {
    app = new App(rom, name);
  } catch (e) {
    toast(`Emulator start failed: ${e}`, 'error');
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
    modeBtn('l1', 'Layer 1', '1'), modeBtn('l2', 'Layer 2', '2'), modeBtn('spr', 'Sprites', '3'), modeBtn('exit', 'Entrances/Exits', '4'), modeBtn('bg', 'BG', '5'));
  const levelTitle = h('span', { class: 'level-title' });
  const zoomLabel = h('span', { class: 'zoom' });
  const levelBar = h('div', { class: 'ctxbar' },
    levelTitle,
    h('button', { onclick: () => openHeaderDialog(app), title: 'Level header (H)' }, 'Header …'),
    h('span', { class: 'sep' }),
    modes,
    h('span', { class: 'sep' }),
    viewMenu(app, () => view.paint()),
    h('span', { class: 'sep' }),
    h('div', { class: 'row zoom-ctl' },
      h('button', { onclick: () => view.setZoom(app.zoom / 2), title: 'Zoom out (Ctrl+mouse wheel)' }, '−'), zoomLabel,
      h('button', { onclick: () => view.setZoom(app.zoom * 2), title: 'Zoom in (Ctrl+mouse wheel)' }, '+')),
  );

  // ---- app bar: menus, workspace switcher, main actions
  const testHere = () => { const hv = view.hover; openTestPlay(app, hv ? { tx: hv.tx, ty: hv.ty } : undefined); };
  const insertHere = () => { const hv = view.hover, c = view.centerTile(); openInsertDialog(app, hv ? hv.tx : c.tx, hv ? hv.ty : c.ty); };
  const menus = menuBar([
    { label: 'File', items: [
      { label: 'Open ROM …', onClick: async () => { const f = await pickFile('.smc,.sfc,.bin,.smwproj'); if (f) openFile(f); } },
      { label: 'Export ROM', title: 'Download the playable ROM with all saved changes (without the editor data)', onClick: () => { if (ow?.dirty) ow.save(); exportRom(app); } },
      { label: 'Export project', title: 'The ROM with the editor data: sources of patches, packages, UberASM, blocks, sprites and music – to keep editing it later or elsewhere', onClick: () => { if (ow?.dirty) ow.save(); exportProject(app); } },
      'sep',
      { label: 'Import level file …', title: 'Replaces the current level (undoable; palette/graphics bypass are written to the ROM directly)', disabled: () => !inLevel(), onClick: () => importLevel(app) },
      { label: 'Export level file …', title: `Level as ${LEVEL_FILE_EXT} file (objects, sprites, exits, header, graphics bypass, custom palette)`, disabled: () => !inLevel(), onClick: () => exportLevel(app) },
      { label: 'Level as PNG …', title: 'Visible layers and sprites at original size', disabled: () => !inLevel(), onClick: () => view.exportPng() },
    ] },
    { label: 'Level', disabled: () => !inLevel(), items: [
      { label: 'Save', shortcut: 'Ctrl+S', onClick: () => app.saveLevel() },
      { label: 'Save as …', onClick: () => openSaveAsDialog(app) },
      { label: 'Header …', shortcut: 'H', onClick: () => openHeaderDialog(app) },
      { label: 'Test play', shortcut: 'T', onClick: () => openTestPlay(app) },
      'sep',
      { label: 'Insert by number …', shortcut: 'I', onClick: insertHere },
      { label: 'Insert screen …', disabled: () => app.level.header.screens >= 32, onClick: () => openScreenDialog(app, 'insert') },
      { label: 'Delete screen …', disabled: () => app.level.header.screens <= 1, onClick: () => openScreenDialog(app, 'delete') },
      { label: 'Clear level …', onClick: () => clearLevelConfirm(app) },
      'sep',
      { label: 'Secondary entrances …', onClick: () => openEntrancesDialog(app) },
    ] },
    { label: 'ROM', items: [
      { label: 'ROM information …', onClick: () => openRomInfo(app) },
      { label: 'Expand ROM …', disabled: () => app.rom.size >= 0x400000, onClick: () => openExpandDialog(app) },
      'sep',
      { label: 'Patches …', title: 'Apply and manage ASM patches (Asar)', onClick: () => openResources(app, 'patches') },
      { label: 'UberASM …', onClick: () => openResources(app, 'uber') },
      { label: 'Custom Blocks …', onClick: () => openResources(app, 'blocks') },
      { label: 'Custom Sprites …', onClick: () => openResources(app, 'sprites') },
      { label: 'Music …', title: 'Custom music (AddmusicK): add songs, listen, set the music of levels', onClick: () => openResources(app, 'music') },
      { label: 'Install editor patch …', disabled: () => hasEditorPatch(app.rom), onClick: () => installEditorPatchAction(app) },
      'sep',
      { label: 'Message boxes …', onClick: () => openMessagesDialog(app) },
    ] },
    { label: 'Help', items: [
      { label: 'Keyboard shortcuts …', shortcut: '?', onClick: () => showHelp() },
      { label: 'Expand/collapse log', shortcut: 'L', onClick: () => logBar.toggle() },
    ] },
  ]);
  const wsBtn = (w: typeof workspace, label: string, key: string) => h('button', { 'data-ws': w, title: `${label} (${key})`, onclick: () => setWorkspace(w) }, label);
  const wsSwitch = h('div', { class: 'btn-group ws-switch' }, wsBtn('level', 'Level', 'Esc'), wsBtn('ow', 'Overworld', 'O'), wsBtn('gfx', 'Graphics', 'P / M / G / A'));
  const undoBtn = h('button', { onclick: () => (workspace === 'ow' ? ow?.undo() : app.undo()), title: 'Undo (Ctrl+Z)' }, '↶');
  const redoBtn = h('button', { onclick: () => (workspace === 'ow' ? ow?.redo() : app.redo()), title: 'Redo (Ctrl+Y)' }, '↷');
  const saveBtn = h('button', { class: 'primary', onclick: () => (workspace === 'ow' ? ow?.save() : app.saveLevel()) });
  const testBtn = h('button', { onclick: () => openTestPlay(app), title: 'Test the level in the built-in emulator (T, Shift+T: from the mouse position)' }, '▶ Test');
  const appbar = h('header', { class: 'appbar' },
    h('span', { class: 'brand' }, 'Solar Magic'),
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
    saveBtn.textContent = inOw ? `Save overworld${ow!.dirty ? ' *' : ''}` : `Save level${app.dirty ? ' *' : ''}`;
    saveBtn.title = inOw ? 'Write overworld to ROM (Ctrl+S)' : 'Write level to ROM (Ctrl+S)';
    undoBtn.disabled = inOw ? !ow!.canUndo : false;
    redoBtn.disabled = inOw ? !ow!.canRedo : false;
    testBtn.disabled = workspace === 'ow';
    testBtn.title = workspace === 'ow' ? 'Test play is available in the level editor' : 'Test the level in the built-in emulator (T, Shift+T: from the mouse position)';
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
  const logBar = new LogBar();
  const busy = busyIndicator(app);
  const layout = h('div', { class: 'layout' }, appbar, levelBar, left, center, right, logBar.root, busy);
  root.append(layout);
  const owRight = h('div', { class: 'right' });
  const showLayout = (bar: HTMLElement, l: HTMLElement, main: HTMLElement, side: HTMLElement) => layout.replaceChildren(appbar, bar, l, main, side, logBar.root, busy);

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
  app.on('open-gfx', () => {
    const n = app.wsGfx;
    app.wsGfx = null;
    void setWorkspace('gfx', { tab: 'gfx' }).then((ok) => { if (ok && n !== null) ws!.showGfx(n); });
  });
  // a graphics file of a package (app.gfxImport) into a free ExGFX number
  app.on('import-gfx', () => {
    const job = app.gfxImport;
    app.gfxImport = null;
    if (!job) return;
    void setWorkspace('gfx', { tab: 'gfx' }).then(async (ok) => { if (ok) job.done(await ws!.gfx.importNew(job.file)); });
  });

  window.onkeydown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (document.querySelector('.modal-back')) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === 'F1' || k === '?') { e.preventDefault(); showHelp(); return; }
    if (k === 'o' || k === 'O') { setWorkspace(workspace === 'ow' ? 'level' : 'ow'); return; }
    if ((k === 'l' || k === 'L') && !ctrl && !e.altKey) { logBar.toggle(); return; }
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
    if (ctrl && k.toLowerCase() === 'd') { e.preventDefault(); app.duplicateSelection(); return; }
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
    else if (k === 'c' || k === 'C') { app.show.collision = !app.show.collision; view.paint(); }
    else if ((k === 'j' || k === 'J') && e.shiftKey) view.toggleArcPin();
    else if (k === 'j' || k === 'J') { app.show.arcs = !app.show.arcs; if (!app.show.arcs) view.arcPin = null; view.paint(); }
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

// the playable ROM: without the editor data (sources of patches, packages, UberASM/blocks/sprites/music)
function exportRom(app: App): void {
  if (app.dirty) app.saveLevel(true);
  const withHeader = app.rom.smcHeader !== null;
  const out = app.rom.output(withHeader);
  const base = app.romName.replace(/\.(smc|sfc|bin|smwproj)$/i, '');
  downloadBytes(`${base}.${withHeader ? 'smc' : 'sfc'}`, out);
  log(`ROM exported as “${base}.${withHeader ? 'smc' : 'sfc'}” (${Math.round(out.length / 1024)} KB)`);
  if (app.rom.extra.size) toast('The playable ROM holds no sources of patches, packages and projects – to keep editing elsewhere, use “Export project”.');
  app.persist();
}

// ROM plus editor data, to open again in the editor
function exportProject(app: App): void {
  if (app.dirty) app.saveLevel(true);
  const out = app.rom.outputProject(app.rom.smcHeader !== null);
  const base = app.romName.replace(/\.(smc|sfc|bin|smwproj)$/i, '');
  downloadBytes(`${base}.smwproj`, out);
  log(`Project exported as “${base}.smwproj” (${Math.round(out.length / 1024)} KB, of which ${Math.round(app.rom.extraSize / 1024)} KB editor data)`);
  app.persist();
}

function showHelp(): void {
  const sections: [string, [string, string][]][] = [
    ['General', [
      ['Ctrl+S', 'Save (level or overworld)'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
      ['Esc / O / M · P · A', 'Workspace level / overworld / graphics (Map16, palettes, animations)'],
      ['Ctrl+mouse wheel · Middle mouse button drag', 'Zoom · Pan view'],
      ['? / F1', 'This overview'],
      ['L', 'Expand/collapse log (all messages with time)'],
      ['Menus: ↑ ↓ ← → / Enter / Esc', 'Choose entry, neighboring menu / run / close'],
    ]],
    ['Level', [
      ['1 / 2 / 3 / 4 / 5', 'Mode layer 1 / layer 2 / sprites / entrances/exits / BG'],
      ['Click · Ctrl+click · Alt+click', 'Select · add to selection · element underneath'],
      ['Drag', 'Move selection / drag a selection box'],
      ['Handle at bottom right', 'Resize object'],
      ['Right click / Shift+click', 'Place the element chosen in “Insert”'],
      ['BG: click/drag · right click/Shift+click', 'Pick up tile(s) as brush · paint'],
      ['Ins / I', 'Insert object/sprite by number (at the mouse)'],
      ['Drag M / Z / S marker', 'Move main entrance / midway screen / secondary entrance'],
      ['Entrances/Exits: click · right click', 'Choose entrance or screen (exit), edit on the right · new secondary entrance, create exit, entrance here'],
      ['Arrow keys · Alt+arrow keys', 'Move selection by 1 tile · resize'],
      ['+ / - · * / /', 'Change width · change height'],
      ['Del / Backspace', 'Delete selection'],
      ['Ctrl+A · Esc', 'Select all · deselect'],
      ['Ctrl+C / Ctrl+V / Ctrl+D', 'Copy / paste at the mouse / duplicate'],
      ['PgUp / PgDn', 'Bring to front / send to back (drawing order)'],
      ['H · G · C', 'Level header · grid on/off · collision overlay on/off'],
      ['T · Shift+T', 'Test level · Mario starts at the mouse'],
      ['J · Shift+J', 'Jump arcs at the mouse on/off · pin them to the tile / unpin'],
    ]],
    ['Overworld', [
      ['1 / 2', 'Layer 1 (paths/levels) / layer 2 (terrain)'],
      ['Click/drag · right click/Shift+click', 'Pick up tile(s) as brush · paint'],
      ['Alt+click / Ctrl+click', 'Level info of the level tile'],
      ['G', 'Grid on/off'],
    ]],
    ['Graphics', [
      ['P / M / G / A', 'Tab palettes / Map16 tiles / graphics / animations; Esc back to the level'],
      ['Ctrl+C / Ctrl+V', 'Copy / paste palette, Map16 tiles or pixels'],
      ['Palettes: arrow keys · Shift+click', 'Other color · mark a range (for “Gradient”)'],
      ['Map16: X / Y / 1–8 / Q', 'Flip quarter / palette 0–7 / next quarter; arrows: other tile'],
      ['Map16: double click · Ctrl+click on palette', 'Edit quarter in “Graphics” · open palette in “Palettes”'],
      ['Graphics: B / F / I / S / 0–9', 'Pencil / fill / eyedropper / selection / color'],
      ['Graphics: right click · Alt+click', 'Paint transparent · pick color'],
      ['Graphics: Enter / Esc', 'Drop floating selection / deselect'],
      ['Animations: Del / Esc', 'Delete animation / cancel selection'],
    ]],
  ];
  modal('Keyboard shortcuts', h('div', { class: 'help-cols' }, sections.map(([title, rows]) => h('section', null,
    h('h3', null, title),
    h('table', { class: 'help' }, rows.map(([a, b]) => h('tr', null, h('td', null, h('kbd', null, a)), h('td', null, b))))))),
  [{ label: 'Close', primary: true }]);
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
      startWith(Rom.fromFile(data), q.split('/').pop() ?? 'rom.smc');
      return;
    }
  }
  try {
    const saved = await kvGet<RomRecord>('rom');
    if (saved?.data) {
      startWith(romFromRecord(saved), saved.name);
      return;
    }
  } catch (e) {
    console.warn(e);
  }
  welcome();
})();
