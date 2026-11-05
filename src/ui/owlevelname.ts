// The name of the selected level tile in the overworld's Levels mode (#369): the level's name drawn in a box under the
// tile in the map's own font (as the overworld's border shows it). A click on the box opens a popover editing the name
// in place – typed as its tiles (core/levelnames.ts typeNameChar, nameKey), a character the font lacks refused while
// typing, said why; Enter or a click outside the popover writes it (one ROM edit), Esc drops it. Beside it the
// translevel's switches as the Levels properties have them (no entry once passed, save prompt) and the other level
// tiles entering the level ("Also used by the tile on Vanilla Dome", owleveltiles.ts alsoUsedBy). A star selected in the
// layer 1 mode (owstars.ts) has its name drawn so too – the status bar's while Mario stands on it –, the popover opened
// by its properties' button (a click on the map paints there), without the switches (it enters no level).

import type { OverworldView } from './overworld.ts';
import { h, checkbox } from './dom.ts';
import { refusalText } from './owrefusal.ts';
import { nameFont } from './levelnamefield.ts';
import { l1XY, owShownAt, translevelToLevel, levelTilesOf, initialFlags, setInitialFlags, FLAG, type OwRender } from '../core/overworld.ts';
import { levelNameTiles, setLevelNameTiles, levelNamePatch, trimName, typeNameChar, nameKey, NAME_LEN, type NameCaret } from '../core/levelnames.ts';
import { alsoUsedBy } from '../core/owleveltiles.ts';
import { isStar } from '../core/owstars.ts';
import { blit8 } from '../core/render.ts';
import { hex2, hex3 } from '../core/names.ts';

const PAD = 2, BOX_H = 8 + 2 * PAD; // the name's box on the map: its tiles in a dark box (map pixels)
const EDIT_COLS = NAME_LEN + 1; // the editor: the 19 tiles and room for the caret after them
const CARET = 0xffffc24c; // (ABGR)

// the translevel switches beside the name (as in the Levels properties' "At the start of a new game")
const SWITCHES: [string, number, string][] = [
  ['No entry if passed', FLAG.noEntry, 'Once passed, the level can\'t be entered again'],
  ['Save prompt when passed', FLAG.savePrompt, 'Passing the level brings up the save prompt (as castles and switch palaces do)'],
];

// a name's tiles in the map's font, `cols` tiles wide (8 high), on black
function nameImage(r: OwRender | null, tiles: number[], cols: number): { img: ImageData; px: Uint32Array } {
  const img = new ImageData(cols * 8, 8), px = new Uint32Array(img.data.buffer).fill(0xff000000);
  if (r) { const g = nameFont(r); tiles.forEach((t, k) => blit8(px, cols * 8, 8, g(t), k * 8, 0)); }
  return { img, px };
}

interface Popover {
  i: number; tl: number; star: boolean; // the level tile or star (l1Index), its translevel
  name: NameCaret;
  dirty: boolean; // typed into since opened (else it follows the ROM: undo)
  root: HTMLElement; canvas: HTMLCanvasElement; input: HTMLTextAreaElement; note: HTMLElement; rest: HTMLElement;
  outside: (e: MouseEvent) => void; // (a click outside the popover and the map: written, closed)
}

export class LevelNameEditor {
  private pop: Popover | null = null;
  private image: { tiles: string; r: OwRender; c: HTMLCanvasElement } | null = null; // the box's tiles drawn
  constructor(private view: OverworldView) {}

  // the selected level tile (Levels mode) or star (layer 1 mode) and its translevel (null: none, another mode, no level
  // names in the ROM)
  private target(): { i: number; tl: number; star: boolean } | null {
    const v = this.view, i = v.selected;
    if ((v.mode !== 'levels' && v.mode !== 'l1') || i < 0 || (i >= 0x400) !== (v.region === 1) || !levelNamePatch(v.app.rom)) return null;
    const tl = v.tls[i], t = v.levelL1()[i];
    if (!tl) return null;
    if (v.mode === 'levels') return v.isLevelTile(t) ? { i, tl, star: false } : null;
    return v.pathKinds() && isStar(t) ? { i, tl, star: true } : null;
  }
  // the name shown: as typed while edited, else as in the ROM
  private tiles(tl: number): number[] {
    return this.pop?.tl === tl ? this.pop.name.tiles : trimName(levelNameTiles(this.view.app.rom, tl));
  }
  // the name's box in map pixels: under the tile, centred on it, kept on the map (above the tile at its bottom)
  private box(i: number, len: number): { x: number; y: number; w: number; h: number } {
    const { x, y } = l1XY(i), w = Math.max(len, 3) * 8 + 2 * PAD;
    const bx = Math.max(0, Math.min(512 - w, x * 16 + 8 - w / 2)), below = y * 16 + 18;
    return { x: bx, y: below + BOX_H > 512 ? y * 16 - BOX_H - 2 : below, w, h: BOX_H };
  }

