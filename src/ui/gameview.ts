// The Game workspace: the game's screens that belong to no level. Listed are the screens and menus the emulated game
// gets into (pregame.ts: Nintendo Presents, title screen, file select, file erase, player select, the overworld's save
// and game over prompts – one a patch removed is not there), each with its picture as the game draws it, and the
// overworld's borders. Edited so far: the title screen's layer 3 tilemap (titlescreen.ts) and the borders
// (owborder.ts: each map's layer 3 fixed on the screen) and the menus' texts (menutext.ts: the cells of a menu's
// stripe image, in place; the cursor's cells and the cells the game writes over are marked) – painted with layer 3's
// 8x8 tiles as every brush editor paints (brushsurface.ts, ADR 0011); a stroke is one ROM edit when the mouse is
// released. Nintendo Presents has fields beside its picture (presents.ts: what the game reads the logo from). The
// title screen page also has the title screen movement (titlemoves.ts): its timeline under the picture, which is the
// game's at the playhead, played and recorded there. The other screens are pictures; an editor for one of them
// replaces its picture in `showScreen`. "Start of game" (startpage.ts) is no screen: what a new save file starts with –
// the intro, the lives, the start position, the initial level flags – beside the intro's picture.

import type { App } from './app.ts';
import { h, toast, attachPanZoom, zoomControl, hexInput } from './dom.ts';
import { iconLabel } from './icons.ts';
import { LevelEmulator } from '../core/levelemu.ts';
import { TileCache } from '../core/render.ts';
import { TITLE_COLS, TITLE_ROWS, TITLE_SHOWN_ROWS, titleTilemap, writeTitleScreen, type TitlePicture } from '../core/titlescreen.ts';
import type { SnesState } from '../core/snes.ts';
import { MovementView } from './titlemoves.ts';
import { startPage } from './startpage.ts';
import { GAME_SCREENS, gameScreenKind, gameScreens, reachedScreenIds, screenPicture, type GameScreenId, type ReachedScreen, type ScreenPicture } from '../core/pregame.ts';
import { MENU_COLS, MENU_ROWS, menuText, paintMenuCell, paintedOverwritten, writeMenuText, type MenuText } from '../core/menutext.ts';
import { pcToSnes } from '../core/rom.ts';
import { presentsLogo, sharedFields, writePresentsValue, type PresentsValue, type LogoObj } from '../core/presents.ts';
import { htmlOf } from './gfx/palettetab.ts';
import { layer3WordText } from '../core/layer3map.ts';
import { layer3Picker } from './l3picker.ts';
import { fillPixels, hidePickerPreview } from './pickerview.ts';
import type { Brush } from './app.ts';
import { BorderView } from './owborder.ts';
import { MAP_NAMES } from '../core/overworld.ts';
import { BrushSurface, PAINT_HINT, PAINT_TITLE } from './brushsurface.ts';
import { MARK, rgba, onTokensChanged, uiToken } from './marks.ts';

// a screen of the game ('title': the title screen, with its editor), or the border of an overworld map (0 the main
// map, 1–6 the submaps), or the start of a game ('start': what a new save file starts with)
export type GameTab = GameScreenId | 'border' | 'start';
export const START_TAB = { name: 'Start of game', about: 'What a new save file starts with: the intro, the lives, the start position, the initial level flags' };
const GAP = 4; // pixels between the screen and the row below it
const SCROLLER_PAD = 16; // .game-scroller's padding (style.css)
const W = 256, H = TITLE_SHOWN_ROWS * 8 + GAP + 8;

export class GameView {
  root: HTMLDivElement;
  side: HTMLDivElement;
  bar: HTMLDivElement;
  left: HTMLDivElement;
  tab: GameTab = 'title';
  private app: App;
  private border: BorderView;
  private title = h('span', { class: 'level-title' }, 'Title screen');
  private list = h('div', { class: 'level-list' });
  private scroller: HTMLDivElement;
  private emu: LevelEmulator | null = null;
  private saved: Uint16Array | null = null; // the tilemap as in the ROM
  private map: Uint16Array | null = null; // with the stroke being painted
  private pic: TitlePicture | null = null;
  private head: SnesState | null = null; // the machine the title screen's picture is of: at the movement's playhead (null: as booted)
  private moves: MovementView;
  private canvas = h('canvas', { class: 'game-canvas', width: W, height: H });
  private status = h('span', { class: 'status-text' });
  private pickPanel = h('div', { class: 'panel game-pick' });
  private pickPixels = 0; // the screen pixels per pixel the tile sheet is drawn at (0: none shown)
  private error = ''; // why there is no title screen to edit
  private screens: GameScreenId[] = []; // the screens the game gets into (pregame.ts), as of the ROM shown
  private screenCanvas = h('canvas', { class: 'game-canvas game-screen', width: W, height: 224 });
  private screenInfo = h('div', { class: 'panel game-pick' });
  private listTimer = 0;
  // the menu whose text is edited (the tab is its screen): the text as in the ROM, the tilemap with the stroke being
  // painted, the picture with it
  private menu: { id: GameScreenId; screen: ReachedScreen; text: MenuText; map: Uint16Array; pic: ScreenPicture } | null = null;
  private menuCanvas = h('canvas', { class: 'game-canvas', width: W, height: 224 });
  private menuInfo = h('div', { class: 'panel' });
  private menuSurface: BrushSurface;
  private marks = true; // the cursor's cells, the cells the game writes over and the cells that are not the menu's shown
  private frame = 0; // a picture to draw at the next animation frame (painting)
  private zoom = 3;
  private zoomCtl: { root: HTMLElement; update: () => void } | undefined;
  private brush: Brush = { w: 1, h: 1, tiles: [0x38fc] };
  private surface: BrushSurface;

