// Sidebar panels: level list, palette (objects / sprites), properties.

import { isBrushMode, type App, type PaletteItem } from './app.ts';
import { h, clear, hexInput, checkbox, attachRectPick, modal, toast, emptyState } from './dom.ts';
import { objectName, spriteName, hex2, hex3 } from '../core/names.ts';
import { objectVariant, withObjectVariant, type ObjKind } from '../core/objkinds.ts';
import { thumbCanvas, objKey, type ObjSpec, type ObjThumb } from './thumbs.ts';
import { newUid, spriteId, spriteBytes, spriteSizes, type LevelObject, type LevelSprite } from '../core/level.ts';
import { levelName } from '../core/overworld.ts';
import { usedInList } from './usedin.ts';
import { buildExitPanel } from './exitpanel.ts';
import { DM16_EXT } from '../core/patches.ts';
import { STRUCT_EXT, TRANSPARENT, freeStructureNumber, readStructure, writeStructure, STRUCT_COUNT, type Structure } from '../core/structs.ts';
import { EXT_TILES } from '../core/map16ext.ts';
import { COND_FLAGS, COND_ADD, condByte, flagRam, isDm16, type Dm16Cond } from '../core/cdm16.ts';
import { TileCache, map16Source, drawMap16 } from '../core/render.ts';
import { lt3Target, lt3Users, blankLayer3Tile, l3Palette, withL3Palette, L3_TILE, L3_PAL, L3_PRIO, L3_FLIP_X, L3_FLIP_Y } from '../core/layer3map.ts';
import { LT3_DESTS } from '../core/layer3gfx.ts';
import { probeable } from '../core/probeclient.ts';
import { probeText, spritesOf, spriteProbeAt, enterText, enterSuffix } from '../core/blockprobe.ts';
import { tileMatches, drawTileMatches } from './tilesearch.ts';
import { matchesAll, type SearchProvider, type SearchResult } from './search.ts';
import { blockFilesByTile } from './blockdialog.ts';

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

