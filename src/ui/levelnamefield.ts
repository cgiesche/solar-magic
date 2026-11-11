// A level's name in the properties of its level tile (overworld): typed as text (Lunar Magic's table, `\XX` for a
// tile without a character, its MultiChar tiles for "YELLOW" and " ILLUSI" when chosen), previewed in place on the
// overworld's border as the map shown has it in VRAM – a character the font lacks is marked there and in a note, a
// name too long is refused. Enter or leaving the field writes it: one ROM edit. The map font's character table is a
// popover at the field while it has the focus (ADR 0015, #462): a click types a character at the caret.

import type { App } from './app.ts';
import { h, checkbox } from './dom.ts';
import { hex, hex3 } from '../core/names.ts';
import type { OwRender } from '../core/overworld.ts';
import { translevelToLevel } from '../core/overworld.ts';
import { TileCache, blit8 } from '../core/render.ts';
import { levelNameTiles, setLevelNameTiles, decodeName, encodeName, tileChar, tileEscape, NAME_LEN, NAME_VRAM, NAME_ATTR, NAME_SPACE, type EncodedName } from '../core/levelnames.ts';
import { boolPref } from './prefs.ts';
import { closeMenus, onCloseMenus } from './menu.ts';
import { placeLabel } from './owlevelname.ts';
import { icon } from './icons.ts';

const COLS = 32, ROWS = 3, FIRST_ROW = 3; // the border's rows shown: the name's (4) with the one above and below
const W = COLS * 8, H = ROWS * 8;
const FONT_TILES = 0x100; // the tiles the picker shows (16 × 16)
const MISSING = 0xff3030e0, TOO_LONG = 0x803030ff; // (ABGR) // a character without a tile; a tile past the name's 19 (blended)

const multiCharPref = boolPref('level-name-multi-char', true);
let multiChar = multiCharPref.get();
function setMultiChar(on: boolean): void {
  multiChar = on;
  multiCharPref.set(on);
}

// the layer 3 font of the map shown: tile t as the game writes a name's tile
export function nameFont(r: OwRender): (t: number) => Uint32Array {
  const tc = new TileCache(r.vram, r.cgram, (r.ppuRegs[0x0c] & 0x0f) << 13);
  return (t) => tc.get((NAME_ATTR << 8) | t, 2);
}

