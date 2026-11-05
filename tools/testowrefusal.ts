// Overworld refusals (#346): core returns data (core/owrefusal.ts), the editor words it (ui/owrefusal.ts). Every kind
// gets a consequence and a reason in the player's terms – no table names, no hex numbers – and the technical line
// (events, tables, numbers) as its details; an event is named by the level exit that runs it; a refused edit throws
// an OwRefusal whose message is that line.
// node tools/testowrefusal.ts
import { Rom } from '../src/core/rom.ts';
import { refusalDetails, refusalOf, OwRefusal, type OwRefusalData, type OwRefusalKind } from '../src/core/owrefusal.ts';
import { refusalWords, eventPhrase, levelTitle, refusalText } from '../src/ui/owrefusal.ts';
import { addReveal } from '../src/core/oweventtiles.ts';
import { makeLink, moveLocation } from '../src/core/owlinks.ts';
import { writeTeleport, writeExitPath, TELEPORTS, EXIT_PATHS } from '../src/core/owteleport.ts';
import { l1Index } from '../src/core/overworld.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const rom = new Rom(await editorImage());

// one of each kind (a Record: a kind added without a case here fails to typecheck)
const samples: { [K in OwRefusalKind]: Extract<OwRefusalData, { kind: K }> } = {
  revealPastTable: { kind: 'revealPastTable', event: 0x70, events: 0x70 },
  revealTaken: { kind: 'revealTaken', event: 3, cell: l1Index(1, 9, 6) },
  revealTopLeft: { kind: 'revealTopLeft' },
  revealUnchanged: { kind: 'revealUnchanged', tile: 0x1f2 },
  revealNoSource: { kind: 'revealNoSource', tile: 0x01 },
  destroyPastEvents: { kind: 'destroyPastEvents', event: 0x78, events: 0x78 },
  destroyTaken: { kind: 'destroyTaken', event: 6, cell: l1Index(1, 9, 1) },
  destroysFull: { kind: 'destroysFull', event: 0x13, max: 0x18 },
  destroyNothing: { kind: 'destroyNothing', tile: 0x5c },
  crumbleNoEvent: { kind: 'crumbleNoEvent', tl: 0x29 },
  crumblesByOther: { kind: 'crumblesByOther', event: 3, cell: l1Index(1, 9, 1) },
  moveCrossed: { kind: 'moveCrossed', event: 2, cell: l1Index(0, 2, 0x11), from: 1, to: 3 },
  moveNoLayer1: { kind: 'moveNoLayer1', event: 3, cell: l1Index(1, 9, 6) },
  linkToItself: { kind: 'linkToItself' },
  l1TilePast: { kind: 'l1TilePast', tile: 0x200, tiles: 0x200 },
  linkNoStart: { kind: 'linkNoStart', tile: 0x5c, path: 'walk' },
  teleportsFull: { kind: 'teleportsFull', max: 0x100 },
  exitPathsFull: { kind: 'exitPathsFull', max: 0x80 },
  koopaPlaceSubmap: { kind: 'koopaPlaceSubmap', from: { submap: 1, x: 3, y: 4 } },
  locationsFull: { kind: 'locationsFull', max: 0x100 },
  noFreeL1Tile: { kind: 'noFreeL1Tile', tiles: 0x200 },
  eventStorageFull: { kind: 'eventStorageFull', max: 0x3600, need: 0x3602 },
  levelTileHeld: { kind: 'levelTileHeld', cell: l1Index(0, 4, 4), tl: 0x29 },
  submapsLoading: { kind: 'submapsLoading' },
  routeGap: { kind: 'routeGap' },
  routeExitInside: { kind: 'routeExitInside' },
  routeCrosses: { kind: 'routeCrosses' },
  routeNoTile: { kind: 'routeNoTile', dir: 0, out: 2, where: 'pathBefore' },
  routeNoTranslevel: { kind: 'routeNoTranslevel', max: 0x5f, kept: 2 },
  starNoTranslevel: { kind: 'starNoTranslevel', max: 0x5f, kept: 2 },
  starOnLevel: { kind: 'starOnLevel', cell: l1Index(0, 4, 4), tl: 0x29 },
  pieceSame: { kind: 'pieceSame' },
  pieceNoneInside: { kind: 'pieceNoneInside' },
  pieceNotFound: { kind: 'pieceNotFound', selection: true },
  nameNoChar: { kind: 'nameNoChar', ch: 'é' },
  nameFull: { kind: 'nameFull', max: 19 },
  deadEndNoStopTile: { kind: 'deadEndNoStopTile' },
  deadEndEventTile: { kind: 'deadEndEventTile', cell: 0x123 },
  customSpritesPerSubmap: { kind: 'customSpritesPerSubmap', submap: 2, count: 0x19, max: 0x18 },
  customSpriteId: { kind: 'customSpriteId', id: 0x7f, max: 0x7e },
  customSpritePos: { kind: 'customSpritePos' },
  customSpriteHeight: { kind: 'customSpriteHeight' },
  codePatched: { kind: 'codePatched', what: 'Lightning' },
  revealSpeedFade: { kind: 'revealSpeedFade' },
  revealSpeedRange: { kind: 'revealSpeedRange', max: 0x40 },
  koopaTableBowsie: { kind: 'koopaTableBowsie' },
  borderNoFile: { kind: 'borderNoFile', map: 'Yoshi\'s Island' },
  borderNoExGfx: { kind: 'borderNoExGfx' },
  borderGameCell: { kind: 'borderGameCell', x: 2, y: 1 },
  borderOutsideFile: { kind: 'borderOutsideFile', x: 0, y: 0x1b },
  importReplaced: { kind: 'importReplaced', rom: 'other', by: 'a tool' },
  importLinkTables: { kind: 'importLinkTables' },
};
// table names and hex numbers the player's words leave to the details (a hex number: two or three digits with a letter)
const technical = /\b(table|entry|entries|storage|translevel|ExGFX|event [0-9A-F]{2})\b|\b(?=[0-9A-F]*[A-F])[0-9A-F]{2,3}\b/;
for (const r of Object.values(samples) as OwRefusalData[]) {
  const w = refusalWords(rom, r);
  check(!!w.consequence && !!w.reason && !technical.test(w.consequence) && !technical.test(w.reason) && !technical.test(w.instead),
    `${r.kind}: "${w.consequence}: ${w.reason}." ${w.instead}`);
  check(w.details === refusalDetails(r) && !!w.details, `${r.kind}: details "${w.details}"`);
}

