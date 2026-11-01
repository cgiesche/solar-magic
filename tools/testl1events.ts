// The rest of what an event changes (issue #77): its layer 1 changes (silent layer 1 steps, owevents.ts
// paintEventL1), the reveal list and the destroyed level tiles (overworld.ts, the editor's patch in Lunar Magic's
// places). Checked by emulation: the patched ROM shows every event progress's layer 1 as the clean game; a layer 1
// change painted for an event, a reveal list entry changed and a level tile set to be destroyed show in the game
// when the event passes (live, passing level 105) and when a save after it is loaded; the castle top on a 16x16
// block's bottom row destroys the tile below it (the clean game the one in the block to its right).
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import {
  OverworldEmulator, gameL1, readL1, writeL1, readTranslevels, baseEvent, OW_EVENTS, NO_EVENT, l1Index,
  hasDestroyPatch, readDestroyList, destroyEvent, setDestroyEvent, destroyEffects, destroyedAt, DESTROYS,
  readRevealList, writeRevealList, revealedTile, revealAt, setRevealEvents,
} from '../src/core/overworld.ts';
import { readEvents, writeEvents, paintEventL1, layer1Without, eventL1Tiles } from '../src/core/owevents.ts';
import { GM, RAM } from '../src/core/ram.ts';
import { cleanImage, editorImage, romDiff, levelTiles } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const lastIndex = <T>(v: T[], f: (x: T) => boolean) => { for (let k = v.length - 1; k >= 0; k--) if (f(v[k])) return k; return -1; };
const diffAt = (a: ArrayLike<number>, b: ArrayLike<number>) => { const out: number[] = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i); return out; };

const clean = new Rom(cleanImage());
const image = await editorImage();
const TL = 0x29; // Yoshi's Island 1
const tile105 = readTranslevels(new Rom(image.slice())).indexOf(TL);
const l1At = (rom: Rom, n: number) => gameL1(new OverworldEmulator(rom).load(0, n)).slice();

// a new game, level 105 entered and passed with its normal exit, until the overworld ran its event: layer 1 in RAM
function pass(rom: Rom): Uint8Array | null {
  const p = PlaySession.overworld(new LevelEmulator(rom), tile105);
  if (!p.enter()) return null;
  const w = p.wram;
  w[RAM.levelExit] = 1; w[RAM.levelBeaten] = 1; w[RAM.midwayTouched] = 1;
  w[RAM.gameMode] = GM.overworldReturn;
  p.follow();
  const e = baseEvent(rom, TL);
  for (let f = 0; f < 3000; f++) { p.frame(); if (f > 300 && w[RAM.owEvents + (e >> 3)] & (0x80 >> (e & 7)) ) break; }
  for (let f = 0; f < 300; f++) p.frame();
  return w.slice(RAM.owLayer1, RAM.owLayer1End);
}

// ---- the patch: layer 1 at every event progress as in the clean game ----
{
  const rom = new Rom(image.slice());
  check(!hasDestroyPatch(clean) && hasDestroyPatch(rom), 'the clean game without the destroyed level tiles patch, the editor\'s ROM with it');
  const l = readDestroyList(rom), game = Array.from({ length: 0x10 }, (_, k) => ({ event: clean.r8(0x04e5d6 + k), tile: clean.r16(0x04e5b6 + k * 2) }));
  check(l.length === DESTROYS && game.every((g, k) => l[k].event === g.event && l[k].tile === g.tile) && l.slice(0x10).every((d) => d.event === NO_EVENT),
    `the game's ${game.length} entries moved, ${DESTROYS - game.length} more none`);
  const ce = new OverworldEmulator(clean), pe = new OverworldEmulator(rom), off: string[] = [];
  for (let n = 0; n <= OW_EVENTS; n++) {
    const d = diffAt(gameL1(ce.load(0, n)), gameL1(pe.load(0, n)));
    if (d.length) off.push(`${hx(n)}: ${d.map((i) => hx(i)).join(',')}`);
  }
  check(!off.length, `layer 1 at every event progress 00–78 as in the clean game (emulated) ${off.slice(0, 6).join(' ')}`);
}

