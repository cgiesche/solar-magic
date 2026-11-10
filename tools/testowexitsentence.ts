// What passing a level does, a sentence per exit (owexitsentence.ts, #361), on the editor's test ROM: Yoshi's Island
// 4's exit opens Iggy's castle (it reveals its level tile), Iggy's castle crumbles (its event destroys its top, the
// level tile below it), Yoshi's Island 2's exit opens Yoshi's Island 3 (6E at 09,06 revealed as 66), a tile entering no
// level revealed is told as the tile it becomes; each reveal and destroy clause names
// its cells and what removes it; an exit to the overworld teleporting is told with the exit it passes. The levels opened
// come from the exits' edges (owexitedges.ts, #375): for every exit of the clean game the sentence names exactly the
// levels its arrows point to, by the cheap rule (exitEdges) and by the probe worker's (passableEdgesJob,
// #380).
// node tools/testowexitsentence.ts
import { Rom } from '../src/core/rom.ts';
import { l1Index, readTranslevels, OverworldEmulator, OverworldLoads, setRevealAt } from '../src/core/overworld.ts';
import { eventRunners, eventChanges, submapViews, submapOf } from '../src/core/owevents.ts';
import { exitEdges, passableEdgesJob, type ExitEdge } from '../src/core/owexitedges.ts';
import { progressSaves, progressSearches, progressInput, progressMapsFromEvents } from '../src/core/owprogress.ts';
import { ExitGraph } from '../src/core/exitgraph.ts';
import { exitSentences, type ExitSentence } from '../src/core/owexitsentence.ts';
import { addReveal, removeReveal } from '../src/core/oweventtiles.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { levelName } from '../src/core/levelnames.ts';
import { OW_NORMAL, OW_SECRET, OW_END_TURN } from '../src/core/level.ts';
import { editorImage, pathKinds, pathShapes, hardWalks } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

const rom = new Rom(await editorImage()), runners = eventRunners(rom), tls = readTranslevels(rom);
// the exits' edges as the layer 1 mode's arrows find them (the maps at every progress built from the events, the saves' level
// flags as the probe worker learns them)
const loads = new OverworldLoads(new OverworldEmulator(rom), 4), views = submapViews(loads);
const maps = progressMapsFromEvents(rom, progressSaves(loads).map((s) => s.levelFlags));
const edges = exitEdges(rom, progressSearches(progressInput(rom, maps, pathKinds(rom), pathShapes(rom), hardWalks(rom), new ExitGraph(rom))), (i) => submapOf(views, i));
const words = { level: (tl: number) => levelName(rom, tl), tile: (t: number) => hx(t) };
const tlOf = (e: number) => runners.get(e)![0].tl;
const say = (s: ExitSentence[]) => s.map((x) => `${x.exit}: ${x.clauses.map((c) => c.text).join(' · ') || 'opens nothing yet'}`).join(' | ');

