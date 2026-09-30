// Sidebar panels: level list, palette (objects / sprites), properties.

import type { App } from './app.ts';
import { h, clear, hexInput } from './dom.ts';
import { objectName, spriteName, hex2, hex3 } from '../core/names.ts';
import { objectVariant, withObjectVariant, type ObjKind } from '../core/objkinds.ts';
import { renderObjectThumbs, objKey, type ObjSpec } from './thumbs.ts';
import { newUid } from '../core/level.ts';
import { levelName } from '../core/overworld.ts';
import { DM16_EXT } from '../core/patches.ts';
import { EXT_TILES, map16Ext } from '../core/map16ext.ts';
import { TileCache, map16Source, drawMap16 } from '../core/render.ts';
import { probeText, spritesOf, probeAt, enterText, enterSuffix } from '../core/blockprobe.ts';

// behaviour of the given Map16 tiles when hit from below or entered (only tiles with an effect);
// undefined while probes are still pending
export function blockSummary(app: App, tiles: number[], all = false): string[] | undefined {
  const out: string[] = [];
  let pending = false;
  for (const t of tiles.slice(0, 16)) {
    const p = app.blockInfo(t);
    if (!p) { pending = true; continue; }
    if (p.summary || p.enter || all) out.push(tiles.length > 1 || all ? `${hex3(t)}: ${probeText(p)}` : p.summary ? p.summary + enterSuffix(p) : enterText(p.enter));
  }
  return pending ? undefined : out;
}

// sprites the given tiles spawn when hit (all X positions, small Mario first), from finished probes only
export function blockSprites(app: App, tiles: number[]): number[] {
  const out = new Set<number>();
  for (const t of tiles.slice(0, 16)) {
    const p = app.prober?.cached(t);
    if (p) for (const q of p.pos) for (const n of spritesOf(q)) out.add(n);
  }
  return [...out];
}

// directions (↓↑←→) in which any of the tiles can be entered, from finished probes only
export function blockEnter(app: App, tiles: number[]): string {
  const dirs = new Set<string>();
  for (const t of tiles.slice(0, 16)) for (const d of app.prober?.cached(t)?.enter ?? '') dirs.add(d);
  return [...'↓↑←→'].filter((d) => dirs.has(d)).join('');
}

// ---------------- level list ----------------
function nameOf(app: App, i: number): string {
  const tl = i < 0x25 ? i : i >= 0x101 && i < 0x13c ? i - 0xdc : -1;
  return tl > 0 ? levelName(app.rom, tl) : '';
}

export class LevelList {
  app: App;
  root: HTMLDivElement;
  list: HTMLDivElement;
  filter: HTMLInputElement;
  onlyUsed: HTMLInputElement;
  constructor(app: App) {
    this.app = app;
    this.filter = h('input', { placeholder: 'Level (hex) …', class: 'filter', spellcheck: false });
    this.onlyUsed = h('input', { type: 'checkbox', checked: true });
    this.list = h('div', { class: 'level-list' });
    this.root = h('div', { class: 'panel levels' },
      h('div', { class: 'panel-title' }, 'Levels'),
      h('div', { class: 'row' }, this.filter),
      h('label', { class: 'row small' }, this.onlyUsed, ' nur benutzte'),
      this.list);
    this.filter.addEventListener('input', () => this.build());
    this.filter.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const n = parseInt(this.filter.value, 16);
        if (n >= 0 && n < 0x200) app.openLevel(n);
      }
    });
    this.onlyUsed.addEventListener('change', () => this.build());
    app.on('level', () => this.build());
  }
  build(): void {
    const used = this.app.usedLevels();
    const f = this.filter.value.trim().toLowerCase();
    clear(this.list);
    for (let i = 0; i < 0x200; i++) {
      if (this.onlyUsed.checked && !used.has(i)) continue;
      const label = hex3(i);
      if (f && !label.toLowerCase().includes(f) && !nameOf(this.app, i).toLowerCase().includes(f)) continue;
      const cur = this.app.level?.number === i;
      const name = nameOf(this.app, i);
      const el = h('div', { class: `level-item${cur ? ' current' : ''}${used.has(i) ? '' : ' unused'}`, title: name, onclick: () => this.app.openLevel(i) }, label, name ? h('span', { class: 'lname' }, ' ' + name) : '');
      this.list.appendChild(el);
      if (cur) setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 0);
    }
  }
}

