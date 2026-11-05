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
// So a star runs no event (#390): eventRunners names none of the stars' base events – the six's (64 56 53 59 50 5C)
// nor those of the four stars events reveal with a base event (36 44 6D 5F; the cells are 5A before) –, the save with
// every event passed (progressSaves) leaves the stars' flags without "passed" and counts none of those 10 events as
// triggered (110 before the fix).
// The editor (#288, owstars.ts): a star painted (OverworldStroke) on a stop tile without translevel takes a free one
// without name, base event or messages, its initial flags the ways its paths open – Mario (emulated, a new game) walks
// off it in each of them and in no other; painted over with a stop it keeps it, with a path it frees it; no translevel
// left, the stroke is refused with nothing written. The budget of levels on the overworld counts it. A star without
// translevel is found (the World check's warning) and given one.
// node tools/teststartiles.ts
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import {
  OverworldEmulator, OverworldLoads, gameL1, readTranslevels, writeTranslevels, readL1, l1XY, l1Index, setInitialFlags, initialFlags,
  OW_EVENTS, MAX_TRANSLEVEL, DIR_NAMES, DIR_FLAGS, FLAG, revealedTile, baseEvent, NO_EVENT,
} from '../src/core/overworld.ts';
import { levelNameTiles, setLevelNameTiles, encodeName, levelName, NAME_VRAM, NAME_LEN, NAME_SPACE } from '../src/core/levelnames.ts';
import { reachInput, walkFrom, neighbor } from '../src/core/owreach.ts';
import { eventRunners, readEvents, writeEvents } from '../src/core/owevents.ts';
import { OverworldStroke } from '../src/core/owstroke.ts';
import { starDirs, giveStarTranslevel, starsWithoutTranslevel, STAR_TILE } from '../src/core/owstars.ts';
import { dirFlags } from '../src/core/owroute.ts';
import { starsWithoutTranslevelProblems, type CheckContext } from '../src/core/owchecks.ts';
import { owBudgets } from '../src/core/owbudget.ts';
import { OwRefusal } from '../src/core/owrefusal.ts';
import { hasNameEventOrMessages, setBaseEvent, readL2 } from '../src/core/overworld.ts';
import { levelsWithoutTile, stopTile } from '../src/core/owleveltiles.ts';
import { progressSaves } from '../src/core/owprogress.ts';
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

// ---- a star runs no event (#390) ----
{
  // (the stars before events, and the cells the reveal list turns into stars: 5A → 5F)
  const cells = [...l1.keys()].filter((i) => tls[i] && (STARS.includes(i) || (revealedTile(rom, l1[i]) & 0xff) === 0x5f));
  const starTls = new Set(cells.map((i) => tls[i])), starEvents = new Set([...starTls].map((tl) => baseEvent(rom, tl)).filter((e) => e !== NO_EVENT));
  check(starTls.size === 13 && [...starEvents].map((e) => hx(e)).sort().join() === '36,44,50,53,56,59,5C,5F,64,6D',
    `the stars at any progress: translevels ${[...starTls].map((tl) => hx(tl)).join(' ')}, base events ${[...starEvents].map((e) => hx(e)).join(' ')}`);
  const runners = eventRunners(rom);
  const byStar = [...runners].filter(([, rs]) => rs.some((r) => starTls.has(r.tl) || cells.includes(r.tile)));
  check(!byStar.length, `eventRunners names no star as running an event: ${byStar.map(([e, rs]) => `${hx(e)} by ${rs.map((r) => hx(r.tl)).join('/')}`).join(', ') || 'none'}`);
  const last = progressSaves(new OverworldLoads(new OverworldEmulator(rom), 4)).at(-1)!;
  check([...starTls].every((tl) => !(last.levelFlags[tl] & FLAG.passed)) && last.eventsTriggered === 110 - starEvents.size,
    `every event passed: no star passed (${[...starTls].map((tl) => `${hx(tl)}=${hx(last.levelFlags[tl])}`).join(' ')}), ${last.eventsTriggered} events triggered (110 less the stars' ${starEvents.size})`);
}

