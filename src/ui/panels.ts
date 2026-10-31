// Sidebar panels: level list, picker (objects / sprites), properties.

import { isBrushMode, type App, type PickedItem } from './app.ts';
import { h, clear, hexInput, checkbox, attachRectPick, modal, toast, emptyState } from './dom.ts';
import { spriteName, hex2, hex3 } from '../core/names.ts';
import { baseObjectName, namedPerTable } from '../core/objectnames.ts';
import { packageObjectName, objectTooltip } from '../core/objtext.ts';
import { boxLabel } from '../core/objboxes.ts';
import { objectBoxCanvas } from './objbox.ts';
import { NAME_MAX, nameOf, namesOf, nameGroups, connectedRect, tileRanges, type NameKind } from '../core/usernames.ts';
import { objectVariant, withObjectVariant, type ObjKind } from '../core/objkinds.ts';
import { thumbCanvas, objKey, type ObjSpec, type ObjThumb } from './thumbs.ts';
import { fillPixels, fitScale, sized, previewOnHover, previewSheet, hidePickerPreview, PREVIEW_BELOW, type LegendRow } from './pickerview.ts';
import { newUid, spriteId, spriteBytes, spriteSizes, type LevelObject, type LevelSprite } from '../core/level.ts';
import { levelName } from '../core/overworld.ts';
import { usedInList } from './usedin.ts';
import { buildExitPanel } from './exitpanel.ts';
import { DM16_EXT } from '../core/patches.ts';
import { objectLength2D, fitExtension, OBJ_2D } from '../core/obj2d.ts';
import { PREFAB_EXT, TRANSPARENT, freePrefabNumber, readPrefab, writePrefab, PREFAB_COUNT, type Prefab } from '../core/prefabs.ts';
import { prefabCost } from '../core/prefabcost.ts';
import type { LevelPlaces } from '../core/prefabplaces.ts';
import { EXT_TILES } from '../core/map16ext.ts';
import { COND_FLAGS, COND_ADD, condByte, flagRam, isDm16, type Dm16Cond } from '../core/cdm16.ts';
import { TileCache, map16Source, drawMap16, sheetCells } from '../core/render.ts';
import { lt3Target, lt3Users, blankLayer3Tile, l3Palette, withL3Palette, L3_TILE, L3_PAL, L3_PRIO, L3_FLIP_X, L3_FLIP_Y } from '../core/layer3map.ts';
import { LT3_DESTS } from '../core/layer3gfx.ts';
import { probeable } from '../core/probeclient.ts';
import { probeText, spritesOf, spriteProbeAt, enterText, enterSuffix, switchText, switchedText, SWITCH_NAME, type SwitchState } from '../core/blockprobe.ts';
import { tileMatches, drawTileMatches } from './tilesearch.ts';
import { animateTiles, noteCopy } from './pickeranim.ts';
import { matchesAll, type SearchProvider, type SearchResult } from './search.ts';
import { blockFilesByTile } from './blockdialog.ts';
import { contextMenu } from './menu.ts';
import { collisionMarks, markCanvas, switchMarks, switchCanvas, MARK_TEXT, type CollisionMark } from './collisionmarks.ts';

// behaviour of the given Map16 tiles when hit from below or entered (only tiles with an effect);
// undefined while probes are still pending
export function blockSummary(app: App, tiles: number[], all = false): string[] | undefined {
  const out: string[] = [];
  let pending = false;
  for (const t of tiles.slice(0, 16)) {
    const p = app.probes.block(t);
    if (!p) { pending = true; continue; }
    if (p.summary || p.enter || all) out.push(tiles.length > 1 || all ? `${hex3(t)}: ${probeText(p)}` : p.summary ? p.summary + enterSuffix(p) : enterText(p.enter));
  }
  return pending ? undefined : out;
}

// sprites the given tiles spawn when hit (all X positions, small Mario first), from finished probes only
export function blockSprites(app: App, tiles: number[]): number[] {
  const out = new Set<number>();
  for (const t of tiles.slice(0, 16)) {
    const p = app.cachedBlock(t);
    if (p) for (const q of p.pos) for (const n of spritesOf(q)) out.add(n);
  }
  return [...out];
}

// directions (↓↑←→) in which any of the tiles can be entered, from finished probes only
export function blockEnter(app: App, tiles: number[]): string {
  const dirs = new Set<string>();
  for (const t of tiles.slice(0, 16)) for (const d of app.cachedBlock(t)?.enter ?? '') dirs.add(d);
  return [...'↓↑←→'].filter((d) => dirs.has(d)).join('');
}

// how any of the tiles treats Mario (kills, hurts, climbable), from finished probes only
export function blockMarks(app: App, tiles: number[]): CollisionMark[] {
  return collisionMarks(tiles.slice(0, 16).map((t) => app.cachedCollision(t)));
}

// the switch states that make any of the tiles act otherwise, with what each does then (finished probes only)
export function blockSwitches(app: App, tiles: number[]): { sw: SwitchState; text: string }[] {
  const probes = tiles.slice(0, 16).map((t) => [t, app.cachedCollision(t)] as const);
  return switchMarks(probes.map(([, c]) => c)).map((sw) => {
    const by = probes.flatMap(([t, c]) => { const x = c && switchText(c, sw); return x ? [{ t, x }] : []; });
    const one = new Set(by.map((b) => b.x)).size === 1;
    return { sw, text: one ? by[0].x : by.map((b) => `${hex3(b.t)}: ${b.x}`).join('; ') };
  });
}

// the symbols the picker draws on an entry, for its preview's legend: the items it gives, the directions it is
// entered in, how it treats Mario
const SWITCH_LEGEND: Record<SwitchState, string> = { blueP: 'While the blue P-switch runs', silverP: 'While the silver P-switch runs', off: 'While ON/OFF is OFF' };
const MARK_LEGEND: Record<CollisionMark, string> = { kills: 'Kills Mario when touched', hurts: 'Hurts Mario when touched', climb: 'Mario can climb in it' };
export function entryLegend(app: App, e: { items?: number[]; enter?: string; marks?: CollisionMark[]; switches?: { sw: SwitchState; text: string }[] }): LegendRow[] {
  const out: LegendRow[] = [];
  for (const n of (e.items ?? []).slice(0, 4)) {
    const img = app.spriteThumbs?.get(n);
    if (img) out.push({ icon: cloneCanvas(img), text: `Gives ${app.spriteLabel(n)}` });
  }
  if (e.enter) {
    const dirs = [...e.enter].map((d) => ({ '↓': 'down', '↑': 'up', '←': 'left', '→': 'right' })[d]);
    out.push({ icon: h('div', { class: 'picker-enter' }, e.enter), text: `Mario enters it holding ${dirs.join(' or ')}` });
  }
  for (const m of e.marks ?? []) out.push({ icon: markCanvas(m), text: MARK_LEGEND[m] });
  for (const { sw, text } of e.switches ?? []) out.push({ icon: switchCanvas(sw), text: `${SWITCH_LEGEND[sw]}: ${text}` });
  return out;
}

// the levels with sprite id, each opening at its first one
function spriteUses(app: App, id: number, title: string): HTMLElement {
  return usedInList(app, title, app.spriteUsers(id).map((u) => ({ level: u.level, at: { x: u.x, y: u.y }, text: `${u.count}×` })), 0, 'In no level.');
}

// ---------------- level list ----------------
export function levelNameOf(app: App, i: number): string {
  const tl = i < 0x25 ? i : i >= 0x101 && i < 0x13c ? i - 0xdc : -1;
  return tl > 0 ? levelName(app.rom, tl) : '';
}

export class LevelList {
  app: App;
  root: HTMLDivElement;
  list: HTMLDivElement;
  filter: HTMLInputElement;
  onlyUsed: HTMLInputElement;
  count = h('span', { class: 'hint' });
  private first = -1;
  constructor(app: App) {
    this.app = app;
    this.filter = h('input', { placeholder: 'No. (hex) or name …', class: 'filter', spellcheck: false, title: 'Filters by level number (hex) or name; Enter opens the first match' });
    this.onlyUsed = h('input', { type: 'checkbox', checked: true });
    this.list = h('div', { class: 'level-list' });
    this.root = h('div', { class: 'panel levels' },
      h('div', { class: 'panel-title' }, 'Level', this.count),
      h('div', { class: 'row' }, this.filter),
      h('label', { class: 'row small' }, this.onlyUsed, ' used only'),
      this.list);
    this.filter.addEventListener('input', () => this.build());
    this.filter.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // an exact number first (also levels hidden by "used only"), else the first match
      const v = this.filter.value.trim(), n = parseInt(v, 16);
      if (/^[0-9a-f]{1,3}$/i.test(v) && n < 0x200) app.openLevel(n);
      else if (this.first >= 0) app.openLevel(this.first);
    });
    this.onlyUsed.addEventListener('change', () => this.build());
    app.on('level', () => this.build());
  }
  build(): void {
    const used = this.app.usedLevels();
    const f = this.filter.value.trim().toLowerCase();
    clear(this.list);
    this.first = -1;
    let n = 0;
    for (let i = 0; i < 0x200; i++) {
      if (this.onlyUsed.checked && !used.has(i)) continue;
      const label = hex3(i);
      if (f && !label.toLowerCase().includes(f) && !levelNameOf(this.app, i).toLowerCase().includes(f)) continue;
      const cur = this.app.level?.number === i;
      const name = levelNameOf(this.app, i);
      const el = h('div', { class: `level-item${cur ? ' current' : ''}${used.has(i) ? '' : ' unused'}`, title: name, onclick: () => this.app.openLevel(i) }, label, name ? h('span', { class: 'lname' }, ' ' + name) : '');
      this.list.appendChild(el);
      if (this.first < 0) this.first = i;
      n++;
      if (cur) setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 0);
    }
    this.count.textContent = String(n);
    if (!n) this.list.append(emptyState(f ? 'No level matches the filter.' : 'No levels.'));
  }
}

// ---------------- picker ----------------
type PickerTab = 'obj' | 'm16' | 'spr';

