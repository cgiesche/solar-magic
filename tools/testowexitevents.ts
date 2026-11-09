// Events run by an exit to the overworld with a base event of its own (#429, level.ts OverworldExit,
// secretexits.ts ownEventExits): owevents.ts eventRunners names such an exit – one a screen exit of a level played
// from a level tile takes, whose action passes the level – as running its base event + the exit its action passes,
// after the level tiles' own exits. The texts naming events go through it (eventTitle "Level 105 · exit to overworld
// (normal exit)" by the exit's own level, the strip's eventWords, eventNames, the refusals' eventPhrase), the event is
// shown on the submap of the level's tile (eventPlace), the World check doesn't report it never run, without the event
// the way the level's exit opens stays open where the level's own exit passes it too (owreach.ts inputWithout), and
// the saves at every progress (progressSaves, emulated) pass it by leaving the level through that exit: the game runs
// and counts it.
// node tools/testowexitevents.ts
import { Rom } from '../src/core/rom.ts';
import { loadLevel, readSecondaryEntrance, writeSecondaryEntrance, newOverworldExit, mainTranslevel, EXIT_NEW, OW_NORMAL, OW_SECRET, OW_NOTHING, type OverworldExit } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { ExitGraph } from '../src/core/exitgraph.ts';
import { baseEvent, eventNames, OverworldEmulator, OverworldLoads, FLAG, l1Index, readL1, readTranslevels, translevelToLevel } from '../src/core/overworld.ts';
import { inputWithout, type ReachInput } from '../src/core/owreach.ts';
import { eventRunners, eventTitle, eventWords, exitChanges, playthroughStrip, eventPlace, submapViews, readEvents, writeEvents, eventChanges, type EventRunner } from '../src/core/owevents.ts';
import { progressSaves } from '../src/core/owprogress.ts';
import { checkContext, eventsNeverRun } from '../src/core/owchecks.ts';
import type { CheckedAt } from '../src/core/worldcheck.ts';
import { levelName } from '../src/core/levelnames.ts';
import { eventPhrase } from '../src/ui/owrefusal.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const image = await editorImage();
const N = 0x105, TL = 0x29; // Yoshi's Island 1, its translevel
const E = 0x6e; // an event no level exit runs in the clean game (it changes nothing)
const show = (r: EventRunner | undefined) => (r ? `${hx(r.tl)}/${r.exit}${r.overworld ? ` (exit to overworld of ${hx(r.overworld.level, 3)}, base ${hx(r.overworld.base)})` : ''}` : 'none');

// a copy of the ROM with an exit to the overworld of level `level` (o: its settings), taken by a new screen exit of
// that level when `used`
function withExit(o: Partial<OverworldExit>, level = N, used = true, from = image): Rom {
  const rom = new Rom(from.slice()), idx = new ExitGraph(rom).freeEntrance()!;
  writeSecondaryEntrance(rom, idx, { ...readSecondaryEntrance(rom, idx), destLevel: level, overworld: { ...newOverworldExit(), ...o } });
  if (used) {
    const lv = loadLevel(rom, level);
    lv.exits = [...lv.exits.filter((x) => x.screen !== 1), { uid: 0, screen: 1, dest: idx, secondary: true, flags: EXIT_NEW | 2 | (idx >> 8) }];
    saveLevel(rom, lv);
  }
  return rom;
}

// ---- the clean game: no level exit runs event 6E ----
{
  const rom = new Rom(image.slice());
  check(!eventRunners(rom).has(E) && eventWords(eventRunners(rom), E, (tl) => levelName(rom, tl)) === `Event ${hx(E)} (run by no level exit)`,
    `the clean game: event ${hx(E)} run by no level exit`);
}

