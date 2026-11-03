import { Rom } from './core/rom.ts';
import { openLevelImport } from './ui/levelimport.ts';
import { createBps, crc32 } from './core/bps.ts';
import { prepareRom } from './core/editorpatches.ts';
import { SMW_CLEAN_CRC } from './core/cleangame.ts';
import { App, type EditMode } from './ui/app.ts';
import { h, clear, toast, log, modal, choose, zoomControl, fieldTakesKey, installStepFields } from './ui/dom.ts';
import { downloadBytes, pickFile, saveFile, filePath, fileName, desktop, guardClose } from './ui/platform.ts';
import { LogBar } from './ui/logbar.ts';
import { pasteHintBox } from './ui/pastehint.ts';
import { kvGet, kvSet, kvDel, kvClear, saveRom, romFromRecord, type RomRecord } from './ui/storage.ts';
import { LevelView } from './ui/levelview.ts';
import { exportLevelPng, openLevelImages } from './ui/levelimages.ts';
import { LevelList, Picker, Properties } from './ui/panels.ts';
import { sideSplitter } from './ui/pickerview.ts';
import { openSearch } from './ui/search.ts';
import { onBehaviorProgress } from './ui/tilebehaviors.ts';
import { openHeaderDialog } from './ui/headerdialog.ts';
import { hex } from './core/names.ts';
import { GfxWorkspace, type WsTab, type WsTarget } from './ui/gfxworkspace.ts';
import type { Map16Target } from './ui/gfx/target.ts';
import { openRemapUses } from './ui/tileuses.ts';
import { openEntrancesDialog, openRomInfo, openInsertDialog, openExpandDialog, openSaveAsDialog, exportLevel, importLevel, importOverworldFrom, openScreenDialog, clearLevelConfirm } from './ui/tools.ts';
import { menuBar, closeMenus } from './ui/menu.ts';
import { viewMenu } from './ui/viewmenu.ts';
import { LEVEL_FILE_EXT } from './core/levelfile.ts';
import { openResources } from './ui/resources.ts';
import { OverworldView } from './ui/overworld.ts';
import { GameView } from './ui/gameview.ts';
import { overworldReplacement } from './core/overworld.ts';
import { openTestPlay, openOverworldTestPlay } from './ui/testplay.ts';
import { musicPlayer, LEVEL_MUSIC, isSubmapMusic } from './ui/musicplayer.ts';
import { MessagePanel, levelMessages } from './ui/messagepanel.ts';
import { NavHistory, fromHash, type NavLoc } from './ui/navhistory.ts';
import { initLanding } from './ui/landing.ts';

const root = document.getElementById('app')!;

// errors nobody caught would otherwise only show up in the dev console
// “ResizeObserver loop …” is only the browser's notice that it moved some resize notifications to the next frame – nothing failed
window.addEventListener('error', (e) => { if (!e.message.startsWith('ResizeObserver loop')) log(`Unexpected error: ${e.message}`, 'error'); });
window.addEventListener('unhandledrejection', (e) => log(`Unexpected error: ${e.reason instanceof Error ? e.reason.message : e.reason}`, 'error'));

// the start page is static HTML in index.html (readable for search engines); kept to show it again after “Close project”
const landing = root.querySelector<HTMLElement>('.landing')!;
landing.querySelector('#landing-new-project')!.addEventListener('click', openRomFile);
landing.querySelector('#landing-open-project')!.addEventListener('click', openProjectFile);
initLanding(landing);

// the desktop app hides the start page's download of itself
if (desktop) document.documentElement.classList.add('desktop');

function welcome(): void {
  // at the start it is already there (and may have been scrolled: index.html shows it before this code runs)
  if (!landing.isConnected) {
    clear(root);
    root.appendChild(landing);
  }
  document.documentElement.classList.remove('booting');
}

async function openRomFile(): Promise<void> { const f = await pickFile('.smc,.sfc,.bin'); if (f) openFile(f); }
async function openProjectFile(): Promise<void> { const f = await pickFile('.smwproj'); if (f) openFile(f); }

async function openFile(f: File): Promise<void> {
  const data = new Uint8Array(await f.arrayBuffer());
  let rom: Rom;
  try { rom = Rom.fromFile(data); } catch (e) { toast(`Could not open “${f.name}”: ${e instanceof Error ? e.message : e}`, 'error'); return; }
  if (!(await startWith(rom, f.name))) return;
  saveRom(f.name, rom).catch(() => {});
  const path = filePath(f);
  setProjectPath(path && /\.smwproj$/i.test(path) ? path : null);
}

// desktop app: the .smwproj the project was opened from or last saved to – “Save project” writes there
let projectPath: string | null = null;
function setProjectPath(path: string | null): void {
  projectPath = path;
  (path ? kvSet('projectPath', path) : kvDel('projectPath')).catch(() => {});
}

// false if the ROM cannot be opened
async function startWith(rom: Rom, name: string): Promise<boolean> {
  log(`ROM “${name}” loaded (${Math.round(rom.size / 1024)} KB${rom.smcHeader ? ', with header' : ''}${rom.extra.size ? `, editor data ${Math.round(rom.extraSize / 1024)} KB` : ''})`);
  // a clean ROM gets the editor's patches; anything but it and the editor's own ROMs is refused
  try {
    if (await prepareRom(rom)) { saveRom(name, rom).catch(() => {}); log('Editor patches installed.'); }
  } catch (e) {
    toast(`Could not open “${name}”: ${e instanceof Error ? e.message : e}`, 'error');
    return false;
  }
  let app: App;
  try {
    app = new App(rom, name);
  } catch (e) {
    toast(`Emulator start failed: ${e}`, 'error');
    return false;
  }
  (window as unknown as { app: App }).app = app;
  const ui = buildUi(app);
  // a reload stays where it was: the entry of the browser history, else the place in the URL
  const st: unknown = history.state;
  const at = st && typeof st === 'object' && 'nav' in st ? (st as { nav: NavLoc }).nav : fromHash(location.hash);
  // a level is open before the UI starts: the workspaces and the restore read app.level
  app.openLevel(at?.w === 'level' ? at.level : 0x105);
  void ui.start(at);
  return true;
}