export class Picker {
  app: App;
  root: HTMLDivElement;
  body: HTMLDivElement;
  // Objects: the user's prefabs, the standard (resizable) and the extended (fixed size) objects in one list
  tab: PickerTab = 'obj';
  builtTab?: PickerTab; // the tab the body shows (undefined: a brush mode's sheet)
  scrolls = { obj: 0, m16: 0, spr: 0 }; // scroll position of each tab's list, kept across rebuilds and tab changes
  prefabBox: HTMLDivElement = h('div'); // the Prefabs section
  // its button and hint, which follow the selection without a rebuild
  thumbs = new Map<string, HTMLCanvasElement>();
  thumbTiles = new Map<string, number[]>(); // Map16 tiles per object key
  effects = new Map<string, string>(); // objects that draw nothing but change RAM: what (thumbs.ts)
  boxes = new Map<string, HTMLCanvasElement>(); // their thumbnails, the box of the level view (made when shown)
  thumbsFrom: ObjThumb[] | undefined; // the thumbnails shown (undefined: placeholders while they are learned)
  tabs: HTMLDivElement;
  builtPixels = 0; // the screen pixels per pixel the sheet shown is drawn at (0: no sheet)
  hovered: { el: HTMLElement; rename: () => void; del?: () => void } | null = null; // the Objects tab's cell under the mouse, for F2 and Del

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'picker-body' });
    this.tabs = h('div', { class: 'tabs seg' });
    this.root = h('div', { class: 'panel picker' }, h('div', { class: 'panel-title' }, 'Picker', h('span', { class: 'hint' }, 'Right click/Shift+click places')), this.tabs,
      this.m16Bar, this.body);
    this.body.addEventListener('scroll', () => this.m16Scrolled());
    // a sheet follows the picker's width, drawn anew when it needs other screen pixels per pixel
    new ResizeObserver(() => requestAnimationFrame(() => { if (this.builtPixels && this.sheetPixels() !== this.builtPixels) this.build(); })).observe(this.body);
    app.on('level', () => { this.ensureThumbs(); this.build(); });
    // the thumbnails of the level as edited: asked for whenever they may have changed, the learner decides
    for (const ev of ['objkinds', 'level-header', 'render', 'rom-change', 'thumbs'] as const) app.on(ev, () => { if (this.ensureThumbs() && this.tab === 'obj') this.build(); });
    let t = 0;
    app.on('sprites', () => { if (this.tab !== 'm16' && !t) t = window.setTimeout(() => { t = 0; this.build(); }, 300); });
    app.on('bgtile', () => { if (isBrushMode(app.mode)) this.build(); });
    app.on('probes', () => { if (this.tab === 'm16') this.m16Tip(); else this.build(); });
    app.on('render', () => { if (isBrushMode(app.mode)) this.build(); });
    app.on('change', () => this.followSelection());
    app.on('picked-item', () => this.build());
    app.on('prefabs', () => { if (this.tab === 'obj') this.build(); });
    app.on('object-names', () => { if (this.tab === 'obj') this.build(); });
    app.on('prefab-suggestions', () => { if (this.tab === 'obj') this.build(); });
    app.on('mode', () => {
      if (app.mode === 'spr') this.tab = 'spr';
      else if (this.tab === 'spr') this.tab = 'obj';
      this.build();
    });
  }

  // an item selected in the level becomes the picked item, shown in its tab and scrolled into view
  followed = -1;
  followSelection(): void {
    const app = this.app;
    const uid = app.selection.size === 1 ? [...app.selection][0] : -1;
    if (uid === this.followed) return;
    this.followed = uid;
    if (uid < 0 || app.mode === 'bg' || app.mode === 'exit') return;
    let item: PickedItem;
    if (app.mode === 'spr') {
      const s = app.selectedSprites()[0];
      if (!s) return;
      item = { kind: 'spr', num: s.num, extra: s.extra };
      this.tab = 'spr';
    } else {
      const o = app.selectedObjects()[0];
      if (!o) return;
      if (o.num === 0 && o.ext === DM16_EXT) {
        item = { kind: 'obj', num: 0, ext: DM16_EXT, size: 0, tile: o.tile ?? 0 };
        this.tab = 'm16';
      } else if (o.num === 0 && o.ext === PREFAB_EXT && o.prefab !== undefined) {
        item = { kind: 'obj', num: 0, ext: PREFAB_EXT, size: 0, prefab: o.prefab };
        this.tab = 'obj';
      } else if (o.num === 0) {
        item = { kind: 'obj', num: 0, ext: o.ext, size: 0 };
        this.tab = 'obj';
      } else {
        const kind = app.objectKind(o.num);
        item = { kind: 'obj', num: o.num, ext: 0, size: withObjectVariant(kind, 0x11, Math.max(0, objectVariant(kind, o.size))), ...(o.extension ? { extension: [...o.extension] } : {}) };
        this.tab = 'obj';
      }
    }
    const cur = app.pickedItem;
    if (cur && JSON.stringify(cur) === JSON.stringify(item) && this.body.querySelector('.selected')) return; // e.g. just inserted
    app.pickedItem = item;
    this.build();
    requestAnimationFrame(() => this.scrollToSelected()); // after the properties panel below has updated
  }

  scrollToSelected(): void {
    const el = this.body.querySelector<HTMLElement>('.selected');
    if (el) { el.scrollIntoView({ block: 'nearest' }); return; }
    const cur = this.app.pickedItem;
    if (cur?.kind !== 'obj' || cur.tile === undefined) return;
    this.scrollToM16Tile(cur.tile);
  }
  // scrolls a Map16 tile into view if it is not
  scrollToM16Tile(t: number): void {
    const c = this.body.querySelector<HTMLCanvasElement>(`canvas.m16-pick[data-page="${t >> 8}"]`);
    if (!c) return;
    // the canvas row of the tile
    const y = (((t & 0xff) >> 4) / 16) * c.clientHeight;
    const body = this.body.getBoundingClientRect(), rc = c.getBoundingClientRect();
    const top = rc.top - body.top + this.body.scrollTop + y;
    if (top < this.body.scrollTop || top + 20 > this.body.scrollTop + this.body.clientHeight) this.body.scrollTop = top - this.body.clientHeight / 2;
  }

  // all Map16 pages in one list; the bar above jumps to a page and shows the one in view
  m16Tip: () => void = () => {};
  m16Observer?: IntersectionObserver;
  m16Page = 0; // page at the top of the list
  m16Bar: HTMLDivElement = h('div', { class: 'tabs seg m16-pages' });
  // the tiles of a name chosen in the central search, marked (the others dimmed) until another tile is chosen
  m16Match: number[] | null = null;
  scrollToM16Page(page: number): void {
    const head = this.body.querySelector<HTMLElement>(`.m16-page-head[data-page="${page}"]`);
    if (head) this.body.scrollTop = head.offsetTop - this.body.offsetTop;
    this.m16Scrolled();
  }
  // marks the page at the top of the list in the bar
  m16Scrolled(): void {
    if (this.tab !== 'm16' || this.app.mode === 'bg') return;
    let page = 0;
    for (const head of this.body.querySelectorAll<HTMLElement>('.m16-page-head')) {
      if (head.offsetTop - this.body.offsetTop > this.body.scrollTop + 4) break;
      page = Number(head.dataset.page);
    }
    this.m16Page = page;
    this.m16Bar.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', i === page));
  }
  buildMap16(): void {
    const app = this.app;
    const cur = app.pickedItem;
    const curTile = cur?.kind === 'obj' && cur.num === 0 && cur.ext === DM16_EXT ? cur.tile ?? -1 : -1;
    const bw = cur?.kind === 'obj' && cur.block ? cur.block.w : 1, bh = cur?.kind === 'obj' && cur.block ? cur.block.h : 1;
    const pages = EXT_TILES / 256;
    clear(this.m16Bar);
    for (let p = 0; p < pages; p++) {
      this.m16Bar.appendChild(h('button', {
        class: p === this.m16Page ? 'active' : '', title: `Page ${p.toString(16).toUpperCase()}`,
        onclick: () => this.scrollToM16Page(p),
      }, p.toString(16).toUpperCase()));
    }
    // tooltip: tile number, name, behaviour when hit from below and how it treats Mario
    let hoverTile = -1, hoverCanvas: HTMLCanvasElement | null = null;
    const tip = () => {
      const p = app.probes.block(hoverTile), name = nameOf(app.rom, 'fg', hoverTile);
      const c = app.probes.collision(hoverTile), o = c && switchedText(c);
      const marks = (c ? collisionMarks([c]).map((m) => ` · ${MARK_TEXT[m]}`).join('') : '') + (o ? ` · ${o}` : '');
      if (hoverCanvas) hoverCanvas.title = `Tile ${hex3(hoverTile)}${name ? ` “${name}”` : ''}: ${p ? probeText(p) + marks : 'determining behavior …'}\nCtrl+click: edit in the Map16 tab`;
    };
    this.m16Tip = () => { if (hoverTile >= 0 && hoverCanvas?.isConnected) tip(); };
    // a page is drawn once it scrolls into view
    this.m16Observer?.disconnect();
    const draws = new Map<Element, () => void>();
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        draws.get(e.target)?.();
        draws.delete(e.target);
        observer.unobserve(e.target);
      }
    }, { root: this.body, rootMargin: '300px 0px' });
    this.m16Observer = observer;
    const k = this.builtPixels = this.sheetPixels(), S = 16 * k, scale = this.sheetShown();
    for (let p = 0; p < pages; p++) {
      const base = p * 256;
      const c = h('canvas', { width: 256 * k, height: 256 * k, class: 'm16-pick sheet-fill', 'data-page': String(p) });
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      let sheet: HTMLCanvasElement | null = null;
      const pageSheet = () => sheet ??= animateSheet(app, renderMap16Sheet(app, false, base, 256), false, base, c, () => draw(...shownRect));
      // page plus the chosen rectangle of tiles (x, y, w, h in cells); drawn again as the animation goes on
      let shownRect: [number, number, number, number] = [-1, 0, 0, 0];
      const draw = (x: number, y: number, w: number, hh: number) => {
        shownRect = [x, y, w, hh];
        ctx.drawImage(pageSheet(), 0, 0, c.width, c.height);
        drawTileMatches(ctx, this.m16Match, base, 256, S);
        if (x < 0) return;
        ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 2;
        ctx.strokeRect(x * S, y * S, w * S, hh * S);
      };
      const sel = curTile - base;
      const shown = () => (sel >= 0 && sel < 256 ? draw(sel & 15, sel >> 4, bw, bh) : draw(-1, 0, 0, 0));
      draws.set(c, shown);
      observer.observe(c);
      // click picks a tile, dragging picks a rectangle of tiles
      attachRectPick(c, 16, 16, (r) => draw(r.x, r.y, r.w, r.h), (r) => {
        this.m16Match = null;
        if (app.mode !== 'l1' && app.mode !== 'l2') app.setMode('l1');
        app.choosePickedItem({ kind: 'obj', num: 0, ext: DM16_EXT, size: 0, tile: base + r.y * 16 + r.x, ...(r.w * r.h > 1 ? { block: { w: r.w, h: r.h } } : {}) });
      }, (x, y) => app.editMap16(base + y * 16 + x));
      previewSheet(c, pageSheet, 16, 16, 16, scale, (r) => {
        const t = base + r.y * 16 + r.x;
        if (r.w * r.h > 1) return [`Block ${r.w}×${r.h} from tile ${hex3(t)}`];
        const pr = app.probes.block(t), name = nameOf(app.rom, 'fg', t);
        return [`Tile ${hex3(t)}${name ? ` “${name}”` : ''}`, pr ? probeText(pr) : 'determining behavior …', 'Ctrl+click: edit in the Map16 tab'];
      }, (r) => {
        const t = base + r.y * 16 + r.x, tiles = Array.from({ length: r.w * r.h }, (_, i) => t + Math.floor(i / r.w) * 16 + (i % r.w));
        tiles.forEach((u) => app.probes.collision(u)); // asked for; shown once known (the next move of the mouse)
        return entryLegend(app, { items: blockSprites(app, tiles), enter: blockEnter(app, tiles), marks: blockMarks(app, tiles), switches: blockSwitches(app, tiles) });
      });
      if (scale < PREVIEW_BELOW) { this.body.append(h('div', { class: 'picker-head m16-page-head', 'data-page': String(p) }, `Page ${p.toString(16).toUpperCase()}`), c); continue; }
      c.addEventListener('mousemove', (e) => {
        const rc = c.getBoundingClientRect();
        const x = Math.floor((e.clientX - rc.left) / (rc.width / 16)), y = Math.floor((e.clientY - rc.top) / (rc.height / 16));
        const t = base + Math.min(15, y) * 16 + Math.min(15, x);
        if (t !== hoverTile || c !== hoverCanvas) { hoverTile = t; hoverCanvas = c; tip(); }
      });
      this.body.append(h('div', { class: 'picker-head m16-page-head', 'data-page': String(p) }, `Page ${p.toString(16).toUpperCase()}`), c);
    }
    // back to where the list was; the pages in view are drawn right away so nothing flickers
    this.body.scrollTop = this.scrolls.m16;
    const top = this.body.scrollTop, bottom = top + this.body.clientHeight;
    for (const [c, draw] of draws) {
      const y = (c as HTMLElement).offsetTop - this.body.offsetTop;
      if (y + (c as HTMLElement).offsetHeight < top || y > bottom) continue;
      draw();
      draws.delete(c);
      observer.unobserve(c);
    }
    this.m16Scrolled();
  }

  // prefabs: blocks of Map16 tiles stored in the ROM, placed as one object each (prefabs.ts); the first section
  // of the Objects tab, shown with its hint even without prefabs, then the suggestions
  buildPrefabs(): void {
    const app = this.app, box = this.prefabBox;
    clear(box);
    const cur = app.pickedItem;
    const curN = cur?.kind === 'obj' && cur.num === 0 && cur.ext === PREFAB_EXT ? cur.prefab ?? -1 : -1;
    box.append(h('div', { class: 'picker-head' }, 'Prefabs'), h('div', { class: 'hint' }, 'A prefab is a stamp of Map16 tiles, placed as one object; editing it changes every copy.'));
    const all = app.prefabs();
    const sheet = prefabTileSource(app);
    const grid = h('div', { class: 'picker-grid' });
    for (const [n, st] of all) {
      const th = prefabThumb(app, sheet, st);
      const title = `Prefab ${hex2(n)}: ${st.name || '(unnamed)'}, ${st.w}×${st.h}`;
      const cell = grid.appendChild(h('div', {
        class: `picker-cell${n === curN ? ' selected' : ''}`, title: `${title}\nRight click: rename (F2), delete (Del)`,
        oncontextmenu: (ev: MouseEvent) => {
          ev.preventDefault();
          contextMenu(ev.clientX, ev.clientY, [{ heading: `Prefab ${hex2(n)}` },
            { label: 'Rename …', shortcut: 'F2', onClick: () => renamePrefab(app, n, st) },
            { label: 'Delete …', shortcut: 'Del', onClick: () => deletePrefab(app, n, st) }]);
        },
        onclick: () => { if (app.mode !== 'l1' && app.mode !== 'l2') app.setMode('l1'); app.choosePickedItem({ kind: 'obj', num: 0, ext: PREFAB_EXT, size: 0, prefab: n }); },
      }, h('div', { class: 'picker-img' }, th.c),
        h('div', { class: 'picker-label' }, hex2(n)), h('div', { class: 'picker-name' }, st.name || '(unnamed)')));
      this.keysOn(cell, () => renamePrefab(app, n, st), () => deletePrefab(app, n, st));
      previewOnHover(cell, th.scale, () => animatedPrefab(app, sheet, st), () => [`Prefab ${hex2(n)}: ${st.name || '(unnamed)'}`, `${st.w}×${st.h} tiles`, 'Right click: rename (F2), delete (Del)']);
    }
    if (grid.firstChild) box.append(grid);
    const sug = app.prefabSuggestions ?? [];
    if (!sug.length) return;
    const sgrid = h('div', { class: 'picker-grid' });
    box.append(h('div', { class: 'picker-sub' }, 'Suggestions'), sgrid);
    for (const sg of sug) {
      const lvs = sg.levels.length > 4 ? `${sg.levels.slice(0, 4).map(hex3).join(', ')} +${sg.levels.length - 4}` : sg.levels.map(hex3).join(', ');
      const th = prefabThumb(app, sheet, sg.prefab);
      const cell = sgrid.appendChild(h('div', {
        class: 'picker-cell', title: `${sg.count} places of these Direct Map16 objects in level ${sg.levels.map(hex3).join(', ')}: save as prefab and replace them all`,
        onclick: () => openSavePrefab(app, { prefab: sg.prefab, places: app.suggestionsCurrent ? sg.places : undefined }),
      }, h('div', { class: 'picker-img' }, th.c),
        h('div', { class: 'picker-label' }, `${sg.count}×`), h('div', { class: 'picker-name' }, `level ${lvs}, saves ${sg.saved} byte${sg.saved === 1 ? '' : 's'}`)));
      previewOnHover(cell, th.scale, () => animatedPrefab(app, sheet, sg.prefab),
        () => [`${sg.count}× in level ${sg.levels.map(hex3).join(', ')}`, `Saves ${sg.saved} byte${sg.saved === 1 ? '' : 's'}: save as prefab and replace them all`]);
    }
  }

  // BG Map16 tiles for painting the level background (BG mode); pages 2-F with the extended BG Map16
  bgBase = 0;
  buildBg(): void {
    const app = this.app;
    const sheet = renderMap16Sheet(app, true, this.bgBase);
    let shownRect: [number, number, number, number] = [-1, 0, 0, 0];
    const brush = app.bgBrush;
    const t0 = brush.tiles[0] - this.bgBase;
    // a brush that is a rectangle of the sheet is outlined there, one picked from the level is shown separately
    const onSheet = t0 >= 0 && t0 < 0x200 && (t0 & 15) + brush.w <= 16 && (t0 >> 4) + brush.h <= 32
      && brush.tiles.every((t, i) => t === brush.tiles[0] + Math.floor(i / brush.w) * 16 + (i % brush.w));
    const k = this.builtPixels = this.sheetPixels(), S = 16 * k, scale = this.sheetShown();
    const c = h('canvas', { width: 256 * k, height: 512 * k, class: 'm16-pick sheet-fill', title: 'Click/drag: tile(s) as brush · Ctrl+click: edit in the Map16 tab' });
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const draw = (x: number, y: number, w: number, hh: number) => {
      shownRect = [x, y, w, hh];
      ctx.drawImage(sheet, 0, 0, c.width, c.height);
      if (x < 0) return;
      ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 2;
      ctx.strokeRect(x * S, y * S, w * S, hh * S);
    };
    animateSheet(app, sheet, true, this.bgBase, c, () => draw(...shownRect));
    if (onSheet) draw(t0 & 15, t0 >> 4, brush.w, brush.h); else draw(-1, 0, 0, 0);
    // click picks a tile, dragging picks a rectangle of tiles (as in the Map16 tab)
    attachRectPick(c, 16, 32, (r) => draw(r.x, r.y, r.w, r.h), (r) => {
      app.bgBrush = { w: r.w, h: r.h, tiles: Array.from({ length: r.w * r.h }, (_, i) => this.bgBase + (r.y + Math.floor(i / r.w)) * 16 + r.x + (i % r.w)) };
      this.build();
    }, (x, y) => app.editMap16(this.bgBase + y * 16 + x, true));
    previewSheet(c, () => sheet, 16, 32, 16, scale, (r) => {
      const t = this.bgBase + r.y * 16 + r.x, name = nameOf(app.rom, 'bg', t);
      return r.w * r.h > 1 ? [`Block ${r.w}×${r.h} from BG tile ${hex3(t)}`] : [`BG tile ${hex3(t)}${name ? ` “${name}”` : ''}`, 'Ctrl+click: edit in the Map16 tab'];
    });
    const what = brush.tiles.length > 1 ? `Block ${brush.w}×${brush.h}${onSheet ? ` from BG tile ${hex3(brush.tiles[0])}` : ' from the level'}` : `BG tile ${hex3(brush.tiles[0])}`;
    const pages = h('select', null, Array.from({ length: EXT_TILES / 512 }, (_, i) => h('option', { value: String(i * 512), selected: i * 512 === this.bgBase },
      i === 0 ? 'Pages 0–1' : `Pages ${(2 * i).toString(16).toUpperCase()}–${(2 * i + 1).toString(16).toUpperCase()}`)));
    pages.addEventListener('change', () => { this.bgBase = Number(pages.value); this.build(); });
    // same order as the Map16 tab: pages, state, sheet
    this.body.append(h('div', { class: 'row' }, pages,
      h('button', { title: 'Edit BG tiles in the graphics area (also create tiles from 200 on)', onclick: () => app.editMap16(onSheet ? brush.tiles[0] : this.bgBase, true) }, 'Edit …')),
    h('div', { class: 'hint' }, `Brush: ${what} – click tiles here or in the level (drag: block). The BG tilemap (32×27) repeats.`));
    if (!onSheet) {
      const p = h('canvas', { width: brush.w * 16, height: brush.h * 16, class: 'bg-brush' });
      const pc = p.getContext('2d')!;
      const tc = new TileCache(app.render.vram, app.render.cgram, (app.render.ppuRegs[0x0b] >> 4) << 13);
      const img = pc.createImageData(brush.w * 16, brush.h * 16), px = new Uint32Array(img.data.buffer);
      const src = map16Source(app.rom, app.render);
      brush.tiles.forEach((t, i) => drawMap16(px, brush.w * 16, brush.h * 16, tc, src.bg(t), (i % brush.w) * 16, Math.floor(i / brush.w) * 16));
      pc.putImageData(img, 0, 0);
      sized(p, fitScale(p.width, p.height, 256 * scale, 256 * scale, scale));
      this.body.append(h('div', { class: 'row' }, p));
    }
    this.body.append(c);
  }

  // layer 3: its 8x8 tiles (2bpp, as in VRAM) as brush, with palette, priority and flips (tilemap word bits
  // 10-12, 13, 14-15); a brush picked from the level keeps each tile's own
  buildL3(): void {
    const app = this.app, r = app.render, b = app.l3Brush, w0 = b.tiles[0];
    const attr = w0 & ~L3_TILE, pal = l3Palette(w0);
    const tc = new TileCache(r.vram, r.cgram, (r.ppuRegs[0x0c] & 0x0f) << 13);
    const setBrush = (nb: typeof b) => { app.l3Brush = nb; this.build(); };
    const each = (f: (w: number) => number) => setBrush({ ...b, tiles: b.tiles.map(f) });
    const draw = (px: Uint32Array, width: number, word: number, x: number, y: number) => {
      const t = tc.get(word, 2);
      for (let k = 0; k < 64; k++) px[(y + (k >> 3)) * width + x + (k & 7)] = t[k] || 0xff282828;
    };
    // a brush that is a rectangle of the sheet (one palette, priority, no flips) is outlined there
    const onSheet = !(attr & (L3_FLIP_X | L3_FLIP_Y)) && (w0 & L3_TILE) < 0x200 && (w0 & 15) + b.w <= 16
      && b.tiles.every((t, i) => t === w0 + Math.floor(i / b.w) * 16 + (i % b.w));
    const S = this.builtPixels = this.sheetPixels(), scale = this.sheetShown();
    const c = h('canvas', { width: 128 * S, height: 256 * S, class: 'm16-pick sheet-fill', title: 'Click/drag: tile(s) as brush' });
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const sheet = document.createElement('canvas');
    sheet.width = 128; sheet.height = 256;
    const sctx = sheet.getContext('2d')!, img = sctx.createImageData(128, 256), px = new Uint32Array(img.data.buffer);
    for (let t = 0; t < 0x200; t++) draw(px, 128, t | (pal << 10), (t & 15) * 8, (t >> 4) * 8);
    sctx.putImageData(img, 0, 0);
    const show = (x: number, y: number, w: number, hh: number) => {
      ctx.drawImage(sheet, 0, 0, c.width, c.height);
      if (x < 0) return;
      ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 2;
      ctx.strokeRect(x * 8 * S, y * 8 * S, w * 8 * S, hh * 8 * S);
    };
    if (onSheet) show(w0 & 15, (w0 & L3_TILE) >> 4, b.w, b.h); else show(-1, 0, 0, 0);
    attachRectPick(c, 16, 32, (q) => show(q.x, q.y, q.w, q.h), (q) =>
      setBrush({ w: q.w, h: q.h, tiles: Array.from({ length: q.w * q.h }, (_, i) => ((q.y + Math.floor(i / q.w)) * 16 + q.x + (i % q.w)) | (attr & (L3_PAL | L3_PRIO))) }));
    previewSheet(c, () => sheet, 16, 32, 8, scale, (q) => [q.w * q.h > 1 ? `Block ${q.w}×${q.h} from tile ${hex3(q.y * 16 + q.x)}` : `Tile ${hex3(q.y * 16 + q.x)}`]);
    const palSel = h('select', { title: 'Palette (colors 4 × n – 4 × n + 3)' }, Array.from({ length: 8 }, (_, i) => h('option', { value: String(i), selected: i === pal }, `Palette ${i}`)));
    palSel.addEventListener('change', () => { const p = Number(palSel.value); each((w) => withL3Palette(w, p)); });
    const prio = h('input', { type: 'checkbox', checked: !!(w0 & L3_PRIO) }) as HTMLInputElement;
    prio.addEventListener('change', () => each((w) => (prio.checked ? w | L3_PRIO : w & ~L3_PRIO)));
    const flip = (bit: number) => setBrush({
      w: b.w, h: b.h,
      tiles: b.tiles.map((_, i) => {
        const x = i % b.w, y = Math.floor(i / b.w);
        return b.tiles[bit === L3_FLIP_X ? y * b.w + (b.w - 1 - x) : (b.h - 1 - y) * b.w + x] ^ bit;
      }),
    });
    const t = lt3Target(app.rom, app.level.number);
    const others = t.file === null ? [] : lt3Users(app.rom, t.file).filter((n) => n !== app.level.number);
    const where = t.file === null
      ? 'Saved with the level into a new layer 3 tilemap file (ExGFX, LT3 in the Graphics tab), under the status bar.'
      : `Saved with the level into its layer 3 tilemap file, ExGFX ${hex2(t.file)} (LT3: ${LT3_DESTS[t.place.dest].toLowerCase()})${others.length ? ` – also used by level${others.length > 1 ? 's' : ''} ${others.map((n) => hex3(n)).join(', ')}` : ''}.`;
    const what = b.tiles.length > 1 ? `Block ${b.w}×${b.h}${onSheet ? ` from tile ${hex3(w0 & L3_TILE)}` : ' from the level'}` : `Tile ${hex3(w0 & L3_TILE)}`;
    this.body.append(
      h('div', { class: 'row' }, palSel, h('label', { class: 'row small', title: 'In front of layers 1 and 2 (tilemap priority)' }, prio, 'Priority'),
        h('button', { title: 'Mirror the brush horizontally', onclick: () => flip(L3_FLIP_X) }, 'Flip X'),
        h('button', { title: 'Mirror the brush vertically', onclick: () => flip(L3_FLIP_Y) }, 'Flip Y'),
        h('button', { title: 'Paint with a tile without visible pixels', onclick: () => setBrush({ w: 1, h: 1, tiles: [blankLayer3Tile(r)] }) }, 'Erase')),
      h('div', { class: 'hint' }, `Brush: ${what} – click tiles here or in the level (drag: block). ${where} Layer 3 shows where it is when the level starts.`));
    if (!onSheet) {
      const p = h('canvas', { width: b.w * 8, height: b.h * 8, class: 'bg-brush' });
      const pc = p.getContext('2d')!, pimg = pc.createImageData(b.w * 8, b.h * 8), ppx = new Uint32Array(pimg.data.buffer);
      b.tiles.forEach((w, i) => draw(ppx, b.w * 8, w, (i % b.w) * 8, Math.floor(i / b.w) * 8));
      pc.putImageData(pimg, 0, 0);
      sized(p, fitScale(p.width, p.height, 128 * scale, 128 * scale, scale));
      this.body.append(h('div', { class: 'row' }, p));
    }
    this.body.append(c);
  }

  // standard objects (with their types), extended objects 10–FF and, where the ROM reads object 2D with an
  // extension (obj2d.ts), its custom numbers 00–FF instead of a plain 2D
  specs(): ObjSpec[] {
    const s: ObjSpec[] = [];
    const len2d = objectLength2D(this.app.rom);
    for (let n = 1; n < 0x40; n++) {
      if (n === OBJ_2D && len2d > 3) continue;
      const k = this.app.objectKind(n);
      if (!k?.type) { s.push({ num: n, ext: 0, size: 0x11 }); continue; }
      for (let t = 0; t < k.count; t++) s.push({ num: n, ext: 0, size: withObjectVariant(k, 0x11, t) });
    }
    for (let e = 0x10; e < 0x100; e++) s.push({ num: 0, ext: e, size: 0 });
    if (len2d > 3) for (let c = 0; c < 0x100; c++) s.push({ num: OBJ_2D, ext: 0, size: 0, extension: Array.from({ length: len2d - 3 }, (_, i) => (i ? 0 : c)) });
    return s;
  }

  // the thumbnails as known now; whether they changed
  ensureThumbs(): boolean {
    const thumbs = this.app.objectThumbs(this.specs());
    if (thumbs === this.thumbsFrom) return false;
    this.thumbsFrom = thumbs;
    this.thumbTiles = new Map();
    this.thumbs = new Map();
    this.effects = new Map();
    this.boxes = new Map();
    for (const t of thumbs ?? []) {
      if (t.effect) { this.effects.set(t.key, t.effect); continue; }
      const c = thumbCanvas(t);
      this.thumbs.set(t.key, c);
      // its copies in the picker, the search and the hover preview follow the animation
      animateTiles(this.app, c, t.cells, { alive: () => this.thumbsFrom === thumbs });
      this.thumbTiles.set(t.key, t.m16);
    }
    if (thumbs) this.app.probes.prefetch([...this.thumbTiles.values()].flat());
    return true;
  }

  // the standard objects (with their types), the extended objects or object 2D's custom numbers as listed in the
  // tab; `text` is what the search looks in (lower case): number, name, Map16 tiles and what they do when hit or
  // entered (emulated, see blockprobe.ts), which tells apart objects that look the same, like pipes with and
  // without an entrance, and the tooltip – a package's (Lunar Magic's .osc, objtext.ts), else for an object that
  // draws nothing what its load changes. Such an object's thumbnail is its box of the level view (objbox.ts).
  objectEntries(section: ObjSection) {
    const app = this.app;
    const out = [];
    for (const s of this.specs()) {
      if (section !== (s.extension ? 'custom' : s.num === 0 ? 'ext' : 'obj')) continue;
      const kind = app.objectKind(s.num), key = objKey(s, kind);
      const vt = s.extension ? -1 : objectVariant(kind, s.size);
      const name = s.extension ? `Custom object ${hex2(s.extension[0])}` : app.objectName(s.num, s.ext) + (vt >= 0 ? ` – type ${vt.toString(16).toUpperCase()}` : '');
      const label = s.extension ? `${hex2(s.num)}.${hex2(s.extension[0])}` : s.num ? hex2(s.num) + (vt >= 0 ? `.${vt.toString(16).toUpperCase()}` : '') : hex2(s.ext);
      const tiles = this.thumbTiles.get(key) ?? [];
      const sum = tiles.length ? blockSummary(app, tiles) : [];
      const effect = this.effects.get(key);
      const tip = objectTooltip(app.rom, s.num, s.extension?.[0] ?? s.ext);
      const marks = blockMarks(app, tiles), switches = blockSwitches(app, tiles);
      const info = (tiles.length ? `\nMap16 ${tiles.slice(0, 8).map(hex3).join(' ')}${tiles.length > 8 ? ' …' : ''}` : '')
        + (tip ? '\n' + tip : effect ? `\nDraws nothing; when the level loads, it ${effect}` : '')
        + (sum === undefined ? '\n(determining behavior …)' : sum.map((x) => '\n' + x).join(''));
      if (effect && !this.boxes.has(key)) this.boxes.set(key, objectBoxCanvas(boxLabel(s)));
      const th = this.thumbs.get(key) ?? this.boxes.get(key);
      // invalid extended objects and custom numbers produce nothing
      if (!th && !effect && section !== 'obj' && this.thumbsFrom) continue;
      out.push({
        s, vt, label, name, th, title: `${label}: ${name}${info}`, behavior: sum?.join(' · ') ?? '', text: `${label} ${name} ${info} ${marks.map((m) => MARK_TEXT[m]).join(' ')} ${switches.map((x) => `${SWITCH_NAME[x.sw]} ${x.text}`).join(' ')}`.toLowerCase(),
        items: blockSprites(app, tiles), enter: blockEnter(app, tiles), marks, switches,
        item: { kind: 'obj', num: s.num, ext: s.ext, size: s.size, ...(s.extension ? { extension: [...s.extension] } : {}) } as PickedItem,
      });
    }
    return out;
  }

  // original sprites 00-E6, then the custom sprites of the ROM (PIXI, ids $2xx/$3xx); `text` for the search
  // includes what the sprite gives when hit from below or jumped on (emulated, see blockprobe.ts)
  spriteEntries() {
    const app = this.app;
    const custom = app.customSprites().filter((c) => c.listed);
    return [...Array.from({ length: 0xe7 }, (_, i) => i), ...custom.map((c) => c.id)].map((id) => {
      const n = id & 0xff, extra = id >> 8;
      const name = app.spriteLabel(id);
      const p = app.probes.sprite(id);
      const info = p?.summary ?? '';
      const num = id >= 0x200 ? `C${hex2(n)}` : hex2(n);
      return {
        id, num, name, info, items: p ? [...new Set(p.pos.flatMap(spritesOf))] : [],
        title: [`${num}: ${name}`, info, app.customSprite(id)?.description].filter(Boolean).join('\n'),
        text: `${hex2(n)} ${num} ${name} ${info}${id >= 0x200 ? ' custom' : ''}`.toLowerCase(),
        item: { kind: 'spr', num: n, extra } as PickedItem,
      };
    });
  }

  // shows an item in its tab, chosen as the picked item (from the central search)
  choose(tab: PickerTab, item: PickedItem): void {
    const app = this.app;
    if (tab === 'spr' ? app.mode !== 'spr' : app.mode !== 'l1' && app.mode !== 'l2') app.setMode(tab === 'spr' ? 'spr' : 'l1');
    this.tab = tab;
    this.m16Match = null;
    app.choosePickedItem(item);
    requestAnimationFrame(() => this.scrollToSelected());
  }

  // the tiles of a name (central search): taken as a block (FG) or brush (BG) when they fill a rectangle, else
  // the first; the FG sheet marks exactly them
  chooseNamed(name: string, tiles: number[], bg: boolean): void {
    const app = this.app, c = connectedRect(tiles);
    const r = c && c.w * c.h === tiles.length ? c : { first: tiles[0], w: 1, h: 1 };
    if (!bg) {
      this.choose('m16', { kind: 'obj', num: 0, ext: DM16_EXT, size: 0, tile: r.first, ...(r.w * r.h > 1 ? { block: { w: r.w, h: r.h } } : {}) });
      this.m16Match = tiles;
      this.build();
      return;
    }
    if (app.mode !== 'bg') app.setMode('bg'); // (says why not when the level has no BG tilemap)
    if (app.mode !== 'bg') return;
    this.bgBase = r.first & ~0x1ff;
    app.bgBrush = { w: r.w, h: r.h, tiles: Array.from({ length: r.w * r.h }, (_, i) => r.first + Math.floor(i / r.w) * 16 + (i % r.w)) };
    this.build();
  }

  // the tabs for the central search (search.ts)
  searchProviders(): SearchProvider[] {
    const app = this.app;
    // the named FG and BG tiles: one result per name, its preview the rectangle around the tiles when they are
    // connected, else the first tile
    const named = (terms: string[]) => (['fg', 'bg'] as NameKind[]).flatMap((kind) => {
      const bg = kind === 'bg', layer = kind.toUpperCase();
      return nameGroups(namesOf(app.rom, kind)).filter((g) => matchesAll(g.name.toLowerCase(), terms)).map((g): SearchResult => {
        const nums = tileRanges(g.tiles);
        return {
          label: layer, name: g.name, detail: nums,
          title: `${layer} tile${g.tiles.length > 1 ? 's' : ''} ${nums}: ${g.name}`,
          thumb: () => {
            const r = connectedRect(g.tiles) ?? { first: g.tiles[0], w: 1, h: 1 };
            const sheet = renderMap16Sheet(app, bg, r.first & ~15, r.h * 16);
            const c = h('canvas', { width: r.w * 16, height: r.h * 16 });
            c.getContext('2d')!.drawImage(sheet, (r.first & 15) * 16, 0, r.w * 16, r.h * 16, 0, 0, r.w * 16, r.h * 16);
            const z = Math.min(1.5, 32 / (r.w * 16), 24 / (r.h * 16));
            c.style.width = `${r.w * 16 * z}px`;
            c.style.height = `${r.h * 16 * z}px`;
            return c;
          },
          pick: () => this.chooseNamed(g.name, g.tiles, bg),
        };
      });
    });
    // Map16: first the tiles the user named, then tiles by number (the rules of the tab's tile search), by what
    // they do (finished probes only) or by the file of the custom block on them
    const map16: SearchProvider = {
      id: 'm16', label: 'Map16',
      search: (terms) => {
        const nums = terms.map((t) => new Set(tileMatches(t, EXT_TILES) ?? []));
        const sheets = new Map<number, HTMLCanvasElement>();
        const files = blockFilesByTile(app.rom);
        const out: SearchResult[] = named(terms);
        for (let t = 0; t < EXT_TILES; t++) {
          const p = app.cachedBlock(t);
          const text = p ? probeText(p) : '';
          const file = files.get(t);
          const low = `${text} ${file ?? ''}`.toLowerCase();
          if (!terms.every((x, i) => nums[i].has(t) || low.includes(x))) continue;
          out.push({
            label: hex3(t), name: text, detail: file ?? undefined, title: `Tile ${hex3(t)}${text ? `: ${text}` : ''}${file ? `\nCustom block: ${file}` : ''}`,
            thumb: () => {
              const page = t >> 8;
              if (!sheets.has(page)) sheets.set(page, renderMap16Sheet(app, false, page * 256, 256));
              const c = h('canvas', { width: 16, height: 16 });
              c.getContext('2d')!.drawImage(sheets.get(page)!, (t & 15) * 16, ((t & 0xff) >> 4) * 16, 16, 16, 0, 0, 16, 16);
              c.style.width = c.style.height = '24px';
              return c;
            },
            pick: () => this.choose('m16', { kind: 'obj', num: 0, ext: DM16_EXT, size: 0, tile: t }),
          });
        }
        return out;
      },
    };
    // the Objects tab in one group, in its order: Prefabs, Resizable, Fixed size, Custom; the section is named
    // after the number (and found by its name)
    const objects: SearchProvider = {
      id: 'obj', label: 'Objects',
      search: (terms) => {
        const sheet = prefabTileSource(app);
        const prefabs = [...app.prefabs()].filter(([n, st]) => matchesAll(`${hex2(n)} ${st.name} prefab`.toLowerCase(), terms)).map(([n, st]): SearchResult => ({
          label: hex2(n), name: `${st.name || '(unnamed)'} ${st.w}×${st.h}`, detail: 'Prefab', title: `Prefab ${hex2(n)}: ${st.name || '(unnamed)'}, ${st.w}×${st.h}`,
          thumb: () => animatedPrefab(app, sheet, st),
          pick: () => this.choose('obj', { kind: 'obj', num: 0, ext: PREFAB_EXT, size: 0, prefab: n }),
        }));
        this.ensureThumbs();
        const sections = ([['obj', 'Resizable'], ['ext', 'Fixed size'], ['custom', 'Custom']] as const).flatMap(([id, section]) =>
          this.objectEntries(id).filter((e) => matchesAll(`${e.text} ${section.toLowerCase()}`, terms)).map((e): SearchResult => ({
            label: e.label, name: e.name, detail: e.behavior ? `${section} · ${e.behavior}` : section, title: `${section}: ${e.title}`,
            thumb: () => (e.th ? cloneCanvas(e.th) : null), pick: () => this.choose('obj', e.item),
          })));
        return [...prefabs, ...sections];
      },
    };
    const sprites: SearchProvider = {
      id: 'spr', label: 'Sprites',
      search: (terms) => this.spriteEntries().filter((e) => matchesAll(e.text, terms)).map((e) => ({
        label: e.num, name: e.name, detail: e.info, title: e.title,
        thumb: () => { const img = app.spriteThumbs?.get(e.id); return img ? cloneCanvas(img) : null; },
        pick: () => this.choose('spr', e.item),
      })),
    };
    // in the order of the picker: Objects, Map16, Sprites
    return [objects, map16, sprites];
  }

  // the sheet of the current tab or brush mode fills the picker's width (layer 3's 8x8 tiles: half as wide as
  // the Map16 pages): the screen pixels per pixel it is drawn at, the size it is shown at
  sheetPixels(): number {
    return fillPixels(this.body.clientWidth, this.app.mode === 'l3' ? 128 : 256);
  }
  sheetShown(): number {
    return this.body.clientWidth / (this.app.mode === 'l3' ? 128 : 256);
  }

  build(): void {
    const app = this.app;
    hidePickerPreview(this.body);
    this.builtPixels = 0;
    clear(this.tabs);
    const brush = isBrushMode(app.mode);
    this.m16Bar.style.display = !brush && this.tab === 'm16' ? '' : 'none';
    // the list being left keeps its scroll position (read here: the scroll event may still be pending)
    if (this.builtTab) this.scrolls[this.builtTab] = this.body.scrollTop;
    this.builtTab = brush ? undefined : this.tab;
    if (app.mode === 'bg') { clear(this.body); this.buildBg(); return; }
    if (app.mode === 'l3') { clear(this.body); this.buildL3(); return; }
    const tabDefs: [typeof this.tab, string][] = [['obj', 'Objects'], ['m16', 'Map16'], ['spr', 'Sprites']];
    for (const [t, l] of tabDefs) this.tabs.appendChild(h('button', { class: this.tab === t ? 'active' : '', onclick: () => { this.tab = t; this.build(); } }, l));
    clear(this.body);
    if (this.tab === 'm16') { this.buildMap16(); return; }
    if (this.tab === 'spr') this.buildSprites(); else this.buildObjects();
    this.body.scrollTop = this.scrolls[this.tab];
  }

  buildSprites(): void {
    const app = this.app;
    const cur = app.pickedItem;
    let grid = this.body.appendChild(h('div', { class: 'picker-grid' }));
    for (const e of this.spriteEntries()) {
      if (e.id >= 0x200 && !grid.dataset.custom) {
        this.body.append(h('div', { class: 'picker-head' }, 'Custom sprites (PIXI)'));
        grid = this.body.appendChild(h('div', { class: 'picker-grid', 'data-custom': '1' }));
      }
      const sel = cur?.kind === 'spr' && spriteId(cur) === e.id;
      const img = app.spriteThumbs?.get(e.id);
      const th = img ? thumbAt(img) : null;
      const unused = e.id >= 0x200 && app.customSprite(e.id) && !app.spriteUsers(e.id).length;
      const cell = grid.appendChild(h('div', {
        class: `picker-cell${sel ? ' selected' : ''}`, title: e.title,
        onclick: () => { if (app.mode !== 'spr') app.setMode('spr'); app.choosePickedItem(e.item); },
      }, h('div', { class: 'picker-img' }, th?.c ?? h('span', { class: 'none' }, '–'),
        h('div', { class: 'picker-corner' }, itemBadge(app, e.items), unused ? h('span', { class: 'gt-unused', title: 'Inserted, but in no level' }, 'unused') : '')),
        h('div', { class: 'picker-label' }, e.num), h('div', { class: 'picker-name' }, e.name)));
      if (img) previewOnHover(cell, th!.scale, () => cloneCanvas(img), () => e.title.split('\n'), () => entryLegend(app, e));
    }
  }

  // F2 (rename) and Del (delete) act on the cell under the mouse
  keysOn(el: HTMLElement, rename: () => void, del?: () => void): void {
    el.addEventListener('mouseenter', () => { this.hovered = { el, rename, del }; });
    el.addEventListener('mouseleave', () => { if (this.hovered?.el === el) this.hovered = null; });
  }

  // a key for the hovered cell; true when it was used
  key(e: KeyboardEvent): boolean {
    const hv = this.hovered;
    if (!hv?.el.isConnected || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
    if (e.key === 'F2') hv.rename();
    else if (e.key === 'Delete' && hv.del) hv.del();
    else return false;
    hidePickerPreview(hv.el);
    return true;
  }

  // the Objects tab: Prefabs, Resizable (standard objects), Fixed size (extended objects), Custom (object 2D's
  // custom numbers); a section without entries is left out (Prefabs keeps its button and hint)
  buildObjects(): void {
    const app = this.app;
    const cur = app.pickedItem;
    this.body.append(this.prefabBox);
    this.buildPrefabs();
    for (const [section, title] of [['obj', 'Resizable'], ['ext', 'Fixed size'], ['custom', 'Custom']] as const) {
      const grid = h('div', { class: 'picker-grid' });
      for (const e of this.objectEntries(section)) {
        const { s, vt } = e;
        const sel = cur?.kind === 'obj' && cur.num === s.num && (s.num !== 0 || cur.ext === s.ext)
          && (s.extension ? cur.extension?.[0] === s.extension[0] : objectVariant(app.objectKind(s.num), cur.size) === vt);
        const th = e.th ? thumbAt(e.th) : null;
        // (custom numbers have no name of their own: renaming would rename object 2D)
        const renames = !s.extension, hint = renames ? '\nRight click: rename (F2)' : '';
        const cell = grid.appendChild(h('div', {
          class: `picker-cell${sel ? ' selected' : ''}`, title: e.title + hint,
          oncontextmenu: (ev: MouseEvent) => {
            ev.preventDefault();
            if (renames) contextMenu(ev.clientX, ev.clientY, [{ heading: app.objectName(s.num, s.ext) }, { label: 'Rename …', shortcut: 'F2', onClick: () => renameObject(app, s.num, s.ext) }]);
          },
          onclick: () => {
            if (app.mode !== 'l1' && app.mode !== 'l2') app.setMode('l1');
            app.choosePickedItem(e.item);
          },
        }, h('div', { class: 'picker-img' }, th?.c ?? h('span', { class: 'none' }, '–'),
          h('div', { class: 'picker-corner' }, itemBadge(app, e.items), e.enter ? h('div', { class: 'picker-enter', title: enterText(e.enter) }, e.enter) : '',
            e.marks.length || e.switches.length ? h('div', { class: 'picker-items', title: [...e.marks.map((m) => MARK_TEXT[m]), ...e.switches.map((x) => `${SWITCH_NAME[x.sw]}: ${x.text}`)].join('\n') },
              ...e.marks.map(markCanvas), ...e.switches.map((x) => switchCanvas(x.sw))) : '')),
          h('div', { class: 'picker-label' }, e.label), h('div', { class: 'picker-name' }, s.extension ? e.name : app.objectName(s.num, s.ext))));
        if (renames) this.keysOn(cell, () => renameObject(app, s.num, s.ext));
        if (e.th) previewOnHover(cell, th!.scale, () => cloneCanvas(e.th!), () => (e.title + hint).split('\n'), () => entryLegend(app, e));
      }
      if (!grid.firstChild) continue;
      this.body.append(h('div', { class: 'picker-head' }, title), grid);
    }
  }
}