  constructor(app: App) {
    onTokensChanged(() => { this.paint(); if (this.tab !== 'border' && this.tab !== 'title' && !this.menu) this.showOther(); }); // (the backdrop is a UI token: another theme)
    this.app = app;
    this.border = new BorderView(app);
    this.border.setStatus = (t) => { this.status.textContent = t; };
    // the zoom as in every view (#489): whole SNES pixels 1×–6×, shown in percent
    this.zoomCtl = zoomControl(() => this.zoom, (z) => this.setZoom(z), 1, 6, () => [1, 2, 3, 4, 5, 6]);
    this.bar = h('div', { class: 'ctxbar' }, this.title,
      h('span', { class: 'sep' }),
      this.zoomCtl.root,
      h('span', { class: 'sep' }),
      h('button', { title: 'Play the game from power-on (T): Nintendo Presents, the title screen with its movement, file select, player select and – on an empty save file – the intro, as a player sees them. Nothing is skipped.', onclick: () => this.playFromPowerOn() }, iconLabel('play', 'Play from power-on')),
      h('label', { class: 'hint game-play-saves', title: 'The save files the game finds at power-on. Empty: file A is new, the intro plays. A save file: file A holds a game at that event progress (made by the game\'s own save) – the file select shows its exit count, the intro does not play.' }, 'Save files', this.playSaves),
      h('span', { class: 'sep' }));
    this.moves = new MovementView({
      app,
      emulator: () => this.emulator(),
      shown: () => this.root.isConnected && this.tab === 'title',
      head: (state) => { this.head = state; if (this.tab === 'title') { this.surface.drop(); this.redraw(); } },
      frame: (frame) => this.showFrame(frame),
    });
    this.left = h('div', { class: 'left' }, h('div', { class: 'panel levels' }, h('div', { class: 'panel-title' }, 'Game'), this.list));
    this.surface = new BrushSurface(this.canvas, {
      cells: { w: TITLE_COLS, h: TITLE_ROWS },
      cellAt: (px, py) => (this.map && !this.moves.live ? this.cellAt(px, py) : null),
      box: (r) => {
        const y0 = this.cellY(r.y), y1 = this.cellY(Math.min(TITLE_ROWS - 1, r.y + r.h - 1));
        return y0 < 0 || y1 < 0 ? null : { x: r.x * 8, y: y0, w: Math.min(r.w, TITLE_COLS - r.x) * 8, h: y1 + 8 - y0 };
      },
      brush: () => this.brush,
      stamp: (x, y) => this.stamp(x, y),
      end: () => this.save(),
      cancel: () => { if (this.saved) { this.map = this.saved.slice(); this.redraw(); } },
      pick: (r) => {
        const map = this.map!, w = Math.min(r.w, TITLE_COLS - r.x), hh = Math.min(r.h, TITLE_ROWS - r.y);
        this.brush = { w, h: hh, tiles: Array.from({ length: w * hh }, (_, k) => map[(r.y + Math.floor(k / w)) * TITLE_COLS + r.x + (k % w)]) };
        this.buildPicker();
      },
      changed: () => this.redraw(),
      moved: (c) => this.updateStatus(c),
    });
    this.menuSurface = new BrushSurface(this.menuCanvas, {
      cells: { w: MENU_COLS, h: MENU_ROWS },
      cellAt: (px, py) => (this.menu ? this.menuCellAt(px, py) : null),
      box: (r) => this.menuBox(r),
      brush: () => this.brush,
      whyNot: (x, y) => (this.menu && !this.brushCells(x, y).some((c) => this.menu!.text.source[c] >= 0) ? 'Not a cell of the menu\'s stripe image: only the tiles the image has are painted here' : ''),
      tell: (why) => { this.status.textContent = why; },
      stamp: (x, y) => this.stampMenu(x, y),
      end: () => this.saveMenu(),
      cancel: () => { const m = this.menu; if (m) { m.map = m.text.map.slice(); this.redraw(); } },
      pick: (r) => {
        const map = this.menu!.map, w = Math.min(r.w, MENU_COLS - r.x), hh = Math.min(r.h, MENU_ROWS - r.y);
        this.brush = { w, h: hh, tiles: Array.from({ length: w * hh }, (_, k) => map[(r.y + Math.floor(k / w)) * MENU_COLS + r.x + (k % w)]) };
        this.buildPicker();
      },
      changed: () => this.redraw(),
      moved: (c) => this.menuStatus(c),
    });
    this.scroller = h('div', { class: 'level-scroller game-scroller' }, this.surface.root);
    attachPanZoom(this.scroller, () => this.zoom, (z, ax, ay) => this.setZoom(z, ax, ay), 1, 6, () => [1, 2, 3, 4, 5, 6]);
    this.root = h('div', { class: 'center' }, h('div', { class: 'level-view' }, this.scroller), this.moves.strip, h('div', { class: 'statusbar' }, this.status));
    this.side = h('div', { class: 'ow-side' }, this.moves.panel, this.pickPanel);
    this.buildList();
    // a ROM edit, undo or redo: shown as in the ROM (a stroke being painted is dropped)
    app.on('rom-change', () => {
      if (!this.root.isConnected) return;
      // (the list a moment later: the game run to every screen again, not while a stroke's edit is shown)
      clearTimeout(this.listTimer);
      this.listTimer = window.setTimeout(() => { if (this.root.isConnected) this.listScreens(); }, 300);
      if (this.tab === 'border') { this.border.reload(); return; }
      this.surface.drop();
      this.menuSurface.drop();
      if (this.tab === 'title') this.sync(); else this.showOther();
    });
    // the sheet follows the panel's width, drawn anew when it needs other screen pixels per pixel
    new ResizeObserver(() => requestAnimationFrame(() => { if (this.pickPixels && fillPixels(this.pickPanel.clientWidth, 128) !== this.pickPixels) this.buildPicker(); })).observe(this.pickPanel);
    this.setZoom(this.zoom);
  }

