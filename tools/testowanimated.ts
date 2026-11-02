// The overworld's 8x8 graphics in the Map16 tab (issue #238): the files behind them and its animated tiles.
// Files: on every submap the 8x8 tiles of its FG1–FG4 slots (submapSlots) are in VRAM where the slots say once the
// overworld loaded there – the file's pixels (the game sets bit 3 of FG3's and FG4's, their colors' upper half), but
// for the tiles the game animates – also with a file of its own put into a slot.
// Animated tiles (owanimated.ts): the game's water on every submap (tiles 75–7F of FG1, as emulated frame by frame),
// none where a submap's settings turn the game's tiles off; a tile slot of a submap's list counts there (also one
// whose frames don't change: from the list), not on another submap.
// Learned in the probe worker (owAnimated, App.owAnimated) as found directly; a submap list edited: asked again, the
// list's tiles then in it.
// node tools/testowanimated.ts
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads } from '../src/core/overworld.ts';
import { submapSlots, assignSubmapSlot, SUBMAPS } from '../src/core/submapgfx.ts';
import { readGfx } from '../src/core/gfxfiles.ts';
import { decodeTile } from '../src/core/gfx.ts';
import { owAnimated } from '../src/core/owanimated.ts';
import { writeSubmapList, setSubmapAnimSettings, emptyList, NO_GAME_TILES } from '../src/core/exanim.ts';
import { ProbeHost } from '../src/core/probehost.ts';
import { ProbeClient } from '../src/core/probeclient.ts';
import type { ProbeMessage, ProbeReply } from '../src/core/probeprotocol.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { loadLevel, L2_PTRS } from '../src/core/level.ts';
import type { Animated } from '../src/core/levelemu.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const list = (s: Iterable<number>) => [...s].sort((a, b) => a - b).map((x) => hx(x, 3)).join(' ');

const rom = new Rom(await editorImage());
const loads = () => new OverworldLoads(new OverworldEmulator(rom), 4);

// the tiles of the submap's FG slots in VRAM that are not the slot's file's (low three bits: FG3/FG4 get bit 3)
const px = new Uint8Array(64);
function offTiles(m: number): { slot: string; file: number; off: number[] }[] {
  const r = new OverworldEmulator(rom).load(m, 0), base = (r.ppuRegs[0x0b] & 0x0f) << 13;
  return submapSlots(rom, m).filter((s) => s.map16).map((s) => {
    const f = readGfx(rom, s.file), off: number[] = [];
    for (let k = 0; k < 0x80; k++) {
      decodeTile(r.vram, (base + (s.first + k) * 32) & 0xffff, 4, px);
      if (k >= f.tiles || px.some((v, i) => (v & 7) !== f.pix[k * 64 + i])) off.push(s.first + k);
    }
    return { slot: s.name, file: s.file, off };
  });
}

// ---- the files ----
const water = owAnimated(loads(), 1, 0).tiles;
for (let m = 0; m < SUBMAPS; m++) {
  const t = offTiles(m), anim = owAnimated(loads(), m, 0).tiles;
  check(t.length === 4 && t.every((x) => x.off.every((n) => anim.has(n))),
    `submap ${m}: FG1–FG4 in VRAM as their files (${t.map((x) => `${x.slot} ${hx(x.file)}${x.off.length ? ` but ${list(x.off)}` : ''}`).join(', ')})`);
}
{
  const fg2 = submapSlots(rom, 1).find((s) => s.name === 'FG2')!;
  assignSubmapSlot(rom, 1, 'FG4', fg2.file);
  const t = offTiles(1).find((x) => x.slot === 'FG4')!;
  check(t.file === fg2.file && !t.off.length, `a file of its own in FG4 of Yoshi's Island (${hx(fg2.file)}): in VRAM there`);
  assignSubmapSlot(rom, 1, 'FG4', 0xff);
}

// ---- animated tiles ----
check(list(water) === list(Array.from({ length: 11 }, (_, k) => 0x75 + k)), `the game's water: tiles ${list(water)}`);
check(Array.from({ length: SUBMAPS }, (_, m) => list(owAnimated(loads(), m, 0).tiles) === list(water)).every(Boolean), 'the same on every submap');
setSubmapAnimSettings(rom, 2, NO_GAME_TILES);
check(owAnimated(loads(), 2, 0).tiles.size === 0, 'none on a submap whose settings turn the game\'s tiles off');
setSubmapAnimSettings(rom, 2, 0);
{
  const r = new OverworldEmulator(rom).load(1, 0), charWord = (r.ppuRegs[0x0b] & 0x0f) << 12;
  const l = emptyList();
  l.slots.set(0, { type: 0x02, trigger: 0, framesLess1: 0, dest: charWord + 0x40 * 16, frames: [0x00] }); // tiles 040, 041: one frame
  writeSubmapList(rom, 1, l);
  const a = owAnimated(loads(), 1, 0).tiles, b = owAnimated(loads(), 3, 0).tiles;
  check(a.has(0x40) && a.has(0x41) && !a.has(0x42) && [...water].every((t) => a.has(t)), `a slot of Yoshi's Island's list (tiles 040, 041, one frame): animated there (${list(a)})`);
  check(!b.has(0x40) && !b.has(0x41), 'not on Forest of Illusion');
  writeSubmapList(rom, 1, null);
}

// ---- in the probe worker ----
{
  const host = new ProbeHost(), er = new Rom((await editorImage()).slice());
  let reply!: (d: ProbeReply) => void;
  const client = new ProbeClient({
    results: new ResultCache(new RomFingerprint(er)), cacheReady: Promise.resolve(),
    rom: () => er, tileset: () => 0,
    connect: (r) => { reply = r; return (m: ProbeMessage) => host.handle(m); },
    later: () => {}, setBusy: () => {}, ready: () => {}, kindsReady: () => {},
    kindLevel: () => { const lv = loadLevel(er, 0x105); return { level: { number: lv.number, header: lv.header }, layer2Pointer: er.r24(L2_PTRS + 0x105 * 3) }; },
  });
  const run = async () => { await new Promise((r) => setTimeout(r, 0)); while (host.pending) { const d = host.next(); if (d) reply(d); } };
  let got: Animated | undefined;
  const ask = () => client.learn<Animated>('owan1:1', { kind: 'owAnimated', map: 1, progress: 0 }, { lane: 'owan', input: { progress: 0 }, replace: true, done: (v) => (got = v) });
  check(ask() === undefined, 'Yoshi\'s Island\'s animated tiles: asked for');
  await run();
  check(!!got && list(got.tiles) === list(water) && list(ask()?.tiles ?? []) === list(water), `learned as found directly, then known at once (${list(got?.tiles ?? [])})`);
  const r = new OverworldEmulator(er).load(1, 0), l = emptyList();
  l.slots.set(0, { type: 0x01, trigger: 0, framesLess1: 0, dest: ((r.ppuRegs[0x0b] & 0x0f) << 12) + 0x40 * 16, frames: [0x00] });
  writeSubmapList(er, 1, l);
  got = undefined;
  check(ask() === undefined, 'its list edited: asked again');
  await run();
  check((got as Animated | undefined)?.tiles.has(0x40) === true, 'the list\'s tile then in it');
}

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