// ---------------- palette ----------------
export class Palette {
  app: App;
  root: HTMLDivElement;
  body: HTMLDivElement;
  tab: 'obj' | 'ext' | 'm16' | 'str' | 'spr' = 'obj';
  thumbs = new Map<string, HTMLCanvasElement>();
  thumbTiles = new Map<string, number[]>(); // Map16 tiles per object key
  thumbsFrom: ObjThumb[] | undefined; // the thumbnails shown (undefined: placeholders while they are learned)
  tabs: HTMLDivElement;
  search: HTMLInputElement;
  searchRow: HTMLDivElement;

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'palette-body' });
    this.search = h('input', { class: 'filter', placeholder: 'Search …', spellcheck: false });
    this.search.addEventListener('input', () => this.build());
    this.tabs = h('div', { class: 'tabs seg' });
    this.searchRow = h('div', { class: 'row' }, this.search);
    this.root = h('div', { class: 'panel palette' }, h('div', { class: 'panel-title' }, 'Insert', h('span', { class: 'hint' }, 'Right click/Shift+click places')), this.tabs,
      this.searchRow, this.m16SearchRow, this.m16Bar, this.body);
    this.body.addEventListener('scroll', () => this.m16Scrolled());
    this.m16Search.addEventListener('input', () => {
      this.m16Match = tileMatches(this.m16Search.value, EXT_TILES, blockFilesByTile(app.rom));
      this.build();
      if (this.m16Match?.length) this.scrollToM16Tile(this.m16Match[0]);
    });
    this.m16Search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.m16Search.value) { e.preventDefault(); this.m16Search.value = ''; this.m16Match = null; this.build(); return; }
      if (e.key !== 'Enter' || this.m16Match?.length !== 1) return;
      e.preventDefault();
      app.paletteItem = { kind: 'obj', num: 0, ext: DM16_EXT, size: 0, tile: this.m16Match[0] };
      this.m16Search.value = '';
      this.m16Match = null;
      this.m16Search.blur();
      if (app.mode !== 'l1' && app.mode !== 'l2') app.setMode('l1');
      this.build();
      this.scrollToSelected();
    });
    app.on('level', () => { this.ensureThumbs(); this.build(); });
    // the thumbnails of the level as edited: asked for whenever they may have changed, the learner decides
    for (const ev of ['objkinds', 'level-header', 'render', 'rom-change', 'thumbs'] as const) app.on(ev, () => { if (this.ensureThumbs() && (this.tab === 'obj' || this.tab === 'ext')) this.build(); });
    let t = 0;
    app.on('sprites', () => { if (this.tab !== 'm16' && !t) t = window.setTimeout(() => { t = 0; this.build(); }, 300); });
    app.on('bgtile', () => { if (isBrushMode(app.mode)) this.build(); });
    app.on('probes', () => { if (this.tab === 'm16') this.m16Tip(); else this.build(); });
    app.on('render', () => { if (isBrushMode(app.mode)) this.build(); });
    app.on('change', () => { this.followSelection(); if (this.tab === 'str') this.build(); });
    app.on('structs', () => { if (this.tab === 'str') this.build(); });
    app.on('mode', () => {
      if (app.mode === 'spr') this.tab = 'spr';
      else if (this.tab === 'spr') this.tab = 'obj';
      this.build();
    });
  }

  // an item selected in the level becomes the palette item, shown in its tab and scrolled into view
  followed = -1;
  followSelection(): void {
    const app = this.app;
    const uid = app.selection.size === 1 ? [...app.selection][0] : -1;
    if (uid === this.followed) return;
    this.followed = uid;
    if (uid < 0 || app.mode === 'bg' || app.mode === 'exit') return;
    let item: PaletteItem;
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
      } else if (o.num === 0 && o.ext === STRUCT_EXT && o.struct !== undefined) {
        item = { kind: 'obj', num: 0, ext: STRUCT_EXT, size: 0, struct: o.struct };
        this.tab = 'str';
      } else if (o.num === 0) {
        item = { kind: 'obj', num: 0, ext: o.ext, size: 0 };
        this.tab = 'ext';
      } else {
        const kind = app.objectKind(o.num);
        item = { kind: 'obj', num: o.num, ext: 0, size: withObjectVariant(kind, 0x11, Math.max(0, objectVariant(kind, o.size))) };
        this.tab = 'obj';
      }
    }
    const cur = app.paletteItem;
    if (cur && JSON.stringify(cur) === JSON.stringify(item) && this.body.querySelector('.selected')) return; // e.g. just inserted
    app.paletteItem = item;
    this.build();
    if (this.tab !== 'm16' && !this.body.querySelector('.selected') && this.search.value) {
      this.search.value = ''; // the filter hides it
      this.build();
    }
    requestAnimationFrame(() => this.scrollToSelected()); // after the properties panel below has updated
  }

  scrollToSelected(): void {
    const el = this.body.querySelector<HTMLElement>('.selected');
    if (el) { el.scrollIntoView({ block: 'nearest' }); return; }
    const cur = this.app.paletteItem;
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
  m16Scroll = 0; // scroll position of the list, kept across rebuilds and tab changes
  m16Bar: HTMLDivElement = h('div', { class: 'tabs seg m16-pages' });
  // search by tile number or block file: the other tiles are dimmed, the list goes to the first match, Enter
  // takes a single match
  m16Search: HTMLInputElement = h('input', { class: 'filter', placeholder: 'Tile no. (hex) or block file …', spellcheck: false, autocomplete: 'off',
    title: 'Dims the tiles that do not match; Enter takes the tile once only one is left' });
  m16SearchRow: HTMLDivElement = h('div', { class: 'row' }, this.m16Search);
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
    this.m16Scroll = this.body.scrollTop;
    this.m16Bar.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', i === page));
  }
  buildMap16(): void {
    const app = this.app;
    const cur = app.paletteItem;
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
    const label = h('div', { class: 'hint' }, curTile >= 0
      ? (bw * bh > 1 ? `Block ${bw}×${bh} from tile ${hex3(curTile)} chosen – right click in the level view places it (one Direct Map16 object per tile).`
        : `Tile ${hex3(curTile)} chosen – right click in the level view places it (Direct Map16 object).`)
      : 'Click a tile (or drag for several), then right click in the level to place it. Requires the editor patch (installed automatically).');
    this.body.append(h('div', { class: 'row' },
      h('button', { title: 'Edit the chosen tile in the graphics area (also create tiles from 200 on)', onclick: () => app.editMap16(curTile >= 0 ? curTile : this.m16Page * 256) }, 'Edit …')), label);
    // tooltip: tile number and behaviour when hit from below
    let hoverTile = -1, hoverCanvas: HTMLCanvasElement | null = null;
    const tip = () => {
      const p = app.probes.block(hoverTile);
      if (hoverCanvas) hoverCanvas.title = `Tile ${hex3(hoverTile)}: ${p ? probeText(p) : 'determining behavior …'}\nCtrl+click: edit in the Map16 tab`;
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
    const S = 16 * 1.2;
    for (let p = 0; p < pages; p++) {
      const base = p * 256;
      const c = h('canvas', { width: 256 * 1.2, height: 256 * 1.2, class: 'm16-pick', 'data-page': String(p) });
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      let sheet: HTMLCanvasElement | null = null;
      // page plus the chosen rectangle of tiles (x, y, w, h in cells)
      const draw = (x: number, y: number, w: number, hh: number) => {
        sheet ??= renderMap16Sheet(app, false, base, 256);
        ctx.drawImage(sheet, 0, 0, c.width, c.height);
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
        app.paletteItem = { kind: 'obj', num: 0, ext: DM16_EXT, size: 0, tile: base + r.y * 16 + r.x, ...(r.w * r.h > 1 ? { block: { w: r.w, h: r.h } } : {}) };
        if (app.mode !== 'l1' && app.mode !== 'l2') app.setMode('l1');
        this.build();
      }, (x, y) => app.editMap16(base + y * 16 + x));
      c.addEventListener('mousemove', (e) => {
        const rc = c.getBoundingClientRect();
        const x = Math.floor((e.clientX - rc.left) / (rc.width / 16)), y = Math.floor((e.clientY - rc.top) / (rc.height / 16));
        const t = base + Math.min(15, y) * 16 + Math.min(15, x);
        if (t !== hoverTile || c !== hoverCanvas) { hoverTile = t; hoverCanvas = c; tip(); }
      });
      this.body.append(h('div', { class: 'pal-head m16-page-head', 'data-page': String(p) }, `Page ${p.toString(16).toUpperCase()}`), c);
    }
    // back to where the list was; the pages in view are drawn right away so nothing flickers
    this.body.scrollTop = this.m16Scroll;
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

  // structures: blocks of Map16 tiles stored in the ROM, placed as one object each (structs.ts)
  buildStructs(): void {
    const app = this.app;
    const cur = app.paletteItem;
    const curN = cur?.kind === 'obj' && cur.num === 0 && cur.ext === STRUCT_EXT ? cur.struct ?? -1 : -1;
    const sel = (app.mode === 'l1' || app.mode === 'l2') ? app.selectedObjects().length : 0;
    const f = this.search.value.trim().toLowerCase();
    this.body.append(
      h('div', { class: 'row' },
        h('button', { disabled: !sel, title: 'Save the tiles of the selected objects as a structure', onclick: () => openSaveStructure(app) }, 'Selection as structure …')),
      h('div', { class: 'hint' }, sel ? `${sel} object${sel > 1 ? 's' : ''} selected.` : 'Select objects in the level (also Direct Map16 blocks), then “Selection as structure”. In the level, a structure is a single object; changes to it apply in all levels.'),
    );
    const all = app.structures();
    if (!all.size) { this.body.append(emptyState('No structures yet.')); return; }
    const sheet = structTileSource(app);
    let shown = 0;
    for (const [n, st] of all) {
      if (f && !`${hex2(n)} ${st.name}`.toLowerCase().includes(f)) continue;
      const row = h('div', {
        class: `pal-row${n === curN ? ' selected' : ''}`, title: `Structure ${hex2(n)}: ${st.name || '(unnamed)'}, ${st.w}×${st.h}`,
        onclick: () => { app.paletteItem = { kind: 'obj', num: 0, ext: STRUCT_EXT, size: 0, struct: n }; if (app.mode !== 'l1' && app.mode !== 'l2') app.setMode('l1'); this.build(); },
      }, h('span', { class: 'pal-thumb-s struct' }, structCanvas(sheet, st)), h('span', { class: 'num' }, hex2(n)),
        h('span', { class: 'grow' }, st.name || '(unnamed)', h('span', { class: 'hint' }, ` ${st.w}×${st.h}`)),
        h('button', { class: 'icon-btn', title: 'Rename', 'aria-label': 'Rename', onclick: (e: Event) => { e.stopPropagation(); renameStructure(app, n, st); } }, '✎'),
        h('button', { class: 'icon-btn', title: 'Delete', 'aria-label': 'Delete', onclick: (e: Event) => { e.stopPropagation(); deleteStructure(app, n, st); } }, '✕'));
      this.body.appendChild(row);
      shown++;
    }
    if (!shown) this.body.append(emptyState('No structure matches the search.'));
  }

  // BG Map16 tiles for painting the level background (BG mode); pages 2-F with the extended BG Map16
  bgBase = 0;
  buildBg(): void {
    const app = this.app;
    const sheet = renderMap16Sheet(app, true, this.bgBase);
    const brush = app.bgBrush;
    const t0 = brush.tiles[0] - this.bgBase;
    // a brush that is a rectangle of the sheet is outlined there, one picked from the level is shown separately
    const onSheet = t0 >= 0 && t0 < 0x200 && (t0 & 15) + brush.w <= 16 && (t0 >> 4) + brush.h <= 32
      && brush.tiles.every((t, i) => t === brush.tiles[0] + Math.floor(i / brush.w) * 16 + (i % brush.w));
    const S = 16 * 1.2;
    const c = h('canvas', { width: 256 * 1.2, height: 512 * 1.2, class: 'm16-pick', title: 'Click/drag: tile(s) as brush · Ctrl+click: edit in the Map16 tab' });
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const draw = (x: number, y: number, w: number, hh: number) => {
      ctx.drawImage(sheet, 0, 0, c.width, c.height);
      if (x < 0) return;
      ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 2;
      ctx.strokeRect(x * S, y * S, w * S, hh * S);
    };
    if (onSheet) draw(t0 & 15, t0 >> 4, brush.w, brush.h); else draw(-1, 0, 0, 0);
    // click picks a tile, dragging picks a rectangle of tiles (as in the Map16 tab)
    attachRectPick(c, 16, 32, (r) => draw(r.x, r.y, r.w, r.h), (r) => {
      app.bgBrush = { w: r.w, h: r.h, tiles: Array.from({ length: r.w * r.h }, (_, i) => this.bgBase + (r.y + Math.floor(i / r.w)) * 16 + r.x + (i % r.w)) };
      this.build();
    }, (x, y) => app.editMap16(this.bgBase + y * 16 + x, true));
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
      p.style.width = `${Math.min(brush.w * S, 256 * 1.2)}px`;
      p.style.imageRendering = 'pixelated';
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
    const S = 2;
    const c = h('canvas', { width: 128 * S, height: 256 * S, class: 'm16-pick', title: 'Click/drag: tile(s) as brush' });
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
      p.style.width = `${Math.min(b.w * 8 * S, 128 * S)}px`;
      p.style.imageRendering = 'pixelated';
      this.body.append(h('div', { class: 'row' }, p));
    }
    this.body.append(c);
  }

  specs(): ObjSpec[] {
    const s: ObjSpec[] = [];
    for (let n = 1; n < 0x40; n++) {
      const k = this.app.objectKind(n);
      if (!k?.type) { s.push({ num: n, ext: 0, size: 0x11 }); continue; }
      for (let t = 0; t < k.count; t++) s.push({ num: n, ext: 0, size: withObjectVariant(k, 0x11, t) });
    }
    for (let e = 0x10; e < 0x100; e++) s.push({ num: 0, ext: e, size: 0 });
    return s;
  }

  // the thumbnails as known now; whether they changed
  ensureThumbs(): boolean {
    const thumbs = this.app.objectThumbs(this.specs());
    if (thumbs === this.thumbsFrom) return false;
    this.thumbsFrom = thumbs;
    this.thumbTiles = new Map();
    this.thumbs = new Map();
    for (const t of thumbs ?? []) {
      this.thumbs.set(t.key, thumbCanvas(t));
      this.thumbTiles.set(t.key, t.m16);
    }
    if (thumbs) this.app.probes.prefetch([...this.thumbTiles.values()].flat());
    return true;
  }

  // the standard objects (with their types) or the extended objects as listed in the tab; `text` is what the
  // search looks in (lower case): number, name, Map16 tiles and what they do when hit or entered (emulated,
  // see blockprobe.ts), which tells apart objects that look the same, like pipes with and without an entrance
  objectEntries(ext: boolean) {
    const app = this.app;
    const out = [];
    for (const s of this.specs()) {
      if (ext !== (s.num === 0)) continue;
      const kind = app.objectKind(s.num);
      const vt = objectVariant(kind, s.size);
      const name = objectName(s.num, s.ext) + (vt >= 0 ? ` – type ${vt.toString(16).toUpperCase()}` : '');
      const label = s.num ? hex2(s.num) + (vt >= 0 ? `.${vt.toString(16).toUpperCase()}` : '') : hex2(s.ext);
      const tiles = this.thumbTiles.get(objKey(s, kind)) ?? [];
      const sum = tiles.length ? blockSummary(app, tiles) : [];
      const info = (tiles.length ? `\nMap16 ${tiles.slice(0, 8).map(hex3).join(' ')}${tiles.length > 8 ? ' …' : ''}` : '')
        + (sum === undefined ? '\n(determining behavior …)' : sum.map((x) => '\n' + x).join(''));
      const th = this.thumbs.get(objKey(s, kind));
      if (!th && ext && this.thumbsFrom) continue; // invalid ext objects produce nothing
      out.push({
        s, vt, label, name, th, title: `${label}: ${name}${info}`, behavior: sum?.join(' · ') ?? '', text: `${label} ${name} ${info}`.toLowerCase(),
        items: blockSprites(app, tiles), enter: blockEnter(app, tiles),
        item: { kind: 'obj', num: s.num, ext: s.ext, size: s.size } as PaletteItem,
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
        item: { kind: 'spr', num: n, extra } as PaletteItem,
      };
    });
  }

  // shows an item in its tab, chosen as the palette item (from the central search)
  choose(tab: typeof this.tab, item: PaletteItem): void {
    const app = this.app;
    if (tab === 'spr' ? app.mode !== 'spr' : app.mode !== 'l1' && app.mode !== 'l2') app.setMode(tab === 'spr' ? 'spr' : 'l1');
    this.tab = tab;
    app.paletteItem = item;
    // (filters that would hide it)
    this.search.value = '';
    this.m16Search.value = '';
    this.m16Match = null;
    this.build();
    requestAnimationFrame(() => this.scrollToSelected());
  }

  // the tabs for the central search (search.ts)
  searchProviders(): SearchProvider[] {
    const app = this.app;
    const objects = (id: 'obj' | 'ext', label: string): SearchProvider => ({
      id, label,
      search: (terms) => {
        this.ensureThumbs();
        return this.objectEntries(id === 'ext').filter((e) => matchesAll(e.text, terms)).map((e) => ({
          label: e.label, name: e.name, detail: e.behavior, title: e.title, thumb: () => (e.th ? cloneCanvas(e.th) : null), pick: () => this.choose(id, e.item),
        }));
      },
    });
    // Map16 tiles by number (the rules of the tab's tile search), by what they do (finished probes only) or by
    // the file of the custom block on them
    const map16: SearchProvider = {
      id: 'm16', label: 'Map16',
      search: (terms) => {
        const nums = terms.map((t) => new Set(tileMatches(t, EXT_TILES) ?? []));
        const sheets = new Map<number, HTMLCanvasElement>();
        const files = blockFilesByTile(app.rom);
        const out: SearchResult[] = [];
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
    const structs: SearchProvider = {
      id: 'str', label: 'Structures',
      search: (terms) => {
        const sheet = structTileSource(app);
        return [...app.structures()].filter(([n, st]) => matchesAll(`${hex2(n)} ${st.name}`.toLowerCase(), terms)).map(([n, st]) => ({
          label: hex2(n), name: `${st.name || '(unnamed)'} ${st.w}×${st.h}`, title: `Structure ${hex2(n)}: ${st.name || '(unnamed)'}, ${st.w}×${st.h}`,
          thumb: () => structCanvas(sheet, st),
          pick: () => this.choose('str', { kind: 'obj', num: 0, ext: STRUCT_EXT, size: 0, struct: n }),
        }));
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
    return [objects('obj', 'Objects'), objects('ext', 'Extended'), map16, structs, sprites];
  }

  build(): void {
    const app = this.app;
    clear(this.tabs);
    const brush = isBrushMode(app.mode);
    const searchable = !brush && this.tab !== 'm16';
    this.searchRow.style.display = searchable ? '' : 'none';
    this.m16Bar.style.display = this.m16SearchRow.style.display = !brush && this.tab === 'm16' ? '' : 'none';
    this.search.placeholder = this.tab === 'spr' ? 'Search sprites (no., name) …' : this.tab === 'str' ? 'Search structures …' : 'Search (no., name, behavior) …';
    if (app.mode === 'bg') { clear(this.body); this.buildBg(); return; }
    if (app.mode === 'l3') { clear(this.body); this.buildL3(); return; }
    if (this.body.querySelector('.m16-page-head')) this.m16Scroll = this.body.scrollTop; // the scroll event may still be pending
    const tabDefs: [typeof this.tab, string][] = [['obj', 'Objects'], ['ext', 'Extended'], ['m16', 'Map16'], ['str', 'Structures'], ['spr', 'Sprites']];
    for (const [t, l] of tabDefs) this.tabs.appendChild(h('button', { class: this.tab === t ? 'active' : '', onclick: () => { this.tab = t; this.build(); } }, l));
    clear(this.body);
    const f = this.search.value.trim().toLowerCase();
    const cur = app.paletteItem;
    if (this.tab === 'spr') {
      let head = false;
      for (const e of this.spriteEntries()) {
        if (f && !e.text.includes(f)) continue;
        if (e.id >= 0x200 && !head) { head = true; this.body.appendChild(h('div', { class: 'pal-head' }, 'Custom sprites (PIXI)')); }
        const sel = cur?.kind === 'spr' && spriteId(cur) === e.id;
        const img = app.spriteThumbs?.get(e.id);
        this.body.appendChild(h('div', {
          class: `pal-row${sel ? ' selected' : ''}`, title: e.title,
          onclick: () => { app.paletteItem = e.item; if (app.mode !== 'spr') app.setMode('spr'); this.build(); app.emit('palette-item'); },
        }, h('span', { class: 'pal-thumb-s' }, img ? cloneCanvas(img) : ''), h('span', { class: 'num' }, e.num), e.name,
          e.id >= 0x200 && app.customSprite(e.id) && !app.spriteUsers(e.id).length ? h('span', { class: 'gt-unused', title: 'Inserted, but in no level' }, 'unused') : '',
          itemBadge(app, e.items, 'pal-items-row')));
      }
      if (!this.body.firstChild) this.body.append(emptyState('No sprite matches the search.'));
      return;
    }
    if (this.tab === 'm16') { this.buildMap16(); return; }
    if (this.tab === 'str') { this.buildStructs(); return; }
    const grid = h('div', { class: 'pal-grid' });
    for (const e of this.objectEntries(this.tab === 'ext')) {
      if (f && !e.text.includes(f)) continue;
      const { s, vt } = e;
      const sel = cur?.kind === 'obj' && cur.num === s.num && (s.num !== 0 || cur.ext === s.ext) && objectVariant(app.objectKind(s.num), cur.size) === vt;
      grid.appendChild(h('div', {
        class: `pal-cell${sel ? ' selected' : ''}`, title: e.title,
        onclick: () => {
          app.paletteItem = e.item;
          if (app.mode !== 'l1' && app.mode !== 'l2') app.setMode('l1');
          this.build();
        },
      }, h('div', { class: 'pal-img' }, e.th ? cloneCanvas(e.th) : h('span', { class: 'none' }, '–'),
        h('div', { class: 'pal-corner' }, itemBadge(app, e.items), e.enter ? h('div', { class: 'pal-enter', title: enterText(e.enter) }, e.enter) : '')),
        h('div', { class: 'pal-label' }, e.label), h('div', { class: 'pal-name' }, objectName(s.num, s.ext))));
    }
    this.body.appendChild(grid.firstChild ? grid : emptyState('No object matches the search.'));
  }
}

// ---------------- structures ----------------
function structTileSource(app: App): (t: number) => HTMLCanvasElement | null {
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

// image of a structure in the current level's graphics; transparent cells stay empty
export function structCanvas(tile: (t: number) => HTMLCanvasElement | null, st: Structure): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = st.w * 16; c.height = st.h * 16;
  const ctx = c.getContext('2d')!;
  st.tiles.forEach((t, i) => { const img = t === TRANSPARENT ? null : tile(t); if (img) ctx.drawImage(img, (i % st.w) * 16, Math.floor(i / st.w) * 16); });
  return c;
}

// the selected objects as a new structure, or over an existing one
function openSaveStructure(app: App): void {
  const r = app.structureFromSelection();
  if (typeof r === 'string') { toast(r, 'error'); return; }
  const free = freeStructureNumber(app.rom);
  const all = app.structures();
  const name = h('input', { value: '', placeholder: 'Name', spellcheck: false });
  const target = h('select', null,
    free >= 0 ? h('option', { value: String(free) }, `New structure ${hex2(free)}`) : '',
    ...[...all].map(([n, st]) => h('option', { value: String(n) }, `Replace ${hex2(n)}: ${st.name || '(unnamed)'}`)));
  const replace = h('input', { type: 'checkbox', checked: true });
  const preview = structCanvas(structTileSource(app), { ...r, name: '' });
  preview.style.cssText = `width:${Math.min(r.w * 32, 320)}px;image-rendering:pixelated;background:repeating-conic-gradient(#333 0 25%,#222 0 50%) 0 0/16px 16px`;
  const note = h('div', { class: 'hint' });
  const upd = () => {
    const n = Number(target.value);
    const users = all.has(n) ? app.structureUsers(n) : [];
    note.textContent = all.has(n) ? `The structure changes everywhere it is used${users.length ? ` (level ${users.map(hex3).join(', ')})` : ''}.` : '';
    if (all.has(n) && !name.value) name.value = all.get(n)!.name;
  };
  target.addEventListener('change', upd);
  if (free < 0 && !all.size) { toast(`All ${STRUCT_COUNT} structures are in use.`, 'error'); return; }
  upd();
  const save = () => app.saveSelectionAsStructure(Number(target.value), name.value.trim(), replace.checked);
  const body = h('div', null,
    h('div', { class: 'row' }, preview),
    h('div', { class: 'hint' }, `${r.w}×${r.h} tiles, ${r.tiles.filter((t) => t === TRANSPARENT).length} of them transparent (tiles of other objects are kept there).`),
    h('div', { class: 'prop' }, h('label', null, 'Name'), name),
    h('div', { class: 'prop' }, h('label', null, 'Save as'), target),
    h('label', { class: 'row small' }, replace, ' Replace the selection in the level with the structure'),
    note,
    h('div', { class: 'hint' }, 'The first time, the structures patch (SMWS) is installed. It only uses extended object 03 and does not change any game code.'));
  const dlg = modal('Selection as structure', body, [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: save }]);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && save()) dlg.close(); });
  setTimeout(() => name.focus(), 0);
}