// spinner pill for background analyses; shown after a short delay so quick jobs don't flicker,
// ignores the mouse so the editor stays usable underneath; hidden while background work is held
function busyIndicator(app: App): HTMLElement {
  const label = h('span');
  const el = h('div', { class: 'busy' }, h('span', { class: 'busy-spin' }), label);
  let timer = 0;
  app.on('busy', () => {
    label.textContent = [...app.busy.values()].join(' · ') + ' …';
    el.title = label.textContent;
    const on = () => app.busy.size > 0 && !app.scheduler.held();
    if (!on()) { clearTimeout(timer); timer = 0; el.classList.remove('show'); }
    else if (!timer && !el.classList.contains('show')) timer = window.setTimeout(() => { timer = 0; if (on()) el.classList.add('show'); }, 200);
  });
  return el;
}

function buildUi(app: App): { start: (at: NavLoc | null) => Promise<void> } {
  clear(root);
  const status = h('div', { class: 'statusbar' });
  const view = new LevelView(app, status);
  const levels = new LevelList(app);
  const picker = new Picker(app);
  const props = new Properties(app);
  app.on('properties', () => {
    if (app.messages) app.closeMessages();
    props.root.scrollIntoView({ block: 'nearest' });
    props.root.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
  });

  let workspace: 'level' | 'ow' | 'gfx' | 'game' = 'level';
  let ow: OverworldView | null = null;
  let game: GameView | null = null;
  let gameBorder: number | null = null; // the overworld map whose border the Game workspace shows when switched to
  // the package that replaced the overworld while the overworld workspace is shown locked (ADR 0005), else null
  let owLocked: string | null = null;
  let ws: GfxWorkspace | null = null;
  const inLevel = () => workspace === 'level' || workspace === 'gfx';
  // the workspaces without the open level: their changes are ROM edits (nothing to save), no level to test or hear
  const romOnly = () => workspace === 'ow' || workspace === 'game';

  // ---- level context bar: mode, view, zoom
  const modeBtn = (m: EditMode, label: string, key: string) => h('button', { class: 'mode', 'data-mode': m, title: `${label} (${key})`, onclick: () => app.setMode(m) }, label);
  const modes = h('div', { class: 'btn-group' },
    modeBtn('l1', 'Layer 1', '1'), modeBtn('l2', 'Layer 2', '2'), modeBtn('spr', 'Sprites', '3'), modeBtn('exit', 'Entrances/Exits', '4'), modeBtn('bg', 'BG', '5'), modeBtn('l3', 'Layer 3', '6'));
  const levelTitle = h('span', { class: 'level-title' });
  const zoomCtl = zoomControl(() => app.view.zoom, (z) => view.setZoom(z));
  const levelBar = h('div', { class: 'ctxbar' },
    levelTitle,
    h('button', { onclick: () => openHeaderDialog(app), title: 'Level header (H)' }, 'Header …'),
    h('span', { class: 'sep' }),
    modes,
    h('span', { class: 'sep' }),
    viewMenu(app, () => view.paint()),
    h('span', { class: 'sep' }),
    zoomCtl.root,
  );

  // ---- app bar: menus, workspace switcher, main actions
  const testHere = () => { const hv = view.hover; openTestPlay(app, hv ? { tx: hv.tx, ty: hv.ty } : undefined); };
  // central search (Ctrl+F or Ctrl+Space): a result is shown in the level workspace
  const search = () => openSearch(picker.searchProviders().map((p) => ({
    ...p, search: (terms) => p.search(terms).map((r) => ({ ...r, pick: () => void setWorkspace('level').then((ok) => { if (ok) r.pick(); }) })),
  })), { refresh: (again) => onBehaviorProgress(app, again) }); // (tiles' behavior determined)
  const insertHere = () => { const hv = view.hover, c = view.centerTile(); openInsertDialog(app, hv ? hv.tx : c.tx, hv ? hv.ty : c.ty); };
  const menus = menuBar([
    { label: 'File', items: [
      { label: 'Open project …', title: 'A project file (.smwproj) saved with “Save project”', onClick: openProjectFile },
      { label: 'Save project', title: 'The ROM with the editor data: sources of patches, packages, UberASM, blocks, sprites and music – to keep editing it later or elsewhere', onClick: () => exportProject(app) },
      ...(desktop ? [{ label: 'Save project as …', title: 'Save the project to another file and keep working on that one', onClick: () => exportProject(app, true) }] : []),
      'sep',
      { label: 'Open ROM …', title: 'Start from a ROM (.smc/.sfc) – clean or already modified', onClick: openRomFile },
      { label: 'Export ROM', title: 'Download the playable ROM with all saved changes (without the editor data)', onClick: () => exportRom(app) },
      { label: 'Export patch …', title: 'A BPS patch (for Floating IPS / Flips) from a clean ROM you choose to the playable ROM with all saved changes', onClick: () => exportPatch(app) },
      'sep',
      { label: 'Import level file …', title: 'Replaces the current level (undoable; palette/graphics bypass are written to the ROM directly)', disabled: () => !inLevel(), onClick: () => importLevel(app) },
      { label: 'Export level file …', title: `Level as ${LEVEL_FILE_EXT} file (objects, sprites, exits, header, graphics bypass, custom palette)`, disabled: () => !inLevel(), onClick: () => exportLevel(app) },
      { label: 'Import overworld from ROM …', title: 'The overworld of another ROM made with the editor (or the clean game) replaces this one\'s – as Lunar Magic\'s “Copy Overworld to Another ROM”; its packages are not copied (undoable)', onClick: () => void importOverworldFrom(app) },
      { label: 'Level as PNG …', title: 'The level as the level view shows it (the View menu\'s layers, sprites and overlays, without the selection) at original size', disabled: () => !inLevel(), onClick: () => void exportLevelPng(app, view.arcPin) },
      { label: 'Levels as images …', title: 'Several levels (used, all or chosen) as PNGs in one .zip, drawn as Level as PNG; with a zoom and cropped to the screens each level uses', disabled: () => !inLevel(), onClick: () => openLevelImages(app, () => levels.shown, view.arcPin) },
      'sep',
      { label: 'Close project …', title: 'Remove the ROM and all editor data from the browser and return to the start page', onClick: () => closeProject(app) },
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
      { label: 'Remap Direct Map16 …', title: 'Which Map16 tiles the Direct Map16 objects of this level or all levels place (Lunar Magic\'s list syntax); the tiles themselves stay', onClick: () => openRemapUses(app, 'fg') },
      { label: 'Remap Background Tiles …', title: 'Which BG Map16 tiles the BG tilemaps of this level or all levels use (Lunar Magic\'s list syntax); the tiles themselves stay', onClick: () => openRemapUses(app, 'bg') },
      { label: 'Import LM level file …', title: 'A Lunar Magic level file (.mwl, or a .zip with one): its background, Map16 tiles, graphics slots and colors into this level', onClick: () => void openLevelImport(app) },
      'sep',
      { label: 'Secondary entrances …', onClick: () => openEntrancesDialog(app) },
      { label: 'Message boxes', title: 'Edit the level\'s two messages (those of its overworld level) and Yoshi\'s thank-you beside the level (also: double click a message box)', onClick: () => app.openMessages(levelMessages(app), 1) },
    ] },
    { label: 'ROM', items: [
      { label: 'ROM information …', onClick: () => openRomInfo(app) },
      { label: 'Expand ROM …', disabled: () => app.rom.size >= 0x400000, onClick: () => openExpandDialog(app) },
      'sep',
      { label: 'Packages …', title: 'Third-party content: upload packages (patches, UberASM, blocks, sprites, music) and configure what they brought', onClick: () => openResources(app, 'packages') },
    ] },
    { label: 'Search', items: [
      { label: 'Search everywhere …', shortcut: 'Ctrl+F / Ctrl+Space', title: 'Objects, extended objects, Map16 tiles, prefabs and sprites by number, name or behavior', onClick: search },
    ] },
    { label: 'Help', items: [
      { label: 'Keyboard shortcuts …', shortcut: '?', onClick: () => showHelp() },
      { label: 'Expand/collapse log', shortcut: 'L', onClick: () => logBar.toggle() },
    ] },
  ]);
  const wsBtn = (w: typeof workspace, label: string, key: string) => h('button', { 'data-ws': w, title: key ? `${label} (${key})` : label, onclick: () => setWorkspace(w) }, label);
  const wsSwitch = h('div', { class: 'btn-group ws-switch' }, wsBtn('level', 'Level', 'Esc'), wsBtn('ow', 'Overworld', 'O'), wsBtn('gfx', 'Graphics', 'P / M / G / A'), wsBtn('game', 'Game', ''));
  const backBtn = h('button', { onclick: () => history.back(), title: 'Back to the place before (Alt+←, mouse back button)', disabled: true }, '←');
  const fwdBtn = h('button', { onclick: () => history.forward(), title: 'Forward (Alt+→, mouse forward button)', disabled: true }, '→');
  const undoBtn = h('button', { onclick: () => app.undo(), title: 'Undo (Ctrl+Z)' }, '↶');
  const redoBtn = h('button', { onclick: () => app.redo(), title: 'Redo (Ctrl+Y)' }, '↷');
  const saveBtn = h('button', { class: 'primary', onclick: () => app.saveLevel(), title: 'Write level to ROM (Ctrl+S)' });
  const testLevelTitle = 'Test the level in the built-in emulator (T, Shift+T: from the mouse position)';
  const testBtn = h('button', { onclick: () => (workspace === 'ow' ? testOverworld() : openTestPlay(app)), title: testLevelTitle }, '▶ Test');
  // loops the open level's music while editing; anything else that plays (test play, a song in a dialog) ends it
  const musicTitle = 'Play the level\'s music in a loop while editing';
  let musicOf = ''; // level and header music playing
  const playLevelMusic = () => {
    musicOf = `${app.level.number}:${app.level.header.music}`;
    void musicPlayer.playLevel(app, app.level.number, LEVEL_MUSIC).then(() => {
      if (musicPlayer.error) toast(`Could not play: ${musicPlayer.error}`, 'error');
    });
  };
  const musicBtn = h('button', { title: musicTitle, onclick: () => { if (musicPlayer.label === LEVEL_MUSIC) musicPlayer.stop(); else playLevelMusic(); } }, '♪ Music');
  musicPlayer.onChange((l) => musicBtn.classList.toggle('active', l === LEVEL_MUSIC));
  // another level or other header music: its music
  const followLevel = () => { if (musicPlayer.label === LEVEL_MUSIC && musicOf !== `${app.level.number}:${app.level.header.music}`) playLevelMusic(); };
  app.on('level', followLevel);
  app.on('level-header', followLevel);
  const appbar = h('header', { class: 'appbar' },
    // three columns, so nothing moves when the buttons on the right change their labels with the workspace
    h('div', { class: 'appbar-l' }, h('span', { class: 'brand' }, 'Solar Magic'), menus, h('div', { class: 'btn-group' }, backBtn, fwdBtn)),
    wsSwitch,
    h('div', { class: 'appbar-r' }, undoBtn, redoBtn, saveBtn, testBtn, musicBtn),
  );

  const updateToolbar = () => {
    for (const b of modes.querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === app.model.mode);
    const btnL2 = modes.querySelector('[data-mode="l2"]') as HTMLButtonElement;
    btnL2.disabled = !app.level?.layer2Objects;
    (modes.querySelector('[data-mode="bg"]') as HTMLButtonElement).disabled = !app.level || !app.canEditBg();
    if (app.level) levelTitle.textContent = `Level ${hex(app.level.number, 3)}${app.dirty ? ' *' : ''}`;
    zoomCtl.update();
    for (const b of wsSwitch.querySelectorAll('button')) b.classList.toggle('active', b.dataset.ws === workspace);
    saveBtn.textContent = `Save level${app.dirty ? ' *' : ''}`;
    // (the overworld's changes are ROM edits: nothing to save; hidden, so nothing else moves)
    saveBtn.style.visibility = romOnly() ? 'hidden' : '';
    testBtn.disabled = (workspace === 'ow' && !owShown()) || workspace === 'game';
    testBtn.title = workspace === 'game' ? 'Test play is available in the level and overworld workspaces'
      : workspace !== 'ow' ? testLevelTitle
      : owShown() ? 'Play the game from the overworld in the built-in emulator (T): a new game at the event progress shown, Mario on the selected tile (without one at the start position)'
        : 'The overworld is replaced by a package';
    musicBtn.disabled = romOnly();
    musicBtn.title = romOnly() ? 'The level\'s music plays in the level editor' : musicTitle;
    if (romOnly() && musicPlayer.label === LEVEL_MUSIC) musicPlayer.stop();
    if (workspace !== 'ow' && isSubmapMusic(musicPlayer.label)) musicPlayer.stop();
    menus.refresh();
  };
  app.on('mode', updateToolbar);
  app.on('change', updateToolbar);
  app.on('level', updateToolbar);
  app.on('zoom', updateToolbar);

  const left = h('div', { class: 'left' }, levels.root);
  const center = h('div', { class: 'center' }, view.root, status);
  const right = h('div', { class: 'right' }, picker.root, props.root);
  const logBar = new LogBar();
  const busy = busyIndicator(app);
  const pasteHint = pasteHintBox(app);
  const layout = h('div', { class: 'layout' });
  const split = sideSplitter(layout);
  layout.append(appbar, levelBar, left, center, right, split.root, logBar.root, busy, pasteHint);
  split.use('level');
  root.append(layout);
  const owRight = h('div', { class: 'right' });
  const showLayout = (bar: HTMLElement, l: HTMLElement, main: HTMLElement, side: HTMLElement) => layout.replaceChildren(appbar, bar, l, main, side, split.root, logBar.root, busy, pasteHint);

  // switches between the level editor, the overworld editor and the graphics workspace (palettes, Map16, GFX);
  // gfx: tab to open (default: the last one), Map16 tile to show
  // at: the workspace's target (a submap and the event progress it is shown at)
  const setWorkspace = async (w: typeof workspace, gfx?: { tab?: WsTab; tile?: number; target?: Map16Target; at?: WsTarget }): Promise<boolean> => {
    closeMenus();
    if (gfx?.at && ws) ws.setTarget(gfx.at);
    if (w === workspace) {
      if (w === 'gfx' && gfx?.tab) {
        ws!.open(gfx.tab);
        if (gfx.tab === 'map16' && gfx.tile !== undefined) ws!.showMap16(gfx.tile, gfx.target, gfx.at);
      }
      return true;
    }
    // leave the current workspace
    if (romOnly()) {
      layout.classList.remove('ow-mode'); // (the Game workspace's layout is the overworld's)
    } else if (workspace === 'gfx') {
      ws!.leave();
      layout.classList.remove('gfx-mode');
    }
    const from = workspace;
    workspace = w;
    split.use(w);
    if (from === 'ow') app.refresh();
    if (w === 'ow') {
      if (app.dirty) app.saveLevel(true);
      showOverworld();
    } else if (w === 'game') {
      if (app.dirty) app.saveLevel(true);
      if (!game) { game = new GameView(app); game.onNav = () => nav?.mark(); }
      showLayout(game.bar, game.left, game.root, game.side);
      layout.classList.add('ow-mode');
      if (gameBorder !== null) game.select('border', gameBorder); else game.show();
      gameBorder = null;
    } else if (w === 'gfx') {
      if (!ws) { ws = new GfxWorkspace(app); ws.onNav = (jump) => nav?.mark(jump); }
      if (gfx?.at) ws.setTarget(gfx.at);
      showLayout(ws.bar, left, ws.root, ws.side);
      layout.classList.add('gfx-mode');
      // the level view is only up to date when coming from it
      const hv = from === 'level' ? view.hover : null;
      ws.enter(gfx?.tab ?? ws.tab, hv ? { tx: hv.tx, ty: hv.ty } : view.centerTile());
      if (gfx?.tab === 'map16' && gfx.tile !== undefined) ws.showMap16(gfx.tile, gfx.target, gfx.at);
    } else {
      showLayout(levelBar, left, center, right);
      view.layout();
    }
    updateToolbar();
    nav?.mark();
    return true;
  };

  // the overworld workspace: the overworld editor, or only a note while a package replaced the overworld (ADR 0005)
  const owLockBar = h('div', { class: 'ctxbar' });
  const owLockLeft = h('div', { class: 'left' });
  const owLockNote = h('div', { class: 'ow-locked' });
  const showOverworld = () => {
    owLocked = overworldReplacement(app.rom);
    if (owLocked) {
      owLockNote.replaceChildren(h('div', { class: 'ow-locked-note' },
        h('b', {}, `The overworld is replaced by ${owLocked}.`),
        h('p', {}, 'Its overworld has its own formats, which the overworld editor would corrupt: the overworld can\'t be edited here. Levels, graphics and everything else are edited as before.')));
      owRight.replaceChildren();
      showLayout(owLockBar, owLockLeft, h('div', { class: 'center' }, owLockNote), owRight);
    } else {
      if (!ow) {
        ow = new OverworldView(app);
        ow.onOpenLevel = async (n) => { if (await setWorkspace('level')) app.openLevel(n); };
        ow.onNav = () => nav?.mark();
        ow.onEditGraphics = (map, progress) => void setWorkspace('gfx', { tab: 'pal', at: { submap: map, progress } });
        ow.onEditBorder = (map) => { gameBorder = map; void setWorkspace('game'); };
      }
      owRight.replaceChildren(ow.side);
      showLayout(ow.bar, ow.left, ow.root, owRight);
    }
    layout.classList.add('ow-mode');
    if (!owLocked) ow!.show();
  };
  // a package installed or removed (or undone) while the overworld workspace is shown: locked or unlocked at once
  app.on('rom-change', () => { if (workspace === 'ow' && !!overworldReplacement(app.rom) !== !!owLocked) { showOverworld(); updateToolbar(); } });
  // the overworld editor while it is shown (not while locked)
  const owShown = () => (workspace === 'ow' && !owLocked ? ow : null);
  // test play from the overworld: the selected tile, the event progress shown with the save learned for it (once it
  // is; a new file's when it can't be); a moment of the meters is shown in the level editor
  const testOverworld = () => {
    const o = owShown();
    if (o) openOverworldTestPlay(app, o.selected, o.progress, app.progressSave(o.progress), (n, at) => void setWorkspace('level').then((ok) => { if (ok) app.showUse(n, at); }));
  };

  app.gotoOverworldTile = async (i) => { if (await setWorkspace('ow')) owShown()?.showTile(i); };

  // the message panel takes the picker's place while it is open
  const messagePanel = new MessagePanel(app);
  app.on('messages', () => {
    if (!app.messages) { right.replaceChildren(picker.root, props.root); return; }
    if (workspace !== 'level') void setWorkspace('level');
    if (messagePanel.root.parentElement !== right) { right.replaceChildren(messagePanel.root); messagePanel.focus(); }
  });

  // ---- browser back/forward through the places (navhistory.ts)
  let nav: NavHistory | null = null;
  const capture = (): NavLoc => {
    if (workspace === 'game') return game?.tab === 'border' ? { w: 'game', tab: 'border', map: game.borderMap } : { w: 'game', tab: 'title' };
    if (workspace === 'ow') { const o = owShown(); return { w: 'ow', map: o?.map ?? 0, ...(o && o.selected >= 0 ? { tile: o.selected } : {}) }; }
    if (workspace === 'gfx' && ws) {
      const t = ws.tab, sub = ws.target.submap ?? undefined, g = { w: 'gfx' as const, tab: t, ...(sub !== undefined ? { sub } : {}) };
      if (t === 'pal') return { ...g, pal: ws.pal.selected };
      if (t === 'map16') { const s = ws.map16.selected; return { ...g, m16: s.tile, target: s.target }; }
      if (t === 'gfx') return { ...g, gfx: ws.gfx.selected };
      return { ...g, anim: ws.anim.selected };
    }
    // the view is only laid out while the level workspace is shown
    const c = workspace === 'level' ? view.centerTile() : null;
    return { w: 'level', level: app.level.number, mode: app.model.mode, ...(c ? { cx: c.tx, cy: c.ty } : {}) };
  };
  const restore = async (l: NavLoc): Promise<boolean> => {
    if (!(await setWorkspace(l.w))) return false;
    if (l.w === 'game') { if (l.tab !== game!.tab || (l.tab === 'border' && l.map !== game!.borderMap)) game!.select(l.tab, l.map); } else if (l.w === 'ow') { const o = owShown(); if (o) { o.setMap(l.map); if (l.tile !== undefined) o.selectTile(l.tile, true); } }
    else if (l.w === 'gfx') {
      ws!.setTarget({ submap: l.sub ?? null, progress: ws!.target.progress });
      if (l.tab === 'pal' && l.pal !== undefined) ws!.showPalette(l.pal >> 4, l.pal & 15);
      else if (l.tab === 'map16' && l.m16 !== undefined) ws!.showMap16(l.m16, l.target, l.sub !== undefined ? { submap: l.sub, progress: ws!.target.progress } : undefined);
      else if (l.tab === 'gfx' && l.gfx !== undefined) ws!.showGfx(l.gfx);
      else if (l.tab === 'anim' && l.anim) ws!.showAnim(l.anim.global, l.anim.slot);
      else ws!.open(l.tab);
    } else {
      if (l.level !== app.level.number) app.openLevel(l.level);
      const m = l.mode;
      if (m && m !== app.model.mode && (m !== 'l2' || app.level.layer2Objects) && (m !== 'bg' || app.canEditBg())) app.setMode(m);
      if (l.cx !== undefined && l.cy !== undefined) {
        // after the level image is laid out
        await new Promise((r) => requestAnimationFrame(r));
        view.scrollToTile(l.cx, l.cy);
      }
    }
    return true;
  };
  const updateNav = () => {
    backBtn.disabled = !nav?.canBack;
    fwdBtn.disabled = !nav?.canForward;
  };
  app.on('level', () => nav?.mark());
  // the desktop app has no browser that does it
  if (desktop) {
    window.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || document.querySelector('.modal-back')) return;
      if (fieldTakesKey(e)) return;
      if (workspace === 'level' && app.model.selection.size) return; // resizes the selection
      if (e.key === 'ArrowLeft') { e.preventDefault(); history.back(); } else if (e.key === 'ArrowRight') { e.preventDefault(); history.forward(); }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3) { e.preventDefault(); history.back(); } else if (e.button === 4) { e.preventDefault(); history.forward(); }
    });
  }
  app.on('open-map16', () => setWorkspace('gfx', { tab: 'map16', tile: app.wsTile, target: app.wsTarget, at: app.wsAt }));
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
    void setWorkspace('gfx', { tab: 'gfx' }).then((ok) => { if (ok) void ws!.gfx.importNew(job.file, job.into ?? undefined); });
  });

  installStepFields();
  window.onkeydown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'f' || e.code === 'Space') && !e.altKey && !document.querySelector('.modal-back')) { e.preventDefault(); search(); return; }
    if (fieldTakesKey(e)) return;
    if (document.querySelector('.modal-back')) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === 'F1' || k === '?') { e.preventDefault(); showHelp(); return; }
    if (k === 'o' || k === 'O') { setWorkspace(workspace === 'ow' ? 'level' : 'ow'); return; }
    if ((k === 'l' || k === 'L') && !ctrl && !e.altKey) { logBar.toggle(); return; }
    // one undo history in every workspace
    if (ctrl && k.toLowerCase() === 's') { e.preventDefault(); app.saveLevel(); return; }
    if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) app.redo(); else app.undo(); return; }
    if (ctrl && k.toLowerCase() === 'y') { e.preventDefault(); app.redo(); return; }
    if (workspace === 'gfx' && ws) {
      if (ws.key(e)) { e.preventDefault(); return; }
      if (k === 'Escape') setWorkspace('level');
      return;
    }
    if (workspace === 'game') {
      if (game?.key(e)) { e.preventDefault(); return; }
      if (k === 'Escape') void setWorkspace('level');
      return;
    }
    if (workspace === 'ow') {
      if (owShown()?.key(e)) e.preventDefault();
      else if ((k === 't' || k === 'T') && !ctrl && !e.altKey && !e.shiftKey && owShown()) testOverworld();
      else if (k === 'Escape') void setWorkspace('level');
      return;
    }
    if (ctrl && k.toLowerCase() === 'c') { app.model.copy(); return; }
    if (ctrl && k.toLowerCase() === 'v') { const hv = view.hover; if (hv) app.paste(hv.tx, hv.ty); return; }
    if (ctrl && k.toLowerCase() === 'd') { e.preventDefault(); app.duplicateSelection(); return; }
    if (ctrl && k.toLowerCase() === 'a') { e.preventDefault(); app.model.selectAll(); return; }
    if (picker.key(e)) { e.preventDefault(); return; }
    if (k === 'Delete' || k === 'Backspace') { app.model.deleteSelection(); return; }
    // Esc: a drag cancelled, else the selection cleared, else the picked item
    if (k === 'Escape') {
      if (view.cancelDrag()) return;
      if (!app.model.clearSelection()) app.clearPickedItem();
      return;
    }
    if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) { e.preventDefault(); view.keyMenu(); return; }
    if (k === '1') app.setMode('l1');
    else if (k === '2') app.setMode('l2');
    else if (k === '3') app.setMode('spr');
    else if (k === '4') app.setMode('exit');
    else if (k === '5') app.setMode('bg');
    else if (k === '6') app.setMode('l3');
    else if (k === 'h' || k === 'H') openHeaderDialog(app);
    else if ((k === 't' || k === 'T') && e.shiftKey) testHere();
    else if (k === 't' || k === 'T') openTestPlay(app);
    else if (k === 'Insert' || k === 'i' || k === 'I') { e.preventDefault(); insertHere(); }
    else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      if (!app.model.selection.size) return;
      e.preventDefault();
      const dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0;
      if (e.altKey) app.resizeSelection(e.shiftKey ? -dx : dx, e.shiftKey ? -dy : dy, e.shiftKey); // (Shift: the left/top edges)
      else app.model.moveSelection(dx, dy);
    } else if (k === '+' || k === '=') app.resizeSelection(1, 0);
    else if (k === '-' || k === '_') app.resizeSelection(-1, 0);
    else if (k === '*') app.resizeSelection(0, 1);
    else if (k === '/') app.resizeSelection(0, -1);
    else if (k === 'PageUp') app.model.reorderSelection('front');
    else if (k === 'PageDown') app.model.reorderSelection('back');
    else if (k === 'g' || k === 'G') { app.view.show.grid = !app.view.show.grid; view.paint(); }
    else if (k === 'c' || k === 'C') { app.view.show.collision = !app.view.show.collision; view.paint(); }
    else if ((k === 'v' || k === 'V') && e.shiftKey) view.placeGameViewByMario();
    else if (k === 'v' || k === 'V') { app.view.show.gameView = !app.view.show.gameView; app.updateGameViewCamera(); view.paint(); }
    else if ((k === 'j' || k === 'J') && e.shiftKey) view.toggleArcPin();
    else if (k === 'j' || k === 'J') { app.view.show.arcs = !app.view.show.arcs; if (!app.view.show.arcs) view.arcPin = null; view.paint(); }
    else if (k === 'm' || k === 'M') setWorkspace('gfx', { tab: 'map16', tile: view.hover ? hoverTile(app, view.hover.tx, view.hover.ty) : undefined });
    else if (k === 'p' || k === 'P') setWorkspace('gfx', { tab: 'pal' });
    else if (k === 'a' || k === 'A') setWorkspace('gfx', { tab: 'anim' });
  };
  window.onbeforeunload = (e) => { if (app.dirty) { e.preventDefault(); } };
  guardClose(() => app.dirty);
  updateToolbar();
  levels.build();
  return {
    // the first place: from a reload, else the level opened at the start
    async start(at) {
      if (at) await restore(at);
      nav = new NavHistory(capture, restore, () => !!document.querySelector('.modal-back'));
      nav.onChange = updateNav;
      updateNav();
    },
  };
}

