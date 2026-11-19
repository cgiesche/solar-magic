// A menu's text (CONTEXT.md: menu, menu text): the layer 3 tiles of the file select, the file erase, the player
// select, the save prompt and the game over prompt, edited where the game has them – in the menu's stripe image.
// Lunar Magic can't edit these.
//
// Nothing here knows where a menu's stripe image is. The way to the menu is run again (pregame.ts replayScreen) with
// every byte's source tracked (Snes.trackSources): each byte the game writes to VRAM is known by the ROM offset it
// was loaded from – whether the game uploads the stripe image from the ROM (player select, the prompts) or copies it
// to the stripe buffer first and writes into it (file select, file erase). A stripe image is found where the four
// bytes before a tile's are the header that puts it at the tile's place; walked from there to its end, it says which
// ROM word each cell of the tilemap shows. Also learned from the emulated game, not from its tables:
// - the cursor's cells: the cells that change as the selection moves down and the cursor blinks;
// - the cells the game writes over: where, with the save files empty, with some exits and with all exits, a cell
//   of the stripe image shows something other than the image's word (the exit count, the star at all exits, the
//   blanked "EMPTY", the cursor's column). The save files are made by the game: the save prompt's first choice taken
//   for each file.
// A menu whose picture is not a stripe image's (Sprite Title Screen Menus) has no menu text: its page is a picture.
//
// Edited in place: a painted cell is its word in the ROM, the image as long as it was. A run of the image (one
// word shown by several cells) is painted as one.

import type { LevelEmulator } from './levelemu.ts';
import type { Rom } from './rom.ts';
import { RAM } from './ram.ts';
import { L3_MAP_VRAM } from './layer3map.ts';
import { holds, type RomReads } from './romdeps.ts';
import { replayScreen, PAD, MAX_CHOICES, type ReachedScreen } from './pregame.ts';
import { saveAtPrompt, SAVE_FILES } from './savefile.ts';

export const MENU_COLS = 32, MENU_ROWS = 32; // the first screen of layer 3's tilemap
const CELLS = MENU_COLS * MENU_ROWS;
const BLINK = 40; // the frames a choice is looked at for the cursor's cells
const MAX_IMAGE = 0x2000; // a stripe image's bytes at most
const MAX_ENTRY = 0x400; // the words of one of its entries looked back over for its header
const EXITS = [12, 255]; // the exit counts of the save files tried: some, all (the most a file counts)

export interface MenuText {
  addr: number; // the stripe image (ROM offset)
  length: number; // its bytes, with the byte that ends it
  map: Uint16Array; // the tilemap as the menu shows it (MENU_COLS × MENU_ROWS words, with the cursor)
  source: Int32Array; // per cell: the ROM offset of the image's word it shows (-1: not of the image, not edited here)
  shared: Uint8Array; // per cell: 1 where its word is a run's, shown by other cells too
  cursor: number[]; // the cells the cursor is drawn in, one per choice
  written: Uint8Array; // per cell: 1 where the game writes over the image (cursor, exit count, a blanked word)
}

interface Entry { vram: number; step: number; rle: boolean; words: number; data: number }

// the stripe image at ROM offset `at`, walked to its end (null: none that ends)
function stripeImage(d: Uint8Array, at: number): { entries: Entry[]; length: number } | null {
  const entries: Entry[] = [];
  let o = at;
  for (; o < d.length && !(d[o] & 0x80); ) {
    if (o + 6 > d.length || o - at > MAX_IMAGE) return null;
    const rle = !!(d[o + 2] & 0x40), len = (((d[o + 2] & 0x3f) << 8) | d[o + 3]) + 1;
    entries.push({ vram: (d[o] << 8) | d[o + 1], step: d[o + 2] & 0x80 ? 32 : 1, rle, words: len >> 1, data: o + 4 });
    o += 4 + (rle ? 2 : len);
  }
  return o < d.length && entries.length ? { entries, length: o + 1 - at } : null;
}

// per cell the ROM offset of the image's word it shows (the last entry that writes it)
function imageCells(entries: Entry[]): Int32Array {
  const src = new Int32Array(CELLS).fill(-1);
  for (const e of entries) for (let i = 0; i < e.words; i++) {
    const c = e.vram + i * e.step - L3_MAP_VRAM;
    if (c >= 0 && c < CELLS) src[c] = e.data + (e.rle ? 0 : i * 2);
  }
  return src;
}