type ObjSection = 'obj' | 'ext' | 'custom'; // the Objects tab's sections (Resizable, Fixed size, Custom)

// ---------------- prefabs ----------------
function prefabTileSource(app: App): (t: number) => HTMLCanvasElement | null {
  const r = app.render;
  const tc = new TileCache(r.vram, r.cgram, (r.ppuRegs[0x0b] & 0x0f) << 13);
  const src = map16Source(app.rom, r);
  const cache = new Map<number, HTMLCanvasElement>();
  return (t) => {
    let c = cache.get(t);
    if (!c) {
      c = document.createElement('canvas');
      c.width = 16; c.height = 16;
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(16, 16);
      drawMap16(new Uint32Array(img.data.buffer), 16, 16, tc, src.fg(t), 0, 0);
      ctx.putImageData(img, 0, 0);
      cache.set(t, c);
    }
    return c;
  };
}

// a picker cell's image (a copy of `img`) at the size it fits the cell's image box at
const CELL_W = 96, CELL_H = 62;
function thumbAt(img: HTMLCanvasElement): { c: HTMLCanvasElement; scale: number } {
  const scale = fitScale(img.width, img.height, CELL_W, CELL_H);
  return { c: sized(cloneCanvas(img), scale), scale };
}

// a prefab's image in a picker cell at the size it fits there
function prefabThumb(app: App, tile: (t: number) => HTMLCanvasElement | null, st: Prefab): { c: HTMLCanvasElement; scale: number } {
  const c = animatedPrefab(app, tile, st), scale = fitScale(c.width, c.height, CELL_W, CELL_H);
  return { c: sized(c, scale), scale };
}

