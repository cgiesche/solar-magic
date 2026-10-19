// Screen exits between levels 0xx and 1xx (Lunar Magic's new-style exits, levelheight.ts): an exit with u
// (0000wush) takes the target's high bit from its own h and whether it is secondary from its own s; a
// secondary entrance's level has its own high bit (D of IPXXDAAA). Every exit the editor writes is new-style,
// and leads where it led before; exits without u behave as in the game (the high bit from the overworld
// submap), and the game's are made new-style when the clean game is patched, leading where the game leads
// them. Community code writing the exit flags (GPS's teleport routine) leads into either bank. Checked on the
// model and by emulation.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator, type LevelOverride } from '../src/core/levelemu.ts';
import {
  type ScreenExit, loadLevel, cloneLevel, serializeLayer1, parseObjects, parseLevelData, readSecondaryEntrance, writeSecondaryEntrance, decodeSecondaryEntrance,
  readSecondaryHeader, encodeSecondaryHeader, newUid, storedExits, exitIndex, levelTranslevel, mainTranslevel, EXIT_NEW, SEC_ENT, SEC_LEVEL_HI,
} from '../src/core/level.ts';
import { ExitGraph, exitTarget, isBlank, submapBanks, newStyleExits } from '../src/core/exitgraph.ts';
import { GM, RAM, LEVEL_LOADED } from '../src/core/ram.ts';
import type { SnesState } from '../src/core/snes.ts';
import { DM16_EXT } from '../src/core/patches.ts';
import { setActsLike, setExtTileWords } from '../src/core/map16ext.ts';
import { map16Source } from '../src/core/render.ts';
import { loadAsar } from '../src/core/asar.ts';
import { saveBlockProject, parseBlockList } from '../src/core/blocks.ts';
import { editorImage, cleanImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16);

const rom = new Rom(await editorImage());
const N = 0x105;

// ---- the model ----
{
  // a level's exits come new-style, with the target's full number (the game's bank from the level)
  const lv = loadLevel(rom, N);
  check(lv.exits.length > 0 && lv.exits.every((e) => (e.flags & EXIT_NEW) !== 0 && e.dest >= 0x100),
    `exits of ${hx(N)} new-style with their 1xx targets (${lv.exits.map((e) => `${hx(e.dest)}${e.secondary ? 's' : ''}`).join(', ')})`);
  const low = loadLevel(rom, 0xbd);
  check(low.exits.every((e) => (e.flags & EXIT_NEW) !== 0 && e.dest < 0x100), 'exits of 0BD new-style with their 0xx targets');
  // written: u always, h the target's high bit, s
  const ex: ScreenExit[] = [{ uid: newUid(), screen: 2, dest: 0x015, secondary: false, flags: 0 }, { uid: newUid(), screen: 3, dest: 0x1cb, secondary: true, flags: 0 }];
  const l1 = serializeLayer1(rom, { ...cloneLevel(lv), exits: ex });
  check(l1[6] === EXIT_NEW && l1[10] === (EXIT_NEW | 3), `written with u: ${hx(l1[6])}, ${hx(l1[10])}`);
  const back = parseObjects(l1, 5, false).exits;
  check(back[0].dest === 0x015 && !back[0].secondary && back[1].dest === 0x1cb && back[1].secondary, 'read back as written');
  // old-style exits read as the game plays them: all secondary or standard by the level's last exit
  const old = serializeLayer1(rom, { ...cloneLevel(lv), exits: ex });
  old[6] &= ~EXIT_NEW & 0xff; old[10] &= ~EXIT_NEW & 0xff;
  const read = parseLevelData(rom, N, old, null, lv.layer2Pointer, new Uint8Array([0, 0xff]), lv.secondary).exits;
  check(read.every((e) => e.secondary && (e.flags & EXIT_NEW)) && read[0].dest === 0x115 && read[1].dest === 0x1cb,
    `old-style exits of 105 read new-style: ${read.map((e) => `${hx(e.dest)}${e.secondary ? 's' : ''}`).join(', ')}`);

  // where exits lead: with u by their own number, without it from the level's bank
  check(exitTarget(rom, N, { dest: 0x015, secondary: false, flags: EXIT_NEW }).to === 0x015, 'new-style exit of 105 into 015');
  check(exitTarget(rom, 0x015, { dest: 0x106, secondary: false, flags: EXIT_NEW }).to === 0x106, 'new-style exit of 015 into 106');
  check(exitTarget(rom, N, { dest: 0x015, secondary: false, flags: 0 }).to === 0x115, 'old-style exit of 105: 115');
  const t = exitTarget(rom, N, { dest: 0x0c0, secondary: true, flags: EXIT_NEW | 2 });
  check(t.entrance === 0x0c0 && t.to === 0x01c, `new-style secondary exit of 105 through entrance 0C0 into ${hx(t.to)}`);

  // a secondary entrance's level: its own high bit (D), set for the game's entrances 100-1FF when the editor
  // patches the clean game
  check(readSecondaryEntrance(rom, 0x1cb).destLevel === 0x105 && readSecondaryEntrance(rom, 0x0c0).destLevel === 0x01c, 'entrances 1CB → 105, 0C0 → 01C');
  const hiBlank = Array.from({ length: 0x100 }, (_, i) => 0x100 | i).filter((i) => SEC_ENT.slice(0, 3).every((a) => rom.r8(a + i) === 0) && rom.r8(SEC_ENT[3] + i) === SEC_LEVEL_HI && SEC_ENT.slice(4).every((a) => rom.r8(a + i) === 0));
  check(hiBlank.length > 200 && hiBlank.every((i) => isBlank(rom, i)), `unused entrances 100-1FF lead into 100 as in the game, and are blank (${hiBlank.length})`);
  const e = decodeSecondaryEntrance([0x06, 0, 0, 0x08, 0, 0]);
  check(e.destLevel === 0x106, 'D: the level\'s bit 8');
  const r = new Rom(rom.data.slice());
  writeSecondaryEntrance(r, 0x40, { ...e, destLevel: 0x1ff });
  check(r.r8(SEC_ENT[0] + 0x40) === 0xff && r.r8(SEC_ENT[3] + 0x40) === SEC_LEVEL_HI && readSecondaryEntrance(r, 0x40).destLevel === 0x1ff, 'written back with D');

  // entrances and free numbers from the whole range
  const g = new ExitGraph(rom);
  const free = g.freeEntrance()!;
  check(free !== null && free < 0x100 && isBlank(rom, free), `a free entrance for 105 from the whole range (${hx(free)})`);
  writeSecondaryEntrance(r, free, { ...decodeSecondaryEntrance([0, 0, 0, 0, 0, 0]), destLevel: N, screen: 2 });
  const g2 = new ExitGraph(r);
  check(g2.entrancesOf(N).includes(free) && g2.entrancesOf(N).includes(0x1cb), `entrances of 105: ${g2.entrancesOf(N).map(hx).join(', ')}`);
}

