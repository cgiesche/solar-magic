// Where FG and BG start (the camera start, Lunar Magic 3.00's, levelheight.ts), checked by emulation: test play loads
// the level with the header the editor made and shows layer 1 ($1C) and layer 2 ($20) at the first frame of
// the level where the settings put them – the game's FG/BG start Y as in the clean game, the camera relative
// to Mario, the BG bottom-aligned by its height, relative to the FG or at 0. Placing an entrance (dragging it,
// test play from here) leaves those settings alone (Lunar Magic 3.50).
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import {
  type SecondaryHeader, type SecondaryEntrance, type BgStart, readSecondaryHeader, encodeSecondaryHeader, readSecondaryEntrance, entrancePos, mainSpot,
  setCameraRows, bgStart, setBgStart, placeMain, placeSecondary, startHeader, nearestEntrance, hasRelativeCamera, levelMode, SEC_HDR, LEVEL_HEIGHTS,
  writeSecondaryEntrance, secondarySpot, loadLevel, cloneLevel,
} from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { GM, RAM, get16, cameraY } from '../src/core/ram.ts';
import { cleanImage, editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16);

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom);
const N = 0x105;
const sec0 = readSecondaryHeader(rom, N);

// layer 1 and layer 2 Y at the first frame of the level, as test play loads it (the secondary header as override)
function start(e: LevelEmulator, n: number, sec?: SecondaryHeader): { fg: number; bg: number; marioY: number } {
  e.load(n, sec ? { secondaryHeader: encodeSecondaryHeader(sec) } : {});
  const s = e.snes;
  for (let f = 0; f < 300 && s.wram[RAM.gameMode] !== GM.level; f++) s.runFrame();
  return { fg: cameraY(s.wram), bg: get16(s.wram, RAM.layer2Y), marioY: get16(s.wram, RAM.marioY) };
}

// the game's FG/BG start Y: as in the clean game with the same bytes (its own four tables)
{
  const wrong: string[] = [], seen = new Set<string>();
  for (let fg = 0; fg < 4; fg++) for (let bg = 0; bg < 4; bg++) {
    const sec = { ...sec0, fgInitY: fg, bgInitY: bg, cameraRelative: 0 };
    const clean = new Rom(cleanImage());
    encodeSecondaryHeader(sec).slice(0, 4).forEach((b, i) => clean.w8(SEC_HDR[i] + N, b));
    const a = start(emu, N, sec), b = start(new LevelEmulator(clean), N);
    seen.add(`${a.fg},${a.bg}`);
    if (a.fg !== b.fg || a.bg !== b.bg) wrong.push(`${fg}/${bg}: ${hx(a.fg)}/${hx(a.bg)}, the game's ${hx(b.fg)}/${hx(b.bg)}`);
  }
  check(!wrong.length && seen.size > 4, `FG/BG start Y 0-3: FG and BG as in the clean game (${seen.size} different starts)${wrong.length ? ` – not ${wrong.join('; ')}` : ''}`);
}

// the camera relative to Mario: rows above him, inside the level (the game's height: $C0 at most)
const relative = (rows: number, bg: BgStart, s: SecondaryHeader = sec0): SecondaryHeader => {
  const sec = { ...s };
  setCameraRows(sec, rows);
  setBgStart(sec, bg);
  return sec;
};
const lowest = LEVEL_HEIGHTS[0] - 0xf0;
const BG27: BgStart = { kind: 'bottom', rows: 27 };
// Mario higher up in the level (the entrance setting nearest Y $B0), so most starts are not at its bottom
const high = startHeader(rom, sec0, 0x40, 0xb0, sec0.entranceScreen);
{
  const wrong: string[] = [], seen = new Set<number>();
  for (const rows of [0, 3, 6, 10, -2]) {
    const r = start(emu, N, relative(rows, BG27, high));
    const want = Math.max(0, Math.min(lowest, r.marioY - rows * 16));
    seen.add(r.fg);
    if (r.fg !== want) wrong.push(`${rows}: ${hx(r.fg)}, not ${hx(want)}`);
  }
  check(!wrong.length && seen.size >= 4, `camera 0, 3, 6, 10, -2 rows above Mario: FG at Mario's Y less the rows, inside the level (${[...seen].map(hx).join(', ')})${wrong.length ? ` – ${wrong.join('; ')}` : ''}`);
}