function hoverTile(app: App, tx: number, ty: number): number {
  return Math.max(0, app.query.tileAt(tx, ty));
}

// the playable ROM: without the editor data (sources of patches, packages, UberASM/blocks/sprites/music)
async function exportRom(app: App): Promise<void> {
  if (app.dirty) app.saveLevel(true);
  const withHeader = app.rom.smcHeader !== null;
  const out = app.rom.output(withHeader);
  const base = app.romName.replace(/\.(smc|sfc|bin|smwproj)$/i, '');
  if (!await downloadBytes(`${base}.${withHeader ? 'smc' : 'sfc'}`, out)) return;
  log(`ROM exported as “${base}.${withHeader ? 'smc' : 'sfc'}” (${Math.round(out.length / 1024)} KB)`);
  if (app.rom.extra.size) toast('The playable ROM holds no sources of patches, packages and projects – to keep editing elsewhere, use “Save project”.');
}

// ROM plus editor data, to open again in the editor
// BPS patch from a clean ROM (headerless on both sides, as Flips expects for SMW)
async function exportPatch(app: App): Promise<void> {
  const f = await pickFile('.smc,.sfc,.bin');
  if (!f) return;
  let source: Uint8Array;
  try { source = Rom.fromFile(new Uint8Array(await f.arrayBuffer())).output(false); } catch (e) { toast(`Could not open “${f.name}”: ${e instanceof Error ? e.message : e}`, 'error'); return; }
  if (crc32(source) !== SMW_CLEAN_CRC) toast(`“${f.name}” is not a clean Super Mario World (U) ROM – the patch only applies to exactly this file.`, 'error');
  if (app.dirty) app.saveLevel(true);
  const target = app.rom.output(false);
  const patch = createBps(source, target);
  const base = app.romName.replace(/\.(smc|sfc|bin|smwproj)$/i, '');
  if (await downloadBytes(`${base}.bps`, patch)) log(`Patch exported as “${base}.bps” (${Math.max(1, Math.round(patch.length / 1024))} KB, from “${f.name}”)`);
}
// forgets everything stored in the browser and starts over (reloading drops all state of the session)
async function closeProject(app: App): Promise<void> {
  const r = await choose('Close project', `“${app.romName}” and all editor data (sources, caches, imported manuals) are removed from the browser. Changes not saved with “Save project” or “Export ROM” are lost.`,
    [{ label: 'Cancel' }, { label: 'Close project', danger: true }]);
  if (r !== 1) return;
  app.close();
  window.onbeforeunload = null;
  guardClose(() => false);
  try { await kvClear(); } catch (e) { toast(`Could not clear the browser storage: ${e instanceof Error ? e.message : e}`, 'error'); return; }
  try { localStorage.clear(); } catch { /* no storage */ }
  location.replace(location.pathname);
}
async function exportProject(app: App, askWhere = false): Promise<void> {
  if (app.dirty) app.saveLevel(true);
  const out = app.rom.outputProject(app.rom.smcHeader !== null);
  const base = app.romName.replace(/\.(smc|sfc|bin|smwproj)$/i, '');
  const res = await saveFile(`${base}.smwproj`, out, { path: askWhere ? undefined : projectPath ?? undefined });
  if (!res) return;
  if (res.path) {
    setProjectPath(res.path);
    // saved under another name: the project is called so from now on
    const name = fileName(res.path);
    if (name !== app.romName) { app.romName = name; saveRom(name, app.rom).catch(() => {}); }
  }
  log(`Project saved as “${res.path ?? `${base}.smwproj`}” (${Math.round(out.length / 1024)} KB, of which ${Math.round(app.rom.extraSize / 1024)} KB editor data)`);
}