function renameStructure(app: App, n: number, st: Structure): void {
  const name = h('input', { value: st.name, spellcheck: false });
  const save = () => {
    const cur = readStructure(app.rom, n);
    if (!cur) return;
    try { app.romEdit(`Structure ${hex2(n)} renamed`, () => writeStructure(app.rom, n, { ...cur, name: name.value.trim() })); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
  };
  const dlg = modal(`Rename structure ${hex2(n)}`, h('div', null, h('div', { class: 'prop' }, h('label', null, 'Name'), name)),
    [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: save }]);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { save(); dlg.close(); } });
  setTimeout(() => name.select(), 0);
}

function deleteStructure(app: App, n: number, st: Structure): void {
  const users = app.structureUsers(n);
  const body = h('div', null, h('div', null, `Delete structure ${hex2(n)} “${st.name || '(unnamed)'}”?`),
    h('div', { class: 'hint' }, users.length
      ? `It is used in level ${users.map(hex3).join(', ')}. The objects stay there but show nothing until a structure ${hex2(n)} is created again.`
      : 'It is not used in any level.'));
  modal('Delete structure', body, [{ label: 'Cancel' }, { label: 'Delete', danger: true, onClick: () => { try { app.romEdit(`Structure ${hex2(n)} deleted`, () => writeStructure(app.rom, n, null)); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); } } }]);
}

