// A change moved to another event from a cell's history (owmovechange.ts, #360) on the editor's test ROM: Iggy's
// castle's event's path section (layer 1 changes, main map 05,13–17) moved later, earlier and into the map before
// events, with its connected cells or (single) one; a reveal and a destroy moved, refused where the target event
// already has one; refused where another event changes a cell in between or at the target. After every move allowed
// the map is as before at every event progress outside the two events, the cells moved hold there the tile they had
// (so the map with every event passed is unchanged), and the game shows it (emulated, as testowcellhistory); one undo
// step restores the ROM.
// node tools/testowmovechange.ts
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { OverworldEmulator, gameL1, readL1, l1Index, l1XY, revealAt, readDestroyList, revealEventCount, OW_EVENTS } from '../src/core/overworld.ts';
import { readEvents, eventPieces, pieceTiles } from '../src/core/owevents.ts';
import { layer1AtEveryProgress, cellHistory } from '../src/core/owcellhistory.ts';
import { planMove, moveChange, BEFORE_EVENTS, type MoveAsk, type MovePlan } from '../src/core/owmovechange.ts';
import { refusalOf } from '../src/core/owrefusal.ts';
import { levelTileTest } from '../src/core/owpaths.ts';
import { editorImage, pathKinds } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const at = (i: number) => { const p = l1XY(i); return `${i >= 0x400 ? 's' : 'm'}${hx(p.x)},${hx(p.y)}`; };
const ev = (e: number) => (e < 0 ? 'before events' : hx(e));

const image = await editorImage();
const IGGY = 6, section = [0x13, 0x14, 0x15, 0x16, 0x17].map((y) => l1Index(0, 5, y)), mid = l1Index(0, 5, 0x15);

// moves `ask` on a copy of the ROM (or `rom`): the plan, and whether the map is as before at every progress outside
// the two events and the cells moved hold there the tile they had before the source event (moved earlier: after it)
function moved(ask: MoveAsk, rom = new Rom(image.slice())): { rom: Rom; plan: MovePlan; off: string[] } {
  const was = layer1AtEveryProgress(rom), plan = moveChange(rom, ask), now = layer1AtEveryProgress(rom), off: string[] = [];
  const { from: s, to: t } = plan, cells = new Set(plan.cells);
  // the progresses whose map changes: later, those after s up to t (the tile before s); earlier, those after t up to s
  // (the tile after s)
  const [lo, hi, keep] = t > s ? [s + 1, t, was[s]] : [t + 1, s, was[s + 1]];
  for (let p = 0; p <= OW_EVENTS; p++) {
    for (let i = 0; i < 0x800; i++) {
      const want = cells.has(i) && p >= lo && p <= hi ? keep[i] : was[p][i];
      if (now[p][i] !== want) { off.push(`${hx(p)} ${at(i)} ${now[p][i].toString(16)}≠${want.toString(16)}`); break; }
    }
  }
  return { rom, plan, off };
}
const refused = (ask: MoveAsk, rom = new Rom(image.slice())) => {
  const was = rom.data.slice(), plan = planMove(rom, ask);
  let thrown: unknown = null;
  try { moveChange(rom, ask); } catch (e) { thrown = e; }
  return { plan, thrown: refusalOf(thrown), same: rom.data.every((v, i) => v === was[i]) };
};
const says = (r: { plan: MovePlan; thrown: unknown; same: boolean }) => JSON.stringify(r.plan.refusal);