// the BG relative to the FG (+/- rows) or at 0
{
  const wrong: string[] = [];
  for (const rows of [0, 4, -3, 15, -15]) {
    const r = start(emu, N, relative(3, { kind: 'fg', rows }, high));
    if (r.bg !== ((r.fg + rows * 16) & 0xffff)) wrong.push(`${rows}: FG ${hx(r.fg)}, BG ${hx(r.bg)}`);
  }
  check(!wrong.length, `BG 0, 4, -3, 15, -15 rows below the FG (FG ${hx(start(emu, N, relative(3, BG27, high)).fg)})${wrong.length ? ` – ${wrong.join('; ')}` : ''}`);
  const z = start(emu, N, relative(3, { kind: 'zero' }, high));
  check(z.bg === 0 && z.fg !== 0, `BG at absolute 0 (FG ${hx(z.fg)}, BG ${hx(z.bg)})`);
}

// the BG bottom-aligned: with the camera at the level's bottom it shows its bottom (its height less $F0)
{
  const wrong: string[] = [];
  for (const rows of [27, 32, 20, 14]) {
    const r = start(emu, N, relative(0, { kind: 'bottom', rows }));
    if (r.fg !== lowest || r.bg !== ((rows * 16 - 0xf0) & 0xffff)) wrong.push(`${rows}: FG ${hx(r.fg)}, BG ${hx(r.bg)}`);
  }
  check(!wrong.length, `BG of 27, 32, 20, 14 rows: its bottom at the level's bottom${wrong.length ? ` – ${wrong.join('; ')}` : ''}`);
}

// the BG start's settings round trip (Lunar Magic's bits: O and the 5-bit value)
{
  const all: BgStart[] = [
    ...Array.from({ length: 32 }, (_, i): BgStart => ({ kind: 'bottom', rows: i + 1 })),
    ...Array.from({ length: 31 }, (_, i): BgStart => ({ kind: 'fg', rows: i - 15 })),
    { kind: 'zero' },
  ];
  const s = { bgRelative: 0, bgHeight: 0 }, bits = new Set<number>();
  const ok = all.every((b) => { setBgStart(s, b); bits.add(s.bgRelative << 5 | s.bgHeight); return JSON.stringify(bgStart(s)) === JSON.stringify(b); });
  check(ok && bits.size === 64, `BG start: ${all.length} settings, each its own bits`);
}

// placing an entrance leaves the FG/BG settings alone: dragged, created, test play from here
{
  const camera = (s: { fgInitY: number; bgInitY: number; cameraRelative: number; cameraOffsetHi: number }) => [s.fgInitY, s.bgInitY, s.cameraRelative, s.cameraOffsetHi].join();
  const bgOf = (s: SecondaryHeader) => [s.bgRelative, s.bgHeight].join();
  const game = { ...sec0, fgInitY: 2, bgInitY: 1, cameraRelative: 0 }, rel = relative(4, { kind: 'fg', rows: 2 });
  const to = nearestEntrance(rom, 0x340, 0x100, false, 9);
  const moved = (s: SecondaryHeader) => { const x = { ...s }; placeMain(x, to); return x; };
  check(camera(moved(game)) === camera(game) && camera(moved(rel)) === camera(rel) && bgOf(moved(rel)) === bgOf(rel),
    'main entrance moved: FG/BG start Y, the relative camera and the BG start as set');
  const e: SecondaryEntrance = { ...readSecondaryEntrance(rom, 0), fgInitY: 3, bgInitY: 2, cameraRelative: 0, cameraOffsetHi: 0 };
  const e2 = { ...e }; placeSecondary(e2, to);
  check(camera(e2) === camera(e), 'secondary entrance moved: FG/BG start Y as set');

  // test play from here: the header keeps them, and the level starts with them
  const here = startHeader(rom, game, 0x340, 0x100, 9);
  const clean = new Rom(cleanImage());
  encodeSecondaryHeader(here).slice(0, 4).forEach((b, i) => clean.w8(SEC_HDR[i] + N, b));
  const a = start(emu, N, here), b = start(new LevelEmulator(clean), N);
  check(camera(here) === camera(game) && here.entranceScreen === 3 && a.fg === b.fg && a.bg === b.bg,
    `test play from here: FG/BG start Y as set (FG ${hx(a.fg)}, BG ${hx(a.bg)}, the clean game's ${hx(b.fg)}/${hx(b.bg)})`);
  const hereRel = startHeader(rom, rel, 0x340, 0x100, 9), c = start(emu, N, hereRel);
  check(camera(hereRel) === camera(rel) && bgOf(hereRel) === bgOf(rel) && c.fg === Math.max(0, Math.min(lowest, c.marioY - 4 * 16)) && c.bg === c.fg + 2 * 16,
    `test play from here: the camera 4 rows above Mario (FG ${hx(c.fg)}), the BG 2 rows below the FG (${hx(c.bg)})`);

  // a tile entrance in a taller level: the game's camera becomes the relative one (its start Y can't reach)
  const sized = { ...game, levelSize: 0x13 };
  const tile = startHeader(rom, sized, 0x340, 0x400, 9, 62);
  check(tile.entranceTile === 1 && tile.cameraRelative === 1, 'a tile entrance in a taller level: the camera relative to Mario');
}

