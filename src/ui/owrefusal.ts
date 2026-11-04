// An overworld refusal (core/owrefusal.ts) worded for the player (#346): the consequence in the player's terms ("The
// secret exit of Vanilla Dome 2 can't reveal a tile"), the reason without table names, a way out – a fix button where
// one exists (given by the caller: its label, the hover saying what it writes, the action), else a sentence what to do
// instead. The technical line (event, table, number) folds out under "Details". Every overworld refusal toast goes
// through refusalToast / refusedToast.

import type { Rom } from '../core/rom.ts';
import { refusalOf, refusalDetails, routeNoTileText, type OwRefusalData } from '../core/owrefusal.ts';
import { eventRunners } from '../core/owevents.ts';
import { levelName, hasLevelName } from '../core/levelnames.ts';
import { h, toast } from './dom.ts';

export interface RefusalWords {
  consequence: string; // a sentence without its period: what didn't happen, in the player's terms
  reason: string; // why, without table names (lower case start: it follows the consequence)
  instead: string; // what to do instead (a sentence; '' none) – shown when no fix is offered
  details: string; // the technical line
}
// a way out of a refusal: one ROM edit, its hover saying what it writes
export interface RefusalFix { label: string; preview: string; run: () => void }

const EXIT_WORDS = ['normal exit', 'secret exit', 'secret exit 2', 'secret exit 3'];
// a level's name as the player reads it ("Vanilla Dome 2" for the game's VANILLA DOME 2); tl: a translevel
export function levelTitle(rom: Rom, tl: number): string {
  const n = levelName(rom, tl);
  if (!hasLevelName(rom, tl)) return 'a level without a name';
  if (/[a-z]/.test(n)) return n;
  return n.toLowerCase().replace(/(^|\s)(\S)/g, (m, s: string, c: string) => s + c.toUpperCase())
    .replace(/(?<=\s)(Of|The|And|A|In|On)(?=\s)/g, (w) => w.toLowerCase());
}
// event e as the player knows it: by the level exit that runs it ("the secret exit of Vanilla Dome 2"), else "this event"
export function eventPhrase(rom: Rom, e: number): string {
  const r = eventRunners(rom).get(e)?.[0];
  return r ? `the ${EXIT_WORDS[r.exit]} of ${levelTitle(rom, r.tl)}` : 'this event';
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function refusalWords(rom: Rom, r: OwRefusalData): RefusalWords {
  const w = (consequence: string, reason: string, instead = ''): RefusalWords => ({ consequence, reason, instead, details: refusalDetails(r) });
  const ev = (e: number) => cap(eventPhrase(rom, e));
  switch (r.kind) {
    case 'revealPastTable': return w(`${ev(r.event)} can't open a tile`,
      `this game lets only the first ${r.events} level exits open tiles`,
      'Paint the tile into the event\'s layer 1 changes instead (layer 1 mode with this event chosen).');
    case 'revealTaken': return w(`${ev(r.event)} can't open another tile`,
      'each event opens one tile, and this one already opens one',
      'Remove its reveal in the timeline (×) first, or paint the tile into the event\'s layer 1 changes.');
    case 'revealTopLeft': return w('The top left tile of the main map can\'t be opened',
      'the game takes that place for "opens nothing"', 'Pick another tile.');
    case 'revealUnchanged': return w('Opening this tile would change nothing',
      'the game turns an opened tile into its counterpart in the reveal list, and this tile has none',
      'Pick in the layer 1 sheet the tile it should become.');
    case 'revealNoSource': return w('No tile can be opened into this one',
      'the reveal list has no pair that turns a tile into it', 'Pick another tile it becomes.');
    case 'destroyPastEvents': return w('This event can\'t destroy a tile', 'the game has no such event');
    case 'destroyTaken': return w(`${ev(r.event)} can't destroy another tile`,
      'each event destroys one tile, and this one already destroys one', 'Remove its destroy in the timeline (×) first.');
    case 'destroysFull': return w(`${ev(r.event)} can't destroy a tile`,
      `the game remembers ${r.max} destroyed castles, fortresses and switch palaces, and all are taken`,
      'Remove the destroy of another event first.');
    case 'destroyNothing': return w('This tile can\'t be destroyed',
      'the game destroys only castles, fortresses and switch palaces', 'Click a castle, fortress or switch palace.');
    case 'linkNoStart': return w('No link starts here', 'Mario doesn\'t stop on this tile: a star or pipe is a tile he stops on, a path to another submap an exit path tile',
      'Start the link on a star, pipe or exit path tile.');
    case 'l1TilePast': return w('This tile can\'t be edited', 'it is past the tiles the overworld has');
    case 'crumbleNoEvent': return w('The level tile can\'t crumble when beaten', `the normal exit of ${levelTitle(rom, r.tl)} changes nothing on the map`,
      'Give the level a base event first.');
    case 'linkToItself': return w('The link isn\'t made', 'it would lead to the tile it starts at', 'Drag to another tile.');
    case 'teleportsFull': return w('This star or pipe can\'t be linked',
      `the game has room for ${r.max} star and pipe links, and all are taken`, 'Remove a star or pipe link you don\'t need first.');
    case 'koopaPlaceSubmap': return w('The Koopa Kid can\'t put Mario there', 'losing to it leaves Mario on the submap where it stands', 'Pick a tile on the same submap.');
    case 'locationsFull': return w('This exit can\'t take Mario to that tile',
      `the game has room for ${r.max} places stars, pipes and exits take Mario to, and all are taken`, 'Pick a tile a star, pipe or other exit already leads to, or remove a star or pipe link first.');
    case 'exitPathsFull': return w('This path between submaps can\'t be linked',
      `the game has room for ${r.max} paths between submaps, and all are taken`, 'Remove a path between submaps you don\'t need first.');
    case 'noFreeL1Tile': return w('No new layer 1 tile can be made', 'every tile of the overworld already has a look of its own, is on a map or does something where Mario walks',
      'Change a tile no map uses in the Map16 tab instead.');
    case 'eventStorageFull': return w('The event\'s changes to the map can\'t be written',
      'the game keeps the tiles all events change in one store, and it is full',
      'Let this or other events change fewer tiles of layer 2.');
    case 'levelTileHeld': return w('This tile can\'t enter another level after the event',
      `it enters ${levelTitle(rom, r.tl)} before the event or by another one, and a tile enters one level all game long`,
      'Place the level tile on another tile.');
    case 'submapsLoading': return w('Not painted', 'the submaps are still being loaded', 'Try again in a moment.');
    case 'routeGap': return w('The route breaks here', 'this cell is not next to the one before', 'Drag from cell to cell.');
    case 'routeExitInside': return w('The route can\'t go on here', 'an exit tile takes Mario to another submap, so the route can only end there');
    case 'routeCrosses': return w('The route can\'t go on here', 'it crosses itself');
    case 'routeNoTile': { const t = routeNoTileText(r); return w('No path tile fits here', t.charAt(0).toLowerCase() + t.slice(1)); }
    case 'pieceSame': return w('Not replaced', 'the new piece is the one to replace', 'Pick another piece to put in its place.');
    case 'pieceNoneInside': return w('Not replaced', 'no piece lies wholly inside the selection', 'Select a larger area.');
    case 'pieceNotFound': return w('Not replaced', `the piece is not ${r.selection ? 'in the selection' : 'on this map'}`);
    case 'nameNoChar': return w(`“${r.ch}” can't be typed`, 'the font of level names has no such character');
    case 'nameFull': return w('No more characters fit', `the name has its ${r.max} tiles`);
    case 'deadEndNoStopTile': return w('No stop tile can be added here', 'the overworld has no stop tile to put there');
    case 'deadEndEventTile': return w('No stop tile can be added here', 'an event puts the tile there', 'Paint a stop tile into that event.');
    case 'customSpritesPerSubmap': return w('No more custom sprites fit on this submap',
      `a submap holds ${r.max} custom sprites`, 'Remove one first.');
    case 'customSpriteId': return w('This custom sprite can\'t be placed',
      'its number is past the last custom overworld sprite this ROM can hold', 'Pick another sprite.');
    case 'customSpritePos': return w('The custom sprite can\'t go there', 'it would be past the edge custom sprites reach');
    case 'customSpriteHeight': return w('The custom sprite can\'t go that high', 'custom sprites float at most 248 pixels high');
    case 'codePatched': return w(`"${r.what}" can't be changed`, 'a patch changed the game\'s code this switch writes');
    case 'revealSpeedFade': return w('The path reveal speed can\'t be set', 'it applies only with the event path fade off',
      'Turn the event path fade off first.');
    case 'revealSpeedRange': return w('The path reveal speed can\'t be set to that', 'the game takes no faster or slower speed');
    case 'koopaTableBowsie': return w('The Koopa Kids can\'t be moved', 'BOWSIE\'s MaxTile keeps its code where their places were');
    case 'borderNoFile': return w(`${r.map} gets no border of its own`, 'it has no border file to copy');
    case 'borderNoExGfx': return w('The border file can\'t be copied', 'every graphics file number for borders is taken',
      'Remove a graphics file you don\'t need first.');
    case 'borderGameCell': return w('Not painted here', 'the game writes the lives and the level name there when the overworld loads', 'Paint elsewhere on the border.');
    case 'borderOutsideFile': return w('Not painted here', 'this part of the screen is not in the submap\'s border file');
    case 'importReplaced': return w('The overworld can\'t be imported',
      `${r.rom === 'other' ? 'the other ROM\'s' : 'this ROM\'s'} overworld is replaced by ${r.by}`);
    case 'importLinkTables': return w('The overworld can\'t be imported', 'the two ROMs keep their overworld links differently');
  }
}

// one line: the consequence and the reason (a disabled control's hover, the log)
export function refusalText(rom: Rom, r: OwRefusalData): string {
  const w = refusalWords(rom, r);
  return `${w.consequence}: ${w.reason}.`;
}

// the refusal as a toast: the consequence, the reason, the fix (a button: run, the toast closed) or what to do instead,
// the details folded out
export function refusalToast(rom: Rom, r: OwRefusalData, fix?: RefusalFix): void {
  const w = refusalWords(rom, r);
  let close = () => {};
  const body = h('div', { class: 'refusal' },
    h('div', null, h('b', null, w.consequence), `: ${w.reason}.`),
    fix ? h('button', { class: 'refusal-fix', title: fix.preview, onclick: () => { close(); fix.run(); } }, fix.label)
      : w.instead ? h('div', { class: 'refusal-instead' }, w.instead) : null,
    h('details', null, h('summary', null, 'Details'), w.details));
  close = toast(`${w.consequence}: ${w.reason}. ${fix ? '' : w.instead} (${w.details})`.replace(/ {2,}/g, ' '), 'error', body);
}
// an error caught from an overworld edit: a refusal as refusalToast, another error as a plain toast after `prefix`
export function refusedToast(rom: Rom, e: unknown, prefix = 'Not changed: ', fix?: (r: OwRefusalData) => RefusalFix | undefined): void {
  const r = refusalOf(e);
  if (r) refusalToast(rom, r, fix?.(r));
  else toast(`${prefix}${e instanceof Error ? e.message : e}`, 'error');
}