// ---- an exit to the overworld of level 105 with base event 6E, the normal exit ----
{
  const rom = withExit({ action: OW_NORMAL, ownEvent: 1, event: E }), runners = eventRunners(rom), r = runners.get(E)?.[0];
  check(!!r && r.tl === TL && r.exit === 0 && r.overworld?.level === N && r.overworld.base === E && r.tile === readTranslevels(rom).indexOf(TL),
    `event ${hx(E)} run by ${show(r)}: Yoshi's Island 1's tile`);
  const title = eventTitle(runners, E), words = eventWords(runners, E, (tl) => levelName(rom, tl));
  check(title === 'Level 105 · exit to overworld (normal exit)', `its title: "${title}"`);
  check(words === `${levelName(rom, TL)} · exit to overworld (normal exit)`, `in the player's words: "${words}"`);
  const strip = playthroughStrip(runners, (tl) => levelName(rom, tl))[E + 1];
  check(strip.label === words && strip.number === hx(E), `the strip: "${strip.label}" (${strip.number})`);
  const name = eventNames(rom).get(E);
  check(name === `105 ${levelName(rom, TL)} – exit to overworld (normal exit)`, `in the base event list: "${name}"`);
  check(eventPhrase(rom, E) === 'the exit to overworld (normal exit) of Yoshi\'s Island 1', `the refusals: "${eventPhrase(rom, E)}"`);
  // the level tile's own exits: still its base event's, the exit to the overworld's event none of them
  const own = exitChanges(rom, TL);
  check(own.some((c) => c.exit === 0 && c.event === baseEvent(rom, TL)) && !own.some((c) => c.event === E),
    `Yoshi's Island 1's exits: events ${own.map((c) => `${hx(c.event)}/${c.exit}`).join(' ')}, not ${hx(E)}`);
  check(runners.get(baseEvent(rom, TL))?.[0].overworld === undefined, 'its base event still run by the tile\'s normal exit first');
  // shown where the tile's base event is: the submap of Yoshi's Island 1's tile, the path from it
  const views = submapViews(new OverworldLoads(new OverworldEmulator(rom), 4));
  const at = eventPlace(runners, views, E, 0), tile = eventPlace(runners, views, baseEvent(rom, TL), 0);
  check(JSON.stringify(at) === JSON.stringify(tile) && !!at.from, `shown as Yoshi's Island 1's event: ${JSON.stringify(at.from)}`);

  // the save after event 6E (emulated): left through the exit, the game runs and counts it, the level passed
  const clean = progressSaves(new OverworldLoads(new OverworldEmulator(new Rom(image.slice())), 4));
  const saves = progressSaves(new OverworldLoads(new OverworldEmulator(rom), 4));
  const counted = (s: typeof saves) => s[E + 1].eventsTriggered - s[E].eventsTriggered;
  check(counted(saves) === 1 && counted(clean) === 0 && (saves[E + 1].levelFlags[TL] & FLAG.passed) !== 0,
    `the save after event ${hx(E)}: counted by the game (${counted(saves)}; the clean game's ${counted(clean)}), Yoshi's Island 1 passed (flags ${hx(saves[E + 1].levelFlags[TL])})`);
}

// ---- its secret exit: base event + 1 ----
{
  const rom = withExit({ action: OW_SECRET, ownEvent: 1, event: E }), runners = eventRunners(rom), r = runners.get(E + 1)?.[0];
  check(!!r && r.tl === TL && r.exit === 1 && r.overworld?.base === E && !runners.has(E) && eventTitle(runners, E + 1) === 'Level 105 · exit to overworld (secret exit 1)',
    `secret exit: event ${hx(E + 1)} run by ${show(r)}: "${eventTitle(runners, E + 1)}"`);
}

// ---- none: doing nothing, no screen exit taking it, the tile's base event ----
{
  check(!eventRunners(withExit({ action: OW_NOTHING, ownEvent: 1, event: E })).has(E), 'an exit doing nothing runs no event');
  check(!eventRunners(withExit({ action: OW_NORMAL, ownEvent: 1, event: E }, N, false)).has(E), 'an exit no screen exit takes runs no event');
  const rom = withExit({ action: OW_SECRET }), b = baseEvent(rom, TL);
  check(!(eventRunners(rom).get(b + 1) ?? []).some((r) => r.overworld), `an exit with the tile's base event: its secret exit the level's own (${show(eventRunners(rom).get(b + 1)?.[0])})`);
}