function showHelp(): void {
  const sections: [string, [string, string][]][] = [
    ['General', [
      ['Ctrl+S', 'Save the level'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
      ['Alt+← / Alt+→ · mouse back/forward buttons', 'Back / forward through the places opened (workspace, level, overworld map, graphics tab, Ctrl+click jumps)'],
      ['Esc / O / M · P · A', 'Workspace level / overworld / graphics (Map16, palettes, animations)'],
      ['Ctrl+mouse wheel · Middle mouse button drag', 'Zoom · Pan view'],
      ['Ctrl+F · Ctrl+Space', 'Search everywhere: objects, Map16 tiles, prefabs, sprites (Tab: only one group)'],
      ['? / F1', 'This overview'],
      ['L', 'Expand/collapse log (all messages with time)'],
      ['Menus: ↑ ↓ ← → / Enter / Esc', 'Choose entry, neighboring menu / run / close'],
    ]],
    ['Level', [
      ['1 / 2 / 3 / 4 / 5', 'Mode layer 1 / layer 2 / sprites / entrances/exits / BG'],
      ['Click · Ctrl+click · Alt+click', 'Select · add to selection · element underneath'],
      ['Drag', 'Move selection / drag a selection box'],
      ['Drag a handle on an edge or corner', 'Resize objects (all selected; the opposite edges stay)'],
      ['Right click / Shift+click', 'Place the element chosen in “Insert” (View → Placement preview shows it at the mouse) or a copy of the selection'],
      ['Right click on the selection or with nothing chosen · Menu key / Shift+F10', 'Context menu'],
      ['Click into nothing', 'Deselect all and clear the element chosen in “Insert”'],
      ['BG: click/drag · right click/Shift+click', 'Pick up tile(s) as brush · paint'],
      ['Ctrl+click on a Map16/BG tile in “Insert”', 'Go to definition: the tile in the Map16 tab of the graphics area'],
      ['Ins / I', 'Insert object/sprite by number (at the mouse)'],
      ['Drag M / Z / S marker', 'Move main entrance / midway point / secondary entrance'],
      ['Entrances/Exits: click · right click', 'Choose entrance or screen (exit), edit on the right · new secondary entrance, create exit, entrance here'],
      ['Arrow keys · Alt+arrow keys · Alt+Shift+arrow keys', 'Move selection by 1 tile · resize on the right/bottom · on the left/top'],
      ['+ / - · * / /', 'Change width · change height'],
      ['Del / Backspace', 'Delete selection'],
      ['F2 · Del over an object or prefab in “Insert”', 'Rename it · delete the prefab'],
      ['Ctrl+A · Esc', 'Select all · cancel dragging, deselect, then clear the element chosen in “Insert”'],
      ['Ctrl+C / Ctrl+V / Ctrl+D', 'Copy / paste at the mouse / duplicate'],
      ['PgUp / PgDn', 'Bring to front / send to back (drawing order)'],
      ['H · G · C', 'Level header · grid on/off · collision overlay on/off'],
      ['V · Shift+V · drag its edge', 'Game view frame on/off · placed by Mario at the mouse (the camera the game puts there) · move it'],
      ['T · Shift+T', 'Test level · Mario starts at the mouse'],
      ['J · Shift+J', 'Jump arcs at the mouse on/off · pin them to the tile / unpin'],
    ]],
    ['Overworld', [
      ['1 / 2 / 3 / 4 / 5', 'Layer 1 (paths) / layer 2 (terrain) / Levels / Overworld links / Sprites'],
      ['Levels: drag · Del · right click', 'Move a level tile (swaps with the tile there) · a stop tile in its place · Place level here…'],
      ['Click/drag · right click/Shift+click', 'Pick up tile(s) as brush · paint'],
      ['Alt+click / Ctrl+click', 'Level info of the level tile'],
      ['G', 'Grid on/off'],
      ['M', 'Edit the selected tile\'s 8x8 tiles in the Map16 tab (target Overworld)'],
      [', / .', 'Event progress: one event back / further'],
      ['Q (held)', 'While layer 1 or 2 is painted: the other layer hidden (else dimmed, View → Layers)'],
      ['T', 'Test play from the overworld: a new game at the event progress, Mario on the selected tile (or at the start position)'],
    ]],
    ['Graphics', [
      ['P / M / G / A', 'Tab palettes / Map16 tiles / graphics / animations; Esc back to the level'],
      ['Ctrl+C / Ctrl+V', 'Copy / paste palette, Map16 tiles or pixels'],
      ['Ctrl+click', 'Go to definition: an animated tile or color opens its own animation, a Map16 quarter its 8x8 tile, a palette button its palette'],
      ['Palettes: arrow keys · Shift+click', 'Other color · mark a range (for “Gradient”)'],
      ['Map16: X / Y / 1–8 / Q', 'Flip quarter / palette 0–7 / next quarter; arrows: other tile'],
      ['Map16: F2', 'Name the selected tiles (to find them by later)'],
      ['Map16: double click · Ctrl+click on palette', 'Edit quarter in “Graphics” · open palette in “Palettes”'],
      ['Graphics sheet: click/drag · right click/Shift+click', 'Pick 8x8 tiles for the pixel editor · paste them at the mouse'],
      ['Pixel editor: S / B / E / F / I', 'Selection / pencil / eraser / fill / eyedropper'],
      ['Pixel editor: left · right button', 'Paint with the left color · the right color'],
      ['Pixel editor: Alt+click · Shift+click', 'Pick the color for that button · line from the last point'],
      ['Pixel editor: 0–9 · X', 'Left color · swap left and right color'],
      ['Pixel editor: Enter / Esc', 'Put the floating selection down / cancel it (or deselect)'],
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
      if (await startWith(Rom.fromFile(data), q.split('/').pop() ?? 'rom.smc')) return;
    }
  }
  try {
    const saved = await kvGet<RomRecord>('rom');
    if (saved?.data) {
      if (desktop) projectPath = (await kvGet<string>('projectPath')) ?? null;
      if (await startWith(romFromRecord(saved), saved.name)) return;
    }
  } catch (e) {
    console.warn(e);
  }
  welcome();
})();