// events named by the level exit running them
const yi2 = eventPhrase(rom, 3), named = refusalWords(rom, samples.revealTaken).consequence;
check(yi2 === 'the normal exit of Yoshi\'s Island 2', `event 03: "${yi2}"`);
check(named.startsWith('The normal exit of Yoshi\'s Island 2 '), `the consequence names it: "${named}"`);
check(eventPhrase(rom, 0x77) === 'this event', 'an event no level exit runs: "this event"');
check(levelTitle(rom, 0x29) === 'Yoshi\'s Island 1', `the game's names in title case: "${levelTitle(rom, 0x29)}"`);
check(/Yoshi's Island 2.*\./.test(refusalText(rom, samples.revealTaken)), `one line: "${refusalText(rom, samples.revealTaken)}"`);

// a refused edit throws an OwRefusal: its data, its message the technical line
const thrown = (f: () => void): unknown => { try { f(); return null; } catch (e) { return e; } };
const e1 = thrown(() => addReveal(new Rom(rom.data.slice()), 3, l1Index(0, 5, 5), 0x66));
check(e1 instanceof OwRefusal && refusalOf(e1)?.kind === 'revealTaken' && (e1 as Error).message === refusalDetails(refusalOf(e1)!), `addReveal on an event with a reveal: ${(e1 as Error)?.message}`);
const t = { submap: 0, x: 3, y: 3 };
check(refusalOf(thrown(() => makeLink(new Rom(rom.data.slice()), 'star', t, t, false)))?.kind === 'linkToItself', 'a link to its own tile: linkToItself');
check(refusalOf(new Error('x')) === null, 'another error: no refusal');

// the link tables full: a star/pipe link, a location moved, an exit path refused with the table's size
{
  const r = new Rom(rom.data.slice()), a = { submap: 0, x: 1, y: 1 }, b = { submap: 0, x: 2, y: 2 };
  for (let i = 0; i < TELEPORTS; i++) writeTeleport(r, i, { from: { submap: 1, x: i & 31, y: i >> 5 }, to: { submap: 1, x: 0, y: 0 } });
  for (let i = 0; i < EXIT_PATHS; i++) writeExitPath(r, i, { from: { submap: 1, x: i * 16 + 8, y: 8 }, to: { submap: 2, x: 8, y: 8 }, tile: { x: 0, y: 0 } });
  const before = r.data.slice();
  check(JSON.stringify(refusalOf(thrown(() => makeLink(r, 'star', a, b, false)))) === JSON.stringify({ kind: 'teleportsFull', max: TELEPORTS }), 'every star/pipe entry used: teleportsFull');
  check(JSON.stringify(refusalOf(thrown(() => makeLink(r, 'exit', { ...a, side: 0 }, { ...b, side: 1 }, false)))) === JSON.stringify({ kind: 'exitPathsFull', max: EXIT_PATHS }), 'every exit path entry used: exitPathsFull');
  check(refusalOf(thrown(() => moveLocation(r, 0, b)))?.kind === 'locationsFull', 'a star\'s entry moved as a location, none free: locationsFull');
  check(r.data.every((v, i) => v === before[i]), 'nothing written');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
