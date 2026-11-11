import { Rom } from './core/rom.ts';
import { openLevelImport } from './ui/levelimport.ts';
import { createBps, crc32 } from './core/bps.ts';
import { prepareRom } from './core/editorpatches.ts';
import { SMW_CLEAN_CRC } from './core/cleangame.ts';
import { App, type EditMode } from './ui/app.ts';
import { h, clear, toast, log, modal, choose, zoomControl, fieldTakesKey, installStepFields, keepAriaStates, setDialogUndo, gotoAt } from './ui/dom.ts';
import { downloadBytes, pickFile, saveFile, filePath, fileName, desktop, guardClose } from './ui/platform.ts';
import { LogBar } from './ui/logbar.ts';
import { pasteHintBox } from './ui/pastehint.ts';
import { kvGet, kvSet, kvDel, kvClear, saveRom, romFromRecord, type RomRecord } from './ui/storage.ts';
import { LevelView } from './ui/levelview.ts';
import { exportLevelPng, openLevelImages } from './ui/levelimages.ts';
import { LevelList, Picker, Properties } from './ui/panels.ts';
import { sideSplitter } from './ui/pickerview.ts';
import { openSearch, matchesAll, type SearchProvider, type SearchResult } from './ui/search.ts';
import { onBehaviorProgress } from './ui/tilebehaviors.ts';
import { openHeaderDialog } from './ui/headerdialog.ts';
import { hex } from './core/names.ts';
import { GfxWorkspace, type WsTab, type WsTarget } from './ui/gfxworkspace.ts';
import type { Map16Target } from './ui/gfx/target.ts';
import { openRemapUses } from './ui/tileuses.ts';
import { openEntrancesDialog, openRomInfo, openInsertDialog, openExpandDialog, openSaveAsDialog, exportLevel, importLevel, importOverworldFrom, openScreenDialog, clearLevelConfirm } from './ui/tools.ts';
import { menuBar, closeMenus, type Menu } from './ui/menu.ts';
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
import { clearPrefs } from './ui/prefs.ts';
import { icon, iconLabel } from './ui/icons.ts';
import { THEMES, themePref } from './ui/theme.ts';
import type { IconName } from './ui/icons.ts';
import { railButton, toolRail } from './ui/rail.ts';
import { shortcutSections } from './ui/shortcuts.ts';

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
  // a clean ROM gets the editor's patches, an editor ROM's older VRAM patch is updated; anything but the clean game
  // and the editor's own ROMs is refused
  try {
    const done = await prepareRom(rom);
    if (done?.failed) toast(done.note, 'error');
    else if (done) { saveRom(name, rom).catch(() => {}); log(done.note); }
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
  const messagePanel = new MessagePanel(app);
  app.on('properties', () => {
    if (app.messages) app.closeMessages();
    showLevelTab('props');
    props.root.scrollIntoView({ block: 'nearest' });
    props.root.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
  });

  let workspace: 'level' | 'ow' | 'gfx' | 'game' = 'level';
  // the picker is shown in the level editor unless the message panel takes its place (it prefetches only then)
  // the level's side panel (ADR 0015, #478): tabs Picker | Properties – a selection shows its properties, picking
  // something to place the picker; the message panel is the Properties tab's content while it is open
  let levelTab: 'picker' | 'props' = 'picker';
  const levelTabs = h('div', { class: 'tabbar side-tabs', role: 'tablist' });
  const propsHost = h('div', { class: 'side-props' });
  const updatePickerShown = () => picker.setShown(workspace === 'level' && levelTab === 'picker');
  const renderLevelSide = () => {
    const tab = (t: typeof levelTab, label: string, title: string) => h('button', { class: levelTab === t ? 'active' : '', title, onclick: () => showLevelTab(t) }, label);
    levelTabs.replaceChildren(
      tab('picker', 'Picker', 'What to place: objects, Map16 tiles, sprites (right click/Shift+click places it)'),
      tab('props', 'Properties', app.messages ? 'The level\'s message boxes' : 'The settings of what is selected'));
    picker.root.hidden = levelTab !== 'picker';
    propsHost.hidden = levelTab !== 'props';
    const content = app.messages ? messagePanel.root : props.root;
    if (propsHost.firstChild !== content) propsHost.replaceChildren(content);
    updatePickerShown();
  };
  function showLevelTab(t: typeof levelTab): void {
    if (levelTab === t) return;
    levelTab = t;
    renderLevelSide();
  }
  let selectedBefore = 0;
  app.on('change', () => {
    const n = app.model.selection.size;
    if (n && !selectedBefore) showLevelTab('props');
    else if (!n && selectedBefore && !app.messages) showLevelTab('picker');
    selectedBefore = n;
  });
  app.on('picked-item', () => showLevelTab('picker'));
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
  // the edit modes in the tool rail at the level's left edge (#477)
  const modeBtn = (m: EditMode, label: string, key: string, ic: IconName) => railButton({ label, key, icon: ic, className: 'mode', data: { mode: m }, onClick: () => app.setMode(m) });
  const modes = toolRail('Edit mode');
  modes.append(modeBtn('l1', 'Layer 1', '1', 'layer-1'), modeBtn('l2', 'Layer 2', '2', 'layer-2'), modeBtn('spr', 'Sprites', '3', 'sprites'),
    modeBtn('exit', 'Entrances/Exits', '4', 'exits'), modeBtn('bg', 'BG', '5', 'bg'), modeBtn('l3', 'Layer 3', '6', 'layer-3'));
  const levelTitle = h('span', { class: 'level-title' });
  const unsavedPill = h('span', { class: 'pill pill-info', title: 'The level\'s changes are written to the ROM with Save level (Ctrl+S)', hidden: true }, 'Unsaved changes');
  const zoomCtl = zoomControl(() => app.view.zoom, (z) => view.setZoom(z));
  const levelBar = h('div', { class: 'ctxbar' },
    levelTitle, unsavedPill,
    h('button', { onclick: () => openHeaderDialog(app), title: 'Level header (H)' }, 'Header …'),
    h('span', { class: 'sep' }),
    viewMenu(app, () => view.paint()),
    h('span', { class: 'sep' }),
    zoomCtl.root,
  );

  // ---- app bar: menus, workspace switcher, main actions
  const testHere = () => { const hv = view.hover; openTestPlay(app, hv ? { tx: hv.tx, ty: hv.ty } : undefined); };
  // central search (Ctrl+F or Ctrl+Space): a result is shown in the level workspace
  // the command palette (#483): commands – every menu entry with its key, the places of G … – and the picker's
  // groups; a picker result is shown in the level workspace
  const commands = (): SearchProvider => ({
    id: 'commands', label: 'Commands',
    search: (terms) => {
      const out: SearchResult[] = [];
      const add = (where: string, name: string, keys: string | undefined, run: () => void, title?: string) => {
        if (matchesAll(`${where} ${name} ${keys ?? ''}`.toLowerCase(), terms)) out.push({ label: keys ?? '', name, detail: where, title, pick: run });
      };
      for (const m of menuDefs) {
        if (m.disabled?.()) continue;
        let heading = '';
        for (const it of typeof m.items === 'function' ? m.items() : m.items) {
          if (it === 'sep') continue;
          if ('heading' in it) { heading = it.heading; continue; }
          if (it.disabled?.()) continue;
          const where = heading ? `${m.label} → ${heading}` : m.label;
          if ('onClick' in it) add(where, it.label.replace(/ …$/, ''), it.shortcut, it.onClick, it.title);
          else add(where, `${it.label}${it.checked() ? ' (on)' : ''}`, it.shortcut, () => void it.onToggle(!it.checked()), it.title);
        }
      }
      for (const [k, w, name] of [['G 1', 'level', 'Level'], ['G 2', 'ow', 'Overworld'], ['G 3', 'gfx', 'Graphics'], ['G 4', 'game', 'Game']] as const) add('Go to', `${name} workspace`, k, () => void setWorkspace(w));
      for (const [k, t, name] of [['G P', 'pal', 'Palettes'], ['G M', 'map16', 'Map16 tiles'], ['G G', 'gfx', 'Graphics'], ['G A', 'anim', 'Animations']] as const) add('Go to', `Graphics: ${name}`, k, () => void setWorkspace('gfx', { tab: t }));
      add('View', 'Grid on/off', "Ctrl+'", toggleGrid);
      add('View', 'Problems', 'L', () => logBar.showProblems());
      return out;
    },
  });
  const search = () => openSearch([commands(), ...picker.searchProviders().map((p) => ({
    ...p, search: (terms: string[]) => p.search(terms).map((r) => ({ ...r, pick: () => void setWorkspace('level').then((ok) => { if (ok) r.pick(); }) })),
  }))], { refresh: (again) => onBehaviorProgress(app, again) }); // (tiles' behavior determined)
  const insertHere = () => { const hv = view.hover, c = view.centerTile(); openInsertDialog(app, hv ? hv.tx : c.tx, hv ? hv.ty : c.ty); };
  const menuDefs: Menu[] = [
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
    { label: 'View', items: [
      { heading: 'Theme' },
      ...THEMES.map((t) => ({ label: t.label, title: t.title, checked: () => themePref.get() === t.id, onToggle: () => { themePref.set(t.id); closeMenus(); } })),
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
    // (owShown is defined further down: the menu bar asks disabled() while built)
    { label: 'Overworld', disabled: () => workspace !== 'ow' || !!owLocked, items: [
      { label: 'Overworld options …', title: 'The settings of the whole overworld: the game\'s overworld options (Lunar Magic\'s Extra Options)', onClick: () => ow?.openOptions() },
      { label: 'Reveal list …', title: 'What a tile becomes when an event reveals it (Lunar Magic\'s Edit Reveal Tile List)', onClick: () => ow?.openOptions('reveals') },
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
      { label: 'Problems and log', shortcut: 'L', title: 'Open or close the bottom panel', onClick: () => logBar.toggle() },
    ] },
  ];
  const menus = menuBar(menuDefs);
  const wsBtn = (w: typeof workspace, label: string, key: string) => h('button', { 'data-ws': w, title: key ? `${label} (${key})` : label, onclick: () => setWorkspace(w) }, label);
  const wsSwitch = h('div', { class: 'btn-group ws-switch' }, wsBtn('level', 'Level', 'G 1'), wsBtn('ow', 'Overworld', 'G 2'), wsBtn('gfx', 'Graphics', 'G 3'), wsBtn('game', 'Game', 'G 4'));
  const backBtn = h('button', { onclick: () => history.back(), title: 'Back to the place before (Alt+←, mouse back button)', 'aria-label': 'Back', disabled: true }, icon('back'));
  const fwdBtn = h('button', { onclick: () => history.forward(), title: 'Forward (Alt+→, mouse forward button)', 'aria-label': 'Forward', disabled: true }, icon('forward'));
  const undoBtn = h('button', { onclick: () => app.undo(), title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo' }, icon('undo'));
  const redoBtn = h('button', { onclick: () => app.redo(), title: 'Redo (Ctrl+Y)', 'aria-label': 'Redo' }, icon('redo'));
  const saveBtn = h('button', { class: 'primary', onclick: () => app.saveLevel(), title: 'Write level to ROM (Ctrl+S)' });
  const testLevelTitle = 'Test the level in the built-in emulator (T, Shift+T: from the mouse position)';
  const testBtn = h('button', { onclick: () => (workspace === 'ow' ? testOverworld() : openTestPlay(app)), title: testLevelTitle }, iconLabel('play', 'Test'));
  // loops the open level's music while editing; anything else that plays (test play, a song in a dialog) ends it
  const musicTitle = 'Play the level\'s music in a loop while editing';
  let musicOf = ''; // level and header music playing
  const playLevelMusic = () => {
    musicOf = `${app.level.number}:${app.level.header.music}`;
    void musicPlayer.playLevel(app, app.level.number, LEVEL_MUSIC).then(() => {
      if (musicPlayer.error) toast(`Could not play: ${musicPlayer.error}`, 'error');
    });
  };
  const musicBtn = h('button', { title: musicTitle, 'aria-label': 'Level music', onclick: () => { if (musicPlayer.label === LEVEL_MUSIC) musicPlayer.stop(); else playLevelMusic(); } }, icon('music'));
  musicPlayer.onChange((l) => musicBtn.classList.toggle('active', l === LEVEL_MUSIC));
  // another level or other header music: its music
  const followLevel = () => { if (musicPlayer.label === LEVEL_MUSIC && musicOf !== `${app.level.number}:${app.level.header.music}`) playLevelMusic(); };
  app.on('level', followLevel);
  app.on('level-header', followLevel);
  const searchBtn = h('button', { class: 'appbar-search', onclick: () => search(), title: 'Search everywhere and run commands (Ctrl+K, Ctrl+F, Ctrl+Space)' },
    iconLabel('search', 'Search or run …'), h('kbd', null, 'Ctrl K'));
  // where the changes go (#476): the level's wait for Save level, the other workspaces' are in the ROM at once
  const savedPill = h('span', { class: 'pill pill-ok', title: 'The overworld\'s, graphics\' and game\'s changes are ROM edits: written at once (Ctrl+Z undoes)' }, 'Saved to ROM');
  const appbar = h('header', { class: 'appbar' },
    // three columns, so nothing moves when the buttons on the right change their labels with the workspace
    h('div', { class: 'appbar-l' }, h('span', { class: 'brand' }, 'Solar Magic'), menus, h('div', { class: 'appbar-nav' }, backBtn, fwdBtn)),
    wsSwitch,
    h('div', { class: 'appbar-r' }, searchBtn, h('div', { class: 'appbar-nav' }, undoBtn, redoBtn), musicBtn, testBtn, saveBtn, savedPill),
  );

  const updateToolbar = () => {
    for (const b of modes.querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === app.model.mode);
    const btnL2 = modes.querySelector('[data-mode="l2"]') as HTMLButtonElement;
    btnL2.disabled = !app.level?.layer2Objects;
    (modes.querySelector('[data-mode="bg"]') as HTMLButtonElement).disabled = !app.level || !app.canEditBg();
    if (app.level) levelTitle.textContent = `Level ${hex(app.level.number, 3)}`;
    unsavedPill.hidden = !app.dirty;
    zoomCtl.update();
    for (const b of wsSwitch.querySelectorAll('button')) b.classList.toggle('active', b.dataset.ws === workspace);
    saveBtn.replaceChildren(...iconLabel('save', 'Save level'));
    saveBtn.disabled = !app.dirty && !romOnly();
    // (the overworld's and game's changes are ROM edits: nothing to save)
    saveBtn.hidden = romOnly();
    savedPill.hidden = !romOnly();
    testBtn.disabled = (workspace === 'ow' && !owShown()) || workspace === 'game';
    testBtn.title = workspace === 'game' ? 'Test play is available in the level and overworld workspaces'
      : workspace !== 'ow' ? testLevelTitle
      : owShown() ? 'Play the game from the overworld in the built-in emulator (T): a new game with the events checked in the event list passed, Mario on the selected tile (without one at the start position)'
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
  const center = h('div', { class: 'center with-rail' }, modes, h('div', { class: 'center-main' }, view.root, status));
  const right = h('div', { class: 'right' }, levelTabs, picker.root, propsHost);
  renderLevelSide();
  const logBar = new LogBar();
  const busy = busyIndicator(app);
  const pasteHint = pasteHintBox(app);
  const layout = h('div', { class: 'layout' });
  const split = sideSplitter(layout);
  layout.append(appbar, levelBar, left, center, right, split.root, logBar.root, busy, pasteHint);
  logBar.setProblems(view.problems.list, () => view.problems.count());
  split.use('level');
  root.append(layout);
  const owRight = h('div', { class: 'right' });
  const showLayout = (bar: HTMLElement, l: HTMLElement, main: HTMLElement, side: HTMLElement) => {
    layout.replaceChildren(appbar, bar, l, main, side, split.root, logBar.root, busy, pasteHint);
    // the bottom panel's Problems: the level's problems, the overworld's World check (#479)
    if (main === center) logBar.setProblems(view.problems.list, () => view.problems.count());
    else if (ow && main === ow.root) logBar.setProblems(ow.check.root, () => ow!.check.count());
    else logBar.setProblems(null);
  };

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
    if (from === 'ow') { app.overworldLeft(); app.refresh(); }
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
    updatePickerShown();
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
        ow.onTestPlay = () => testOverworld();
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
  // test play from the overworld: the selected tile, exactly the events checked in the event list with the save learned
  // for them (once it is; a new file's when it can't be); a moment of the meters is shown in the level editor
  const testOverworld = () => {
    const o = owShown();
    if (o) openOverworldTestPlay(app, o.selected, o.checked, app.progressSave(o.checked), (n, at) => void setWorkspace('level').then((ok) => { if (ok) app.showUse(n, at); }));
  };

  app.gotoOverworldTile = async (i) => { if (await setWorkspace('ow')) owShown()?.showTile(i); };

  // the message panel takes the picker's place while it is open
  app.on('messages', () => {
    if (app.messages) {
      if (workspace !== 'level') void setWorkspace('level');
      const opened = messagePanel.root.parentElement !== propsHost;
      levelTab = 'props';
      renderLevelSide();
      if (opened) messagePanel.focus();
    } else renderLevelSide();
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
  keepAriaStates(document.body);
  setDialogUndo(() => app.undo(), () => app.redo());
  const mouseAt = { x: -1, y: -1 }; // (the last mouse position: F12 and the keyboard's context menu act there)
  // the context menu from the keyboard everywhere (#480): Menu key or Shift+F10 opens the one of the focused control,
  // else (the level's canvas has its own: the selection's or the mouse tile's) of what is under the mouse
  {
    window.addEventListener('mousemove', (e) => { mouseAt.x = e.clientX; mouseAt.y = e.clientY; }, { passive: true });
    const mx = () => mouseAt.x, my = () => mouseAt.y;
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
      const f = document.activeElement as HTMLElement | null;
      const focused = f && f !== document.body && !f.matches('.level-scroller, canvas') ? f : null;
      if (!focused && workspace === 'level' && !document.querySelector('.modal-back')) return; // (the level view's keyMenu)
      const r = focused?.getBoundingClientRect();
      const x = r ? r.left + Math.min(r.width / 2, 24) : mx(), y = r ? r.top + r.height / 2 : my();
      const at = focused ?? (x >= 0 ? document.elementFromPoint(x, y) : null);
      if (!at) return;
      e.preventDefault();
      e.stopPropagation();
      at.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
    }, true);
  }
  // G then a key within a second goes to a place (#482): G 1 … G 5 the workspaces, G P / G M / G G / G A the Graphics
  // views; "G …" shown meanwhile
  let goSince = 0;
  const goHint = h('div', { class: 'key-pending', hidden: true }, h('kbd', null, 'G'), ' … 1 Level · 2 Overworld · 3 Graphics · 4 Game · P / M / G / A Graphics views');
  document.body.append(goHint);
  const goEnd = () => { goSince = 0; goHint.hidden = true; };
  const GO_WS: Record<string, 'level' | 'ow' | 'gfx' | 'game'> = { 1: 'level', 2: 'ow', 3: 'gfx', 4: 'game' };
  const GO_TAB: Record<string, WsTab> = { p: 'pal', m: 'map16', g: 'gfx', a: 'anim' };
  const goKey = (e: KeyboardEvent): boolean => {
    if (e.ctrlKey || e.metaKey || e.altKey) { goEnd(); return false; }
    const k = e.key.toLowerCase();
    if (goSince && performance.now() - goSince < 1000) {
      goEnd();
      if (GO_WS[k]) void setWorkspace(GO_WS[k]);
      else if (GO_TAB[k]) void setWorkspace('gfx', { tab: GO_TAB[k] });
      else if (k === '5') toast('The Packages workspace follows – until then: ROM → Packages …');
      return true;
    }
    goEnd();
    if (k !== 'g' || e.shiftKey) return false;
    goSince = performance.now();
    goHint.hidden = false;
    setTimeout(() => { if (goSince && performance.now() - goSince >= 990) goEnd(); }, 1000);
    return true;
  };
  // the grid of the workspace shown (Ctrl+', #482)
  const toggleGrid = () => {
    if (workspace === 'level') { app.view.show.grid = !app.view.show.grid; view.paint(); }
    else if (workspace === 'ow') owShown()?.toggleGrid();
  };
  window.onkeydown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'k' || e.code === 'Space') && !e.altKey && !document.querySelector('.modal-back')) { e.preventDefault(); search(); return; }
    if (fieldTakesKey(e)) return;
    if (document.querySelector('.modal-back')) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    // G then a key: a place (#482)
    if (goKey(e)) { e.preventDefault(); return; }
    if (k === 'F1' || k === '?') { e.preventDefault(); showHelp(); return; }
    if (k === 'F12') { e.preventDefault(); if (mouseAt.x >= 0) gotoAt(mouseAt.x, mouseAt.y); return; }
    if (ctrl && (k === "'" || e.code === 'Backslash' && e.shiftKey)) { e.preventDefault(); toggleGrid(); return; }
    if ((k === 'l' || k === 'L') && !ctrl && !e.altKey) { logBar.toggle(); return; }
    // one undo history in every workspace
    if (ctrl && k.toLowerCase() === 's') { e.preventDefault(); app.saveLevel(); return; }
    if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) app.redo(); else app.undo(); return; }
    if (ctrl && k.toLowerCase() === 'y') { e.preventDefault(); app.redo(); return; }
    if (workspace === 'gfx' && ws) {
      if (ws.key(e)) e.preventDefault();
      return;
    }
    if (workspace === 'game') {
      if (game?.key(e)) e.preventDefault();
      return;
    }
    if (workspace === 'ow') {
      if (owShown()?.key(e)) e.preventDefault();
      else if ((k === 't' || k === 'T') && !ctrl && !e.altKey && !e.shiftKey && owShown()) testOverworld();
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
    else if (k === 'c' || k === 'C') { app.view.show.collision = !app.view.show.collision; view.paint(); }
    else if ((k === 'v' || k === 'V') && e.shiftKey) view.placeGameViewByMario();
    else if (k === 'v' || k === 'V') { app.view.show.gameView = !app.view.show.gameView; app.updateGameViewCamera(); view.paint(); }
    else if ((k === 'j' || k === 'J') && e.shiftKey) view.toggleArcPin();
    else if (k === 'j' || k === 'J') { app.view.show.arcs = !app.view.show.arcs; if (!app.view.show.arcs) view.arcPin = null; view.paint(); }
    else if (k === 'm' || k === 'M') setWorkspace('gfx', { tab: 'map16', tile: view.hover ? hoverTile(app, view.hover.tx, view.hover.ty) : undefined });
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
  clearPrefs();
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

// the keyboard scheme's table (ui/shortcuts.ts, #482): one source, never stale
function showHelp(): void {
  modal('Keyboard shortcuts', h('div', { class: 'help-cols' }, shortcutSections().map(([title, rows]) => h('section', null,
    h('h3', null, title),
    h('table', { class: 'help' }, rows.map((r) => h('tr', null, h('td', null, h('kbd', null, r.keys)), h('td', null, r.what))))))),
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