// prefabCanvas following the level's animation while shown
function animatedPrefab(app: App, tile: (t: number) => HTMLCanvasElement | null, st: Prefab): HTMLCanvasElement {
  const c = prefabCanvas(tile, st);
  animateTiles(app, c, st.tiles.flatMap((t, i) => (t === TRANSPARENT ? [] : [(i % st.w) * 16, Math.floor(i / st.w) * 16, t])), { on: c });
  return c;
}

// image of a prefab in the current level's graphics; transparent cells stay empty
export function prefabCanvas(tile: (t: number) => HTMLCanvasElement | null, st: Prefab): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = st.w * 16; c.height = st.h * 16;
  const ctx = c.getContext('2d')!;
  st.tiles.forEach((t, i) => { const img = t === TRANSPARENT ? null : tile(t); if (img) ctx.drawImage(img, (i % st.w) * 16, Math.floor(i / st.w) * 16); });
  return c;
}

// the selected objects as a new prefab, or over an existing one; or a suggestion's arrangement (from), with its
// places when they are current (else found anew)
// whether o is a placed prefab (saving it alone as prefab would only copy one)
export function isPlacedPrefab(o: LevelObject): boolean {
  return o.num === 0 && o.ext === PREFAB_EXT && o.prefab !== undefined;
}

