// Events named by a secret exit only where the level can have one (#383, owevents.ts eventRunners, secretexits.ts):
// on the clean game the levels whose data shows a secret exit – a keyhole, a goal tape with its extra bit – are the
// game's levels with secret exits but the Donut Secret House and Chocolate Island 2; those keep their names as their
// events are no level's base event and change something – the only secret exits named without the ROM showing them.
// Yoshi's Island 4's base event + 1 (Iggy's castle's) isn't named its secret exit – a secret goal tape or an
// overworld exit passing it by secret exit 2 makes it one. The texts naming events go through it (eventTitle, the
// refusals' eventPhrase, eventNames).
// A level with the base event "No event" (FF): its secret exit 1 runs event 00 (FF + 1, #389, as testrevealwalk
// emulates it), its other exits none – named by eventRunners where the level has the secret exit, its changes the
// level's (exitChanges), and the saves at every progress (progressSaves, emulated) pass it for event 00.
// node tools/testsecretexits.ts
import { Rom } from '../src/core/rom.ts';
import { loadLevel, readSecondaryEntrance, writeSecondaryEntrance, newOverworldExit, EXIT_NEW, OW_SECRET } from '../src/core/level.ts';
import { saveLevel, saveSprites } from '../src/core/save.ts';
import { ExitGraph } from '../src/core/exitgraph.ts';
import { baseEvent, setBaseEvent, eventNames, NO_EVENT, OverworldEmulator, OverworldLoads, FLAG, MAX_TRANSLEVEL } from '../src/core/overworld.ts';
import { eventRunners, eventTitle, exitChanges, exitEvent } from '../src/core/owevents.ts';
import { progressSaves } from '../src/core/owprogress.ts';
import { shownSecretExits } from '../src/core/secretexits.ts';
import { eventPhrase } from '../src/ui/owrefusal.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const image = await editorImage();
const YI4 = 0x26, IGGY = 0x25, VD2 = 0x3c, DSH = 0x13, CI2 = 0x24;
const runs = (rom: Rom, e: number, tl: number, exit: number) => !!eventRunners(rom).get(e)?.some((r) => r.tl === tl && r.exit === exit);

// ---- the clean game ----
{
  const rom = new Rom(image.slice()), shown = shownSecretExits(rom);
  // keyholes: Donut Plains 1, 2, Donut Secret 1, Vanilla Dome 1, 2, Valley of Bowser 2, 4, Valley Ghost House, Forest
  // of Illusion 1–4, Star World 1–5, and levels 016/017 (unused copies of Donut Plains 1); secret goal tapes: Donut
  // Ghost House, Cheese Bridge, Chocolate Island 3, Vanilla Secret 1, Forest Ghost House
  const want = [0x15, 0x09, 0x0a, 0x3e, 0x3c, 0x39, 0x33, 0x38, 0x42, 0x44, 0x47, 0x43, 0x58, 0x54, 0x56, 0x59, 0x5a, 0x16, 0x17,
    0x04, 0x0f, 0x23, 0x2d, 0x41].sort((a, b) => a - b);
  const got = [...shown.keys()].sort((a, b) => a - b);
  check(got.join() === want.join() && [...shown.values()].every((s) => [...s].join() === '1'),
    `secret exit 1 shown for ${got.map((t) => hx(t)).join(' ')}`);
  const vd2 = baseEvent(rom, VD2) + 1;
  check(eventRunners(rom).get(vd2)?.[0].tl === VD2 && eventTitle(eventRunners(rom), vd2) === 'Level 118 · secret exit 1', `Vanilla Dome 2's secret exit keeps its event ${hx(vd2)}: ${eventTitle(eventRunners(rom), vd2)}`);
  const e = baseEvent(rom, YI4) + 1;
  check(e === baseEvent(rom, IGGY) && !runs(rom, e, YI4, 1) && eventRunners(rom).get(e)?.length === 1,
    `Yoshi's Island 4's base event + 1 (${hx(e)}): run by Iggy's castle only, not by a secret exit of it`);
  check(eventPhrase(rom, e) === 'the normal exit of #1 Iggy\'s Castle' && eventNames(rom).get(e) === '101 #1 IGGY\'S CASTLE – normal exit',
    `named "${eventPhrase(rom, e)}", in the base event list "${eventNames(rom).get(e)}"`);
  for (const [tl, name] of [[DSH, 'Donut Secret House'], [CI2, 'Chocolate Island 2']] as const) {
    const s = baseEvent(rom, tl) + 1;
    check(!shown.has(tl) && runs(rom, s, tl, 1), `${name}: no secret exit in its data, its event ${hx(s)} (no level's base event) still named its secret exit`);
  }
  // the secret exits named without the ROM showing them: those two only
  const unshown = [...eventRunners(rom).values()].flat().filter((r) => r.exit && !shown.get(r.tl)?.has(r.exit));
  check(unshown.map((r) => `${hx(r.tl)}/${r.exit}`).sort().join() === [DSH, CI2].map((tl) => `${hx(tl)}/1`).sort().join(),
    `secret exits named without the ROM showing them: ${unshown.map((r) => `${hx(r.tl)}/${r.exit}`).join(' ')}`);
}

