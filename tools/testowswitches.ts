// The switch palaces pressed in the save at an event progress (#257, owprogress.ts progressSaveJob): which tiles press
// which switch learned by the block probe (Mario landing on each tile, BlockProber.probePress), the levels placing them
// by loading the levels played from each translevel passed (its level and those its exits lead to). The clean game's
// four palaces are pressed from their event on, also with a switch moved to another level; test play from the
// overworld takes the save over.
// node tools/testowswitches.ts
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { BlockProber } from '../src/core/blockprobe.ts';
import { LevelUses } from '../src/core/levelusage.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { OverworldEmulator, OverworldLoads, baseEvent, readTranslevels } from '../src/core/overworld.ts';
import { progressSaveJob, type PressSource, type ProgressSave } from '../src/core/owprogress.ts';
import { runJob } from '../src/core/jobrunner.ts';
import { loadLevel, cloneLevel, mainTranslevel, newUid } from '../src/core/level.ts';
import { DM16_EXT } from '../src/core/patches.ts';
import { saveLevel } from '../src/core/save.ts';
import { RAM } from '../src/core/ram.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

const source = (rom: Rom): PressSource => {
  const prober = new BlockProber(rom);
  return { prober, uses: new LevelUses(rom, prober.results), emu: new LevelEmulator(rom) };
};
const saveAt = (loads: OverworldLoads, src: PressSource, p: number) => runJob(progressSaveJob(loads, p, src) as Generator<string | void, ProgressSave>);

const rom = new Rom(await editorImage());
{
  const src = source(rom), loads = new OverworldLoads(new OverworldEmulator(rom), 4);
  // the probe: the clean game's switch tiles (the switch palaces' tileset) press by the tile, two of each four
  src.prober.use(4);
  const press = Array.from({ length: 16 }, (_, k) => src.prober.probePress(0xec + k));
  check(press.join() === [0, 0, -1, -1, 1, 1, -1, -1, 2, 2, -1, -1, 3, 3, -1, -1].join() && src.prober.probePress(0x130) === -1 && src.prober.probePress(0x1ec) === -1,
    `tiles 0EC–0FB press green, yellow, blue, red (${press.join(' ')}); 130 and 1EC none`);
  // the palaces: green (level 008), yellow (014), red (11B), blue (121) – their switches are in sub-levels
  const off: string[] = [];
  for (const [level, i] of [[0x008, 0], [0x014, 1], [0x11b, 3], [0x121, 2]]) {
    const e = baseEvent(rom, mainTranslevel(level)!);
    const before = saveAt(loads, src, e), after = saveAt(loads, src, e + 1);
    if (before.switchPalaces[i] || !after.switchPalaces[i]) off.push(`${hx(level)}: ${before.switchPalaces.join('')} at ${hx(e)}, ${after.switchPalaces.join('')} at ${hx(e + 1)}`);
  }
  check(!off.length, `each palace pressed from the progress its event passed on ${off.join('; ')}`);
  const last = saveAt(loads, src, 0x78), first = saveAt(loads, src, 0);
  check(last.switchPalaces.every((v) => v === 1) && first.switchPalaces.every((v) => !v), `progress 78: all four pressed (${last.switchPalaces.join('')}), 0: none`);

  // test play from the overworld takes the save over
  const emu = new LevelEmulator(rom), tile = readTranslevels(rom).indexOf(0x29);
  const p = PlaySession.fromOverworld(emu, tile, 0x78, last);
  check([...emu.snes.wram.subarray(RAM.switchPalaces, RAM.switchPalaces + 4)].every((v) => v === 1), 'test play at progress 78: the four switches pressed in the game');
  p.close();
}

// the yellow switch moved: out of its room (level 0CA), into level 106 (Yoshi's Island 2, passed after the palace)
{
  const r2 = new Rom(rom.data.slice());
  const room = cloneLevel(loadLevel(r2, 0xca)), yi2 = cloneLevel(loadLevel(r2, 0x106));
  const sw = room.objects.findIndex((o) => o.num === 0 && o.ext === 0x8b); // the big switch (extended object 8B)
  room.objects.splice(sw, 1);
  saveLevel(r2, room);
  yi2.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 0x20, y: 0x16, size: 0x00, tile: 0xf0 });
  saveLevel(r2, yi2);
  const src = source(r2), loads = new OverworldLoads(new OverworldEmulator(r2), 4);
  const ysp = baseEvent(r2, 0x14), yi = baseEvent(r2, mainTranslevel(0x106)!);
  const at = (p: number) => saveAt(loads, src, p).switchPalaces[1];
  check(sw >= 0 && yi > ysp && !at(ysp + 1), `the yellow palace passed (progress ${hx(ysp + 1)}): its switch not pressed (${at(ysp + 1)})`);
  check(!at(yi) && at(yi + 1) === 1, `pressed once level 106 passed (progress ${hx(yi + 1)}: ${at(yi + 1)}, ${hx(yi)}: ${at(yi)})`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