  // the border's map shown (while the border is the tab; else the last one shown)
  get borderMap(): number { return this.border.map; }

  // shown: the title screen as in the ROM, or the border of the map shown last
  show(): void {
    if (this.tab === 'border') this.border.show(this.border.map);
    else if (this.tab === 'title') this.sync();
    else this.showOther();
    this.listScreens();
    this.labelSaves();
  }
  // the tab shown that is neither the title screen nor a border: a screen's picture or menu text, or the start of a game
  private showOther(): void {
    if (this.tab === 'start') this.showStart();
    else if (this.tab !== 'border') this.showScreen(this.tab);
  }
  // a screen of the game, or the border of map `map`
  select(tab: GameTab, map = this.border.map): void {
    this.tab = tab;
    const border = tab === 'border', edited = tab === 'title';
    this.title.textContent = border ? `${MAP_NAMES[map]} – overworld border` : tab === 'start' ? START_TAB.name : gameScreenKind(tab).name;
    this.menu = null;
    if (!edited) { this.moves.leave(); this.moves.strip.hidden = true; }
    if (border) {
      this.scroller.replaceChildren(this.border.root);
      this.side.replaceChildren(this.border.side);
    } else if (edited) {
      this.scroller.replaceChildren(this.surface.root);
      this.side.replaceChildren(this.moves.panel, this.pickPanel);
    }
    if (border || edited) this.status.textContent = PAINT_HINT;
    if (border) this.bar.append(this.border.bar); else this.border.bar.remove();
    if (border) this.border.show(map); else if (edited) this.sync(); else this.showOther();
    this.listScreens();
  }
  // the list with the screens the game gets into as of the ROM shown
  private listScreens(): void {
    try { this.screens = reachedScreenIds(this.emulator()); } catch { this.screens = []; }
    this.buildList();
  }
  private buildList(): void {
    const item = (label: string, title: string, on: boolean, go: () => void) => h('div', { class: `level-item${on ? ' current' : ''}`, title, onclick: go }, label);
    // the screens reached – and the one shown, also when the game no longer gets there (its page says so)
    const screens = GAME_SCREENS.filter((k) => this.tab === k.id || this.screens.includes(k.id))
      .map((k) => ({ k, el: item(k.name, k.about, this.tab === k.id, () => { this.select(k.id); this.onNav(); }) }));
    const prompts = screens.filter((s) => !s.k.pregame);
    this.list.replaceChildren(
      ...screens.filter((s) => s.k.pregame).map((s) => s.el),
      item(START_TAB.name, START_TAB.about, this.tab === 'start', () => { this.select('start'); this.onNav(); }),
      ...(prompts.length ? [h('div', { class: 'panel-title' }, 'Overworld prompts'), ...prompts.map((s) => s.el)] : []),
      h('div', { class: 'panel-title' }, 'Overworld border'),
      ...MAP_NAMES.map((n, m) => item(n, `${n}'s border: layer 3, fixed on the screen while the map is shown`, this.tab === 'border' && this.border.map === m, () => { this.select('border', m); this.onNav(); })));
  }
  onNav: () => void = () => {};
  // set by the host: plays the game from power-on with the save files chosen (file: file A a save at an event
  // progress – 'shown': the one the overworld editor shows, 'all': every event passed; null: empty save files)
  onPlay: (file: 'shown' | 'all' | null) => void = () => {};
  // set by the host: the overworld editor's event progress in words (the choice's label)
  shownProgress: () => string = () => 'before events';
  private playSaves = h('select', { onfocus: () => this.labelSaves() },
    h('option', { value: '' }, 'Empty'), h('option', { value: 'shown' }, ''), h('option', { value: 'all' }, 'File A: every event passed'));
  private labelSaves(): void { this.playSaves.options[1].textContent = `File A: the overworld's event progress (${this.shownProgress()})`; }
  playFromPowerOn(): void {
    const v = this.playSaves.value;
    this.moves.leave(); // (a recording or the movement played on the title screen page ends)
    this.onPlay(v === 'shown' || v === 'all' ? v : null);
  }
  // set by the host: the level editor on a level (then: what to do there)
  onOpenLevel: (n: number, then?: () => void) => void = () => {};
  // Esc: a stroke or pick in progress cancelled (else the workspace is left); whether it was taken
  key(e: KeyboardEvent): boolean {
    return this.tab === 'border' ? this.border.key(e) : this.tab === 'title' ? this.moves.key(e) || this.surface.key(e) : this.menu ? this.menuSurface.key(e) : false;
  }