// the border's rows around the name as the map shown has them, the name's tiles (shown: -1 a character the font lacks)
// in its place
function drawBorder(c: HTMLCanvasElement, r: OwRender | null, shown: number[]): void {
  const ctx = c.getContext('2d')!, img = ctx.createImageData(W, H), px = new Uint32Array(img.data.buffer).fill(0xff000000);
  if (r) {
    const tc = new TileCache(r.vram, r.cgram, (r.ppuRegs[0x0c] & 0x0f) << 13), map = (r.ppuRegs[0x09] & 0xfc) << 9;
    const at = NAME_VRAM * 2 - map, row = (at >> 6) - FIRST_ROW, col = (at >> 1) & 31, g = nameFont(r);
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const a = map + ((FIRST_ROW + y) * COLS + x) * 2;
      blit8(px, W, H, tc.get(r.vram[a] | (r.vram[a + 1] << 8), 2), x * 8, y * 8);
    }
    for (let k = 0; k < Math.max(NAME_LEN, shown.length) && col + k < COLS && row >= 0 && row < ROWS; k++) {
      const t = shown[k] ?? NAME_SPACE, x = (col + k) * 8, y = row * 8;
      for (let i = 0; i < 64; i++) px[(y + (i >> 3)) * W + x + (i & 7)] = 0xff000000;
      if (t >= 0) blit8(px, W, H, g(t), x, y);
      for (let i = 0; i < 64; i++) {
        const p = (y + (i >> 3)) * W + x + (i & 7), edge = i >> 3 === 0 || i >> 3 === 7 || (i & 7) === 0 || (i & 7) === 7;
        if (t < 0 && edge) px[p] = MISSING;
        else if (k >= NAME_LEN) px[p] = blend(px[p], TOO_LONG);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
const blend = (a: number, b: number) => {
  const f = (b >>> 24) / 255, ch = (s: number) => Math.round(((a >> s) & 0xff) * (1 - f) + ((b >> s) & 0xff) * f);
  return (0xff000000 | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
};

// the name field's rows for translevel tl, drawn with the map's load r (null: the border not shown yet); edit: the name
// of the ROM edit writing it (a star's or pipe's name: its own)
export function levelNameField(app: App, tl: number, r: OwRender | null, edit = `Level name ${hex3(translevelToLevel(tl))}`): HTMLElement[] {
  const rom = app.rom;
  const text = () => decodeName(levelNameTiles(rom, tl), multiChar);
  const input = h('input', { type: 'text', class: 'ln-input', spellcheck: false, autocomplete: 'off', value: text(), 'aria-label': 'Level name',
    title: `The name the overworld's border shows while Mario stands here: up to ${NAME_LEN} tiles; \\XX types tile XX (or a click on the map's font, shown while typing)` });
  const canvas = h('canvas', { width: W, height: H, class: 'ln-border', title: 'As the overworld\'s border shows it (this map\'s font)' });
  const note = h('div', { class: 'hint' });
  let enc: EncodedName = encodeName(input.value, multiChar);
  const problem = (): string => {
    const m = [...new Set(enc.missing.map((x) => x.ch))];
    return [
      m.length ? `The font has no ${m.map((x) => `“${x}”`).join(' ')} (marked) – \\XX types a tile by number, or click one in the font at the field` : '',
      enc.tiles.length > NAME_LEN ? `${enc.tiles.length - NAME_LEN} tile${enc.tiles.length - NAME_LEN > 1 ? 's' : ''} too long (${NAME_LEN} fit)` : '',
    ].filter(Boolean).join('. ');
  };
  const update = () => {
    enc = encodeName(input.value, multiChar);
    const p = problem();
    note.replaceChildren(...(p ? [icon('warning'), ` ${p}`] : [`${enc.tiles.length} of ${NAME_LEN} tiles`]));
    note.classList.toggle('warn-text', !!p);
    input.classList.toggle('bad', !!p);
    drawBorder(canvas, r, enc.shown);
  };
  const commit = () => {
    update();
    if (problem()) return;
    if (levelNameTiles(rom, tl).every((t, k) => t === (enc.tiles[k] ?? NAME_SPACE))) return;
    app.romEdit(edit, () => setLevelNameTiles(rom, tl, enc.tiles));
  };
  input.addEventListener('input', update);
  input.addEventListener('change', commit);
  const chars = charTable(input, note, r, (t) => {
    const ch = tileChar(t) ?? tileEscape(t), a = input.selectionStart ?? input.value.length, b = input.selectionEnd ?? a;
    input.value = input.value.slice(0, a) + ch + input.value.slice(b);
    input.setSelectionRange(a + ch.length, a + ch.length);
    update();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key !== 'Escape') return;
    e.preventDefault();
    // (Esc layered: the character table closed first, the field keeps the focus; then the typing undone)
    if (chars.close()) e.stopPropagation();
    else { input.value = text(); update(); input.blur(); }
  });
  update();
  return [
    h('div', { class: 'prop' }, h('label', null, 'Name'), input, chars.box),
    canvas,
    note,
    h('div', { class: 'row' },
      checkbox(' MultiChar tiles', 'Lunar Magic\'s MultiChar tiles: “YELLOW” and “ ILLUSI” typed as the game\'s squished tiles (as in “YELLOW SWITCH PALACE”, “FOREST OF ILLUSION”), and shown as these letters', multiChar, (on) => {
        setMultiChar(on);
        if (!enc.missing.length) input.value = decodeName(enc.tiles, on);
        update();
      })),
  ];
}

// the character table shown (one at a time), closed with the menus and popovers (menu.ts closeMenus)
let shownTable: (() => boolean) | null = null;
onCloseMenus(() => shownTable?.());

const rectOf = (b: DOMRect) => ({ x: b.left, y: b.top, w: b.width, h: b.height });

// the map's font as a popover at the name field (fixed: out of the side panel's scrolling), shown while the field has
// the focus – under it and its preview down to keepSeen (the preview and its note stay seen while typing), above the
// field where there is no room below; none while the field is scrolled out of its panel. A click types a character
// and the focus stays in the field; closed by Esc, a click in the field or typing shows it again. close(): false when
// it was not shown
function charTable(input: HTMLInputElement, keepSeen: HTMLElement, r: OwRender | null, pick: (t: number) => void): { box: HTMLElement; close: () => boolean } {
  const box = h('div', { class: 'popover ln-chars', role: 'dialog', 'aria-label': 'The map\'s font: a click types a character', hidden: true },
    r ? fontPicker(r, pick) : h('div', { class: 'hint' }, 'The font is shown once the map is loaded.'));
  // (a click in it beside the font: the focus stays in the field too)
  box.addEventListener('mousedown', (e) => e.preventDefault());
  const place = () => {
    if (!input.isConnected || document.activeElement !== input) { close(); return; }
    const f = input.getBoundingClientRect(), clip = (input.closest('.props') ?? document.documentElement).getBoundingClientRect();
    const seen = f.bottom > clip.top && f.top < clip.bottom;
    const anchor = { ...rectOf(f), h: Math.max(f.height, keepSeen.getBoundingClientRect().bottom - f.top) };
    const at = seen ? placeLabel(anchor, box.offsetWidth, box.offsetHeight, { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }, 3) : null;
    box.style.visibility = at ? '' : 'hidden';
    if (at) { box.style.left = `${at.x}px`; box.style.top = `${at.y}px`; }
  };
  const open = () => {
    if (!box.hidden) return;
    closeMenus(); // (one popover at a time: another field's table too)
    shownTable = close;
    box.hidden = false;
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
  };
  const close = (): boolean => {
    if (box.hidden) return false;
    if (shownTable === close) shownTable = null;
    box.hidden = true;
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    return true;
  };
  input.addEventListener('focus', open);
  input.addEventListener('blur', () => close());
  const again = () => { if (document.activeElement === input) open(); };
  input.addEventListener('mousedown', again);
  input.addEventListener('input', again);
  return { box, close };
}

// the map's font, 16 × 16 tiles; a click types one
function fontPicker(r: OwRender, pick: (t: number) => void): HTMLCanvasElement {
  const c = h('canvas', { width: 16 * 8, height: (FONT_TILES / 16) * 8, class: 'msg-font ln-font' });
  const ctx = c.getContext('2d')!, img = ctx.createImageData(c.width, c.height), px = new Uint32Array(img.data.buffer).fill(0xff000000);
  const g = nameFont(r);
  for (let k = 0; k < FONT_TILES; k++) blit8(px, c.width, c.height, g(k), (k & 15) * 8, (k >> 4) * 8);
  ctx.putImageData(img, 0, 0);
  const tileAt = (e: MouseEvent) => {
    const b = c.getBoundingClientRect();
    return Math.min(15, Math.floor(((e.clientX - b.left) / b.width) * 16)) + 16 * Math.min(15, Math.floor(((e.clientY - b.top) / b.height) * 16));
  };
  c.addEventListener('mousemove', (e) => { const t = tileAt(e), ch = tileChar(t); c.title = `${hex(t, 2)}${ch ? ` “${ch}”` : ` (${tileEscape(t)})`} · click to type it`; });
  c.addEventListener('mousedown', (e) => { e.preventDefault(); pick(tileAt(e)); });
  return c;
}