// ---- Iggy's castle without base event: event 06 run by no normal exit – named Yoshi's Island 4's secret exit ----
{
  const rom = new Rom(image.slice()), e = baseEvent(rom, YI4) + 1;
  setBaseEvent(rom, IGGY, NO_EVENT);
  check(runs(rom, e, YI4, 1), `Iggy's castle without base event: ${hx(e)} named "${eventPhrase(rom, e)}" (no normal exit runs it)`);
}

// ---- a secret goal tape in Yoshi's Island 4: its secret exit runs event 06 (after Iggy's castle's normal exit) ----
{
  const rom = new Rom(image.slice()), e = baseEvent(rom, YI4) + 1, lv = loadLevel(rom, 0x1ff), tape = lv.sprites.find((s) => s.num === 0x7b)!;
  tape.extra |= 1;
  saveSprites(rom, lv);
  const r = eventRunners(rom).get(e) ?? [];
  check(shownSecretExits(rom).get(YI4)?.has(1) === true && r[0]?.tl === IGGY && r[1]?.tl === YI4 && r[1].exit === 1,
    `its goal tape with the extra bit: ${hx(e)} run by Iggy's castle, then Yoshi's Island 4's secret exit`);
}

// ---- an exit to the overworld passing Yoshi's Island 4 by secret exit 2 ----
{
  const rom = new Rom(image.slice()), e = baseEvent(rom, YI4) + 2, g = new ExitGraph(rom), idx = g.freeEntrance()!;
  writeSecondaryEntrance(rom, idx, { ...readSecondaryEntrance(rom, idx), destLevel: 0x102, overworld: { ...newOverworldExit(), action: OW_SECRET + 1 } });
  const lv = loadLevel(rom, 0x102);
  lv.exits = [...lv.exits, { uid: 0, screen: 1, dest: idx, secondary: true, flags: EXIT_NEW | 2 | (idx >> 8) }];
  saveLevel(rom, lv);
  const r = eventRunners(rom).get(e) ?? [];
  check(shownSecretExits(rom).get(YI4)?.has(2) === true && r.some((x) => x.tl === YI4 && x.exit === 2) && !runs(rom, e - 1, YI4, 1),
    `an overworld exit with secret exit 2: ${hx(e)} also run by Yoshi's Island 4's secret exit 2 (${r.map((x) => `${hx(x.tl)}/${x.exit}`).join(' ')}), secret exit 1 still not`);
}

// ---- "No event": secret exit 1 runs event 00 (#389) ----
{
  check(exitEvent(NO_EVENT, 1) === 0 && [0, 2, 3].every((x) => exitEvent(NO_EVENT, x) < 0) && exitEvent(0x76, 1) === 0x77 && exitEvent(0x76, 2) < 0,
    'exitEvent: with no event only secret exit 1 runs one (00); past the last event none');
  const rom = new Rom(image.slice());
  setBaseEvent(rom, VD2, NO_EVENT);
  const r = eventRunners(rom).get(0) ?? [];
  check(runs(rom, 0, VD2, 1) && r[0]?.exit === 0 && !exitChanges(rom, VD2).length,
    `Vanilla Dome 2 with no event (a keyhole): its secret exit 1 runs event 00, after ${r[0] && `${hx(r[0].tl)}'s normal exit`}: no changes of its own`);
  // event 00's levels without their event: a no-event level's secret exit 1 is the first to run it
  const owners = Array.from({ length: MAX_TRANSLEVEL }, (_, k) => k + 1).filter((tl) => baseEvent(rom, tl) === 0);
  for (const tl of owners) setBaseEvent(rom, tl, NO_EVENT);
  const first = eventRunners(rom).get(0)?.[0];
  check(!!first && first.exit === 1 && baseEvent(rom, first.tl) === NO_EVENT && exitChanges(rom, first.tl).some((c) => c.exit === 1 && c.event === 0),
    `${owners.map((tl) => hx(tl)).join(' ')} with no event too: event 00 first run by ${first && `${hx(first.tl)}'s secret exit 1`}, its changes that level's`);
  const saves = progressSaves(new OverworldLoads(new OverworldEmulator(rom), 4));
  check(!!first && (saves[1].levelFlags[first.tl] & FLAG.passed) !== 0 && !(saves[0].levelFlags[first.tl] & FLAG.passed) && saves[1].eventsTriggered === saves[0].eventsTriggered + 1,
    `the save after event 00 (emulated): ${first && hx(first.tl)} passed (flags ${first && hx(saves[1].levelFlags[first.tl])}), ${saves[1].eventsTriggered} event triggered`);
}

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