export function openSavePrefab(app: App, sug?: { prefab: Prefab; places?: LevelPlaces[] }): void {
  const from = sug?.prefab;
  const r = from ?? app.prefabFromSelection();
  if (typeof r === 'string') { toast(r, 'error'); return; }
  const free = freePrefabNumber(app.rom);
  const all = app.prefabs();
  const name = h('input', { value: '', placeholder: 'Name', spellcheck: false });
  const target = h('select', null,
    free >= 0 ? h('option', { value: String(free) }, `New prefab ${hex2(free)}`) : '',
    ...[...all].map(([n, st]) => h('option', { value: String(n) }, `Replace ${hex2(n)}: ${st.name || '(unnamed)'}`)));
  const replace = h('input', { type: 'checkbox', checked: true });
  const preview = prefabCanvas(prefabTileSource(app), { ...r, name: '' });
  preview.style.cssText = `width:${Math.min(r.w * 32, 320)}px;image-rendering:pixelated;background:repeating-conic-gradient(#333 0 25%,#222 0 50%) 0 0/16px 16px`;
  const note = h('div', { class: 'hint' });
  // what the prefab costs and saves against the same tiles as Direct Map16 objects (prefabcost.ts); the name is part of it
  const cost = h('div', { class: 'hint' });
  const updCost = () => {
    const c = prefabCost({ ...r, name: name.value.trim() });
    const nth = (k: number) => (k === 1 ? 'first' : `${k}${k % 100 >= 11 && k % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][k % 10] ?? 'th'}`);
    cost.replaceChildren(
      h('div', null, `Once: ${c.once} bytes of ROM space (the prefab with its name and RATS tag).`),
      h('div', null, `Each placement: ${c.perPlacement} bytes of level data, as Direct Map16 ${c.dm16Bytes} bytes (${c.dm16Objects} object${c.dm16Objects === 1 ? '' : 's'}).`),
      h('div', null, c.breakEven === null ? 'The prefab never takes less space than Direct Map16.'
        : `Saves space from the ${nth(c.breakEven)} placement on (${c.dm16Bytes - c.perPlacement} bytes per placement).`));
  };
  name.addEventListener('input', updCost);
  // the same arrangement elsewhere as Direct Map16 objects (prefabplaces.ts), replaced on request
  const places = sug?.places ?? app.prefabPlaces({ ...r, name: '' }, !!from);
  const found = places.reduce((k, p) => k + p.places.length, 0);
  const saved = places.reduce((k, p) => k + p.places.reduce((b, q) => b + q.bytes, 0), 0);
  const replaceAll = h('input', { type: 'checkbox', checked: !!from });
  const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const elsewhere = found
    ? h('div', null,
      usedInList(app, from ? 'Where these Direct Map16 objects are' : 'The same Direct Map16 objects elsewhere', places.map((p) => ({
        level: p.level, at: { x: p.places[0].x, y: p.places[0].y },
        text: `${plural(p.places.length, 'place')}, ${plural(p.places.reduce((b, q) => b + q.bytes, 0), 'byte')} saved`,
      })), 0, ''),
      h('label', { class: 'row small' }, replaceAll, ` Replace ${found === 1 ? 'it' : `all ${found}`} with the prefab (saves ${plural(saved, 'byte')} of level data)`))
    : h('div', { class: 'hint' }, 'The same tiles as Direct Map16 objects are nowhere else.');
  const upd = () => {
    const n = Number(target.value);
    const users = all.has(n) ? app.prefabUsers(n) : [];
    note.textContent = all.has(n) ? `The prefab changes everywhere it is used${users.length ? ` (level ${users.map(hex3).join(', ')})` : ''}.` : '';
    if (all.has(n) && !name.value) name.value = all.get(n)!.name;
    updCost();
  };
  target.addEventListener('change', upd);
  if (free < 0 && !all.size) { toast(`All ${PREFAB_COUNT} prefabs are in use.`, 'error'); return; }
  upd();
  const save = () => (from
    ? app.saveArrangementAsPrefab(Number(target.value), { ...from, name: name.value.trim() }, replaceAll.checked ? places : [])
    : app.saveSelectionAsPrefab(Number(target.value), name.value.trim(), replace.checked, replaceAll.checked ? places : []));
  const body = h('div', null,
    h('div', { class: 'row' }, preview),
    h('div', { class: 'hint' }, `${r.w}×${r.h} tiles, ${r.tiles.filter((t) => t === TRANSPARENT).length} of them transparent (tiles of other objects are kept there).`),
    h('div', { class: 'prop' }, h('label', null, 'Name'), name),
    h('div', { class: 'prop' }, h('label', null, 'Save as'), target),
    from ? '' : h('label', { class: 'row small' }, replace, ' Replace the selection in the level with the prefab'),
    note,
    cost,
    elsewhere,
    h('div', { class: 'hint' }, 'Prefabs (SMWS) only use extended object 04 (free in the game and in Lunar Magic) and change no game code.'));
  const dlg = modal(from ? 'Suggestion as prefab' : 'Selection as prefab', body, [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: save }]);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && save()) dlg.close(); });
  setTimeout(() => name.focus(), 0);
}