const IGGY = 6, YI4 = 5, YI2 = 3, top = l1Index(1, 9, 1), castle = l1Index(1, 9, 2), bridge = l1Index(1, 9, 6);
const iggy = levelName(rom, tls[castle]);
{
  const s = exitSentences(rom, tlOf(YI4), words, [], edges), n = s.find((x) => x.event === YI4)!;
  const c = n.clauses.find((x) => x.kind === 'opens');
  // (its event reveals the castle's tile as it is – #391: nothing to take away)
  check(c?.text === `opens ${iggy}` && c.l1.join() === String(castle) && !c.remove,
    `Yoshi's Island 4's normal exit opens Iggy's castle, its tile revealed as it is not offered to take away (${say(s)})`);
  check(c === n.clauses[0], 'the level opened first');
}
{
  const s = exitSentences(rom, tlOf(IGGY), words, [], edges), n = s.find((x) => x.event === IGGY)!;
  const c = n.clauses.find((x) => x.kind === 'destroy');
  check(c?.text === `${iggy} crumbles` && c.l1.includes(top) && c.l1.includes(castle) && c.remove?.kind === 'destroy' && c.remove.tile === top,
    `Iggy's castle's exit: it crumbles, its top and level tile outlined (${say(s)})`);
}
{
  const s = exitSentences(rom, tlOf(YI2), words, [], edges), n = s.find((x) => x.event === YI2)!;
  const c = n.clauses.find((x) => x.kind === 'opens');
  check(c?.text === `opens ${levelName(rom, tls[bridge])}` && c.l1.join() === String(bridge), `Yoshi's Island 2's exit opens the next level, its tile 6E at 09,06 revealed as 66 (${say(s)})`);
  const m = n.clauses.find((x) => x.kind === 'map');
  check(!!m && m.l2.length > 0 && !m.l1.includes(bridge), `and changes the map with its steps, the revealed tile told once (${m?.text})`);
}
{
  // a reveal of a tile entering no level: told as the tile it becomes (Yoshi's Island 2's event made to reveal 04,04
  // of the main map; the level it opens told without the reveal); taken away by its clause's remove, one ROM edit: the
  // clause gone
  const r = new Rom(rom.data.slice()), at = l1Index(0, 4, 4);
  removeReveal(r, YI2);
  addReveal(r, YI2, at, 0x66);
  const n = exitSentences(r, tlOf(YI2), words, [], edges).find((x) => x.event === YI2)!;
  const c = n.clauses.find((x) => x.kind === 'reveal');
  check(c?.text === 'the tile at main map 04,04 becomes 66' && c.remove?.tile === at && !n.clauses.some((x) => x.kind === 'opens' && (x.remove || x.l1.includes(at))), `a tile entering no level revealed: ${say([n])}`);
  const s = new RomEditSession(r);
  s.edit('no reveal', () => removeReveal(r, YI2), { key: null });
  const after = exitSentences(r, tlOf(YI2), words, [], edges).find((x) => x.event === YI2)!;
  check(s.history.undoStack.length === 1 && !after.clauses.some((x) => x.kind === 'reveal'), `removed: one ROM edit, the clause gone (${say([after])})`);
}
{
  // #391: an exit opening nothing yet whose event is made to reveal main 00,01 (tile 000, not in the reveal list: it
  // stays) still opens nothing yet; made to reveal 04,04 as 66 it tells the reveal
  const [tl, x] = [...new Set(tls)].filter((t) => t).flatMap((t) => exitSentences(rom, t, words, [], edges).map((x) => [t, x] as const))
    .find(([, x]) => !x.clauses.length)!;
  const r = new Rom(rom.data.slice());
  setRevealAt(r, x.event, l1Index(0, 0, 1));
  const n = exitSentences(r, tl, words, [], edges).find((y) => y.exit === x.exit)!;
  check(!n.clauses.length, `event ${hx(x.event)} revealing main map 00,01 (tile 000 stays): opens nothing yet (${say([n])})`);
  setRevealAt(r, x.event, 0);
  addReveal(r, x.event, l1Index(0, 4, 4), 0x66);
  const m = exitSentences(r, tl, words, [], edges).find((y) => y.exit === x.exit)!;
  check(m.clauses.some((c) => c.kind === 'reveal'), `revealing 04,04 as 66 told (${say([m])})`);
}
{
  // without the edges (learned) a revealed level tile is told as revealed (Yoshi's Island 2's 6E becoming 66; Iggy's
  // castle's tile, which Yoshi's Island 4's event reveals as it is, not – #391)
  const n = exitSentences(rom, tlOf(YI2), words).find((x) => x.event === YI2)!;
  check(n.clauses.some((x) => x.kind === 'reveal' && x.l1.includes(bridge)) && !n.clauses.some((x) => x.kind === 'opens'), 'the edges not known: the level tile told as a reveal');
  const c = exitSentences(rom, tlOf(YI4), words).find((x) => x.event === YI4)!;
  check(!c.clauses.some((x) => x.kind === 'reveal' || x.kind === 'opens'), `nor Iggy's castle's tile revealed as it is (${say([c])})`);
}
{
  // teleports by the exit they pass the level with
  const to = { submap: 0, x: 0x0c, y: 0x09 };
  const t = (action: number) => ({ location: 1, to, entrance: 0x1a, action });
  const s = exitSentences(rom, tlOf(YI2), words, [t(OW_NORMAL), t(OW_SECRET), t(OW_END_TURN)], edges);
  const go = (exit: number) => s.find((x) => x.exit === exit)?.clauses.filter((c) => c.kind === 'teleport').map((c) => c.text) ?? [];
  check(go(0).join() === 'Mario goes to Main map 0C,09', `the normal exit's teleport: ${go(0)}`);
  check(s.every((x) => x.clauses.filter((c) => c.kind === 'teleport').length <= 1), 'an exit ending the turn: on no exit');
}
{
  // every level: a sentence per exit whose event is the level's; those doing nothing have no clauses
  const all = [...new Set([...runners.values()].map((r) => r[0].tl))].map((tl) => exitSentences(rom, tl, words, [], edges));
  const none = all.flat().filter((x) => !x.clauses.length);
  const changes = eventChanges(rom);
  check(none.every((x) => !changes(x.event).l1.length && !changes(x.event).l2.length), 'those opening nothing yet: their events change nothing');
  check(all.flat().length > 0 && all.flat().every((x) => x.clauses.every((c) => c.text)), `every level's exits: ${all.flat().length} sentences, ${none.length} opening nothing yet${none.length ? ` (e.g. event ${hx(none[0].event)})` : ''}`);
}

// every exit of the clean game: the levels the sentence says it opens are exactly those its arrows point to – by
// the cheap rule (exitEdges) and by the probe worker's (passableEdgesJob: the events still passable without the
// exit, #380)
function sentencesOpen(edges: readonly ExitEdge[], rule: string) {
  const wrong: string[] = [];
  let told = 0;
  for (const e of edges) {
    const n = exitSentences(rom, e.tl, words, [], edges).find((x) => x.exit === e.exit && x.event === e.event);
    const said = n?.clauses.filter((c) => c.kind === 'opens').map((c) => c.text) ?? [];
    told += said.length;
    if (!n || said.join() !== e.opens.map((o) => `opens ${words.level(o.tl)}`).join()) wrong.push(`${hx(e.tl)}/${e.exit}: ${said.join(', ') || 'nothing'}`);
  }
  check(!wrong.length && told === edges.reduce((k, e) => k + e.opens.length, 0) && told > 0,
    `${rule}: every exit's sentence opens the levels of its arrows (${edges.length} exits, ${told} levels${wrong.length ? `; wrong: ${wrong.join(' | ')}` : ''})`);
}
sentencesOpen(edges, 'the cheap rule (exitEdges)');
{
  const job = passableEdgesJob(rom, loads, pathKinds(rom), pathShapes(rom), hardWalks(rom));
  let st = job.next();
  while (!st.done) st = job.next();
  const differ = st.value.filter((e) => edges.find((x) => x.tl === e.tl && x.exit === e.exit)?.opens.map((o) => o.tl).join() !== e.opens.map((o) => o.tl).join());
  // (the two rules differ on the clean game – #380's exits – so the sentences follow the edges they are given)
  check(differ.length > 0, `the worker's edges differ from the cheap rule's at ${differ.length} exits`);
  sentencesOpen(st.value, 'the worker\'s rule (passableEdgesJob)');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