// ---- what destroying a tile does, learned by emulation ----
const rom0 = new Rom(image.slice());
const effects = destroyEffects(rom0);
const destroyable = [...effects.keys()].filter((t) => effects[t].length);
check(destroyable.length > 0, `destroyable tiles: ${destroyable.map((t) => `${hx(t)} → ${effects[t].map((c) => `${c.dx},${c.dy}:${hx(c.tile)}`).join(' ')}`).join(' · ')}`);
{
  // every entry of the game destroys a tile of the map after the events before it
  const all = l1At(rom0, OW_EVENTS), list = readDestroyList(rom0).filter((d) => d.event !== NO_EVENT);
  // (as the game: revealed by the event first)
  const at = (d: { event: number; tile: number }) => { const t = l1At(rom0, d.event)[d.tile]; return effects[t].length ? t : revealedTile(rom0, t); };
  const kept = list.filter((d) => at(d) >= 0 && effects[at(d)].length && all[d.tile] !== at(d));
  check(kept.length === list.length, `the game's ${list.length} destroyed tiles are destroyable tiles, destroyed after all events${kept.length < list.length ? ` – not: ${list.filter((d) => !kept.includes(d)).map((d) => `event ${hx(d.event)} tile ${hx(d.tile)}`).join(', ')}` : ''}`);
  const tall = destroyable.find((t) => effects[t].some((c) => c.dy === 1));
  if (tall !== undefined) {
    const l1 = readL1(rom0), j = l1Index(0, 6, 6);
    l1[j] = tall;
    check(destroyedAt(effects, l1, j) === j && destroyedAt(effects, l1, l1Index(0, 6, 7)) === j && destroyedAt(effects, l1, l1Index(0, 7, 7)) === -1,
      `a castle top (${hx(tall)}): its own setting, also on the tile below it, not beside`);
  }
}

// ---- a level tile destroyed by an event ----
{
  const rom = new Rom(image.slice()), e = baseEvent(rom, TL), l1 = readL1(rom);
  const isLevelTile = levelTiles(rom);
  const t = destroyable.find((v) => isLevelTile(v) && effects[v].length === 1 && !effects[v][0].dx && !effects[v][0].dy)!;
  l1[tile105] = t;
  writeL1(rom, l1);
  const s = new RomEditSession(rom);
  s.edit('Destroy', () => setDestroyEvent(rom, tile105, e));
  check(destroyEvent(rom, tile105) === e, `tile 105 (${hx(t)}) destroyed by event ${hx(e)}: written and read back`);
  s.undo();
  check(destroyEvent(rom, tile105) === NO_EVENT, 'undone');
  s.redo();
  const into = effects[t][0].tile;
  check(l1At(rom, e)[tile105] === t && l1At(rom, e + 1)[tile105] === into, `a save loaded: ${hx(t)} at event progress ${hx(e)}, destroyed (${hx(into)}) at ${hx(e + 1)} (emulated)`);
  const live = pass(rom);
  check(!!live && live[tile105] === into, `passing level 105: the game destroys it (${live ? hx(live[tile105]) : 'not passed'})`);
  // one tile per event; none removes it
  const other = l1Index(0, 3, 3);
  setDestroyEvent(rom, other, e);
  check(destroyEvent(rom, tile105) === NO_EVENT && destroyEvent(rom, other) === e, 'an event destroys one tile: set on another, it moves');
  setDestroyEvent(rom, other, NO_EVENT);
  check(destroyEvent(rom, other) === NO_EVENT && readDestroyList(rom).filter((d) => d.event === e).length === 0, 'none: removed');
  let full = false;
  try { for (let k = 0; k <= DESTROYS; k++) setDestroyEvent(rom, l1Index(1, k, 2), 0x40 + k); } catch { full = true; }
  check(full, `more than ${DESTROYS} destroyed tiles: refused`);
}

// ---- a castle top on a 16x16 block's bottom row (row F): the tile below it is destroyed, also in the game ----
{
  const tall = destroyable.find((t) => effects[t].some((c) => c.dy === 1));
  const below = tall === undefined ? undefined : effects[tall].find((c) => c.dy === 1)!.tile;
  const at = l1Index(0, 4, 15), under = l1Index(0, 4, 16), right = l1Index(0, 20, 0); // right: the game's $10 more
  const show = (rom: Rom, entry: (r: Rom) => void) => {
    const l1 = readL1(rom);
    l1[at] = tall!;
    l1[under] = 0x56; l1[right] = 0x56;
    writeL1(rom, l1);
    entry(rom);
    return l1At(rom, OW_EVENTS);
  };
  const fixed = show(new Rom(image.slice()), (r) => setDestroyEvent(r, at, 0x30));
  // the clean game with an entry of its table set to it (an event none of its entries has)
  const game = show(new Rom(cleanImage()), (r) => { r.w8(0x04e5d6, 0x30); r.w16(0x04e5b6, at); });
  check(tall !== undefined && fixed[under] === below && fixed[right] === 0x56, `castle top ${tall !== undefined ? hx(tall) : '?'} at 04,0F: the tile below (04,10) destroyed (${hx(fixed[under])}), 14,00 not (${hx(fixed[right])})`);
  check(game[right] === below && game[under] === 0x56, `the clean game destroys 14,00 instead (${hx(game[right])}), as Lunar Magic's fix describes`);
}