// names an object for the project (2E-3F for the open level's object table); Reset brings back the built-in name
// (or the one a package's Lunar Magic .mw0t gives it)
function renameObject(app: App, num: number, ext: number): void {
  const what = num ? `object ${hex2(num)}` : `extended object ${hex2(ext)}`;
  const builtin = baseObjectName(app.rom, num, ext, app.objectTableOf(num));
  const fromPackage = num === 0 && packageObjectName(app.rom, ext) !== null;
  const cur = app.objectName(num, ext);
  const name = h('input', { value: cur, placeholder: builtin, maxLength: NAME_MAX, spellcheck: false, autocomplete: 'off' });
  const save = () => { if (name.value.trim() !== cur) app.renameObject(num, ext, name.value.trim() === builtin ? '' : name.value); };
  const dlg = modal(`Rename ${what}`, h('div', null, h('div', { class: 'prop' }, h('label', null, 'Name'), name),
    h('div', { class: 'hint' }, `${fromPackage ? 'From a package' : 'Built-in'}: ${builtin}.${namedPerTable(num) ? ' Objects 2E–3F are named per object group (this level’s).' : ''} The name is kept with the project, not in the ROM.`)),
    [{ label: 'Cancel' }, ...(cur !== builtin ? [{ label: 'Reset', onClick: () => app.renameObject(num, ext, '') }] : []), { label: 'OK', primary: true, onClick: save }]);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { save(); dlg.close(); } });
  setTimeout(() => name.select(), 0);
}