// ---------------- palette ----------------
export class Palette {
  app: App;
  root: HTMLDivElement;
  body: HTMLDivElement;
  tab: 'obj' | 'ext' | 'm16' | 'spr' = 'obj';
  thumbs = new Map<string, HTMLCanvasElement>();
  thumbTiles = new Map<string, number[]>(); // Map16 tiles per object key
  thumbsFor = '';
  tabs: HTMLDivElement;
  search: HTMLInputElement;
  allTypes: HTMLInputElement; // also list sub-object types no level of the tileset uses

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'palette-body' });
    this.search = h('input', { class: 'filter', placeholder: 'Suchen …', spellcheck: false });
    this.search.addEventListener('input', () => this.build());
    this.allTypes = h('input', { type: 'checkbox', onchange: () => this.build() });
    this.tabs = h('div', { class: 'tabs' });
    this.root = h('div', { class: 'panel palette' }, h('div', { class: 'panel-title' }, 'Einfügen', h('span', { class: 'hint' }, 'Rechtsklick/Shift+Klick platziert')), this.tabs,
      h('div', { class: 'row' }, this.search, h('label', { class: 'pal-all', title: 'Auch Unterobjekt-Typen zeigen, die nicht zum Tileset passen (kein Level benutzt sie so, Grafik oft falsch)' }, this.allTypes, 'alle Typen')), this.body);
    app.on('objkinds', () => this.invalidate());
    app.on('level', () => { this.ensureThumbs(); this.build(); });
    let t = 0;
    app.on('sprites', () => { if (this.tab !== 'm16' && !t) t = window.setTimeout(() => { t = 0; this.build(); }, 300); });
    app.on('bgtile', () => { if (app.mode === 'bg') this.build(); });
    app.on('blockinfo', () => { if (this.tab === 'm16') this.m16Tip(); else this.build(); });
    app.on('render', () => { if (app.mode === 'bg') this.build(); });
    app.on('mode', () => {
      if (app.mode === 'spr') this.tab = 'spr';
      else if (this.tab === 'spr') this.tab = 'obj';
      this.build();
    });
  }

  m16Base = 0; // first tile of the shown sheet (pages 0-1, 2-3, …)
  m16Tip: () => void = () => {};
  buildMap16(): void {
    const app = this.app;
    const sheet = renderMap16Sheet(app, false, this.m16Base);
    const cur = app.paletteItem;
    const curTile = cur?.kind === 'obj' && cur.num === 0 && cur.ext === DM16_EXT ? cur.tile ?? -1 : -1;
    const selTile = curTile >= 0 && (curTile & ~0x1ff) === this.m16Base ? curTile & 0x1ff : -1;
    const pages = h('select', null, Array.from({ length: EXT_TILES / 512 }, (_, i) => h('option', { value: String(i * 512), selected: i * 512 === this.m16Base },
      i === 0 ? 'Seiten 0–1' : `Seiten ${(2 * i).toString(16).toUpperCase()}–${(2 * i + 1).toString(16).toUpperCase()}${map16Ext(app.rom) ? '' : ' (leer)'}`)));
    pages.addEventListener('change', () => { this.m16Base = Number(pages.value); this.build(); });
    const c = h('canvas', { width: 256 * 1.2, height: 512 * 1.2, class: 'm16-pick' });
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheet, 0, 0, c.width, c.height);
    if (selTile >= 0) {
      ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 2;
      ctx.strokeRect((selTile & 15) * 16 * 1.2, (selTile >> 4) * 16 * 1.2, 16 * 1.2, 16 * 1.2);
    }
    const label = h('div', { class: 'hint' }, curTile >= 0 ? `Tile ${hex3(curTile)} gewählt – Rechtsklick in der Levelansicht platziert es (Direct-Map16-Objekt).` : 'Tile anklicken, dann per Rechtsklick im Level platzieren. Erfordert den Editor-Patch (wird automatisch installiert). Tiles ab 200 legt der Map16-Editor (M) an.');
    c.addEventListener('mousedown', (e) => {
      const rc = c.getBoundingClientRect();
      const x = Math.floor((e.clientX - rc.left) / (rc.width / 16)), y = Math.floor((e.clientY - rc.top) / (rc.height / 32));
      app.paletteItem = { kind: 'obj', num: 0, ext: DM16_EXT, size: 0, tile: this.m16Base + y * 16 + x };
      if (app.mode !== 'l1' && app.mode !== 'l2') app.setMode('l1');
      this.build();
    });
    // tooltip: tile number and behaviour when hit from below
    let hoverTile = -1;
    const tip = () => {
      const p = app.blockInfo(hoverTile);
      c.title = `Tile ${hex3(hoverTile)}: ${p ? probeText(p) : 'Verhalten wird ermittelt …'}`;
    };
    c.addEventListener('mousemove', (e) => {
      const rc = c.getBoundingClientRect();
      const x = Math.floor((e.clientX - rc.left) / (rc.width / 16)), y = Math.floor((e.clientY - rc.top) / (rc.height / 32));
      const t = this.m16Base + Math.min(31, y) * 16 + Math.min(15, x);
      if (t !== hoverTile) { hoverTile = t; tip(); }
    });
    this.m16Tip = () => { if (hoverTile >= 0 && c.isConnected) tip(); };
    this.body.append(h('div', { class: 'row' }, pages), label, c);
  }

  // BG Map16 tiles 000-1FF for painting the level background (BG mode)
  buildBg(): void {
    const app = this.app;
    const sheet = renderMap16Sheet(app, true);
    const sel = app.bgTile;
    const c = h('canvas', { width: 256 * 1.2, height: 512 * 1.2, class: 'm16-pick' });
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheet, 0, 0, c.width, c.height);
    ctx.strokeStyle = '#4cc2ff'; ctx.lineWidth = 2;
    ctx.strokeRect((sel & 15) * 16 * 1.2, ((sel >> 4) & 31) * 16 * 1.2, 16 * 1.2, 16 * 1.2);
    c.addEventListener('mousedown', (e) => {
      const rc = c.getBoundingClientRect();
      const x = Math.floor((e.clientX - rc.left) / (rc.width / 16)), y = Math.floor((e.clientY - rc.top) / (rc.height / 32));
      app.bgTile = y * 16 + x;
      this.build();
    });
    this.body.append(h('div', { class: 'hint' }, `BG-Tile ${hex3(sel)} – Klicken/Ziehen in der Levelansicht malt, Rechtsklick nimmt ein Tile auf. Die BG-Tilemap (32×27) wiederholt sich.`), c);
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

  ensureThumbs(): void {
    const h0 = this.app.level.header;
    const key = `${h0.tileset}-${h0.fgPalette}-${h0.bgPalette}-${h0.spriteGfx}-${this.app.level.number}`;
    const tsKey = `${h0.tileset}-${h0.fgPalette}-${h0.bgPalette}-${this.app.tilesetKinds() ? 1 : 0}`;
    if (this.thumbsFor === tsKey) return;
    this.thumbsFor = tsKey;
    void key;
    try {
      this.thumbTiles = new Map();
      this.thumbs = renderObjectThumbs(this.app, this.specs(), this.thumbTiles);
    } catch (e) {
      console.error(e);
    }
  }

  // Sub-object types fit the tileset when a level of it uses them, or when they look exactly like
  // in a tileset whose levels use them; others often draw with graphics meant for other tilesets.
  fits = new Set<string>();
  fitsFor = '';
  ensureFits(): void {
    const app = this.app;
    const ts = app.level.header.tileset;
    const key = `${this.thumbsFor}-${app.emu.romGen}`;
    if (this.fitsFor === key) return;
    this.fitsFor = key;
    this.fits = new Set();
    const usage = app.objectUsageAll();
    const uses = (t: number, s: ObjSpec, k: ObjKind) => [...usage.get(t)?.get(s.num) ?? []].some((z) => objectVariant(k, z) === objectVariant(k, s.size));
    const other = new Map<number, ObjSpec[]>(); // tileset → specs to compare
    for (const s of this.specs()) {
      const k = app.objectKind(s.num);
      if (!k?.type) continue;
      if (uses(ts, s, k)) { this.fits.add(objKey(s, k)); continue; }
      for (const t of usage.keys()) if (t !== ts && uses(t, s, k)) { let l = other.get(t); if (!l) other.set(t, (l = [])); l.push(s); }
    }
    try {
      for (const [t, specs] of other) {
        const th = renderObjectThumbs(app, specs.filter((s) => !this.fits.has(objKey(s, app.objectKind(s.num)))), undefined, t);
        for (const [k, c] of th) { const mine = this.thumbs.get(k); if (mine && sameImage(mine, c)) this.fits.add(k); }
      }
    } catch (e) {
      console.error(e);
    }
  }

  invalidate(): void {
    this.thumbsFor = '';
    this.ensureThumbs();
    this.build();
  }

  build(): void {
    const app = this.app;
    clear(this.tabs);
    if (app.mode === 'bg') { clear(this.body); this.buildBg(); return; }
    const tabDefs: [typeof this.tab, string][] = [['obj', 'Objekte'], ['ext', 'Erweitert'], ['m16', 'Map16'], ['spr', 'Sprites']];
    for (const [t, l] of tabDefs) this.tabs.appendChild(h('button', { class: this.tab === t ? 'active' : '', onclick: () => { this.tab = t; this.build(); } }, l));
    clear(this.body);
    const f = this.search.value.trim().toLowerCase();
    const cur = app.paletteItem;
    if (this.tab === 'spr') {
      for (let n = 0; n < 0xe7; n++) {
        const name = spriteName(n);
        // what the sprite gives when hit from below (emulated, see blockprobe.ts)
        const p = app.spriteInfo(n);
        const info = p?.summary ?? '';
        if (f && !(`${hex2(n)} ${name} ${info}`.toLowerCase().includes(f))) continue;
        const sel = cur?.kind === 'spr' && cur.num === n;
        const img = app.spriteThumbs?.get(n);
        const items = p ? [...new Set(p.pos.flatMap(spritesOf))] : [];
        this.body.appendChild(h('div', {
          class: `pal-row${sel ? ' selected' : ''}`, title: info ? `${hex2(n)}: ${name}\nVon unten: ${info}` : '',
          onclick: () => { app.paletteItem = { kind: 'spr', num: n, extra: 0 }; if (app.mode !== 'spr') app.setMode('spr'); this.build(); },
        }, h('span', { class: 'pal-thumb-s' }, img ? cloneCanvas(img) : ''), h('span', { class: 'num' }, hex2(n)), name, itemBadge(app, items, 'pal-items-row')));
      }
      return;
    }
    if (this.tab === 'm16') { this.buildMap16(); return; }
    const grid = h('div', { class: 'pal-grid' });
    this.ensureFits();
    for (const s of this.specs()) {
      if ((this.tab === 'obj') !== (s.num !== 0)) continue;
      const kind = app.objectKind(s.num);
      const vt = objectVariant(kind, s.size);
      // sub-object types no level of this tileset uses often draw with graphics of other tilesets
      const unused = vt >= 0 && !this.fits.has(objKey(s, kind));
      if (unused && !this.allTypes.checked) continue;
      const name = objectName(s.num, s.ext) + (vt >= 0 ? ` – Typ ${vt.toString(16).toUpperCase()}` : '');
      const label = s.num ? hex2(s.num) + (vt >= 0 ? `.${vt.toString(16).toUpperCase()}` : '') : hex2(s.ext);
      // Map16 tiles and what they do when hit or entered (emulated, see blockprobe.ts); tells apart
      // objects that look the same, like pipes with and without an entrance
      let info = '';
      let items: number[] = [];
      let enter = '';
      {
        const tiles = this.thumbTiles.get(objKey(s, kind)) ?? [];
        items = blockSprites(app, tiles);
        enter = blockEnter(app, tiles);
        const sum = tiles.length ? blockSummary(app, tiles) : [];
        info = (tiles.length ? `\nMap16 ${tiles.slice(0, 8).map(hex3).join(' ')}${tiles.length > 8 ? ' …' : ''}` : '')
          + (sum === undefined ? '\n(Verhalten wird ermittelt …)' : sum.map((x) => '\n' + x).join(''));
      }
      if (f && !(`${label} ${name} ${info}`.toLowerCase().includes(f))) continue;
      const th = this.thumbs.get(objKey(s, kind));
      if (!th && this.tab === 'ext') continue; // invalid ext objects produce nothing
      const sel = cur?.kind === 'obj' && cur.num === s.num && (s.num !== 0 || cur.ext === s.ext) && objectVariant(kind, cur.size) === vt;
      grid.appendChild(h('div', {
        class: `pal-cell${sel ? ' selected' : ''}${unused ? ' unused' : ''}`, title: `${label}: ${name}${unused ? '\n(passt nicht zum Tileset: kein Level benutzt es so)' : ''}${info}`,
        onclick: () => {
          app.paletteItem = { kind: 'obj', num: s.num, ext: s.ext, size: s.size };
          if (app.mode !== 'l1' && app.mode !== 'l2') app.setMode('l1');
          this.build();
        },
      }, h('div', { class: 'pal-img' }, th ? cloneCanvas(th) : h('span', { class: 'none' }, '–'),
        h('div', { class: 'pal-corner' }, itemBadge(app, items), enter ? h('div', { class: 'pal-enter', title: enterText(enter) }, enter) : '')),
        h('div', { class: 'pal-label' }, label)));
    }
    this.body.appendChild(grid);
  }
}