  // drawn on the map (its pixels): the name in the map's font, outlined as the selected tile is
  paint(ctx: CanvasRenderingContext2D, lw: number): void {
    const t = this.target(), r = t && this.view.render();
    if (!t || !r) return;
    const tiles = this.tiles(t.tl), b = this.box(t.i, tiles.length);
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = '#4cc2ff';
    ctx.lineWidth = lw;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    if (!tiles.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '7px sans-serif';
      ctx.fillText('name', b.x + PAD + 1, b.y + PAD + 7);
      return;
    }
    // (drawn again for another name or another load of the map: its font)
    if (this.image?.tiles !== tiles.join() || this.image.r !== r) {
      const c = document.createElement('canvas');
      c.width = tiles.length * 8; c.height = 8;
      c.getContext('2d')!.putImageData(nameImage(r, tiles, tiles.length).img, 0, 0);
      this.image = { tiles: tiles.join(), r, c };
    }
    ctx.drawImage(this.image.c, b.x + PAD, b.y + PAD);
  }

  // a click on the map at pixel p; true: taken – one open closed (the name typed written), or (Levels mode) the
  // popover opened by a click on the name's box
  down(p: { x: number; y: number }): boolean {
    if (this.pop) { this.close(true); return true; }
    const t = this.target();
    if (!t || t.star) return false;
    const b = this.box(t.i, this.tiles(t.tl).length);
    if (p.x < b.x || p.x >= b.x + b.w || p.y < b.y || p.y >= b.y + b.h) return false;
    this.open(t.i, t.tl, false);
    return true;
  }
  // the popover opened on the selected star's name (its properties' button); false: no star selected, no level names
  openStar(): boolean {
    const t = this.target();
    if (!t?.star) return false;
    if (!this.pop) this.open(t.i, t.tl, true);
    return true;
  }
  // whether the name is being typed (a click on the map closes it first)
  get editing(): boolean { return !!this.pop; }
  // Esc outside the name: the popover closed, the name typed dropped; false: none open
  cancel(): boolean {
    if (!this.pop) return false;
    this.close(false);
    return true;
  }

  // ---- the popover ----
  private open(i: number, tl: number, star: boolean): void {
    const v = this.view, tiles = trimName(levelNameTiles(v.app.rom, tl));
    const canvas = h('canvas', { width: EDIT_COLS * 8, height: 8, class: 'ow-name-canvas' });
    const input = h('textarea', { class: 'msg-input', spellcheck: false, autocomplete: 'off', 'aria-label': 'Level name',
      title: 'Type the name (the characters of the map\'s font) · Enter writes it, Esc drops it' });
    const note = h('div', { class: 'hint' }), rest = h('div', { class: 'ow-name-rest' });
    const root = h('div', { class: 'ow-name-pop' }, h('div', { class: 'ow-name-box' }, canvas, input), note, rest);
    // (clicks on the map: down)
    const outside = (e: MouseEvent) => { const t = e.target as Node; if (!root.contains(t) && !v.scroller.contains(t)) this.close(true); };
    this.pop = { i, tl, star, name: { tiles, at: tiles.length }, dirty: false, root, canvas, input, note, rest, outside };
    this.wire(this.pop);
    window.addEventListener('mousedown', outside, true);
    v.scroller.parentElement!.append(root);
    this.refresh();
    this.place();
    input.focus();
    this.say('');
  }
  // closed: the name typed written when it changed (commit), else dropped
  close(commit: boolean): void {
    const p = this.pop;
    if (!p) return;
    this.pop = null;
    window.removeEventListener('mousedown', p.outside, true);
    p.root.remove();
    const rom = this.view.app.rom;
    if (commit && p.dirty && trimName(levelNameTiles(rom, p.tl)).join() !== p.name.tiles.join())
      this.view.app.romEdit(p.star ? `Star name (translevel ${hex2(p.tl)})` : `Level name ${hex3(translevelToLevel(p.tl))}`, () => setLevelNameTiles(rom, p.tl, p.name.tiles));
    this.view.paint();
  }
  // the popover under the name's box where the view paints it (its screen pixels per map pixel, its scroll: paint);
  // hidden while the box is scrolled out of the map's view
  place(): void {
    const p = this.pop, v = this.view;
    if (!p) return;
    const dpr = window.devicePixelRatio || 1, z = Math.round(v.zoom * dpr * 2) / 2, s = v.scroller;
    const b = this.box(p.i, p.name.tiles.length), at = owShownAt(v.region, b.x, b.y + b.h);
    const x = (at.x * z - Math.round(s.scrollLeft * dpr)) / dpr, y = (at.y * z - Math.round(s.scrollTop * dpr)) / dpr;
    p.root.style.display = x < 0 || y < 0 || x > s.clientWidth || y > s.clientHeight ? 'none' : '';
    p.root.style.left = `${s.offsetLeft + x}px`;
    p.root.style.top = `${s.offsetTop + y + 4}px`;
  }
  // the ROM changed (an edit, undo): the switches and the tiles sharing the level again; the name too unless typed into
  refresh(): void {
    const p = this.pop, v = this.view, rom = v.app.rom;
    if (!p) return;
    if (v.selected !== p.i || v.tls[p.i] !== p.tl || !this.target()) { this.close(false); return; }
    if (!p.dirty) { const t = trimName(levelNameTiles(rom, p.tl)); p.name = { tiles: t, at: Math.min(p.name.at, t.length) }; }
    const flags = initialFlags(rom, p.tl), lvl = hex3(translevelToLevel(p.tl));
    const views = v.views, others = (p.star ? [...v.tls.keys()].filter((k) => v.tls[k] === p.tl) : levelTilesOf(v.levelL1(), v.tls, p.tl, v.isLevelTile)).filter((k) => k !== p.i);
    const shared = !others.length ? '' : views ? alsoUsedBy(others, views) : `Also used by ${others.length} other tile${others.length > 1 ? 's' : ''}`;
    // (a star: no switches – it enters no level)
    const rest = p.star ? { note: 'The status bar shows it while Mario stands on the star', owner: 'name and ways are the translevel\'s' }
      : { note: '', owner: 'name and switches are the level\'s' };
    p.rest.replaceChildren(
      ...(rest.note ? [h('div', { class: 'hint' }, rest.note)] : SWITCHES.map(([label, bit, title]) => checkbox(` ${label}`, title, (flags & bit) !== 0, (on) => {
        v.app.romEdit(`Level ${lvl}: initial flags`, () => setInitialFlags(rom, p.tl, on ? flags | bit : flags & ~bit));
        p.input.focus(); // (typing goes on)
      }))),
      ...(shared ? [h('div', { class: 'hint warn-text' }, `${shared} – the ${rest.owner}, for all of them`)] : []));
    this.draw();
  }