function renamePrefab(app: App, n: number, st: Prefab): void {
  const name = h('input', { value: st.name, spellcheck: false });
  const save = () => {
    const cur = readPrefab(app.rom, n);
    if (!cur) return;
    try { app.romEdit(`Prefab ${hex2(n)} renamed`, () => writePrefab(app.rom, n, { ...cur, name: name.value.trim() })); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  };
  const dlg = modal(`Rename prefab ${hex2(n)}`, h('div', null, h('div', { class: 'prop' }, h('label', null, 'Name'), name)),
    [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: save }]);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { save(); dlg.close(); } });
  setTimeout(() => name.select(), 0);
}

function deletePrefab(app: App, n: number, st: Prefab): void {
  const uses = app.prefabUses(n), count = uses.reduce((k, u) => k + u.count, 0);
  const body = h('div', null, h('div', null, `Delete prefab ${hex2(n)} “${st.name || '(unnamed)'}”?`),
    uses.length
      ? h('div', { class: 'warn-box' }, `Its ${count === 1 ? 'object' : `${count} objects`} in level ${uses.map((u) => (u.count > 1 ? `${hex3(u.level)} (${u.count})` : hex3(u.level))).join(', ')} ${count === 1 ? 'is' : 'are'} deleted too. To keep the tiles, “Break up” them first.`)
      : h('div', { class: 'hint' }, 'It is not used in any level.'));
  modal('Delete prefab', body, [{ label: 'Cancel' }, { label: 'Delete', danger: true, onClick: () => app.deletePrefab(n) }]);
}

// small images of the sprites a block spawns, shown in the corner of a picker cell
function itemBadge(app: App, items: number[], cls = 'picker-items'): HTMLElement | '' {
  const imgs = items.slice(0, 4).map((n) => app.spriteThumbs?.get(n)).filter((c): c is HTMLCanvasElement => !!c);
  if (!imgs.length) return '';
  return h('div', { class: cls }, ...imgs.map(cloneCanvas));
}

// `count` tiles from `base`, 16 per row
const SHEET_BACK = 0xff181818; // where a sheet's tiles draw nothing
export function renderMap16Sheet(app: App, bg = false, base = 0, count = 512): HTMLCanvasElement {
  const r = app.render;
  const tc = new TileCache(r.vram, r.cgram, (bg ? r.ppuRegs[0x0b] >> 4 : r.ppuRegs[0x0b] & 0x0f) << 13);
  const src = map16Source(app.rom, r);
  const c = document.createElement('canvas');
  const hgt = count / 16 * 16;
  c.width = 256; c.height = hgt;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(256, hgt);
  const px = new Uint32Array(img.data.buffer);
  px.fill(SHEET_BACK);
  for (let t = 0; t < count; t++) drawMap16(px, 256, hgt, tc, bg ? src.bg(base + t) : src.fg(base + t), (t & 15) * 16, (t >> 4) * 16);
  ctx.putImageData(img, 0, 0);
  return c;
}

// a sheet of renderMap16Sheet (its tiles from base) follows the level's animation while `on` (the canvas
// it is drawn into by shown) is in the page
function animateSheet(app: App, sheet: HTMLCanvasElement, bg: boolean, base: number, on: HTMLCanvasElement, shown: () => void): HTMLCanvasElement {
  animateTiles(app, sheet, sheetCells(base, (sheet.height >> 4) * 16), { bg, back: SHEET_BACK, on, shown });
  return sheet;
}

// (a copy of a canvas following the animation follows it too)
export function cloneCanvas(c: HTMLCanvasElement): HTMLCanvasElement {
  const n = document.createElement('canvas');
  n.width = c.width; n.height = c.height;
  n.getContext('2d')!.drawImage(c, 0, 0);
  noteCopy(c, n);
  return n;
}

