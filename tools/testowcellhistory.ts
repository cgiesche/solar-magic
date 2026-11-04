// A cell's history over the game (owcellhistory.ts, #359) on the editor's test ROM: layer 1 through the events as the
// model has it is the game's at every event progress (emulated); Iggy's castle's top destroyed by its event, the castle's
// level tile revealed by Yoshi's Island 4's event and changed by the destroy, the tile Yoshi's Island 2's event reveals,
// a cell its layer 2 steps cover; level tiles placed and removed told with the path kinds.
// node tools/testowcellhistory.ts
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, gameL1, readL1, l1Index, OW_EVENTS } from '../src/core/overworld.ts';
import { readEvents, eventPieces, pieceTiles } from '../src/core/owevents.ts';
import { cellHistory, historyWords, layer1AtProgress } from '../src/core/owcellhistory.ts';
import { levelTileTest } from '../src/core/owpaths.ts';
import { editorImage, pathKinds } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

const rom = new Rom(await editorImage()), d = readEvents(rom), isLevel = levelTileTest(pathKinds(rom));

// ---- the model's layer 1 is the game's at every event progress ----
{
  const emu = new OverworldEmulator(rom), off: string[] = [];
  for (let n = 0; n <= OW_EVENTS; n++) {
    const game = gameL1(emu.load(0, n)), mine = layer1AtProgress(rom, n, d);
    const diff = [...game.keys()].filter((i) => game[i] !== mine[i]);
    if (diff.length) off.push(`${hx(n)}: ${diff.length} (${diff.slice(0, 3).map((i) => `${i.toString(16)} ${game[i].toString(16)}/${mine[i].toString(16)}`).join(', ')})`);
  }
  check(!off.length, `layer 1 through the events as the game loads it, every progress 00–${hx(OW_EVENTS)}${off.length ? `: ${off.slice(0, 6).join('; ')}` : ''}`);
  check(layer1AtProgress(rom, 0, d).every((v, i) => v === readL1(rom)[i]), 'progress 0: the map before events');
}

// ---- cells ----
const IGGY = 6, YI4 = 5, YI2 = 3, top = l1Index(1, 9, 1), castle = l1Index(1, 9, 2), bridge = l1Index(1, 9, 6);
const words = (h: ReturnType<typeof cellHistory>) => `${hx(h.before)} ${h.changes.map((c) => `→ ${hx(c.event)}:${c.l1 ? `${hx(c.l1.to)} by ${c.l1.by}` : ''}${c.l2 ? ' l2' : ''}${c.level ? ` level ${c.level}` : ''}`).join(' ')}`;
{
  const h = cellHistory(rom, top, isLevel, d);
  const e = h.changes.find((c) => c.event === IGGY);
  check(h.before === 0x4c && !!e?.l1 && e.l1.from === 0x4c && e.l1.by.includes('destroy'), `Iggy's castle's top: 4C destroyed by event 06 (${words(h)})`);
}
{
  const h = cellHistory(rom, castle, isLevel, d);
  const rev = h.changes.find((c) => c.event === YI4), des = h.changes.find((c) => c.event === IGGY);
  check(!!rev?.l1?.by.includes('reveal') && rev.l1.from === rev.l1.to && !rev.level, `the castle's level tile: revealed by Yoshi's Island 4's event, the tile kept (not in the reveal list) (${words(h)})`);
  check(!!des?.l1?.by.includes('destroy') && des.level === 'removed', 'the castle\'s level tile: destroyed by Iggy\'s castle\'s event, no level tile after it');
  const evs = h.changes.map((c) => c.event);
  check(evs.every((e, k) => !k || e > evs[k - 1]), 'in number order, each event once');
}
{
  const h = cellHistory(rom, bridge, isLevel, d);
  const rev = h.changes.find((c) => c.event === YI2);
  check(h.before === 0x6e && rev?.l1?.to === 0x66 && rev.l1.by.join() === 'reveal', `Yoshi's Island 2's event reveals 09,06: 6E → 66 (${words(h)})`);
}
{
  // a cell under one of Yoshi's Island 2's layer 2 steps (a changed entry)
  const l2 = pieceTiles(d, eventPieces(d, YI2)[0])[0], r = l2 >> 12, k = l2 & 0xfff, q = k >> 10;
  const x = ((q & 1) * 32 + (k & 31)) >> 1, y = ((q >> 1) * 32 + ((k >> 5) & 31)) >> 1;
  const h = cellHistory(rom, l1Index(r, x, y), isLevel, d);
  check(h.changes.some((c) => c.event === YI2 && c.l2), `a cell under Yoshi's Island 2's first step: layer 2 changed by event 03 (${words(h)})`);
}
{
  // in the player's words, each entry with its event to jump to
  const w = historyWords(cellHistory(rom, castle, isLevel, d), (t) => hx(t), (e) => `event ${hx(e)}`);
  check(w[0].event === -1 && w[0].text === '5D (before events)', `before events: ${w[0].text}`);
  check(w.some((x) => x.event === YI4 && x.text === 'revealed (5D stays) (event 05)'), `the reveal: ${w.find((x) => x.event === YI4)?.text}`);
  check(w.some((x) => x.event === IGGY && x.text === 'destroyed: 81, no level tile, layer 2 too (event 06)'), `the destroy: ${w.find((x) => x.event === IGGY)?.text}`);
}
{
  const h = cellHistory(rom, l1Index(0, 0, 0), isLevel, d);
  check(h.changes.length === 0, `a cell no event changes: none (${words(h)})`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