// the way to the menu run again: per VRAM byte the ROM offset it was loaded from (-1: none, or not written)
function vramSources(emu: LevelEmulator, screen: ReachedScreen, sram?: Uint8Array): Int32Array {
  const s = emu.snes, src = new Int32Array(s.vram.length).fill(-1);
  replayScreen(emu, screen, { onVramWrite: (a) => { src[a] = s.writeSource; } }, { sram, sources: true });
  return src;
}

// Save files as the game writes them, each with `exits` as its exit count: from the save prompt, its first choice
// taken for every file. null: no save prompt, or the game saved nothing.
function savedFiles(emu: LevelEmulator, prompt: ReachedScreen | undefined, exits: number): Uint8Array | null {
  if (!prompt) return null;
  const s = emu.snes, w = s.wram;
  let sram = (prompt.state.sram as Uint8Array).slice();
  for (let file = 0; file < SAVE_FILES; file++) {
    s.loadState(prompt.state);
    s.sram.set(sram);
    w[RAM.saveFile] = file;
    w[RAM.eventsTriggered] = exits;
    if (!saveAtPrompt(s)) return null;
    sram = s.sram.slice();
  }
  return sram;
}

// the cells of the first screen of layer 3 that change while the selection moves through the menu's choices
function cursorCells(emu: LevelEmulator, screen: ReachedScreen): number[] {
  const s = emu.snes, was = screen.state.vram as Uint8Array, cells = new Set<number>();
  s.loadState(screen.state);
  s.joy1 = 0;
  const look = () => {
    for (let c = 0; c < CELLS; c++) {
      const a = (L3_MAP_VRAM + c) * 2;
      if (s.vram[a] !== was[a] || s.vram[a + 1] !== was[a + 1]) cells.add(c);
    }
  };
  for (let k = 0; k < MAX_CHOICES && s.wram[RAM.gameMode] === screen.mode; k++) {
    for (let f = 0; f < BLINK; f++) { s.runFrame(); look(); }
    s.joy1 = PAD.down;
    s.runFrame();
    s.joy1 = 0;
  }
  return [...cells].sort((a, b) => a - b);
}

// The menu's text as the game draws it (null: its picture is not a stripe image's). `screens`: the screens reached
// (for the save prompt, by which save files are made). The emulator's machine is left in the last state run.
export function learnMenuText(emu: LevelEmulator, screen: ReachedScreen, screens: readonly ReachedScreen[]): MenuText | null {
  const s = emu.snes, d = emu.rom.data, hook = s.hook;
  s.hook = null;
  try {
    const first = vramSources(emu, screen), shown = s.vram.slice();
    // where a stripe image starts: a word of VRAM loaded from the ROM, the four bytes before it the header that puts
    // it there
    // (any word of an entry tells: its first may be written over, as the file erase's by the cursor)
    const starts = new Set<number>();
    for (let a = 0; a + 1 < first.length; a += 2) {
      const o = first[a];
      if (o < 4 || first[a + 1] !== o + 1) continue;
      for (let k = 0; k < MAX_ENTRY && o - 4 - k * 2 >= 0; k++) {
        const h = o - 4 - k * 2;
        if (d[h] & 0x80) continue;
        const rle = !!(d[h + 2] & 0x40), words = ((((d[h + 2] & 0x3f) << 8) | d[h + 3]) + 1) >> 1, by = ((a >> 1) - ((d[h] << 8) | d[h + 1])) / (d[h + 2] & 0x80 ? 32 : 1);
        if (rle ? k === 0 && Number.isInteger(by) && by >= 0 && by < words : by === k && k < words) { starts.add(h); break; }
      }
    }
    // the image that most of layer 3's cells are of (images walked from the lowest start on: one start per image)
    let best: { at: number; length: number; source: Int32Array; n: number } | null = null;
    let end = -1;
    for (const at of [...starts].sort((a, b) => a - b)) {
      if (at < end) continue;
      const img = stripeImage(d, at);
      if (!img) continue;
      end = at + img.length;
      const source = imageCells(img.entries);
      let n = 0;
      for (let c = 0; c < CELLS; c++) if (source[c] >= 0 && first[(L3_MAP_VRAM + c) * 2] === source[c]) n++;
      if (n && (!best || n > best.n)) best = { at, length: img.length, source, n };
    }
    if (!best) return null;
    const source = best.source, written = new Uint8Array(CELLS), shared = new Uint8Array(CELLS), count = new Map<number, number>();
    for (const o of source) if (o >= 0) count.set(o, (count.get(o) ?? 0) + 1);
    source.forEach((o, c) => { if (o >= 0 && count.get(o)! > 1) shared[c] = 1; });
    const mark = (src: Int32Array) => {
      for (let c = 0; c < CELLS; c++) {
        const a = (L3_MAP_VRAM + c) * 2;
        if (source[c] >= 0 && (src[a] !== source[c] || src[a + 1] !== source[c] + 1)) written[c] = 1;
      }
    };
    mark(first);
    const prompt = screens.find((x) => x.id === 'savePrompt');
    for (const exits of EXITS) {
      const sram = savedFiles(emu, prompt, exits);
      if (sram) mark(vramSources(emu, screen, sram));
    }
    const cursor = cursorCells(emu, screen);
    for (const c of cursor) if (source[c] >= 0) written[c] = 1;
    const map = Uint16Array.from({ length: CELLS }, (_, c) => shown[(L3_MAP_VRAM + c) * 2] | (shown[(L3_MAP_VRAM + c) * 2 + 1] << 8));
    return { addr: best.at, length: best.length, map, source, shared, cursor, written };
  } finally {
    s.hook = hook;
    s.joy1 = 0;
  }
}

