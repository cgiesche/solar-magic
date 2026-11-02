// Animation frames read from RAM and the graphics files (#214): pictures of a level (the placement preview, object
// thumbnails) have the graphics files of its layers and the frames of its Anim graphics in their input, not graphics
// files the game decompressed elsewhere at its load (their bytes aren't among those read). This checks that no frame
// shown reads such a file: after a level's load the files' data is only in the decompression buffer ($7EAD00, the
// last file decompressed – a layer file or another), and neither the game's tile animations nor the ExAnimation slots
// copy from there (the game's read GFX33 at $7E7D00, loaded by its own pointer at boot; ExAnimation slots reading RAM
// there, Lunar Magic's AN2, have their frames copied into an Anim graphic when imported, testanimframes.ts).
import { LevelEmulator, type LevelOverride } from '../src/core/levelemu.ts';
import { Rom } from '../src/core/rom.ts';
import { GFX_FILES } from '../src/core/patches.ts';
import { gfxFileRange } from '../src/core/gfxpages.ts';
import { loadLevel } from '../src/core/level.ts';
import { emptyList, writeLevelList, AN2_FRAMES, AN2_FRAMES_END } from '../src/core/exanim.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hex = (a: number) => '$' + (0x7e0000 + a).toString(16).toUpperCase();

const IMAGE = await editorImage();
const rom = new Rom(IMAGE.slice());
// 1 for the ROM bytes of graphics file data (the files of the file table)
const fileData = new Uint8Array(rom.data.length);
for (let i = 0; i < GFX_FILES; i++) { const r = gfxFileRange(rom, i); if (r) fileData.fill(1, r[0], r[1]); }

// the WRAM addresses DMA transfers to VRAM read while `dmas` is set
let dmas: Set<number> | null = null;
function watched(r: Rom): LevelEmulator {
  const e = new LevelEmulator(r), s = e.snes;
  e.boot();
  const runDma = s.runDma.bind(s);
  s.runDma = (mask: number) => {
    if (dmas) for (let ch = 0; ch < 8; ch++) {
      if (!(mask & (1 << ch))) continue;
      const d = s.dma, b = ch * 16;
      if (d[b] & 0x80 || (d[b + 1] !== 0x18 && d[b + 1] !== 0x19)) continue;
      const bank = d[b + 4], off = d[b + 2] | (d[b + 3] << 8), count = (d[b + 5] | (d[b + 6] << 8)) || 0x10000;
      const w = bank === 0x7e || bank === 0x7f ? (bank - 0x7e) * 0x10000 + off : (bank & 0x7f) < 0x40 && off < 0x2000 ? off : -1;
      if (w >= 0) for (let i = 0; i < count; i++) dmas.add(w + i);
    }
    runDma(mask);
  };
  return e;
}
const emu = watched(rom);
// the decompression buffer: Lunar Magic's AN2 is kept there
const BUFFER = AN2_FRAMES, BUFFER_END = AN2_FRAMES_END;
const inBuffer = (a: number) => a >= BUFFER && a < BUFFER_END;

// a level loaded and its animations run as for its pictures (LevelEmulator.animationFrames): the WRAM holding graphics
// file data after the load (low RAM aside: a byte of a file's data in scratch RAM) and what VRAM DMAs read
function run(e: LevelEmulator, n: number, ov: LevelOverride = {}): { files: number[]; read: Set<number> } {
  const s = e.snes;
  dmas = new Set();
  e.load(n, { ...ov, trackSources: true });
  const files: number[] = [];
  for (let a = 0x2000; a < 0x20000; a++) { const t = s.taint[a]; if (t >= 0 && fileData[t]) files.push(a); }
  e.animationFrames(16, 4);
  const read = dmas;
  dmas = null;
  return { files, read };
}

// a level of each tileset and sprite graphics set
{
  const seen = new Set<string>(), levels: number[] = [];
  for (let n = 0; n < 0x200; n++) {
    let h; try { h = loadLevel(rom, n).header; } catch { continue; }
    const k = `${h.tileset}:${h.spriteGfx}`;
    if (!seen.has(k)) { seen.add(k); levels.push(n); }
  }
  const outside: string[] = [], fromBuffer: string[] = [], fromFiles: string[] = [];
  let tracked = 0; // loads with graphics file data found in the buffer: the source tracking sees the files
  // without and with the switches pressed and ON/OFF off (the frames these show)
  for (const ov of [{}, { switchPalaces: true, onOffSwitch: true }] as LevelOverride[]) for (const n of levels) {
    const { files, read } = run(emu, n, ov);
    const l = n.toString(16) + (ov.switchPalaces ? ' switches' : '');
    if (files.some(inBuffer)) tracked++;
    const out = files.find((a) => !inBuffer(a));
    if (out !== undefined) outside.push(`${l} (${hex(out)})`);
    const b = [...read].find(inBuffer);
    if (b !== undefined) fromBuffer.push(`${l} (${hex(b)})`);
    const f = files.find((a) => read.has(a));
    if (f !== undefined) fromFiles.push(`${l} (${hex(f)})`);
  }
  check(levels.length > 20, `${levels.length} levels, one of each tileset and sprite graphics set`);
  check(tracked > levels.length, `graphics file data is found in the buffer after ${tracked} of ${levels.length * 2} loads`);
  check(!outside.length, `after the load graphics file data is only in the decompression buffer ${hex(BUFFER)}-${hex(BUFFER_END - 1)}${outside.length ? `: not in ${outside.join(', ')}` : ''}`);
  check(!fromBuffer.length, `no animation copies from the decompression buffer${fromBuffer.length ? `: ${fromBuffer.join(', ')}` : ''}`);
  check(!fromFiles.length, `no animation copies graphics file data decompressed at the load${fromFiles.length ? `: ${fromFiles.join(', ')}` : ''}`);
}

// an ExAnimation slot reading RAM as Lunar Magic's levels do (GFX33's coin frames at $7E7D00+): its frames are read
// there, not from the buffer
{
  const r = new Rom(IMAGE.slice()), N = 0x105, list = emptyList();
  list.slots.set(0, { type: 0x04, trigger: 0, framesLess1: 1, dest: 0x0400, frames: [0x9100, 0x9180] });
  list.count = 1;
  writeLevelList(r, N, list);
  const { read } = run(watched(r), N);
  check(read.has(0x9100) || read.has(0x9180), 'a slot\'s RAM frames are copied from where it points');
  check(![...read].some(inBuffer), 'not from the decompression buffer');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
