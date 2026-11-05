// What the game uses the translevels of the star tiles (5F) for (issue #288, docs/research/star-tile-translevels.md),
// learned by emulation on the clean game's map (the editor's image: Lunar Magic's translevel table as the game's scan
// fills it). The six 5F tiles of the map before events hold translevels 4D 52 53 57 5B 5C:
// - their level flags ($1EA2 + translevel) are the directions Mario walks off the star in: a new file gives them the
//   clean game's list at $009EE0 (6 of its 8 entries); the flags zeroed, or the tile given another translevel, Mario
//   stays; another translevel's flags opened, he walks;
// - arriving on a star by walking opens the way back in its translevel's flags (as on a level tile), and so does the
//   reveal walk of a Star World level passed whose path leads to the star; nothing sets its "passed" flag;
// - the status bar shows the name of the star's translevel ("STAR ROAD"), on the overworld's load and when Mario stops
//   there; the name changed it shows the new one, the translevel zeroed the blank name of translevel 0;
// - A on a star warps by Mario's position only (the star/pipe table): with the translevel zeroed he goes to the same
//   place, the game reads neither the tile's translevel nor $13BF for it.
// node tools/teststartiles.ts
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import {
  OverworldEmulator, OverworldLoads, gameL1, readTranslevels, writeTranslevels, readL1, l1XY, l1Index, setInitialFlags, initialFlags,
  OW_EVENTS, MAX_TRANSLEVEL, DIR_NAMES, DIR_FLAGS, FLAG,
} from '../src/core/overworld.ts';
import { levelNameTiles, setLevelNameTiles, encodeName, levelName, NAME_VRAM, NAME_LEN, NAME_SPACE } from '../src/core/levelnames.ts';
import { reachInput, walkFrom } from '../src/core/owreach.ts';
import { readStart } from '../src/core/owsprites.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { GM, RAM, PAD, get16 } from '../src/core/ram.ts';
import { cleanImage, editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const at = (i: number) => { const { x, y } = l1XY(i); return `${i >> 10 ? 'submaps' : 'main'} ${hx(x)},${hx(y)}`; };

const rom = new Rom(await editorImage());
const l1 = readL1(rom), tls = readTranslevels(rom);
const STARS = [...l1.keys()].filter((i) => (l1[i] & 0xff) === 0x5f);
check(STARS.map((i) => hx(tls[i])).join() === '4D,52,53,57,5B,5C', `the map's 5F tiles and their translevels: ${STARS.map((i) => `${at(i)} ${hx(tls[i])}`).join(', ')}`);

const standing = (() => { const e = new LevelEmulator(rom); e.startGame(0); return e.snes.wram[RAM.owProcess]; })();
const tileOf = (w: Uint8Array) => l1Index(w[RAM.submap] ? 1 : 0, get16(w, RAM.owPlayerTileX), get16(w, RAM.owPlayerTileY));
const border = (e: LevelEmulator) => Array.from({ length: NAME_LEN }, (_, k) => e.snes.vram[NAME_VRAM * 2 + k * 2]).join();
const named = (r: Rom, tl: number) => levelNameTiles(r, tl).join();
const withTl = (i: number, tl: number) => { const r = new Rom(rom.data.slice()), t = readTranslevels(r); t[i] = tl; writeTranslevels(r, t); return r; };

// WRAM reads and writes of `addrs` while fn runs, as "R/W addr @pc" (the game's code: the instruction's address)
function watching(e: LevelEmulator, addrs: number[], fn: () => void): Set<string> {
  const s = e.snes, ws = new Set(addrs), out = new Set<string>();
  s.hook = {
    onWramRead(a) { if (ws.has(a)) out.add(`R ${hx(a, 4)} @${hx(s.cpu.opPc & 0x7fffff, 6)}`); },
    onWramWrite(a) { if (ws.has(a)) out.add(`W ${hx(a, 4)} @${hx(s.cpu.opPc & 0x7fffff, 6)}`); },
  };
  try { fn(); } finally { s.hook = null; }
  return out;
}
// the pad pressed for a few frames, until Mario stands again (or didn't go): the tile he stands on
function press(e: LevelEmulator, pad: number): number {
  const s = e.snes, w = s.wram;
  let moved = false;
  for (let f = 0; f < 1500; f++) {
    s.joy1 = f < 4 ? pad : 0;
    s.runFrame();
    if (w[RAM.owProcess] !== standing || w[RAM.gameMode] !== GM.overworld) moved = true;
    else if ((moved && f > 30) || (!moved && f > 40)) break;
  }
  s.joy1 = 0;
  return tileOf(w);
}
const onTile = (r: Rom, i: number) => { const e = new LevelEmulator(r); e.startGameAt(i); return e; };
const PADS = [PAD.up, PAD.down, PAD.left, PAD.right];

// ---- a new file: the stars' flags ----
{
  const clean = cleanImage(), hdr = clean.length % 0x8000;
  const rd = (a: number) => clean[hdr + ((a >> 16) & 0x7f) * 0x8000 + (a & 0x7fff)];
  const list = Array.from({ length: 8 }, (_, k) => [rd(0x009ee0 + k * 2), rd(0x009ee1 + k * 2)]); // (translevel, flags)
  const starTls = STARS.map((i) => tls[i]);
  check(starTls.every((tl) => list.some(([t]) => t === tl)), `the clean game's new-file list ($009EE0) holds every star's translevel: ${list.map(([t, f]) => `${hx(t)}=${hx(f)}`).join(' ')}`);
  const e = new LevelEmulator(rom); e.startGame(0);
  const w = e.snes.wram;
  check(starTls.every((tl) => w[RAM.levelFlags + tl] === list.find(([t]) => t === tl)![1] && initialFlags(rom, tl) === w[RAM.levelFlags + tl]),
    `a new game: the stars' flags are the list's (${starTls.map((tl) => `${hx(tl)}=${hx(w[RAM.levelFlags + tl])}`).join(' ')}), Lunar Magic's initial flags the same`);
}

// ---- walking off a star: its translevel's flags ----
const loads = new OverworldLoads(new OverworldEmulator(rom), 2);
const kinds = pathKinds(rom), shapes = pathShapes(rom);
const allL1 = gameL1(loads.get(0, OW_EVENTS)).slice();
const open = reachInput(rom, allL1, tls, new Uint8Array(MAX_TRANSLEVEL + 1).fill(0x0f), kinds, shapes, readStart(rom, 0));
const UNUSED = Array.from({ length: MAX_TRANSLEVEL }, (_, k) => k + 1).find((t) => !tls.includes(t) && !initialFlags(rom, t))!;
{
  const res: string[] = [];
  let ok = true;
  for (const i of STARS) {
    const tl = tls[i], d = [0, 1, 2, 3].find((k) => initialFlags(rom, tl) & DIR_FLAGS[k] && walkFrom(open, i, k)?.to !== undefined && walkFrom(open, i, k)!.to >= 0);
    if (d === undefined) { res.push(`${hx(tl)}: no way`); ok = false; continue; }
    const to = walkFrom(open, i, d)!.to;
    // the game's own flags
    const e = onTile(rom, i);
    let walked = -1;
    const reads = watching(e, [RAM.levelFlags + tl], () => { walked = press(e, PADS[d]); });
    // its flags zeroed
    const z = onTile(rom, i); z.snes.wram[RAM.levelFlags + tl] = 0;
    const stayed = press(z, PADS[d]);
    // the tile given an unused translevel: without flags, and with that direction open
    const u = onTile(withTl(i, UNUSED), i), uStay = press(u, PADS[d]);
    const ro = withTl(i, UNUSED); setInitialFlags(ro, UNUSED, DIR_FLAGS[d]);
    const o = onTile(ro, i), oWalk = press(o, PADS[d]);
    const good = walked === to && stayed === i && uStay === i && oWalk === to && reads.size > 0;
    ok &&= good;
    res.push(`${hx(tl)} ${DIR_NAMES[d]} → ${at(walked)}${good ? '' : ` (zeroed ${at(stayed)}, ${hx(UNUSED)} ${at(uStay)}/${at(oWalk)})`} [${[...reads].join(' ')}]`);
  }
  check(ok, `Mario walks off each star as its translevel's flags let him (zeroed or another translevel without them: he stays; ${hx(UNUSED)} with the direction opened: he walks): ${res.join('; ')}`);
}

// ---- arriving: the way back opened in the star's flags ----
{
  const res: string[] = [];
  let ok = true;
  for (const i of STARS) {
    const tl = tls[i];
    let way: [number, number, number] | null = null; // from, direction, the direction he arrives in
    for (let from = 0; from < 0x800 && !way; from++) for (let d = 0; d < 4 && !way; d++) {
      if (from === i || !['level', 'stop'].includes(kinds[open.l1[from]]) || (l1[from] & 0xff) === 0x5f) continue;
      const w = walkFrom(open, from, d);
      if (w && w.to === i) way = [from, d, w.dir];
    }
    if (!way) { res.push(`${hx(tl)}: no way onto it`); ok = false; continue; }
    const [from, d, arrives] = way, e = onTile(rom, from), w = e.snes.wram;
    w.set(Uint8Array.from(allL1), RAM.owLayer1);
    w.fill(0x0f, RAM.levelFlags, RAM.levelFlags + MAX_TRANSLEVEL + 1);
    w[RAM.levelFlags + tl] = 0;
    let got = -1;
    const writes = watching(e, [RAM.levelFlags + tl], () => { got = press(e, PADS[d]); });
    const back = DIR_FLAGS[arrives ^ 1];
    const good = got === i && w[RAM.levelFlags + tl] === back && border(e) === named(rom, tl);
    ok &&= good;
    res.push(`${hx(tl)} from ${at(from)} ${DIR_NAMES[d]}: flags ${hx(w[RAM.levelFlags + tl])}${good ? '' : ` (on ${at(got)}, name ${border(e) === named(rom, tl)})`} [${[...writes].join(' ')}]`);
  }
  check(ok, `walking onto a star opens the way back in its translevel's flags, the status bar shows its name: ${res.join('; ')}`);
}

// ---- the reveal walk: a Star World level passed opens the way back on the star its path leads to ----
{
  // (Star World level, exit) → the star its path leads to: the stars' translevels changed by passing it, and nothing else but its own
  const want: [number, number, number][] = [[0x58, 1, 0x53], [0x54, 1, 0x52], [0x56, 1, 0x57], [0x59, 1, 0x5c], [0x5a, 0, 0x5b]];
  const res: string[] = [];
  let ok = true;
  for (const [lv, exit, star] of want) {
    const p = PlaySession.overworld(new LevelEmulator(rom), tls.indexOf(lv));
    if (!p.enter()) { ok = false; res.push(`${hx(lv)} not entered`); continue; }
    const w = p.wram, before = w.slice(RAM.levelFlags, RAM.levelFlags + MAX_TRANSLEVEL + 1);
    w[RAM.levelExit] = exit + 1; w[RAM.midwayTouched] = 1; w[RAM.levelBeaten] = 1; w[RAM.gameMode] = GM.overworldReturn;
    p.follow();
    for (let k = 0; k < 900; k++) p.frame();
    const changed = [...before.keys()].filter((t) => t !== lv && w[RAM.levelFlags + t] !== before[t]);
    const good = changed.join() === `${star}` && (w[RAM.levelFlags + star] & ~before[star] & 0x0f) !== 0 && !(w[RAM.levelFlags + star] & FLAG.passed);
    ok &&= good;
    res.push(`${hx(lv)} exit ${exit}: ${changed.map((t) => `${hx(t)} ${hx(before[t])}→${hx(w[RAM.levelFlags + t])}`).join(' ')}`);
  }
  check(ok, `passing a Star World level, the reveal walk opens the way back in the flags of the star its path leads to (never "passed"): ${res.join('; ')}`);
}

// ---- the name in the status bar ----
{
  const i = STARS[0], tl = tls[i];
  check(STARS.every((s) => border(onTile(rom, s)) === named(rom, tls[s])), `on each star the status bar shows its translevel's name ("${levelName(rom, tl)}")`);
  const r = new Rom(rom.data.slice());
  setLevelNameTiles(r, tl, encodeName('STAR TEST').tiles);
  check(border(onTile(r, i)) === named(r, tl) && border(onTile(r, STARS[1])) === named(rom, tls[STARS[1]]),
    `translevel ${hx(tl)} named "STAR TEST": shown on its star (${at(i)}), not on the others`);
  const z = onTile(withTl(i, 0), i);
  check(border(z) === Array(NAME_LEN).fill(NAME_SPACE).join() && named(rom, 0) === border(z), `the star's translevel zeroed: the blank name of translevel 0`);
}

// ---- A: the warp doesn't depend on the translevel ----
{
  const res: string[] = [];
  let ok = true;
  for (const i of STARS) {
    const tl = tls[i], e = onTile(rom, i);
    let to = -1, inOw = new Set<string>();
    const all = watching(e, [RAM.owTranslevels + i, RAM.translevel], () => {
      // reads while the overworld runs (not its load after the warp, which reads every tile's translevel)
      const s = e.snes, w = s.wram, ws = new Set([RAM.owTranslevels + i, RAM.translevel]), hook = s.hook!;
      s.hook = { ...hook, onWramRead(a) { if (ws.has(a) && w[RAM.gameMode] === GM.overworld) inOw.add(`R ${hx(a, 4)} @${hx(s.cpu.opPc & 0x7fffff, 6)}`); hook.onWramRead!(a); } };
      to = press(e, PAD.a);
    });
    const zt = press(onTile(withTl(i, 0), i), PAD.a), ot = press(onTile(withTl(i, UNUSED), i), PAD.a);
    const good = to !== i && zt === to && ot === to && !inOw.size && ![...all].some((k) => k.startsWith(`W ${hx(RAM.translevel, 4)}`));
    ok &&= good;
    res.push(`${hx(tl)} → ${at(to)}${good ? '' : ` (zeroed ${at(zt)}, ${hx(UNUSED)} ${at(ot)}; read ${[...inOw].join(' ')})`}`);
  }
  check(ok, `A on a star: the same place with its translevel zeroed or another, the tile's translevel and $13BF not read for it: ${res.join('; ')}`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('star tiles ok');