// The menu's text, kept per emulator and screen while the ROM bytes the game read for it are as they were.
const kept = new WeakMap<LevelEmulator, Map<string, { gen: number; reads: RomReads; screen: ReachedScreen; text: MenuText | null }>>();
export function menuText(emu: LevelEmulator, screen: ReachedScreen, screens: readonly ReachedScreen[]): MenuText | null {
  let m = kept.get(emu);
  if (!m) kept.set(emu, m = new Map());
  const had = m.get(screen.id);
  if (had && had.screen === screen && holds(emu.rom, had)) return had.text;
  const r = emu.record('title screen', () => learnMenuText(emu, screen, screens));
  m.set(screen.id, { gen: r.gen, reads: r.reads, screen, text: r.result });
  return r.result;
}

// Cell `cell` of `map` (a copy of text.map being painted) set to `word`, the cells that show the same word of the
// image with it. false: nothing changed – it is that word already, or the cell is not of the image.
export function paintMenuCell(text: MenuText, map: Uint16Array, cell: number, word: number): boolean {
  const o = text.source[cell];
  if (o === undefined || o < 0) return false;
  let changed = false;
  const set = (c: number) => { if (map[c] !== word) { map[c] = word; changed = true; } };
  if (text.shared[cell]) text.source.forEach((x, c) => { if (x === o) set(c); }); else set(cell);
  return changed;
}

// the cells of `map` painted (other than text.map) that the game writes over
export function paintedOverwritten(text: MenuText, map: Uint16Array): number[] {
  const out: number[] = [];
  for (let c = 0; c < CELLS; c++) if (text.written[c] && text.source[c] >= 0 && map[c] !== text.map[c]) out.push(c);
  return out;
}

// Writes the painted cells of `map` into the menu's stripe image, in place; the number of words written. (A cell the
// game writes over is written too: the image has it, the game shows its own there.)
export function writeMenuText(rom: Rom, text: MenuText, map: Uint16Array): number {
  if (map.length !== CELLS) throw new Error(`A menu's tilemap has ${MENU_COLS} × ${MENU_ROWS} tiles`);
  const words = new Map<number, number>();
  for (let c = 0; c < CELLS; c++) if (text.source[c] >= 0 && map[c] !== text.map[c]) words.set(text.source[c], map[c]);
  for (const [o, w] of words) rom.writeAt(o, Uint8Array.from([w & 0xff, w >> 8]));
  return words.size;
}