// ---- a layer 1 path section ----
{
  const p = planMove(new Rom(image.slice()), { cell: mid, from: IGGY, to: 0x20 });
  check(p.cells.join() === section.join() && p.steps.length === 5 && p.reveal < 0 && !p.destroys.length && !p.refusal,
    `Iggy's castle's event, main map 05,15: the connected cells it changes move (${p.cells.map(at).join(' ')}), not 05,11 – layer 2 under them: ${p.layer2}`);
  const one = planMove(new Rom(image.slice()), { cell: mid, from: IGGY, to: 0x20, single: true });
  check(one.cells.join() === String(mid) && one.steps.join() === String(mid), 'single (Alt): that cell only');
  // (the submap test: a submap function cutting the section)
  const cut = planMove(new Rom(image.slice()), { cell: mid, from: IGGY, to: 0x20, submap: (i) => (l1XY(i).y > 0x15 ? 9 : 0) });
  check(cut.cells.map(at).join(' ') === 'm05,13 m05,14 m05,15', `connected on the same submap only: ${cut.cells.map(at).join(' ')}`);
}
for (const [to, single] of [[0x20, false], [0x01, false], [BEFORE_EVENTS, false], [0x20, true], [0x77, false]] as [number, boolean][]) {
  const { rom, plan, off } = moved({ cell: mid, from: IGGY, to, single });
  check(!off.length && plan.cells.length === (single ? 1 : 5), `the section moved from 06 to ${ev(to)}${single ? ' (single)' : ''}: ${plan.cells.length} cells, the maps as before outside the two, the map with every event passed unchanged${off.length ? ` – ${off.slice(0, 4).join('; ')}` : ''}`);
  const h = cellHistory(rom, mid), d = readEvents(rom);
  check(to < 0 ? h.before === layer1AtEveryProgress(new Rom(image.slice()))[IGGY + 1][mid] && !h.changes.some((c) => c.event === IGGY && c.l1)
    : h.changes.some((c) => c.event === to && c.l1?.by.includes('tiles')) && !d.silent[IGGY].some((x) => x.layer === 1 && x.loc === mid),
  `its history: ${to < 0 ? 'the tile before events' : `changed by ${ev(to)}`}, not by 06 (${hx(h.before)} ${h.changes.map((c) => `${hx(c.event)}${c.l1 ? `:${c.l1.to.toString(16)}` : ''}`).join(' ')})`);
  if (to === 0x20 && !single) {
    const end = cellHistory(rom, section[4], levelTileTest(pathKinds(rom))).changes.find((c) => c.event === 0x20);
    check(end?.level === 'removed', `the level tile at 05,17 the section's end removes: removed by event 20 now (${end?.level})`);
  }
  if (to === 0x20) {
    // the game shows it at the target event (emulated): the tile before event 06 up to it, the tile after it from then on
    const was = layer1AtEveryProgress(new Rom(image.slice())), emu = new OverworldEmulator(rom), cells = plan.cells;
    const g = (n: number) => gameL1(emu.load(0, n));
    const before = g(0x20), after = g(0x21), atSix = g(IGGY + 1);
    check(cells.every((c) => before[c] === was[IGGY][c] && atSix[c] === was[IGGY][c] && after[c] === was[IGGY + 1][c]),
      `the game (emulated): the cells as before event 06 after 06 and up to 20, as after 06 from event 20 on (${cells.map((c) => `${before[c].toString(16)}→${after[c].toString(16)}`).join(' ')})`);
  }
}
{
  // moving it back to where it was: the ROM's map at every progress as at first
  const { rom } = moved({ cell: mid, from: IGGY, to: 0x20 }), back = moved({ cell: mid, from: 0x20, to: IGGY }, rom);
  const first = layer1AtEveryProgress(new Rom(image.slice())), now = layer1AtEveryProgress(rom);
  check(!back.off.length && now.every((m, p) => m.every((v, i) => v === first[p][i])), 'moved to 20 and back to 06: every progress as at first');
}
{
  // the map before events as a source: not a change an event makes
  let threw = false;
  try { planMove(new Rom(image.slice()), { cell: mid, from: BEFORE_EVENTS, to: 3 }); } catch { threw = true; }
  check(threw, 'the map before events is no source (only an event\'s change moves)');
}