  private wire(p: Popover): void {
    const { input } = p, app = this.view.app;
    const set = (n: NameCaret) => {
      p.dirty ||= n.tiles.join() !== p.name.tiles.join();
      p.name = n;
      this.draw();
      this.view.paint();
    };
    input.addEventListener('mousedown', (e) => {
      const r = input.getBoundingClientRect(), col = Math.round(((e.clientX - r.left) / r.width) * EDIT_COLS);
      set({ tiles: p.name.tiles, at: Math.max(0, Math.min(p.name.tiles.length, col)) });
    });
    input.addEventListener('focus', () => this.draw());
    input.addEventListener('blur', () => this.draw());
    input.addEventListener('keydown', (e) => {
      const k = e.key, ctrl = e.ctrlKey || e.metaKey;
      // Ctrl+Z: what is typed dropped, else the last ROM edit undone; Ctrl+Y redoes
      if (ctrl && k.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (p.dirty) { p.dirty = false; this.refresh(); this.view.paint(); this.say(''); } else app.undo();
        return;
      }
      if (ctrl && (k.toLowerCase() === 'y' || (k.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); app.redo(); return; }
      if (ctrl || e.altKey) return;
      if (k === 'Enter') { e.preventDefault(); this.close(true); return; }
      if (k === 'Escape') { e.preventDefault(); this.close(false); return; }
      const n = nameKey(p.name, k);
      if (!n) return;
      e.preventDefault();
      set(n);
      this.say('');
    });
    // typed (and pasted) characters, one by one: the first the name can't take refused, with the reason
    const type = (text: string) => {
      let n = p.name, why = '';
      for (const ch of text.replace(/\r?\n/g, ' ')) {
        const t = typeNameChar(n, ch);
        if ('kind' in t) { why = refusalText(this.view.app.rom, t); break; }
        n = t;
      }
      set(n);
      this.say(why, !!why);
    };
    const typed = () => { const s = input.value; input.value = ''; type(s); };
    input.addEventListener('input', (e) => { if (!(e as InputEvent).isComposing) typed(); }); // (an accent composed: when done)
    input.addEventListener('compositionend', typed);
    input.addEventListener('paste', (e) => { e.preventDefault(); type(e.clipboardData?.getData('text/plain') ?? ''); });
  }

  // the name as typed in the map's font, the caret while typing
  private draw(): void {
    const p = this.pop;
    if (!p) return;
    const c = p.canvas, { img, px } = nameImage(this.view.render(), p.name.tiles, EDIT_COLS);
    if (document.activeElement === p.input) for (let y = 0; y < 8; y++) px[y * c.width + Math.min(c.width - 1, p.name.at * 8)] = CARET;
    c.getContext('2d')!.putImageData(img, 0, 0);
  }
  private say(text: string, warn = false): void {
    const p = this.pop;
    if (!p) return;
    p.note.textContent = text || `${p.name.tiles.length} of ${NAME_LEN} tiles · Enter writes it, Esc drops it`;
    p.note.classList.toggle('warn-text', warn);
  }
}