// ---- by emulation: level 105 entered on its exit pipe (screen 7), going down it ----
// the level Mario arrives in through level 105's exits `exits` (as raw layer 1 bytes when `raw` changes them),
// (-1: none)
function arrive(r: Rom, exits: ScreenExit[], raw?: (l1: Uint8Array) => void): number {
  const lv = cloneLevel(loadLevel(r, N));
  lv.exits = exits;
  const l1 = serializeLayer1(r, lv);
  raw?.(l1);
  const sec = { ...readSecondaryHeader(r, N), entranceScreen: 7, entranceTile: 1, entranceX: 0, entranceXHi: 1, entranceY: 0x14 & 15, entranceYHi: 0x14 >> 4 };
  const em = new LevelEmulator(r);
  em.load(N, { layer1: l1, secondaryHeader: encodeSecondaryHeader(sec) });
  const s = em.snes, w = s.wram;
  for (let f = 0; f < 300 && w[RAM.gameMode] !== GM.level; f++) s.runFrame();
  w[RAM.marioX] = 0x88;
  let left = false;
  for (let f = 0; f < 2000; f++) {
    s.joy1 = 0x0400; s.runFrame();
    if (w[RAM.gameMode] !== GM.level) left = true;
    if (left && w[RAM.gameMode] === GM.level) break;
  }
  if (!left || w[RAM.gameMode] !== GM.level) return -1;
  // the level the game loaded (the level heights patch keeps it, from Y at the setup)
  const at = LEVEL_LOADED - 0x7e0000;
  return w[at] | (w[at + 1] << 8);
}
const exit = (screen: number, dest: number, secondary: boolean): ScreenExit => ({ uid: newUid(), screen, dest, secondary, flags: EXIT_NEW });
{
  const a = arrive(rom, [exit(7, 0x015, false)]);
  check(a === 0x015, `standard exit of 105 into 015: arrives in ${hx(a)}`);
  const b = arrive(rom, [exit(7, 0x0c0, true)]);
  check(b === 0x01c, `secondary exit of 105 through entrance 0C0: arrives in ${hx(b)} (01C)`);
  // an entrance numbered 0xx into level 1xx
  const r = new Rom(rom.data.slice());
  const free = new ExitGraph(r).freeEntrance()!;
  writeSecondaryEntrance(r, free, { ...readSecondaryEntrance(r, 0x1cb), destLevel: 0x106 });
  const c = arrive(r, [exit(7, free, true)]);
  check(free < 0x100 && c === 0x106, `secondary exit through entrance ${hx(free)} into 106: arrives in ${hx(c)}`);
  // standard and secondary exits mixed: each leads where it is set (the game: the level's last exit decides)
  const d = arrive(rom, [exit(7, 0x015, false), exit(2, 0x0c0, true)]);
  const e = arrive(rom, [exit(7, 0x0c0, true), exit(2, 0x015, false)]);
  check(d === 0x015 && e === 0x01c, `mixed exits: standard → ${hx(d)}, secondary → ${hx(e)}`);
  // without u (a level the editor has not changed): as in the game, the high bit from the overworld submap
  // (Yoshi's Island: 1xx), the level's last exit deciding secondary
  const old = arrive(rom, [exit(7, 0x0cb, false), exit(2, 0x0c0, true)], (l1) => { l1[6] &= ~EXIT_NEW & 0xff; l1[10] &= ~EXIT_NEW & 0xff; });
  check(old === 0x105, `old-style exits: the game's rule, through entrance 1CB into ${hx(old)}`);
}