// ---- a reveal, a destroy ----
const YI2 = 3, bridge = l1Index(1, 9, 6);
{
  const rom = new Rom(image.slice()), m = moved({ cell: bridge, from: YI2, to: 0x2f }, rom);
  check(!m.off.length && m.plan.reveal === bridge && revealAt(rom, YI2) === 0 && revealAt(rom, 0x2f) === bridge,
    `Yoshi's Island 2's reveal (submaps 09,06) moved to event 2F: the reveal table says so, the maps as before outside 03–2F${m.off.length ? ` – ${m.off.slice(0, 4).join('; ')}` : ''}`);
  const emu = new OverworldEmulator(rom), was = layer1AtEveryProgress(new Rom(image.slice()));
  check(gameL1(emu.load(0, 0x2f))[bridge] === was[YI2][bridge] && gameL1(emu.load(0, 0x30))[bridge] === was[YI2 + 1][bridge],
    'the game (emulated): the bridge revealed from event 2F on, not before');
  const b = moved({ cell: bridge, from: YI2, to: BEFORE_EVENTS });
  check(!b.off.length && readL1(b.rom)[bridge] === was[YI2 + 1][bridge] && revealAt(b.rom, YI2) === 0, 'the reveal moved into the map before events: the revealed tile there, no reveal');
  const n = revealEventCount(rom);
  if (n < OW_EVENTS) {
    const past = refused({ cell: bridge, from: YI2, to: n });
    check(past.thrown?.kind === 'revealPastTable' && past.same, `to event ${hx(n)}, past the reveal table: ${says(past)}`);
  } else console.log(`(the reveal table has every event: no event past it)`);
  const r = refused({ cell: bridge, from: YI2, to: 7 });
  check(r.thrown?.kind === 'revealTaken' && r.same, `to event 07, which reveals a tile: ${says(r)}, nothing written`);
}
{
  const top = l1Index(0, 1, 0x0d), DEST = 0x28;
  const m = moved({ cell: top, from: DEST, to: 0x2f });
  check(!m.off.length && m.plan.destroys.join() === String(top) && readDestroyList(m.rom).some((x) => x.event === 0x2f && x.tile === top) && !readDestroyList(m.rom).some((x) => x.event === DEST),
    `event 28's destroy (main map 01,0D) moved to 2F: cells ${m.plan.cells.map(at).join(' ')}${m.off.length ? ` – ${m.off.slice(0, 4).join('; ')}` : ''}`);
  const one = planMove(new Rom(image.slice()), { cell: m.plan.cells[m.plan.cells.length - 1], from: DEST, to: 0x2f, single: true });
  check(one.cells.join() === m.plan.cells.join(), 'single: a destroy moves whole');
  const early = refused({ cell: top, from: DEST, to: BEFORE_EVENTS });
  check(early.thrown?.kind === 'moveCrossed' && says(early).includes('"event":10'), `into the map before events, event 0A revealing it before: ${says(early)}`);
  const b = moved({ cell: l1Index(1, 0x17, 4), from: 0x40, to: BEFORE_EVENTS });
  check(!b.off.length && !readDestroyList(b.rom).some((x) => x.event === 0x40), `event 40's destroy (submaps 17,04) moved into the map before events: the destroyed tiles there (${b.plan.cells.map(at).join(' ')}), no destroy`);
  const r = refused({ cell: top, from: DEST, to: 0x29 });
  check(r.thrown?.kind === 'destroyTaken' && r.same, `to event 29, which destroys a tile: ${says(r)}, nothing written`);
}

// ---- refused where another event changes a cell between ----
{
  const c = l1Index(0, 2, 0x11); // event 01 writes 79, event 02 destroys it
  const r = refused({ cell: c, from: 1, to: 3 });
  check(r.thrown?.kind === 'moveCrossed' && says(r).includes('"event":2') && r.same, `event 01's change (main map 02,11) to 03, event 02 destroying it between: ${says(r)}, nothing written`);
  const e = refused({ cell: c, from: 2, to: 0 });
  check(e.thrown?.kind === 'moveCrossed' && says(e).includes('"event":1'), `event 02's destroy earlier than 01's change there: ${says(e)}`);
  const t = refused({ cell: l1Index(0, 1, 0x0d), from: 0x0a, to: 0x28 });
  check(t.thrown?.kind === 'moveCrossed' && says(t).includes(`"event":${0x28}`), `a reveal moved to the event destroying its tile (the target changes it too): ${says(t)}`);
  const ok = moved({ cell: c, from: 1, to: BEFORE_EVENTS });
  check(!ok.off.length, 'event 01\'s change into the map before events (no event changes it before): moved');
}
{
  // a cell whose change is only on layer 2
  const d = readEvents(new Rom(image.slice())), l2 = pieceTiles(d, eventPieces(d, YI2)[0]), hist = layer1AtEveryProgress(new Rom(image.slice()));
  const cells = l2.map((k) => { const r = k >> 12, q = (k & 0xfff) >> 10; return l1Index(r, ((q & 1) * 32 + (k & 31)) >> 1, ((q >> 1) * 32 + ((k >> 5) & 31)) >> 1); });
  const only = cells.find((c) => hist[YI2][c] === hist[YI2 + 1][c] && c !== bridge)!;
  const r = refused({ cell: only, from: YI2, to: 0x2f });
  check(r.thrown?.kind === 'moveNoLayer1' && r.same, `a cell only Yoshi's Island 2's layer 2 steps change (${at(only)}): ${says(r)}`);
}
{
  // the same event: nothing to do
  const rom = new Rom(image.slice()), was = rom.data.slice(), p = moveChange(rom, { cell: mid, from: IGGY, to: IGGY });
  check(p.cells.length === 5 && rom.data.every((v, i) => v === was[i]), 'to the event it is in: nothing written');
}

// ---- one undo step ----
{
  const rom = new Rom(image.slice()), was = rom.data.slice(), s = new RomEditSession(rom);
  s.edit('Moved', () => moveChange(rom, { cell: mid, from: IGGY, to: BEFORE_EVENTS }));
  const changed = !rom.data.every((v, i) => v === was[i]);
  s.undo();
  check(changed && rom.data.every((v, i) => v === was[i]), 'one ROM edit: undone, every byte as before');
  s.redo();
  check(readEvents(rom).silent[IGGY].filter((x) => x.layer === 1).length === 1, 'redone: event 06 keeps only its change at 05,11');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
