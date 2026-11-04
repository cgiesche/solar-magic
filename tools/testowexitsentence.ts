// What passing a level does, a sentence per exit (owexitsentence.ts, #361), on the editor's test ROM: Yoshi's Island
// 4's exit opens Iggy's castle (it reveals its level tile), Iggy's castle crumbles (its event destroys its top, the
// level tile below it), Yoshi's Island 2's exit opens Yoshi's Island 3 (6E at 09,06 revealed as 66), a tile entering no
// level revealed is told as the tile it becomes; each reveal and destroy clause names
// its cells and what removes it; an exit to the overworld teleporting is told with the exit it passes.
// node tools/testowexitsentence.ts
import { Rom } from '../src/core/rom.ts';
import { l1Index, readTranslevels } from '../src/core/overworld.ts';
import { eventRunners, eventPieces, readEvents } from '../src/core/owevents.ts';
import { exitSentences, type ExitSentence } from '../src/core/owexitsentence.ts';
import { levelTileTest } from '../src/core/owpaths.ts';
import { addReveal, removeReveal, eventReveal } from '../src/core/oweventtiles.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { levelName } from '../src/core/levelnames.ts';
import { OW_NORMAL, OW_SECRET, OW_END_TURN } from '../src/core/level.ts';
import { editorImage, pathKinds } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

const rom = new Rom(await editorImage()), isLevel = levelTileTest(pathKinds(rom)), runners = eventRunners(rom), tls = readTranslevels(rom);
const words = { level: (tl: number) => levelName(rom, tl), tile: (t: number) => hx(t) };
const tlOf = (e: number) => runners.get(e)![0].tl;
const say = (s: ExitSentence[]) => s.map((x) => `${x.exit}: ${x.clauses.map((c) => c.text).join(' · ') || 'opens nothing yet'}`).join(' | ');

const IGGY = 6, YI4 = 5, YI2 = 3, top = l1Index(1, 9, 1), castle = l1Index(1, 9, 2), bridge = l1Index(1, 9, 6);
const iggy = levelName(rom, tls[castle]);
{
  const s = exitSentences(rom, tlOf(YI4), words, [], isLevel), n = s.find((x) => x.event === YI4)!;
  const c = n.clauses.find((x) => x.kind === 'opens');
  check(c?.text === `opens ${iggy}` && c.l1.join() === String(castle) && c.remove?.kind === 'reveal' && c.remove.tile === castle,
    `Yoshi's Island 4's normal exit opens Iggy's castle, its level tile revealed (${say(s)})`);
  check(c === n.clauses[0], 'the level opened first');
}
{
  const s = exitSentences(rom, tlOf(IGGY), words, [], isLevel), n = s.find((x) => x.event === IGGY)!;
  const c = n.clauses.find((x) => x.kind === 'destroy');
  check(c?.text === `${iggy} crumbles` && c.l1.includes(top) && c.l1.includes(castle) && c.remove?.kind === 'destroy' && c.remove.tile === top,
    `Iggy's castle's exit: it crumbles, its top and level tile outlined (${say(s)})`);
}
{
  const s = exitSentences(rom, tlOf(YI2), words, [], isLevel), n = s.find((x) => x.event === YI2)!;
  const c = n.clauses.find((x) => x.kind === 'opens');
  check(c?.text === `opens ${levelName(rom, tls[bridge])}` && c.l1.join() === String(bridge), `Yoshi's Island 2's exit opens the next level, its tile 6E at 09,06 revealed as 66 (${say(s)})`);
  const m = n.clauses.find((x) => x.kind === 'map');
  check(!!m && m.l2.length > 0 && !m.l1.includes(bridge), `and changes the map with its steps, the revealed tile told once (${m?.text})`);
}
{
  // a reveal of a tile entering no level: told as the tile it becomes (Yoshi's Island 2's event made to reveal 04,04
  // of the main map); taken away by its clause's remove, one ROM edit: the clause gone
  const r = new Rom(rom.data.slice()), at = l1Index(0, 4, 4);
  removeReveal(r, YI2);
  addReveal(r, YI2, at, 0x66);
  const n = exitSentences(r, tlOf(YI2), words, [], isLevel).find((x) => x.event === YI2)!;
  const c = n.clauses.find((x) => x.kind === 'reveal');
  check(c?.text === 'the tile at main map 04,04 becomes 66' && c.remove?.tile === at && !n.clauses.some((x) => x.kind === 'opens'), `a tile entering no level revealed: ${say([n])}`);
  const s = new RomEditSession(r);
  s.edit('no reveal', () => removeReveal(r, YI2), { key: null });
  const after = exitSentences(r, tlOf(YI2), words, [], isLevel).find((x) => x.event === YI2)!;
  check(s.history.undoStack.length === 1 && !after.clauses.some((x) => x.kind === 'reveal'), `removed: one ROM edit, the clause gone (${say([after])})`);
}
{
  // without the path kinds a revealed level tile is told as revealed
  const n = exitSentences(rom, tlOf(YI4), words).find((x) => x.event === YI4)!;
  check(n.clauses.some((x) => x.kind === 'reveal') && !n.clauses.some((x) => x.kind === 'opens'), 'the path kinds not known: the level tile told as a reveal');
}
{
  // teleports by the exit they pass the level with
  const to = { submap: 0, x: 0x0c, y: 0x09 };
  const t = (action: number) => ({ location: 1, to, entrance: 0x1a, action });
  const s = exitSentences(rom, tlOf(YI2), words, [t(OW_NORMAL), t(OW_SECRET), t(OW_END_TURN)], isLevel);
  const go = (exit: number) => s.find((x) => x.exit === exit)?.clauses.filter((c) => c.kind === 'teleport').map((c) => c.text) ?? [];
  check(go(0).join() === 'Mario goes to Main map 0C,09', `the normal exit's teleport: ${go(0)}`);
  check(s.every((x) => x.clauses.filter((c) => c.kind === 'teleport').length <= 1), 'an exit ending the turn: on no exit');
}
{
  // every level: a sentence per exit whose event is the level's; those doing nothing have no clauses
  const all = [...new Set([...runners.values()].map((r) => r[0].tl))].map((tl) => exitSentences(rom, tl, words, [], isLevel));
  const none = all.flat().filter((x) => !x.clauses.length);
  check(none.every((x) => !eventPieces(readEvents(rom), x.event).length && eventReveal(rom, x.event) < 0), 'those opening nothing yet: their events change nothing');
  check(all.flat().length > 0 && all.flat().every((x) => x.clauses.every((c) => c.text)), `every level's exits: ${all.flat().length} sentences, ${none.length} opening nothing yet${none.length ? ` (e.g. event ${hx(none[0].event)})` : ''}`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