// ---- the reveal list ----
{
  const rom = new Rom(image.slice()), list = readRevealList(rom), l1 = readL1(rom), e = baseEvent(rom, TL);
  check(list.length === 0x16 && list.every((p) => revealedTile(rom, p.from) === list[lastIndex(list, (q) => q.from === p.from)].to), `the reveal list: ${list.map((p) => `${hx(p.from)}→${hx(p.to)}`).join(' ')}`);
  check([0x52, 0x53, 0x54].every((t) => list.some((p) => p.from === t)), 'tiles 52–54 have entries');
  // a tile revealed by 105's normal exit, its entry pointed elsewhere
  const used = new Set(Array.from({ length: OW_EVENTS }, (_, k) => revealAt(rom, k)));
  const at = [...l1.keys()].find((i) => i > 0 && i < 0x400 && revealedTile(rom, l1[i]) >= 0 && !used.has(i) && l1At(rom, OW_EVENTS)[i] === l1[i])!;
  setRevealEvents(rom, at, [e]);
  const k = lastIndex(list, (p) => p.from === l1[at]), to = 0x5f === list[k].to ? 0x5e : 0x5f;
  const s = new RomEditSession(rom);
  s.edit('Reveal list', () => writeRevealList(rom, list.map((p, n) => (n === k ? { ...p, to } : p))));
  check(revealedTile(rom, l1[at]) === to, `entry ${hx(k)}: ${hx(l1[at])} → ${hx(to)}, written and read back`);
  check(l1At(rom, e + 1)[at] === to && l1At(rom, e)[at] === l1[at], `a save loaded: tile ${hx(at)} revealed as ${hx(to)} after event ${hx(e)}, not before (emulated)`);
  const live = pass(rom);
  check(!!live && live[at] === to, `passing level 105: revealed as ${hx(to)} (${live ? hx(live[at]) : 'not passed'})`);
  // tile 54 reveals one tile (the game's unused second one turned off, as Lunar Magic does)
  const k54 = lastIndex(list, (p) => p.from === 0x54);
  const l = readL1(rom), j = l1Index(0, 2, 2);
  l[j] = 0x54; l[j + 1] = 0x56;
  writeL1(rom, l);
  setRevealEvents(rom, j, [e]);
  const shown = l1At(rom, e + 1);
  check(shown[j] === list[k54].to && shown[j + 1] === 0x56, `tile 54 revealed: ${hx(shown[j])}, the tile right of it stays (${hx(shown[j + 1])})`);
  check((() => { try { writeRevealList(rom, list.slice(1)); return false; } catch { return true; } })(), 'a list of another length: refused');
  s.undo();
}

// ---- layer 1 changes of an event ----
{
  const rom = new Rom(image.slice()), was = rom.data.slice(), d0 = readEvents(rom);
  const withL1 = [...d0.silent.keys()].filter((e) => eventL1Tiles(d0, e).length);
  check(withL1.length > 0, `the clean game's events with layer 1 changes: ${withL1.map((e) => `${hx(e)} (${eventL1Tiles(d0, e).length})`).join(' ')}`);
  // each painted as it is (the map after it): the same steps
  let d = d0;
  for (const e of withL1) d = paintEventL1(d, e, l1At(rom, e + 1), layer1Without(rom, e));
  writeEvents(rom, d);
  const same = withL1.every((e) => new Set(eventL1Tiles(d, e)).size === eventL1Tiles(d0, e).length && eventL1Tiles(d0, e).every((i) => eventL1Tiles(d, e).includes(i)));
  check(same && romDiff(was, rom.data) === 0, `painted as they are: the same changes (those writing the tile already there too), no byte changed (${romDiff(was, rom.data)})`);
  // 105's normal exit changes a main map tile and a submap tile
  const e = baseEvent(rom, TL), after = l1At(rom, e + 1), without = layer1Without(rom, e);
  const a = l1Index(0, 25, 25), b = l1Index(1, 9, 3);
  const painted = after.slice();
  painted[a] = after[a] === 0x10 ? 0x11 : 0x10; painted[b] = after[b] === 0x12 ? 0x13 : 0x12;
  const s = new RomEditSession(rom);
  s.edit('Event: layer 1', () => writeEvents(rom, paintEventL1(readEvents(rom), e, painted, without)));
  const tiles = eventL1Tiles(readEvents(rom), e);
  check(tiles.includes(a) && tiles.includes(b), `event ${hx(e)}: ${tiles.length} layer 1 changes, the 2 painted among them`);
  const now = l1At(rom, e + 1), then = l1At(rom, e);
  check(now[a] === painted[a] && now[b] === painted[b] && then[a] === without[a] && then[b] === without[b] && !diffAt(now, painted).length,
    `a save loaded: the map after event ${hx(e)} is the painted one, before it as it was (emulated)`);
  const live = pass(rom);
  check(!!live && live[a] === painted[a] && live[b] === painted[b], 'passing level 105: the game changes both tiles');
  // painted back as without them: no layer 1 change left
  s.edit('Event: layer 1', () => writeEvents(rom, paintEventL1(readEvents(rom), e, without, layer1Without(rom, e), new Set(tiles))));
  check(!eventL1Tiles(readEvents(rom), e).length, 'painted back: the event has no layer 1 change');
  s.undo(); s.undo();
  check(romDiff(was, rom.data) === 0, 'undone: the ROM as before');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('layer 1 events ok');