  // the emulator of the ROM shown (its boot the app's)
  private emulator(): LevelEmulator {
    if (!this.emu || this.emu.rom !== this.app.rom) this.emu = new LevelEmulator(this.app.rom);
    // the app's boot snapshot, also when it was booted again (the title screen picture painted): one boot for both
    this.emu.adoptBoot(this.app.emu.bootSnapshot());
    return this.emu;
  }

  // A screen as the game draws it. A menu whose picture is a stripe image's: its text's editor (menutext.ts); any
  // other screen: its picture.
  private showScreen(id: GameScreenId): void {
    const kind = gameScreenKind(id), ctx = this.screenCanvas.getContext('2d')!;
    let why = '', note = 'The picture is the game\'s own: the editor runs the game to this screen as a player gets there. It can\'t be edited here yet.';
    let fields: HTMLElement[] = [];
    this.menu = null;
    try {
      const emu = this.emulator(), screens = gameScreens(emu), screen = screens.find((s) => s.id === id);
      const text = screen && kind.menu ? menuText(emu, screen, screens) : null;
      if (screen && text) {
        this.menu = { id, screen, text, map: text.map.slice(), pic: screenPicture(emu, screen.state) };
        this.scroller.replaceChildren(this.menuSurface.root);
        this.side.replaceChildren(this.menuInfo, this.pickPanel);
        this.buildMenuInfo();
        this.paintMenu();
        this.menuStatus(null);
        this.buildPicker();
        return;
      }
      if (screen) {
        const img = ctx.createImageData(W, 224);
        new Uint32Array(img.data.buffer).set(screenPicture(emu, screen.state).frame);
        ctx.putImageData(img, 0, 0);
        if (id === 'presents') fields = this.presentsFields(emu, screen);
        if (fields.length) note = 'The picture is the game\'s own, at the logo\'s brightest. The fields are what the game was seen to read the logo from on the way here; a field changed is a byte of the ROM.';
        if (kind.menu) note = 'The picture is the game\'s own. The game draws this menu without a stripe image (a patch draws it another way, as Sprite Title Screen Menus does): its text can\'t be edited here.';
      } else why = `The game does not get to its ${kind.name.toLowerCase()}.`;
    } catch (e) {
      why = `The game does not get to its ${kind.name.toLowerCase()}: ${e instanceof Error ? e.message : e}`;
    }
    if (why) { ctx.fillStyle = uiToken('--canvas-bg', '#15171b'); ctx.fillRect(0, 0, W, 224); }
    this.scroller.replaceChildren(this.screenCanvas);
    this.side.replaceChildren(this.screenInfo);
    this.status.textContent = why || `${kind.name}, as the game shows it`;
    this.screenInfo.replaceChildren(h('div', { class: 'panel-title' }, kind.name),
      h('p', { class: 'hint game-screen-about' }, `${kind.about}.`),
      h('p', { class: 'hint game-screen-about' }, why || note), ...fields);
  }

  // The start of a game (startpage.ts): the intro as the game shows it on a new file – without one, the file's first
  // overworld – and beside it what a new file starts with.
  private showStart(): void {
    const ctx = this.screenCanvas.getContext('2d')!;
    let status = '', body: HTMLElement[] = [], shown = false;
    this.menu = null;
    try {
      const emu = this.emulator(), page = startPage(this.app, emu, {
        openLevel: (n) => this.onOpenLevel(n),
        editMessage: (n, tl, msg) => this.onOpenLevel(n, () => this.app.openMessages(tl, msg)),
        showTile: (i) => this.app.gotoOverworldTile(i),
      });
      status = page.status;
      body = page.body;
      if (page.state) {
        const img = ctx.createImageData(W, 224);
        new Uint32Array(img.data.buffer).set(screenPicture(emu, page.state).frame);
        ctx.putImageData(img, 0, 0);
        shown = true;
      }
    } catch (e) {
      status = `The game does not start a new file: ${e instanceof Error ? e.message : e}`;
      body = [h('div', { class: 'panel-title' }, START_TAB.name), h('p', { class: 'hint game-screen-about' }, status)];
    }
    if (!shown) { ctx.fillStyle = uiToken('--canvas-bg', '#15171b'); ctx.fillRect(0, 0, W, 224); }
    this.scroller.replaceChildren(this.screenCanvas);
    this.side.replaceChildren(this.screenInfo);
    this.status.textContent = status;
    this.screenInfo.replaceChildren(...body);
  }