// ---------------- properties ----------------
export class Properties {
  app: App;
  root: HTMLDivElement;
  body: HTMLDivElement;
  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'props-body' });
    this.root = h('div', { class: 'panel props' }, h('div', { class: 'panel-title' }, 'Properties'), this.body);
    app.on('change', () => this.build());
    app.on('level', () => this.build());
    app.on('objkinds', () => this.build());
    app.on('object-names', () => this.build());
    app.on('probes', () => { if (this.probePending) this.build(); });
    app.on('rom-change', () => { if (app.mode === 'exit') this.build(); });
    app.on('picked-item', () => { if (app.mode === 'spr' && !app.selectedSprites().length) this.build(); });
  }

  probePending = false; // the shown object's block behaviour is still being probed

  // the flag the Direct Map16 objects `objs` depend on (Lunar Magic's conditional Direct Map16, cdm16.ts), set for
  // all of them at once, or removed
  condFields(objs: LevelObject[]): HTMLElement[] {
    if (!objs.length) return [];
    const app = this.app;
    const all = (f: (o: LevelObject) => void) => app.editLevel(() => { for (const o of liveObjects(app, objs)) f(o); });
    const first = objs.find((o) => o.cond)?.cond;
    const many = objs.length > 1 ? ` of the ${objs.length} Direct Map16 objects` : '';
    if (!first) {
      return [this.field('Flag', h('button', { title: `Draw${many} only while a flag of $7FC060-F is on (set by ASM, e.g. UberASM)`, onclick: () => all((o) => (o.cond = { flag: 0, always: false })) }, 'Add flag check'))];
    }
    const mixed = new Set(objs.map((o) => (o.cond ? condByte(o.cond) : -1))).size > 1;
    // always show adds 100 to the tiles while the flag is on: they must stay in range
    const tooHigh = objs.filter((o) => (o.tile ?? 0) + COND_ADD >= EXT_TILES).length;
    // the flag and always show as shown here, for all of them
    const set = (c: Partial<Dm16Cond>) => {
      const cond = { ...first, ...c };
      if (cond.always && tooHigh) { toast(`Always show adds 100 to the tiles while the flag is on: ${tooHigh} object${tooHigh > 1 ? 's have tiles' : ' has a tile'} from F00 on.`, 'error'); this.build(); return; }
      all((o) => (o.cond = { ...cond }));
    };
    const ram = flagRam(first.flag);
    return [
      this.field('Flag', hexInput(first.flag, 2, (v) => set({ flag: v }), COND_FLAGS - 1),
        h('button', { title: `Remove the flag check${many}: always drawn as it is`, onclick: () => all((o) => delete o.cond) }, 'Remove flag check')),
      h('div', { class: 'prop' }, h('label', null, ''), checkbox(' Always show', 'Drawn also while the flag is off; while it is on, its tiles + 100', first.always, (on) => set({ always: on }))),
      h('div', { class: 'hint' }, mixed ? 'The selected objects have different flag settings; a change here sets flag and always show for all of them. ' : '',
        first.always ? `Drawn as it is while flag ${hex2(first.flag)} (${ram}) is off, with its tiles + 100 while it is on.` : `Drawn only while flag ${hex2(first.flag)} (${ram}) is on.`,
        ' View → Conditional Direct Map16 shows the level with the flags.'),
    ];
  }

  field(label: string, input: HTMLElement, extra?: HTMLElement): HTMLElement {
    return h('div', { class: 'prop' }, h('label', null, label), input, extra);
  }

  build(): void {
    const app = this.app;
    clear(this.body);
    this.probePending = false;
    if (!app.level) return;
    if (app.mode === 'exit') return this.buildExit();
    if (app.mode === 'bg') {
      this.body.appendChild(h('div', { class: 'hint' }, `Edit the background (BG tilemap). ${app.level.bg ? 'Changed – written to free ROM space on save (BG patch).' : 'Unchanged.'}`));
      return;
    }
    if (app.mode === 'spr') {
      const sel = app.selectedSprites();
      if (!sel.length) {
        this.body.appendChild(emptyState(`${app.level.sprites.length} sprites – none selected.`));
        // the sprite chosen in the picker
        const p = app.pickedItem;
        if (p?.kind === 'spr') {
          const id = spriteId(p);
          this.body.append(spriteUses(app, id, `Sprite ${hex2(p.num)} (${app.spriteLabel(id)}) used in levels`));
        }
        return;
      }
      if (sel.length > 1) { this.body.append(h('div', { class: 'prop-title' }, `${sel.length} sprites selected`)); return; }
      const s = sel[0];
      // changes the sprite in the open level (a ROM edit saves a changed level: it is loaded anew, the ids kept)
      const upd = (f: (s: LevelSprite) => void) => app.editLevel((lv) => {
        const x = lv.sprites.find((x) => x.uid === s.uid);
        if (!x) return false;
        f(x);
      }, false);
      const id = spriteId(s), custom = app.customSprite(id);
      // custom sprites: their extra bytes (as many as the size table says for number and extra bit)
      const nBytes = s.extra >= 2 ? spriteBytes(spriteSizes(app.rom), s).length : 0;
      const resize = (s: LevelSprite) => { const b = spriteBytes(spriteSizes(app.rom), s); if (b.length) s.bytes = b; else delete s.bytes; };
      this.body.append(
        h('div', { class: 'prop-title' }, `${s.extra >= 2 ? 'Custom Sprite' : 'Sprite'} ${hex2(s.num)}: ${app.spriteLabel(id)}`),
        this.field('Number', hexInput(s.num, 2, (v) => upd((s) => { s.num = v; resize(s); }))),
        this.field('X', hexInput(s.x, 3, (v) => upd((s) => (s.x = v)), app.levelWidthTiles() - 1)),
        this.field('Y', hexInput(s.y, 3, (v) => upd((s) => (s.y = v)), app.levelHeightTiles() - 1)),
        this.field('Extra bits', hexInput(s.extra, 1, (v) => upd((s) => { s.extra = v; resize(s); }), 3)),
        ...Array.from({ length: nBytes }, (_, i) => this.field(`Extra byte ${i + 1}`, hexInput(s.bytes?.[i] ?? 0, 2, (v) => upd((s) => { resize(s); if (s.bytes) s.bytes[i] = v; })))),
        s.extra >= 2 ? h('div', { class: 'hint' }, custom ? 'Extra bits 2/3: custom sprite without/with extra bit.' : 'This custom sprite is not inserted (ROM → Packages …, Sprites); the game treats it like the original sprite with the same number.') : '',
        custom?.description ? h('div', { class: 'hint pre' }, custom.description) : '',
        spriteUses(app, id, 'Used in levels'),
      );
      // behaviour when hit from below or jumped on, at this position and in general (emulated)
      const p = app.probes.sprite(id);
      this.probePending = !p && probeable(id);
      if (p?.summary) {
        const here = spriteProbeAt(p, s.x, s.y).summary;
        this.body.append(h('div', { class: 'hint' }, `At this position: ${here ?? 'nothing'}`,
          p.summary !== here ? [h('br'), `In general: ${p.summary}`] : ''));
      } else if (this.probePending) this.body.append(h('div', { class: 'hint' }, 'Determining behavior …'));
      return;
    }
    const sel = app.selectedObjects();
    if (!sel.length) {
      this.body.appendChild(emptyState(`${app.currentObjects().length} objects on ${app.mode === 'l2' ? 'layer 2' : 'layer 1'} – none selected.`));
      return;
    }
    if (sel.length > 1) { this.body.append(h('div', { class: 'prop-title' }, `${sel.length} objects selected`), ...this.condFields(sel.filter(isDm16))); return; }
    const o = sel[0];
    // changes the object in the open level (see the sprite's)
    const upd = (f: (o: LevelObject) => void) => app.editLevel(() => {
      const [x] = liveObjects(app, [o]);
      if (!x) return false;
      f(x);
    });
    const idx = app.currentObjects().indexOf(o);
    const ov = app.objectKind(o.num);
    const pf = isPlacedPrefab(o) ? readPrefab(app.rom, o.prefab!) : null;
    this.body.append(
      h('div', { class: 'prop-title' }, isPlacedPrefab(o)
        ? `Prefab ${hex2(o.prefab!)}: ${pf ? pf.name || '(unnamed)' : '(missing)'}`
        : `${o.num ? 'Object ' + hex2(o.num) : 'Ext. object ' + hex2(o.ext)}: ${app.objectName(o.num, o.ext)}`),
      h('div', { class: 'hint' }, `No. ${idx + 1} of ${app.currentObjects().length} (drawing order)`),
      this.field('Object', hexInput(o.num, 2, (v) => upd((o) => { o.num = v; fixPrefab(o); fitExtension(o, objectLength2D(app.rom)); }), 0x3f)),
      o.num === 0 ? this.field('Ext. object', hexInput(o.ext, 2, (v) => upd((o) => { o.ext = v; fixPrefab(o); }), 0xff)) : '',
      o.num === 0 && o.ext === PREFAB_EXT && o.prefab !== undefined ? this.field('Prefab', hexInput(o.prefab, 2, (v) => upd((o) => (o.prefab = v)), 0xff)) : '',
      isPlacedPrefab(o) && !pf ? h('div', { class: 'hint' }, 'This prefab does not exist – the object places nothing.') : '',
      o.num === 0 && o.ext === DM16_EXT ? this.field('Map16 tile', hexInput(o.tile ?? 0, 3, (v) => upd((o) => (o.tile = v)), EXT_TILES - 1 - (o.cond?.always ? COND_ADD : 0)),
        h('button', { title: 'Edit the tile in the graphics area', onclick: () => app.editMap16(o.tile ?? 0) }, 'Edit …')) : '',
      o.num === 0 && o.ext === DM16_EXT ? this.field('Size (hw)', hexInput(o.size, 2, (v) => upd((o) => (o.size = v)))) : '',
      ...this.condFields(isDm16(o) ? [o] : []),
      this.field('X', hexInput(o.x, 3, (v) => upd((o) => (o.x = v)), app.levelWidthTiles() - 1)),
      this.field('Y', hexInput(o.y, 3, (v) => upd((o) => (o.y = v)), app.levelHeightTiles() - 1)),
      o.num !== 0 && ov?.type ? this.field('Type', hexInput(objectVariant(ov, o.size), 1, (v) => upd((o) => (o.size = withObjectVariant(ov, o.size, v))), ov.count - 1)) : '',
      o.num !== 0 ? this.field('Size (byte)', hexInput(o.size, 2, (v) => upd((o) => (o.size = v)))) : '',
      o.extension ? this.field('Extension', h('span', { title: "The object's bytes after its 3, read by the ROM's code for object 2D (Lunar Magic's Extension; the first is often a custom object's number)" },
        ...o.extension.map((b, i) => hexInput(b, 2, (v) => upd((o) => { if (o.extension) o.extension[i] = v; }))))) : '',
      o.num !== 0 ? h('div', { class: 'hint' }, `${nibbleText(ov)} · Keys: + / - width, * / / height, Alt+arrows`) : '',
    );
    // Map16 tiles of the object and their behaviour when hit from below (emulated)
    const tiles = app.objectMap16(o);
    if (tiles.length) {
      const sum = blockSummary(app, tiles, tiles.length === 1);
      this.probePending = sum === undefined;
      this.body.append(h('div', { class: 'hint' },
        `Map16: ${tiles.slice(0, 12).map(hex3).join(' ')}${tiles.length > 12 ? ' …' : ''}`,
        ...(sum === undefined ? [h('br'), 'Determining behavior …'] : sum.flatMap((x) => [h('br'), x]))));
    }
  }

  buildExit(): void {
    this.probePending = buildExitPanel(this.app, this.body);
  }
}

// the objects (of the current layer) with the ids of `objs` in the open level
function liveObjects(app: App, objs: LevelObject[]): LevelObject[] {
  const ids = new Set(objs.map((o) => o.uid));
  return app.currentObjects().filter((o) => ids.has(o.uid));
}

// extended object $04 always carries a prefab number (its 4th byte)
function fixPrefab(o: LevelObject): void {
  if (o.num === 0 && o.ext === PREFAB_EXT) o.prefab ??= 0;
  else delete o.prefab;
  if (!isDm16(o)) delete o.cond;
}

// what the nibbles of a standard object's settings byte do (emulated, see objkinds.ts)
function nibbleText(k: ObjKind | null): string {
  if (!k) return 'Low nibble = width, high = height';
  if (k.lo === 'w' && k.hi === 'w') return 'The whole byte is the width';
  const part = (d: 'w' | 'h' | null, type: boolean) => (type ? 'type' : d === 'w' ? 'width' : d === 'h' ? 'height' : 'no effect');
  return `${k.type ? `Sub-object with ${k.count} types: ` : ''}low nibble = ${part(k.lo, k.type === 'lo')}, high = ${part(k.hi, k.type === 'hi')}`;
}