// small images of the sprites a block spawns, shown in the corner of a palette cell
function itemBadge(app: App, items: number[], cls = 'pal-items'): HTMLElement | '' {
  const imgs = items.slice(0, 4).map((n) => app.spriteThumbs?.get(n)).filter((c): c is HTMLCanvasElement => !!c);
  if (!imgs.length) return '';
  return h('div', { class: cls }, ...imgs.map(cloneCanvas));
}

// `count` tiles from `base`, 16 per row
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
  px.fill(0xff181818);
  for (let t = 0; t < count; t++) drawMap16(px, 256, hgt, tc, bg ? src.bg(base + t) : src.fg(base + t), (t & 15) * 16, (t >> 4) * 16);
  ctx.putImageData(img, 0, 0);
  return c;
}

export function cloneCanvas(c: HTMLCanvasElement): HTMLCanvasElement {
  const n = document.createElement('canvas');
  n.width = c.width; n.height = c.height;
  n.getContext('2d')!.drawImage(c, 0, 0);
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
    app.on('probes', () => { if (this.probePending) this.build(); });
    app.on('rom-change', () => { if (app.mode === 'exit') this.build(); });
    app.on('palette-item', () => { if (app.mode === 'spr' && !app.selectedSprites().length) this.build(); });
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

  // what can be done with the selection (also reachable by keys)
  actions(objects: boolean): HTMLElement {
    const app = this.app;
    return h('div', { class: 'row prop-actions' },
      h('button', { title: 'Duplicate (Ctrl+D)', onclick: () => app.duplicateSelection() }, 'Duplicate'),
      objects ? h('button', { title: 'To front – drawn last (PgUp)', onclick: () => app.reorderSelection('front') }, 'To front') : '',
      objects ? h('button', { title: 'To back – drawn first (PgDn)', onclick: () => app.reorderSelection('back') }, 'To back') : '',
      objects ? h('button', { title: 'Save the tiles of the selection as a structure', onclick: () => openSaveStructure(app) }, 'As structure …') : '',
      h('button', { class: 'danger', title: 'Delete (Del)', onclick: () => app.deleteSelection() }, 'Delete'));
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
        // the sprite chosen in the palette
        const p = app.paletteItem;
        if (p?.kind === 'spr') {
          const id = spriteId(p);
          this.body.append(spriteUses(app, id, `Sprite ${hex2(p.num)} (${app.spriteLabel(id)}) used in levels`));
        }
        return;
      }
      if (sel.length > 1) { this.body.append(h('div', { class: 'prop-title' }, `${sel.length} sprites selected`), this.actions(false)); return; }
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
        this.actions(false),
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
    if (sel.length > 1) { this.body.append(h('div', { class: 'prop-title' }, `${sel.length} objects selected`), ...this.condFields(sel.filter(isDm16)), this.actions(true)); return; }
    const o = sel[0];
    // changes the object in the open level (see the sprite's)
    const upd = (f: (o: LevelObject) => void) => app.editLevel(() => {
      const [x] = liveObjects(app, [o]);
      if (!x) return false;
      f(x);
    });
    const idx = app.currentObjects().indexOf(o);
    const ov = app.objectKind(o.num);
    this.body.append(
      h('div', { class: 'prop-title' }, `${o.num ? 'Object ' + hex2(o.num) : 'Ext. object ' + hex2(o.ext)}: ${objectName(o.num, o.ext)}`),
      h('div', { class: 'hint' }, `No. ${idx + 1} of ${app.currentObjects().length} (drawing order)`),
      this.field('Object', hexInput(o.num, 2, (v) => upd((o) => { o.num = v; fixStruct(o); }), 0x3f)),
      o.num === 0 ? this.field('Ext. object', hexInput(o.ext, 2, (v) => upd((o) => { o.ext = v; fixStruct(o); }), 0xff)) : '',
      o.num === 0 && o.ext === STRUCT_EXT && o.struct !== undefined ? this.field('Structure', hexInput(o.struct, 2, (v) => upd((o) => (o.struct = v)), 0xff)) : '',
      o.num === 0 && o.ext === STRUCT_EXT && o.struct !== undefined ? h('div', { class: 'hint' }, structInfo(app, o.struct), ' ',
        h('button', { title: 'Replace the structure here with single Direct Map16 objects (to edit it, then “Selection as structure” again)', onclick: () => app.explodeStructure(o) }, 'Break up')) : '',
      o.num === 0 && o.ext === DM16_EXT ? this.field('Map16 tile', hexInput(o.tile ?? 0, 3, (v) => upd((o) => (o.tile = v)), EXT_TILES - 1 - (o.cond?.always ? COND_ADD : 0)),
        h('button', { title: 'Edit the tile in the graphics area', onclick: () => app.editMap16(o.tile ?? 0) }, 'Edit …')) : '',
      o.num === 0 && o.ext === DM16_EXT ? this.field('Size (hw)', hexInput(o.size, 2, (v) => upd((o) => (o.size = v)))) : '',
      ...this.condFields(isDm16(o) ? [o] : []),
      this.field('X', hexInput(o.x, 3, (v) => upd((o) => (o.x = v)), app.levelWidthTiles() - 1)),
      this.field('Y', hexInput(o.y, 3, (v) => upd((o) => (o.y = v)), app.levelHeightTiles() - 1)),
      o.num !== 0 && ov?.type ? this.field('Type', hexInput(objectVariant(ov, o.size), 1, (v) => upd((o) => (o.size = withObjectVariant(ov, o.size, v))), ov.count - 1)) : '',
      o.num !== 0 ? this.field('Size (byte)', hexInput(o.size, 2, (v) => upd((o) => (o.size = v)))) : '',
      o.num !== 0 ? h('div', { class: 'hint' }, `${nibbleText(ov)} · Keys: + / - width, * / / height, Alt+arrows`) : '',
      this.actions(true),
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

// extended object $03 always carries a structure number (its 4th byte)
function fixStruct(o: LevelObject): void {
  if (o.num === 0 && o.ext === STRUCT_EXT) o.struct ??= 0;
  else delete o.struct;
  if (!isDm16(o)) delete o.cond;
}

function structInfo(app: App, n: number): string {
  const st = readStructure(app.rom, n);
  return st ? `${st.name || '(unnamed)'}, ${st.w}×${st.h}` : 'This structure does not exist – the object places nothing.';
}

// what the nibbles of a standard object's settings byte do (emulated, see objkinds.ts)
function nibbleText(k: ObjKind | null): string {
  if (!k) return 'Low nibble = width, high = height';
  if (k.lo === 'w' && k.hi === 'w') return 'The whole byte is the width';
  const part = (d: 'w' | 'h' | null, type: boolean) => (type ? 'type' : d === 'w' ? 'width' : d === 'h' ? 'height' : 'no effect');
  return `${k.type ? `Sub-object with ${k.count} types: ` : ''}low nibble = ${part(k.lo, k.type === 'lo')}, high = ${part(k.hi, k.type === 'hi')}`;
}