  // Nintendo Presents' fields (presents.ts): each OBJ's position, tile and properties, the time, the colours, the
  // graphics file – what the game reads from the ROM a field, what it computes a value
  private presentsFields(emu: LevelEmulator, screen: ReachedScreen): HTMLElement[] {
    const logo = presentsLogo(emu, screen), out: HTMLElement[] = [];
    const hex = (n: number, d = 2) => n.toString(16).toUpperCase().padStart(d, '0');
    const set = (what: string, f: PresentsValue, v: number, bytes: 1 | 2 = 1) => {
      if (v === f.value) return;
      try { this.app.romEdit(`Nintendo Presents: ${what}`, () => writePresentsValue(this.app.rom, f, v, bytes)); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
    };
    const row = (label: string, title: string, ...body: (HTMLElement | string)[]) => h('div', { class: 'prop game-field', title }, h('label', null, label), ...body);
    const computed = (text: string) => h('span', { class: 'hint', title: 'The game computes this, or a patch draws it: not read from the ROM as a byte, no field' }, text);
    const dec = (what: string, f: PresentsValue, min: number, max: number): HTMLElement => {
      if (f.at < 0) return computed(String(f.value));
      const inp = h('input', { type: 'number', min, max, value: String(f.value), class: 'game-num' });
      inp.addEventListener('change', () => { const v = Math.round(Number(inp.value)); if (inp.value.trim() === '' || !(v >= min && v <= max)) inp.value = String(f.value); else set(what, f, v); });
      return inp;
    };
    const hexField = (what: string, f: PresentsValue): HTMLElement => (f.at < 0 ? computed(`$${hex(f.value)}`) : hexInput(f.value, 2, (v) => set(what, f, v)));
    // (a field several tiles read from one byte: once, named for them)
    const of = (n: number[]) => (n.length === logo.objs.length && n.length > 1 ? 'all tiles' : `tile${n.length > 1 ? 's' : ''} ${n.join(', ')}`);
    const group = (title: string, pick: (o: LogoObj) => PresentsValue, make: (what: string, f: PresentsValue) => HTMLElement, name: string, tip: string) => {
      const fs = sharedFields(logo.objs, pick);
      if (!fs.length) return;
      out.push(h('div', { class: 'panel-title' }, title));
      for (const g of fs) out.push(row(of(g.objs).replace(/^./, (c) => c.toUpperCase()), tip, make(`${name} of ${of(g.objs)}`, g.field)));
    };
    if (!logo.objs.length) out.push(h('p', { class: 'hint game-screen-about' }, 'The game shows no OBJ here: the logo is drawn another way (a patch\'s), and has no fields of its tiles.'));
    else out.push(h('p', { class: 'hint game-screen-about' }, `The logo is ${logo.objs.length} OBJ ("tiles" below, numbered in the game's order), each ${logo.objs.every((o) => o.big) ? '16×16' : logo.objs.some((o) => o.big) ? '8×8 or 16×16' : '8×8'} pixels.`));
    group('X position', (o) => o.x, (w, f) => dec(w, f, 0, 255), 'X', 'The tile\'s left edge on the screen, in pixels (0–255)');
    group('Y position', (o) => o.y, (w, f) => dec(w, f, 0, 255), 'Y', 'The tile\'s top edge on the screen, in pixels (the screen shows 0–223)');
    group('Tile', (o) => o.tile, hexField, 'tile number', 'The tile\'s number in the sprite graphics (hex): its top left 8×8 tile');
    group('Properties', (o) => o.props, hexField, 'properties', 'YXPPCCCT (hex): Y flip, X flip, priority (2 bits), sprite palette (3 bits), the tile\'s page');
    out.push(h('div', { class: 'panel-title' }, 'Time'));
    if (logo.time) {
      const t = logo.time;
      out.push(row('Frames', 'The frames the game counts while the logo shows, before it goes on to the title screen (1–255; 60 frames are a second)',
        dec('time', t, 1, 255), h('span', { class: 'hint' }, `≈ ${(t.value / 60).toFixed(1)} s`)));
    } else out.push(h('p', { class: 'hint game-screen-about' }, 'No time found: the game does not count a byte of the ROM down while the logo shows.'));
    if (logo.colours.length) {
      out.push(h('div', { class: 'panel-title' }, 'Colours'));
      for (const c of logo.colours) {
        const own = c.at >= 0 && !c.shared;
        const sw = h('input', { type: 'color', value: htmlOf(c.value), disabled: !own, class: 'game-colour' });
        // (the 15-bit colour of the picker's 24 bits; written as a word)
        sw.addEventListener('change', () => { const n = parseInt(sw.value.slice(1), 16); set(`colour $${hex(c.index)}`, c, ((n >> 19) & 31) | (((n >> 11) & 31) << 5) | (((n >> 3) & 31) << 10), 2); });
        const why = c.at < 0 ? 'computed by the game'
          : c.shared ? `not the logo's own: the game loads ${c.shared} other colours from the same word of the ROM (the white of its palettes' colour 1)` : '';
        out.push(row(`Colour $${hex(c.index)}`, 'A colour the logo\'s pixels use (its entry in the sprite palettes)', sw, h('span', { class: 'hint game-field-note' }, why)));
      }
    }
    if (logo.gfx) {
      const g = logo.gfx, name = `GFX${hex(g.file)}`;
      out.push(h('div', { class: 'panel-title' }, 'Graphics'),
        row('File', 'The graphics file the game read on the way here whose tiles are the logo\'s', h('button', { onclick: () => this.app.showGfxFile(g.file) }, `${name} in the graphics workspace`)),
        h('p', { class: 'hint game-screen-about' }, `The first tile is ${name}'s tile ${hex(g.tile)}.`));
    }
    return out;
  }

  // ---- a menu's text ----
  // layer 3's tilemap pixel at the screen's top left, as the game scrolled it
  private menuScroll(): { x: number; y: number } { return this.menu?.pic.l3Scroll ?? { x: 0, y: 0 }; }
  private menuCellAt(px: number, py: number): { x: number; y: number } | null {
    const sc = this.menuScroll(), x = ((Math.floor(px) + sc.x) & 0x1ff) >> 3, y = ((Math.floor(py) + sc.y) & 0x1ff) >> 3;
    return px < 0 || py < 0 || px >= W || py >= 224 || x >= MENU_COLS || y >= MENU_ROWS ? null : { x, y };
  }
  // the cells' rectangle on the screen (null: scrolled off it)
  private menuBox(r: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } | null {
    const sc = this.menuScroll(), at = (v: number) => { const p = (v & 0x1ff); return p >= 0x100 ? p - 0x200 : p; };
    const x = at(r.x * 8 - sc.x), y = at(r.y * 8 - sc.y), w = Math.min(r.w, MENU_COLS - r.x) * 8, hh = Math.min(r.h, MENU_ROWS - r.y) * 8;
    return x + w <= 0 || y + hh <= 0 || x >= W || y >= 224 ? null : { x, y, w, h: hh };
  }
  // the cells the brush covers put at cell (x, y)
  private brushCells(x: number, y: number): number[] {
    const b = this.brush, out: number[] = [];
    for (let k = 0; k < b.tiles.length; k++) {
      const cx = x + (k % b.w), cy = y + Math.floor(k / b.w);
      if (cx < MENU_COLS && cy < MENU_ROWS) out.push(cy * MENU_COLS + cx);
    }
    return out;
  }
  private stampMenu(cx: number, cy: number): boolean {
    const m = this.menu!, b = this.brush;
    let changed = false;
    b.tiles.forEach((w, k) => {
      const x = cx + (k % b.w), y = cy + Math.floor(k / b.w);
      if (x < MENU_COLS && y < MENU_ROWS && paintMenuCell(m.text, m.map, y * MENU_COLS + x, w)) changed = true;
    });
    return changed;
  }
  // the stroke saved: one ROM edit, the stripe image's words in place
  private saveMenu(): void {
    const m = this.menu;
    if (!m || m.map.every((w, i) => w === m.text.map[i])) return;
    const name = gameScreenKind(m.id).name, over = paintedOverwritten(m.text, m.map), cursor = over.filter((c) => m.text.cursor.includes(c)).length;
    try {
      this.app.romEdit(`${name} painted`, () => { writeMenuText(this.app.rom, m.text, m.map); });
      if (over.length) toast(`${over.length === 1 ? 'One painted cell is' : `${over.length} painted cells are`} written over by the game (${cursor === over.length ? 'the cursor' : cursor ? 'the cursor, a file\'s exit count or its blanked word' : 'a file\'s exit count or its blanked word'}): the menu's stripe image has the tiles now, the game shows its own there.`);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
      this.showScreen(m.id);
    }
  }
  // the menu as the game draws it with the tilemap as painted, and the marks over it
  private paintMenu(): void {
    const m = this.menu, ctx = this.menuCanvas.getContext('2d')!;
    if (!m) return;
    const img = ctx.createImageData(W, 224);
    new Uint32Array(img.data.buffer).set(m.pic.frame);
    ctx.putImageData(img, 0, 0);
    if (this.marks) {
      const t = m.text, box = (c: number) => this.menuBox({ x: c % MENU_COLS, y: Math.floor(c / MENU_COLS), w: 1, h: 1 });
      // what is not the menu's: dimmed
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      for (let c = 0; c < t.source.length; c++) { const b = t.source[c] < 0 && !t.cursor.includes(c) ? box(c) : null; if (b) ctx.fillRect(b.x, b.y, b.w, b.h); }
      const frame = (c: number, color: string) => { const b = box(c); if (b) { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1); } };
      t.written.forEach((v, c) => { if (v && !t.cursor.includes(c)) frame(c, rgba(MARK.warn, 0.9)); });
      for (const c of t.cursor) frame(c, rgba(MARK.select, 0.9));
    }
    this.menuSurface.frames();
  }
  private menuStatus(c: { x: number; y: number } | null): void {
    const m = this.menu;
    if (!m) return;
    if (!c) { this.status.textContent = PAINT_HINT; return; }
    const i = c.y * MENU_COLS + c.x, t = m.text, choice = t.cursor.indexOf(i);
    const what = choice >= 0 ? `the cursor's place for choice ${choice + 1}${t.source[i] >= 0 ? ': the game draws the cursor or a blank over the image\'s tile' : ' (not of the stripe image)'}`
      : t.source[i] < 0 ? 'not of the menu\'s stripe image, not painted here'
      : t.written[i] ? 'the game writes over it (a file\'s exit count or its blanked word)'
      : t.shared[i] ? `one of a run of ${t.source.filter((o) => o === t.source[i]).length} cells with one tile: painted as one` : '';
    this.status.textContent = `Column ${c.x}, row ${c.y}: tile ${layer3WordText(m.map[i])}${what ? ` – ${what}` : ''} – ${PAINT_HINT}`;
  }
  private buildMenuInfo(): void {
    const m = this.menu;
    if (!m) return;
    const kind = gameScreenKind(m.id), t = m.text, a = pcToSnes(t.addr);
    const hex = (n: number, d: number) => n.toString(16).toUpperCase().padStart(d, '0');
    const box = h('input', { type: 'checkbox', checked: this.marks, onchange: () => { this.marks = box.checked; this.paintMenu(); } });
    const key = (color: string, text: string) => h('p', { class: 'hint game-screen-about' }, h('span', { class: 'game-mark', style: `border-color:${color}` }), text);
    this.menuInfo.replaceChildren(h('div', { class: 'panel-title' }, kind.name),
      h('p', { class: 'hint game-screen-about' }, `${kind.about}.`),
      h('p', { class: 'hint game-screen-about' }, `Its text is the stripe image at $${hex(a >> 16, 2)}:${hex(a & 0xffff, 4)} (${t.length} bytes), found by what the game writes to the screen on the way here. Painting changes its tiles in place: the tiles it has, where it has them.`),
      h('label', { class: 'hint game-screen-about' }, box, ' Marks'),
      key(MARK.select, `The cursor's place${t.cursor.length === 1 ? '' : 's'} (${t.cursor.length} choice${t.cursor.length === 1 ? '' : 's'}), as the game moves it`),
      ...(t.written.some((v, c) => v && !t.cursor.includes(c)) ? [key(MARK.warn, 'Written over by the game: a file\'s exit count, the word blanked for a file in use')] : []),
      h('p', { class: 'hint game-screen-about' }, 'Dimmed: not of this stripe image (what is under the menu, or drawn another way).'));
  }