// ---- the editor: a star painted takes a translevel of its own (#288) ----
{
  const paths = { kinds, shapes }, isLevel = (t: number) => kinds[t] === 'level';
  // (a stop tile of the map before events without translevel with a path off it – in the clean game a pipe 82; a stop
  // tile painted over it: stopTile, 81)
  const cell = [...l1.keys()].find((i) => kinds[l1[i]] === 'stop' && !tls[i] && (l1[i] & 0xff) !== STAR_TILE && starDirs(l1, i, paths).length)!, stop = stopTile(kinds);
  const paint = (r: Rom, i: number, t: number) => {
    const maps = { l1: readL1(r), l2: readL2(r) }, s = new OverworldStroke(r, 'l1', maps, isLevel, null, paths), { x, y } = l1XY(i);
    s.paint(i >> 10, x, y, t);
    s.end().write!();
  };
  const levels = (r: Rom) => owBudgets(r, 0, kinds).find((b) => b.key === 'translevels')!.used;
  const r = new Rom(rom.data.slice());
  paint(r, cell, STAR_TILE);
  const tl = readTranslevels(r)[cell], dirs = starDirs(readL1(r), cell, paths);
  check(!!tl && !tls.includes(tl) && !hasNameEventOrMessages(r, tl) && initialFlags(r, tl) === dirFlags(dirs) && levels(r) === levels(rom) + 1,
    `a star painted at ${at(cell)}: translevel ${hx(tl)} of its own, no name or event, its flags ${hx(initialFlags(r, tl))} the ways its paths open (${dirs.map((d) => DIR_NAMES[d]).join(' ')}); levels on the overworld ${levels(rom)} → ${levels(r)}`);
  const walks = PADS.map((pad) => press(onTile(r, cell), pad) !== cell);
  check(walks.some(Boolean) && walks.every((w, d) => w === dirs.includes(d)), `Mario (a new game) walks off it ${walks.map((w, d) => (w ? DIR_NAMES[d] : '')).filter(Boolean).join(' ')}, in no other way`);
  paint(r, cell, stop);
  check(readTranslevels(r)[cell] === tl, `a stop (${hx(stop)}) painted over it keeps translevel ${hx(readTranslevels(r)[cell])}`);
  paint(r, cell, STAR_TILE);
  const path = readL1(r)[[0, 1, 2, 3].map((d) => neighbor(cell, d)).find((n) => n >= 0 && ['walk', 'climb', 'swim'].includes(kinds[readL1(r)[n]]))!];
  paint(r, cell, path);
  check(readTranslevels(r)[cell] === 0 && levels(r) === levels(rom), `a path (tile ${hx(path)}) painted over it frees it (${hx(readTranslevels(r)[cell])}), levels on the overworld ${levels(r)}`);
  // a path painted over a star of the clean game: its translevel freed and reset (no name: free for a new star or stop)
  const r2 = new Rom(rom.data.slice()), s0 = STARS[0], t0 = tls[s0];
  paint(r2, s0, path);
  check(readTranslevels(r2)[s0] === 0 && !hasNameEventOrMessages(r2, t0) && levelsWithoutTile(readTranslevels(r2)).includes(t0),
    `a path painted over the star at ${at(s0)}: translevel ${hx(t0)} freed, its name "${levelName(rom, t0).trim()}" and event reset`);
  // a star painted where an event puts a level tile: refused (the cell keeps one translevel all game long)
  // (event 00 given a layer 1 change putting a level tile, with a translevel, on the pipe cell)
  const r4 = new Rom(rom.data.slice()), d4 = readEvents(r4), lt = l1.find((t) => isLevel(t))!, t4 = readTranslevels(r4);
  d4.silent[0] = [...d4.silent[0], { layer: 1, tile: lt, loc: cell }];
  writeEvents(r4, d4);
  t4[cell] = tls[l1.findIndex((t) => isLevel(t))]; writeTranslevels(r4, t4);
  let onLevel = '';
  try { paint(r4, cell, STAR_TILE); } catch (e) { onLevel = e instanceof OwRefusal ? e.refusal.kind : String(e); }
  check(onLevel === 'starOnLevel', `a star painted before events at ${at(cell)}, where an event puts a level tile: refused (${onLevel})`);
  // a star on a cell sharing a level tile's translevel: one of its own
  const lvTile = [...l1.keys()].find((k) => isLevel(l1[k]) && tls[k])!, r3 = new Rom(rom.data.slice()), t3 = readTranslevels(r3);
  t3[cell] = tls[lvTile]; writeTranslevels(r3, t3);
  paint(r3, cell, STAR_TILE);
  check(readTranslevels(r3)[cell] !== tls[lvTile] && !!readTranslevels(r3)[cell] && readTranslevels(r3)[lvTile] === tls[lvTile],
    `a star painted on a cell holding level tile ${at(lvTile)}'s translevel ${hx(tls[lvTile])}: one of its own (${hx(readTranslevels(r3)[cell])})`);
  // no translevel left: refused, nothing written
  const full = new Rom(rom.data.slice());
  for (const t of levelsWithoutTile(readTranslevels(full))) if (!hasNameEventOrMessages(full, t)) setBaseEvent(full, t, 0);
  const was = full.data.slice();
  let why = '';
  try { paint(full, cell, STAR_TILE); } catch (e) { why = e instanceof OwRefusal ? e.refusal.kind : String(e); }
  check(why === 'starNoTranslevel' && full.data.every((v, k) => v === was[k]), `every free translevel with a base event: the star refused (${why}), nothing written`);
}

// ---- a star without translevel: the World check's warning, one given ----
{
  const paths = { kinds, shapes };
  check(!starsWithoutTranslevel(rom).length, 'the clean game: every star (before events or revealed) has a translevel');
  const r = withTl(STARS[0], 0), place = (i: number) => at(i);
  const ps = starsWithoutTranslevelProblems({ rom: r, place } as CheckContext);
  check(ps.length === 1 && ps[0].tile === STARS[0] && ps[0].severity === 'warn' && ps[0].progress === 0, `its translevel zeroed: "${ps[0]?.text}"`);
  const tl = giveStarTranslevel(r, STARS[0], readL1(r), paths);
  check(!!tl && readTranslevels(r)[STARS[0]] === tl && initialFlags(r, tl) === dirFlags(starDirs(readL1(r), STARS[0], paths)) && !starsWithoutTranslevel(r).length,
    `given one: ${hx(tl)}, its flags ${hx(initialFlags(r, tl))}`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('star tiles ok');