// ---- by emulation: a game in progress, as a player plays it ----
// Mario on the overworld tile of translevel tl (the game's submap), level `level` entered from it (with
// `ov`), then left by the exits of the screens `screens` one after another the way GPS's teleport routine
// takes one, once Mario stands (Mario on the screen, $71 = 6 and $88 = 0: the game's pipe exit through the
// screen's $19B8/$19D8; $89 below 4: going into the pipe, a pipe entrance leaves it at 4 or more). Where Mario
// arrives: the level data and his position (both ROMs), the level loaded (the editor's ROM), or null
const games = new Map<LevelEmulator, Map<number, SnesState>>(); // the overworld after startGame, per translevel
function play(em: LevelEmulator, tl: number, level: number, screens: number[], ov: LevelOverride = {}): { at: string; level: number } | null {
  const g = games.get(em) ?? games.set(em, new Map()).get(em)!;
  const st = g.get(tl);
  if (st) em.snes.loadState(st);
  else { em.startGame(tl); g.set(tl, em.snes.saveState()); }
  em.load(level, { ...ov, translevel: tl, continueState: true });
  const s = em.snes, w = s.wram;
  for (const screen of screens) {
    for (let f = 0; f < 600 && (w[RAM.gameMode] !== GM.level || w[RAM.marioAnim] !== 0); f++) s.runFrame();
    w[w[RAM.screenMode] & 1 ? RAM.marioY + 1 : RAM.marioX + 1] = screen;
    w[RAM.marioAnim] = 6; w[RAM.pipeTimer] = 0; w[RAM.pipeAction] = 0;
    let left = false;
    for (let f = 0; f < 600; f++) {
      s.runFrame();
      if (w[RAM.gameMode] !== GM.level) left = true;
      if (left && w[RAM.gameMode] === GM.level) break;
    }
    if (!left || w[RAM.gameMode] !== GM.level) return null;
  }
  const b = (a: number, n: number) => Array.from(w.subarray(a, a + n), (v) => hx(v).padStart(2, '0')).join('');
  const at = LEVEL_LOADED - 0x7e0000;
  return { at: `${b(RAM.levelDataPtr, 3)} ${b(RAM.spriteDataPtr, 3)} ${b(RAM.marioX, 4)}`, level: w[at] | (w[at + 1] << 8) };
}

// the game's exits: where the rules differ, and made new-style at install leading where the game leads them
{
  const banks = submapBanks(rom);
  const foreign = [...banks].filter(([n, b]) => b.size !== 1 || !b.has(n >> 8));
  check(banks.size > 200 && !foreign.length,
    `the game plays every level from a submap of its own bank (${banks.size} levels): its rule and the level's bank agree${foreign.map(([n]) => ' ' + hx(n)).join('')}`);
  const all = Array.from({ length: 0x200 }, (_, n) => n).flatMap((n) => storedExits(rom, n).exits.map((e) => ({ n, e })));
  check(all.length > 200 && all.every(({ e }) => e.flags & EXIT_NEW), `installed: the game's ${all.length} exits are new-style`);
  // every exit of a level the game plays, taken in the clean game and in the editor's ROM
  const clean = new LevelEmulator(new Rom(cleanImage())), ed = new LevelEmulator(rom);
  const differ: string[] = [];
  let n = 0;
  for (const { n: lv, e } of all) {
    const tl = levelTranslevel(rom, lv);
    if (!tl && !mainTranslevel(lv)) continue;
    const a = play(clean, tl, lv, [e.screen]), b = play(ed, tl, lv, [e.screen]);
    n++;
    if (!a || !b || a.at !== b.at) differ.push(`${hx(lv)}:${e.screen} ${a?.at} / ${b?.at}`);
  }
  check(n > 200 && !differ.length, `the game's exits lead where they did in the clean game (${n}) ${differ.join(', ')}`);

  // where the rules differ: 1CB (the game's from 105 on Yoshi's Island) entered only from 015 on the main map,
  // its exit old-style into 006 there (the level's bank: 106)
  const r = new Rom(rom.data.slice());
  const poke = (lv: number, i: number, flags: number, dest: number) => {
    const a = storedExits(r, lv).at[i];
    r.w8(a + 1, (r.r8(a + 1) & 0xf0) | flags); r.w8(a + 3, dest);
  };
  poke(0x105, 0, EXIT_NEW | 1, 0x06);
  poke(0x015, 0, EXIT_NEW | 1, 0xcb);
  poke(0x1cb, 0, 0, 0x06);
  const ex = storedExits(r, 0x1cb).exits[0];
  check([...submapBanks(r).get(0x1cb)!].join() === '0' && exitIndex(0x1cb, ex) === 0x106, '1CB played from the main map only, its old-style exit 106 by the level\'s bank');
  const em = new LevelEmulator(r);
  const game = play(em, 0x15, 0x015, [7, 1]);
  check(game?.level === 0x006, `the game: 015 → 1CB → ${hx(game?.level ?? -1)} (006, by the submap)`);
  newStyleExits(r);
  const now = storedExits(r, 0x1cb).exits[0];
  const made = play(em, 0x15, 0x015, [7, 1]);
  check((now.flags & EXIT_NEW) !== 0 && exitIndex(0x1cb, now) === 0x006 && made?.level === 0x006 && made.at === game?.at, `made new-style: into ${hx(exitIndex(0x1cb, now))}, arrives in ${hx(made?.level ?? -1)}`);
}

