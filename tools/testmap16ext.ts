// Extended Map16 / acts like: the patch leaves vanilla behaviour unchanged, an extended tile with the
// graphics and acts-like of a vanilla tile renders and behaves exactly like that tile.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator, type LevelOverride } from '../src/core/levelemu.ts';
import { loadLevel, serializeLayer1, serializeSprites, isL1Vertical, newUid, type Level } from '../src/core/level.ts';
import { installEditorPatch, DM16_EXT } from '../src/core/patches.ts';
import { installMap16Ext, setActsLike, setExtTileWords, actsLike, LM_ACTS_PTRS } from '../src/core/map16ext.ts';
import { map16Source } from '../src/core/render.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { PAD } from '../src/core/ram.ts';

const file = new Uint8Array(readFileSync('test/fixtures/smw.smc'));
let bad = 0;
const list = [...Array(0x25).keys(), ...Array.from({ length: 0x3c }, (_, i) => 0x101 + i)];

const vanilla = new Rom(file.slice());
installEditorPatch(vanilla);
const patched = new Rom(vanilla.data.slice());
const ev = new LevelEmulator(vanilla); ev.boot();
const ep = new LevelEmulator(patched); ep.boot();
const blank = map16Source(vanilla, ev.load(0x105)).fg(0x025);
installMap16Ext(patched, blank);

// 1. every vanilla level loads identically (level map, Map16 pointers, BG1/BG2 tilemaps); the hook
// code costs cycles, so frame counters, fades and tile animation may be a frame apart
for (const n of list) {
  const a = ev.load(n), b = ep.load(n);
  let d = 0;
  for (let i = 0xc800; i < 0x10000; i++) if (a.wram[i] !== b.wram[i] || a.wram[i + 0x10000] !== b.wram[i + 0x10000]) d++;
  for (let i = 0x0fbe; i < 0x13be; i++) if (a.wram[i] !== b.wram[i]) d++;
  for (const reg of [0x07, 0x08]) {
    const base = (a.ppuRegs[reg] & 0xfc) << 9;
    for (let i = base; i < base + 0x1000; i++) if (a.vram[i & 0xffff] !== b.vram[i & 0xffff]) d++;
  }
  if (d || !b.ok) { console.log(n.toString(16), 'load differs with patch', d, b.error ?? ''); bad++; }
}

// scripted play: run right with Y, jump periodically; Mario position + camera per game frame
function play(emu: LevelEmulator, n: number, ov: LevelOverride = {}, frames = 400, input = (f: number) => PAD.y | PAD.right | (f % 50 < 22 ? PAD.b : 0)): string {
  const r = PlaySession.start(emu, n, { ov }).render!;
  if (!r.ok) return 'fail ' + r.error;
  const s = emu.snes, w = s.wram;
  w[0x13] = 0; w[0x14] = 0; w[0x148d] = 0; w[0x148e] = 0; // align frame counters and RNG
  const trace: number[] = [];
  // step per game frame: lag frames (the hooks cost cycles) don't count
  for (let f = 0; f < frames; f++) {
    s.joy1 = input(f);
    const t = w[0x13];
    for (let k = 0; k < 4 && w[0x13] === t; k++) s.runFrame();
    trace.push(w[0x94] | (w[0x95] << 8), w[0x96] | (w[0x97] << 8), w[0x1a] | (w[0x1b] << 8));
  }
  s.joy1 = 0;
  return trace.join(',');
}
// 2. gameplay unchanged
for (const n of [0x105, 0x106, 0x001, 0x009, 0x10f, 0x0c]) {
  if (play(ev, n) !== play(ep, n)) { console.log(n.toString(16), 'gameplay differs with patch'); bad++; }
}

// 3. extended tile $2A0 = copy of $130 (cement block): same look, same collision
const EXT = 0x2a0, REF = 0x130;
setExtTileWords(patched, EXT, map16Source(patched, ep.load(0x105)).fg(REF));
setActsLike(patched, EXT, REF);
const withWall = (tile: number): LevelOverride => {
  const lv: Level = loadLevel(patched, 0x105);
  lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 9, y: 14, size: 0x91, tile }); // 2×10 wall
  lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 4, y: 19, size: 0x02, tile }); // ledge
  return { layer1: serializeLayer1(patched, lv), sprites: serializeSprites(lv.sprites, lv.spriteHeader, isL1Vertical(patched, lv.header.mode)) };
};
{
  const a = ep.load(0x105, withWall(REF)), b = ep.load(0x105, withWall(EXT));
  let d = 0;
  for (const reg of [0x07, 0x08]) {
    const base = (a.ppuRegs[reg] & 0xfc) << 9;
    for (let i = base; i < base + 0x1000; i++) if (a.vram[i & 0xffff] !== b.vram[i & 0xffff]) d++;
  }
  if (d) { console.log('extended tile renders differently from', REF.toString(16), d); bad++; }
  const ta = play(ep, 0x105, withWall(REF)), tb = play(ep, 0x105, withWall(EXT));
  if (ta !== tb) { console.log('extended tile behaves differently from', REF.toString(16)); bad++; }
  const tc = play(ep, 0x105, withWall(0x025));
  if (tc === ta) { console.log('wall test is not sensitive (Mario never touches the wall)'); bad++; }
}
// 4. acts like on a vanilla tile: ground ($100) acting like air lets Mario fall
{
  const before = play(ep, 0x105, {}, 60, () => 0);
  const floor = new Rom(patched.data.slice());
  for (let t = 0x100; t < 0x110; t++) setActsLike(floor, t, 0x025);
  const ef = new LevelEmulator(floor); ef.boot();
  const after = play(ef, 0x105, {}, 60, () => 0);
  const y = (tr: string) => Number(tr.split(',').at(-2));
  if (!(y(after) > y(before) + 16)) { console.log('ground acting like air: Mario did not fall', y(before), y(after)); bad++; }
}
// 5. Lunar Magic's acts-like table pointers ($06F624 pages 00-3F, $06F63A 40-7F), which community code reads
// acts-like through: a tile's entry 2 bytes per tile from the page's first tile, the editor's acts-like
{
  const lm = (t: number) => patched.r16(patched.r24(LM_ACTS_PTRS[t >= 0x4000 ? 1 : 0]) + (t & 0x3fff) * 2);
  if (![0x025, 0x130, 0x1ff, EXT].every((t) => lm(t) === actsLike(patched, t)) || lm(EXT) !== REF) { console.log("Lunar Magic's acts-like pointers do not give the tiles' acts-like"); bad++; }
}
console.log('map16 ext bad', bad);
if (bad) process.exitCode = 1;