  private sync(): void {
    this.emulator();
    try {
      this.saved = titleTilemap(this.emu!);
      this.map = this.saved.slice();
      this.head = this.moves.sync();
      this.pic = this.titlePic();
      this.error = '';
    } catch (e) {
      this.saved = this.map = this.pic = this.head = null;
      this.error = `The game does not reach its title screen: ${e instanceof Error ? e.message : e}`;
    }
    this.paint();
    this.updateStatus(null);
    this.buildPicker();
  }

  // the title screen as the game draws it at the movement's playhead, with the tilemap as painted
  private titlePic(): TitlePicture {
    return screenPicture(this.emu!, this.head ?? this.emu!.bootState(), this.map ?? undefined);
  }
  // a frame of the game running on the page (the movement played or recorded): over the screen's rows
  private showFrame(frame: Uint32Array): void {
    const ctx = this.canvas.getContext('2d')!, img = ctx.createImageData(W, 224);
    new Uint32Array(img.data.buffer).set(frame);
    ctx.putImageData(img, 0, 0);
  }

  // z: zoom factor; anchor: the point in the scroller that stays put (default: its top left)
  private setZoom(z: number, ax = 0, ay = 0): void {
    const old = this.zoom, sc = this.scroller;
    this.zoom = Math.max(1, Math.min(6, Math.round(z)));
    this.canvas.style.width = `${W * this.zoom}px`;
    this.canvas.style.height = `${H * this.zoom}px`;
    for (const c of [this.screenCanvas, this.menuCanvas]) {
      c.style.width = `${W * this.zoom}px`;
      c.style.height = `${224 * this.zoom}px`;
    }
    this.border.setZoom(this.zoom);
    this.zoomCtl?.update();
    this.surface.frames();
    this.menuSurface?.frames();
    // (the picture starts after the scroller's padding)
    const pad = SCROLLER_PAD, at = (s: number, a: number) => (s + a - pad) / old * this.zoom + pad - a;
    if (sc && old !== this.zoom) { sc.scrollLeft = at(sc.scrollLeft, ax); sc.scrollTop = at(sc.scrollTop, ay); }
  }