// ---- in a sub-level: named by its own level, run from the translevel it is played from ----
{
  const rom = new Rom(image.slice()), g = new ExitGraph(rom);
  const tls = readTranslevels(rom);
  // a sub-level of a level with a tile (not a main level itself)
  let sub = -1, from = -1;
  for (const tl of [...new Set(tls)].filter((t) => t).sort((a, b) => a - b)) {
    const m = g.reachedFrom(translevelToLevel(tl)).find((x) => mainTranslevel(x) === null);
    if (m !== undefined) { sub = m; from = tl; break; }
  }
  const r2 = withExit({ action: OW_NORMAL, ownEvent: 1, event: E }, sub), runners = eventRunners(r2), r = runners.get(E)?.[0];
  check(sub >= 0 && !!r && r.overworld?.level === sub && new ExitGraph(r2).reachedFrom(translevelToLevel(r.tl)).includes(sub) && r.tl === from,
    `level ${hx(sub, 3)} (played from translevel ${hx(from)}): event ${hx(E)} run by ${show(r)}, "${eventTitle(runners, E)}"`);
  check(eventTitle(runners, E) === `Level ${hx(sub, 3)} · exit to overworld (normal exit)`, `named by its own level: "${eventTitle(runners, E)}"`);
  const main = translevelToLevel(from), name = eventNames(r2).get(E);
  check(name === `${hx(sub, 3)} (from ${hx(main, 3)} ${levelName(r2, from)}) – exit to overworld (normal exit)`, `in the base event list: "${name}"`);
}

// ---- without an event: the way the level's normal exit opens stays open where the same exit runs another event ----
{
  const without = (rom: Rom, e: number, tl: number) => {
    const all = { l1: readL1(rom), flags: new Uint8Array(0x60).fill(0xff) } as unknown as ReachInput;
    return inputWithout(rom, all, eventChanges(rom)(e), eventRunners(rom).get(e) ?? [], readL1(rom)).flags[tl];
  };
  // (a level whose normal exit's way no other exit of it opens: without its base event closed)
  const clean = new Rom(image.slice());
  const tl = [...new Set(readTranslevels(clean))].filter((t) => t).sort((x, y) => x - y).find((t) => eventRunners(clean).get(baseEvent(clean, t))?.[0].tl === t && without(clean, baseEvent(clean, t), t) !== 0xff)!;
  const b = baseEvent(clean, tl), rom = withExit({ action: OW_NORMAL, ownEvent: 1, event: E }, translevelToLevel(tl));
  check(!!tl && without(clean, b, tl) !== 0xff, `the clean game without event ${hx(b)}: translevel ${hx(tl)}'s normal exit's way closed (flags ${hx(without(clean, b, tl))})`);
  check(without(rom, b, tl) === 0xff && without(rom, E, tl) === 0xff,
    `with an exit to the overworld running ${hx(E)} by its normal exit: open without ${hx(b)} (${hx(without(rom, b, tl))}) and without ${hx(E)} (${hx(without(rom, E, tl))})`);
}

// ---- the World check: event 77 changing the map, run by an exit to the overworld – not reported never run ----
{
  const e = 0x77, cell = l1Index(1, 0, 0);
  const changing = (r: Rom) => { const d = readEvents(r); d.silent[e].push({ layer: 1, tile: 0x66, loc: cell }); writeEvents(r, d); return r; };
  // (eventsNeverRun reads only the events and their runners, not the search)
  const never = (r: Rom) => eventsNeverRun(checkContext(r, null as unknown as CheckedAt, String)).some((p) => p.key === `event-never-run:${e}`);
  const plain = changing(new Rom(image.slice()));
  check(eventChanges(plain)(e).l1.length > 0 && never(plain), `event ${hx(e)} changing the map: never run`);
  check(!never(changing(withExit({ action: OW_NORMAL, ownEvent: 1, event: e }))), `with an exit to the overworld of 105 running it: not reported`);
  check(never(changing(withExit({ action: OW_NORMAL, ownEvent: 1, event: e }, N, false))), `one no screen exit takes: still never run`);
}

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