// test play from a secondary entrance starts FG and BG as entering the level through it does (level 105's
// exit pipe on screen 7 leads to it): with its own camera start, not the main entrance's
{
  const idx = 0x1f0;
  const enter = (e: SecondaryEntrance) => {
    const r = new Rom(rom.data.slice());
    writeSecondaryEntrance(r, idx, e);
    const lv = cloneLevel(loadLevel(r, N));
    lv.exits = lv.exits.map((x) => ({ ...x, dest: idx, secondary: true }));
    // Mario starts on the pipe (tile 8, 20 of screen 7)
    lv.secondary = { ...lv.secondary, entranceScreen: 7, entranceTile: 1, entranceX: 0, entranceXHi: 1, entranceY: 0x14 & 15, entranceYHi: 0x14 >> 4 };
    saveLevel(r, lv);
    const em = new LevelEmulator(r);
    em.load(N);
    const s = em.snes, w = s.wram;
    for (let f = 0; f < 300 && w[RAM.gameMode] !== GM.level; f++) s.runFrame();
    w[RAM.marioX] = 0x88; // on the pipe's middle
    let left = false;
    for (let f = 0; f < 2000; f++) {
      s.joy1 = 0x0400; s.runFrame();
      if (w[RAM.gameMode] !== GM.level) left = true;
      if (left && w[RAM.gameMode] === GM.level) break;
    }
    return { left, ...settled(s) };
  };
  // the two ways into the level reach its first frame after different fades: compared once Mario has stood
  // still for a second (the camera follows him the same way from the same start)
  const settled = (s: LevelEmulator['snes']) => {
    s.joy1 = 0;
    for (let f = 0; f < 60; f++) s.runFrame();
    const w = s.wram;
    return { fg: cameraY(w), bg: get16(w, RAM.layer2Y) };
  };
  const wrong: string[] = [];
  const base: SecondaryEntrance = { ...readSecondaryEntrance(rom, idx), destLevel: N, screen: 2, entranceX: 3, entranceY: 6, entranceTile: 0, action: 0, raw3: 0 };
  const cases: [string, SecondaryEntrance][] = [
    ...[[0, 0], [1, 3], [2, 1], [3, 2]].map(([fg, bg]): [string, SecondaryEntrance] => [`FG/BG start Y ${fg}/${bg}`, { ...base, fgInitY: fg, bgInitY: bg, cameraRelative: 0, cameraOffsetHi: 0 }]),
    ...[2, 7].map((rows): [string, SecondaryEntrance] => { const e = { ...base }; setCameraRows(e, rows); return [`${rows} rows above Mario`, e]; }),
  ];
  let entered = 0;
  const bgs = new Set<number>(); // the main entrance's camera start would give one BG for all
  for (const [name, e] of cases) {
    const g = enter(e);
    const p = entrancePos(rom, secondarySpot(e), false);
    start(emu, N, startHeader(rom, { ...sec0, cameraRelative: 1, cameraOffsetHi: 1 }, p.x, p.y, 9, 0, e));
    const t = settled(emu.snes);
    if (g.left) entered++;
    bgs.add(t.bg);
    if (!g.left || g.fg !== t.fg || g.bg !== t.bg) wrong.push(`${name}: test play ${hx(t.fg)}/${hx(t.bg)}, entered ${hx(g.fg)}/${hx(g.bg)}`);
  }
  check(!wrong.length && entered === cases.length && bgs.size >= 4, `test play from a secondary entrance: FG and BG as when entering through it, BG ${[...bgs].map(hx).join('/')} (${cases.map(([n]) => n).join(', ')})${wrong.length ? ` – ${wrong.join('; ')}` : ''}`);
}

// the relative camera only in horizontal levels: in a vertical one the bits are the game's FG/BG start Y
{
  const V = 0x0e7; // a vertical level (mode 8)
  const vertical = !hasRelativeCamera(rom, levelMode(rom, V)) && hasRelativeCamera(rom, levelMode(rom, N));
  const sv = readSecondaryHeader(rom, V);
  const a = start(emu, V, { ...sv, cameraRelative: 0 }), b = start(emu, V, { ...sv, cameraRelative: 1 });
  check(vertical && a.fg === b.fg && a.bg === b.bg, `vertical level ${hx(V)}: no relative camera (FG ${hx(a.fg)}/${hx(b.fg)}, BG ${hx(a.bg)}/${hx(b.bg)})`);
}

// the entrance's own Y from the level, unchanged by all this
check(entrancePos(rom, mainSpot(sec0), false).y > 0, 'level 105\'s entrance');

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