// small images of the sprites a block spawns, shown in the corner of a palette cell
function itemBadge(app: App, items: number[], cls = 'pal-items'): HTMLElement | '' {
  const imgs = items.slice(0, 4).map((n) => app.spriteThumbs?.get(n)).filter((c): c is HTMLCanvasElement => !!c);
  if (!imgs.length) return '';
  return h('div', { class: cls }, ...imgs.map(cloneCanvas));
}

export function renderMap16Sheet(app: App, bg = false, base = 0): HTMLCanvasElement {
  const r = app.render;
  const tc = new TileCache(r.vram, r.cgram, (bg ? r.ppuRegs[0x0b] >> 4 : r.ppuRegs[0x0b] & 0x0f) << 13);
  const src = map16Source(app.rom, r);
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(256, 512);
  const px = new Uint32Array(img.data.buffer);
  px.fill(0xff181818);
  for (let t = 0; t < 512; t++) drawMap16(px, 256, 512, tc, bg ? src.bg(t) : src.fg(base + t), (t & 15) * 16, (t >> 4) * 16);
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
    this.root = h('div', { class: 'panel props' }, h('div', { class: 'panel-title' }, 'Eigenschaften'), this.body);
    app.on('change', () => this.build());
    app.on('level', () => this.build());
    app.on('objkinds', () => this.build());
    app.on('blockinfo', () => { if (this.probePending) this.build(); });
  }

  probePending = false; // the shown object's block behaviour is still being probed

  field(label: string, input: HTMLElement): HTMLElement {
    return h('div', { class: 'prop' }, h('label', null, label), input);
  }

  build(): void {
    const app = this.app;
    clear(this.body);
    this.probePending = false;
    if (!app.level) return;
    if (app.mode === 'exit') return this.buildExit();
    if (app.mode === 'bg') {
      this.body.appendChild(h('div', { class: 'hint' }, `Hintergrund (BG-Tilemap) bearbeiten. ${app.level.bg ? 'Geändert – wird beim Speichern in freien ROM-Speicher geschrieben (BG-Patch).' : 'Unverändert.'}`));
      return;
    }
    if (app.mode === 'spr') {
      const sel = app.selectedSprites();
      if (!sel.length) { this.body.appendChild(h('div', { class: 'hint' }, `${app.level.sprites.length} Sprites. Klicken zum Auswählen, Ziehen zum Verschieben.`)); return; }
      if (sel.length > 1) { this.body.appendChild(h('div', null, `${sel.length} Sprites ausgewählt`)); return; }
      const s = sel[0];
      const upd = (f: () => void) => { app.checkpoint(); f(); app.changed(false); };
      this.body.append(
        h('div', { class: 'prop-title' }, `Sprite ${hex2(s.num)}: ${spriteName(s.num)}`),
        this.field('Nummer', hexInput(s.num, 2, (v) => upd(() => (s.num = v)))),
        this.field('X', hexInput(s.x, 3, (v) => upd(() => (s.x = v)), app.levelWidthTiles() - 1)),
        this.field('Y', hexInput(s.y, 3, (v) => upd(() => (s.y = v)), app.levelHeightTiles() - 1)),
        this.field('Extra-Bits', hexInput(s.extra, 1, (v) => upd(() => (s.extra = v)), 3)),
      );
      // behaviour when hit from below, at this position and in general (emulated)
      const p = app.spriteInfo(s.num);
      this.probePending = !p && s.num < 0xc9;
      if (p?.summary) {
        const here = probeAt(p, s.x).summary;
        this.body.append(h('div', { class: 'hint' }, `Von unten an dieser Stelle: ${here ?? 'nichts'}`,
          p.summary !== here ? [h('br'), `Allgemein: ${p.summary}`] : ''));
      } else if (this.probePending) this.body.append(h('div', { class: 'hint' }, 'Verhalten wird ermittelt …'));
      return;
    }
    const sel = app.selectedObjects();
    if (!sel.length) {
      this.body.appendChild(h('div', { class: 'hint' }, `${app.currentObjects().length} Objekte auf ${app.mode === 'l2' ? 'Layer 2' : 'Layer 1'}. Klicken zum Auswählen, Ziehen zum Verschieben, Griff unten rechts zum Skalieren.`));
      return;
    }
    if (sel.length > 1) { this.body.appendChild(h('div', null, `${sel.length} Objekte ausgewählt`)); return; }
    const o = sel[0];
    const upd = (f: () => void) => { app.checkpoint(); f(); app.changed(); };
    const idx = app.currentObjects().indexOf(o);
    const ov = app.objectKind(o.num);
    this.body.append(
      h('div', { class: 'prop-title' }, `${o.num ? 'Objekt ' + hex2(o.num) : 'Erw. Objekt ' + hex2(o.ext)}: ${objectName(o.num, o.ext)}`),
      h('div', { class: 'hint' }, `Index ${idx} von ${app.currentObjects().length}`),
      this.field('Objekt', hexInput(o.num, 2, (v) => upd(() => (o.num = v)), 0x3f)),
      o.num === 0 ? this.field('Erw. Nr.', hexInput(o.ext, 2, (v) => upd(() => (o.ext = v)), 0xff)) : '',
      o.num === 0 && o.ext === DM16_EXT ? this.field('Map16-Tile', hexInput(o.tile ?? 0, 3, (v) => upd(() => (o.tile = v)), EXT_TILES - 1)) : '',
      o.num === 0 && o.ext === DM16_EXT ? this.field('Größe (hw)', hexInput(o.size, 2, (v) => upd(() => (o.size = v)))) : '',
      this.field('X', hexInput(o.x, 3, (v) => upd(() => (o.x = v)), app.levelWidthTiles() - 1)),
      this.field('Y', hexInput(o.y, 3, (v) => upd(() => (o.y = v)), app.levelHeightTiles() - 1)),
      o.num !== 0 && ov?.type ? this.field('Typ', hexInput(objectVariant(ov, o.size), 1, (v) => upd(() => (o.size = withObjectVariant(ov, o.size, v))), ov.count - 1)) : '',
      o.num !== 0 ? this.field('Größe (Byte)', hexInput(o.size, 2, (v) => upd(() => (o.size = v)))) : '',
      o.num !== 0 ? h('div', { class: 'hint' }, `${nibbleText(ov)}. Tasten: +/− Breite, * und / Höhe, Alt+Pfeile`) : '',
    );
    // Map16 tiles of the object and their behaviour when hit from below (emulated)
    const tiles = app.objectMap16(o);
    if (tiles.length) {
      const sum = blockSummary(app, tiles, tiles.length === 1);
      this.probePending = sum === undefined;
      this.body.append(h('div', { class: 'hint' },
        `Map16: ${tiles.slice(0, 12).map(hex3).join(' ')}${tiles.length > 12 ? ' …' : ''}`,
        ...(sum === undefined ? [h('br'), 'Verhalten wird ermittelt …'] : sum.flatMap((x) => [h('br'), x]))));
    }
  }

  buildExit(): void {
    const app = this.app;
    const lv = app.level;
    const scr = app.exitScreen;
    let ex = lv.exits.find((e) => e.screen === scr);
    this.body.appendChild(h('div', { class: 'prop-title' }, `Screen ${hex2(scr)}`));
    if (!ex) {
      this.body.appendChild(h('button', {
        onclick: () => { app.checkpoint(); lv.exits.push({ uid: newUid(), screen: scr, dest: 0, secondary: false, flags: 0 }); app.changed(); },
      }, 'Screen-Exit anlegen'));
    } else {
      const e = ex;
      const upd = (f: () => void) => { app.checkpoint(); f(); app.changed(false); };
      const sec = h('input', { type: 'checkbox', checked: e.secondary });
      sec.addEventListener('change', () => upd(() => (e.secondary = sec.checked)));
      this.body.append(
        this.field('Ziel', hexInput(e.dest, 3, (v) => upd(() => (e.dest = v)), 0x1ff)),
        this.field('Sekundär', sec),
        h('div', { class: 'hint' }, e.secondary ? 'Ziel = Nummer des sekundären Eingangs' : 'Ziel = Levelnummer (Haupteingang)'),
        h('button', { onclick: () => { app.checkpoint(); lv.exits = lv.exits.filter((x) => x !== e); app.changed(); } }, 'Exit löschen'),
      );
      ex = e;
    }
    this.body.appendChild(h('div', { class: 'hint' }, 'Screen per Klick in der Levelansicht wählen. Exits gelten für Türen, Rohre usw. auf diesem Screen.'));
  }
}

// what the nibbles of a standard object's settings byte do (emulated, see objkinds.ts)
function nibbleText(k: ObjKind | null): string {
  if (!k) return 'Unteres Nibble = Breite, oberes = Höhe';
  if (k.lo === 'w' && k.hi === 'w') return 'Das ganze Byte ist die Breite';
  const part = (d: 'w' | 'h' | null, type: boolean) => (type ? 'Typ' : d === 'w' ? 'Breite' : d === 'h' ? 'Höhe' : 'ohne Wirkung');
  return `${k.type ? `Unterobjekt mit ${k.count} Typen: ` : ''}unteres Nibble = ${part(k.lo, k.type === 'lo')}, oberes = ${part(k.hi, k.type === 'hi')}`;
}

function sameImage(a: HTMLCanvasElement, b: HTMLCanvasElement): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const da = a.getContext('2d')!.getImageData(0, 0, a.width, a.height).data;
  const db = b.getContext('2d')!.getImageData(0, 0, b.width, b.height).data;
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) return false;
  return true;
}