  // the picture as the game draws it with the tilemap as painted (once per animation frame while painting)
  private redraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const m = this.menu;
      if (m && this.emu) {
        try { m.pic = screenPicture(this.emu, m.screen.state, m.map); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
        this.paintMenu();
        return;
      }
      if (!this.emu || !this.map) return;
      try { this.pic = this.titlePic(); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
      this.paint();
    });
  }

  private paint(): void {
    const ctx = this.canvas.getContext('2d')!;
    ctx.fillStyle = uiToken('--canvas-bg', '#15171b');
    ctx.fillRect(0, 0, W, H);
    const p = this.pic, map = this.map;
    if (!p || !map) return;
    const img = ctx.createImageData(W, H), px = new Uint32Array(img.data.buffer);
    px.fill(0xff22201b);
    px.set(p.frame, 0);
    const tc = new TileCache(p.vram, p.cgram, p.charBase), y0 = TITLE_SHOWN_ROWS * 8 + GAP;
    for (let x = 0; x < TITLE_COLS; x++) {
      const t = tc.get(map[(TITLE_ROWS - 1) * TITLE_COLS + x], 2);
      for (let k = 0; k < 64; k++) if (t[k]) px[(y0 + (k >> 3)) * W + x * 8 + (k & 7)] = t[k];
    }
    ctx.putImageData(img, 0, 0);
    this.surface.frames();
  }

  // the canvas's pixel y of a tilemap row (-1: none)
  private cellY(row: number): number {
    return row < TITLE_SHOWN_ROWS ? row * 8 : row === TITLE_ROWS - 1 ? TITLE_SHOWN_ROWS * 8 + GAP : -1;
  }

  // the cell at canvas pixel (px, py): the screen's rows, the row below it under the gap
  private cellAt(px: number, py: number): { x: number; y: number } | null {
    const x = Math.floor(px / 8);
    if (x < 0 || x >= TITLE_COLS || py < 0) return null;
    if (py < TITLE_SHOWN_ROWS * 8) return { x, y: Math.floor(py / 8) };
    const below = TITLE_SHOWN_ROWS * 8 + GAP;
    return py >= below && py < below + 8 ? { x, y: TITLE_ROWS - 1 } : null;
  }

  private stamp(cx: number, cy: number): boolean {
    const b = this.brush, map = this.map!;
    let changed = false;
    b.tiles.forEach((w, k) => {
      const x = cx + (k % b.w), y = cy + Math.floor(k / b.w);
      if (x >= TITLE_COLS || y >= TITLE_ROWS || map[y * TITLE_COLS + x] === w) return;
      map[y * TITLE_COLS + x] = w;
      changed = true;
    });
    return changed;
  }

  // the stroke saved: one ROM edit
  private save(): void {
    const map = this.map;
    if (!map || !this.saved || map.every((w, i) => w === this.saved![i])) return;
    try {
      this.app.romEdit('Title screen painted', () => writeTitleScreen(this.app.rom, map.slice()));
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
      this.sync();
    }
  }

  private updateStatus(c: { x: number; y: number } | null): void {
    if (!this.map) { this.status.textContent = this.error; return; }
    if (!c) { this.status.textContent = PAINT_HINT; return; }
    const w = this.map[c.y * TITLE_COLS + c.x];
    this.status.textContent = `Column ${c.x}, row ${c.y}${c.y === TITLE_ROWS - 1 ? ' (below the screen)' : ''}: tile ${layer3WordText(w)} – ${PAINT_HINT}`;
  }

  // layer 3's 8x8 tiles as the brush (l3picker.ts), as on the title screen
  private buildPicker(): void {
    const m = this.tab !== 'title' ? this.menu : null, p = m ? m.pic : this.tab === 'title' ? this.pic : null;
    hidePickerPreview(this.pickPanel);
    this.pickPanel.replaceChildren(h('div', { class: 'panel-title' }, 'Paint', h('span', { class: 'hint' }, PAINT_TITLE)));
    this.pickPixels = 0;
    if (!p) return;
    const w = this.pickPanel.clientWidth;
    layer3Picker(this.pickPanel, p, this.brush, (nb) => { this.brush = nb; this.buildPicker(); }, {
      pixels: this.pickPixels = fillPixels(w, 128), shown: w / 128, from: 'the screen',
      hint: m ? 'click tiles here or on the menu (drag: block). The graphics are layer 3\'s as the game has them in this menu.'
        : 'click tiles here or on the title screen (drag: block). The graphics are layer 3\'s as the title screen\'s level has them; the row under the screen is written too (as Lunar Magic does), the game\'s scroll does not show it.',
    });
  }
}