// old-style exits of a 0xx level on the main map (015, submap 0): standard into 0xx, secondary through an
// entrance 0xx (its D clear: the game's entrances 100-1FF got D at install) into its level 0xx
{
  const em = new LevelEmulator(rom);
  // the level's exits written first, 4 bytes each: u cleared
  const old = (exits: ScreenExit[]) => {
    const lv = cloneLevel(loadLevel(rom, 0x015));
    lv.exits = exits;
    const l1 = serializeLayer1(rom, lv);
    exits.forEach((_, i) => { l1[6 + i * 4] &= ~EXIT_NEW & 0xff; });
    return { layer1: l1 };
  };
  const a = play(em, 0x15, 0x015, [7], old([exit(7, 0x01a, false)]));
  check(a?.level === 0x01a, `old-style standard exit of 015: arrives in ${hx(a?.level ?? -1)} (01A)`);
  const b = play(em, 0x15, 0x015, [7], old([exit(7, 0x0c0, true)]));
  check(!(readSecondaryEntrance(rom, 0x0c0).destLevel & 0x100) && b?.level === 0x01c, `old-style secondary exit of 015 through entrance 0C0: arrives in ${hx(b?.level ?? -1)} (01C)`);
}

// GPS's teleport routine: writes the screen's exit with u ($19B8/$19D8) and takes it; from 105 into 015
{
  await loadAsar();
  const r = new Rom(rom.data.slice());
  const T = 0x2a0, REF = 0x130;
  setExtTileWords(r, T, map16Source(r, new LevelEmulator(r).load(N)).fg(REF)); setActsLike(r, T, REF);
  const offs = ['MarioBelow', 'MarioAbove', 'MarioSide', 'SpriteV', 'SpriteH', 'MarioCape', 'MarioFireball', 'TopCorner', 'BodyInside', 'HeadInside'];
  const block = ['db $42', ...offs.map((o) => `JMP ${o === 'MarioAbove' ? 'Go' : 'Done'}`), 'Go:', '  REP #$20 : LDA.w #$0015', '  %teleport()', 'Done:', '  RTL'].join('\n');
  const res = saveBlockProject(r, { files: new Map([['blocks/teleport.asm', new TextEncoder().encode(block)]]), list: parseBlockList(`${hx(T)} teleport.asm\n`) });
  check(res.ok, 'a block calling %teleport() assembles ' + res.errors.join(' | '));
  const lv = cloneLevel(loadLevel(r, N));
  lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 0, y: 24, size: 0x08, tile: T }); // the floor under Mario
  const em = new LevelEmulator(r);
  em.load(N, { layer1: serializeLayer1(r, lv) });
  const s = em.snes, w = s.wram;
  for (let f = 0; f < 300 && w[RAM.gameMode] !== GM.level; f++) s.runFrame();
  let left = false;
  for (let f = 0; f < 1500; f++) {
    s.runFrame();
    if (w[RAM.gameMode] !== GM.level) left = true;
    if (left && w[RAM.gameMode] === GM.level) break;
  }
  const at = LEVEL_LOADED - 0x7e0000, to = w[at] | (w[at + 1] << 8);
  check(left && to === 0x015, `teleport of 105 into 015 (the other bank): arrives in ${hx(to)}`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
