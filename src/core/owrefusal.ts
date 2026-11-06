// An overworld edit refused (#346), as data: what kind of refusal and the numbers involved. The core's checks return or
// throw it (OwRefusal); the editor words it for the player (ui/owrefusal.ts: the consequence, the reason, a way out)
// and shows the technical line built here (refusalDetails, the error's message) folded out under "Details".

import { hex } from './names.ts';
import { translevelToLevel } from './overworld.ts';
import { cellText } from './oweventtiles.ts';
import { wayText } from './owpathshape.ts';

export type OwRefusalData =
  // ---- reveals and destroys (oweventtiles.ts) ----
  | { kind: 'revealPastTable'; event: number; events: number } // the reveal table has events 00…events-1
  | { kind: 'revealTaken'; event: number; cell: number } // the event already reveals cell
  | { kind: 'revealTopLeft' } // cell 0 stands for "reveals nothing"
  | { kind: 'revealUnchanged'; tile: number } // no reveal list pair turns tile into another
  | { kind: 'revealNoSource'; tile: number } // no reveal list pair turns a tile into tile
  | { kind: 'destroyPastEvents'; event: number; events: number } // the game has events 00…events-1
  | { kind: 'destroyTaken'; event: number; cell: number } // the event already destroys cell
  | { kind: 'destroysFull'; event: number; max: number } // the destroy list's max entries all used
  | { kind: 'destroyNothing'; tile: number } // the game destroys no tile `tile`
  | { kind: 'crumbleNoEvent'; tl: number } // translevel tl's normal exit runs no event
  | { kind: 'crumblesByOther'; event: number; cell: number } // another event than the level's base event destroys cell
  // ---- a change moved to another event from a cell's history (owmovechange.ts) ----
  | { kind: 'moveCrossed'; event: number; cell: number; from: number; to: number } // event changes cell between from and to (to: -1 before events)
  | { kind: 'moveNoLayer1'; event: number; cell: number } // event changes cell only on layer 2 (its steps aren't moved)
  // ---- links (owlinks.ts) ----
  | { kind: 'linkToItself' }
  | { kind: 'l1TilePast'; tile: number; tiles: number } // a layer 1 tile past the overworld's (000…tiles-1)
  | { kind: 'linkNoStart'; tile: number; path: string } // a link from a tile Mario doesn't stop on (path: its kind's name)
  | { kind: 'teleportsFull'; max: number } // every star/pipe entry used
  | { kind: 'exitPathsFull'; max: number } // every exit path entry used
  | { kind: 'koopaPlaceSubmap'; from: { submap: number; x: number; y: number } } // a Koopa Kid's place off the submap of its tile
  | { kind: 'locationsFull'; max: number } // an exit to the overworld teleported to a tile no star/pipe entry has: none free
  // ---- layer 1 tiles (owl1sheet.ts) ----
  | { kind: 'noFreeL1Tile'; tiles: number } // no tile of `tiles` (001…) is a copy of 000 on no map
  // ---- event steps (owevents.ts) and level tiles (owleveltiles.ts) ----
  | { kind: 'eventStorageFull'; max: number; need?: number } // the places the events' tiles are kept in
  | { kind: 'levelTileHeld'; cell: number; tl: number } // cell enters translevel tl on another map
  | { kind: 'submapsLoading' } // an event's layer 2 painted before the submaps' views are known
  // ---- a route drawn with the route brush, "Path (auto)" (owroute.ts; told in the status bar) ----
  | { kind: 'routeGap' } // a cell not next to the one before
  | { kind: 'routeExitInside' } // an exit tile not at the route's end
  | { kind: 'routeCrosses' }
  // no path tile leads Mario in direction dir and out toward out (where: at all, from where his first step off the stop
  // or the path before leaves him, to where his first step off the stop after it leaves him walking back)
  | { kind: 'routeNoTile'; dir: number; out: number; where: 'any' | 'stopStep' | 'pathBefore' | 'stepBack' }
  | { kind: 'starOnLevel'; cell: number; tl: number; pipe: boolean } // a star (pipe: a pipe 5B) painted on cell, a level tile entering translevel tl at another event progress
  | { kind: 'starNoTranslevel'; max: number; kept: number; pipe: boolean } // a star (pipe: a pipe 5B) painted (owstars.ts): every translevel 01…max held by a tile or (kept of them) with a name, base event or messages
  | { kind: 'routeNoTranslevel'; max: number; kept: number } // a stop tile the route puts: every translevel 01…max held by a tile, by a stop before or (kept of them) with a name, base event or messages
  // ---- layer 2 pieces replaced (owl2pieces.ts, the layer 2 sheet's "Replace piece…") ----
  | { kind: 'pieceSame' } // the new piece is the one to replace
  | { kind: 'pieceNoneInside' } // no piece lies wholly inside the selection
  | { kind: 'pieceNotFound'; selection: boolean } // the piece is not in the selection (on the map: false)
  // ---- a level name typed (levelnames.ts typeNameChar) ----
  | { kind: 'nameNoChar'; ch: string } // the font has no tile for ch
  | { kind: 'nameFull'; max: number }
  // ---- the World check's fixes (worldcheck.ts) ----
  | { kind: 'deadEndNoStopTile' } // a dead end's stop tile: the overworld has none to put there
  | { kind: 'deadEndEventTile'; cell: number } // the tile Mario is stuck on is put there by an event
  // ---- custom overworld sprites (owcustom.ts) ----
  | { kind: 'customSpritesPerSubmap'; submap: number; count: number; max: number }
  | { kind: 'customSpriteId'; id: number; max: number } // ids 01…max (7E with BOWSIE)
  | { kind: 'customSpritePos' }
  | { kind: 'customSpriteHeight' }
  // ---- the game's options and code (owoptions.ts, owsprites.ts) ----
  | { kind: 'codePatched'; what: string } // a patch changed the game's code the switch `what` writes
  | { kind: 'revealSpeedFade' } // the path reveal speed applies with the path fade off
  | { kind: 'revealSpeedRange'; max: number }
  | { kind: 'koopaTableBowsie' }
  // ---- borders (owlayer3.ts) ----
  | { kind: 'borderNoFile'; map: string } // map: the submap's name
  | { kind: 'borderNoExGfx' }
  | { kind: 'borderGameCell'; x: number; y: number } // a layer 3 cell the game writes when the overworld loads
  | { kind: 'borderOutsideFile'; x: number; y: number } // a layer 3 cell the submap's tilemap file doesn't hold
  // ---- importing another ROM's overworld (owimport.ts) ----
  | { kind: 'importReplaced'; rom: 'other' | 'this'; by: string }
  | { kind: 'importLinkTables' };

export type OwRefusalKind = OwRefusalData['kind'];

const tileHex = (t: number) => hex(t, t > 0xff ? 3 : 2);

// the technical line: events, tables, numbers (events, tiles, ids in hex as the editor shows them; counts in decimal)
export function refusalDetails(r: OwRefusalData): string {
  switch (r.kind) {
    case 'revealPastTable': return `Event ${hex(r.event, 2)}: the reveal table has events 00–${hex(r.events - 1, 2)}.`;
    case 'revealTaken': return `Event ${hex(r.event, 2)} already reveals the tile at ${cellText(r.cell)} (one reveal table entry per event).`;
    case 'revealTopLeft': return 'Main map 00,00: a reveal table entry of 0 stands for none.';
    case 'revealUnchanged': return `Tile ${tileHex(r.tile)} is not in the reveal list.`;
    case 'revealNoSource': return `No pair of the reveal list becomes tile ${tileHex(r.tile)}.`;
    case 'destroyPastEvents': return `Event ${hex(r.event, 2)} is past the last event (${hex(r.events - 1, 2)}).`;
    case 'destroyTaken': return `Event ${hex(r.event, 2)} already destroys the tile at ${cellText(r.cell)}.`;
    case 'destroysFull': return `Event ${hex(r.event, 2)}: all ${r.max} entries of the destroy list are used.`;
    case 'destroyNothing': return `Tile ${tileHex(r.tile)} has no destroy effect.`;
    case 'moveCrossed': return `Event ${hex(r.event, 2)} changes the tile at ${cellText(r.cell)} ${r.event === r.to ? 'too' : `between event ${hex(r.from, 2)} and ${r.to < 0 ? 'the map before events' : `event ${hex(r.to, 2)}`}`}.`;
    case 'moveNoLayer1': return `Event ${hex(r.event, 2)} changes only layer 2 at ${cellText(r.cell)}.`;
    case 'l1TilePast': return `Tile ${tileHex(r.tile)} is past the overworld's layer 1 tiles (000–${hex(r.tiles - 1, 3)}).`;
    case 'linkNoStart': return `Tile ${tileHex(r.tile)} (${r.path}): a star or pipe is a tile Mario stops on, an exit path an exit path tile.`;
    case 'crumbleNoEvent': return `Translevel ${hex(r.tl, 2)} has no base event (FF).`;
    case 'crumblesByOther': return `Event ${hex(r.event, 2)} already destroys the tile at ${cellText(r.cell)}.`;
    case 'linkToItself': return 'The link\'s start and target are the same tile.';
    case 'teleportsFull': return `All ${r.max} entries of the star/pipe table are used.`;
    case 'koopaPlaceSubmap': return `A Koopa Kid's place is on the submap of its tile (submap ${r.from.submap}, ${hex(r.from.x, 2)},${hex(r.from.y, 2)}).`;
    case 'locationsFull': return `All ${r.max} locations (star/pipe table entries) are used.`;
    case 'exitPathsFull': return `All ${r.max} entries of the exit path table are used.`;
    case 'noFreeL1Tile': return `No layer 1 tile 001–${hex(r.tiles - 1, 3)} is free: drawn and acting as tile 000, and on no map.`;
    case 'eventStorageFull': return r.need ? `The event tiles need ${r.need} of ${r.max} storage places.` : `All ${r.max} places of the event storage are used.`;
    case 'levelTileHeld': return `Tile ${cellText(r.cell)} enters level ${hex(translevelToLevel(r.tl), 3)} before the event or by another one (translevel table: one level per tile).`;
    case 'submapsLoading': return 'The submaps\' views are not known yet.';
    case 'routeGap': return 'Not next to the cell before.';
    case 'routeExitInside': return 'An exit tile takes Mario to another submap: the route can only end there.';
    case 'routeCrosses': return 'The route crosses itself here.';
    case 'routeNoTile': return `${routeNoTileText(r)}.`;
    case 'starOnLevel': return `Tile ${cellText(r.cell)} enters level ${hex(translevelToLevel(r.tl), 3)} at another event progress (translevel table: one translevel per tile): a ${r.pipe ? 'pipe' : 'star'} there would share it.`;
    case 'starNoTranslevel': return `All ${r.max} translevels (01–${hex(r.max, 2)}) are held by a tile${r.kept ? `, or have a name, base event or messages a ${r.pipe ? 'pipe' : 'star'} would erase (${r.kept})` : ''}: a ${r.pipe ? 'pipe' : 'star'} needs one of its own (its flags open the ways Mario walks off it, its name is the status bar's).`;
    case 'routeNoTranslevel': return `All ${r.max} translevels (01–${hex(r.max, 2)}) are held by a tile or a stop before on the route${r.kept ? `, or have a name, base event or messages a stop tile would erase (${r.kept})` : ''}: a stop tile needs one of its own (its flags open the ways Mario walks off it).`;
    case 'pieceSame': return 'The new piece is the one to replace.';
    case 'pieceNoneInside': return 'No piece lies wholly inside the selection (2x2 blocks on the 16-pixel grid).';
    case 'pieceNotFound': return `The piece is not ${r.selection ? 'in the selection' : 'on this map'}.`;
    case 'nameNoChar': return `The level name font has no tile for “${r.ch}”.`;
    case 'nameFull': return `A level name has ${r.max} tiles.`;
    case 'deadEndNoStopTile': return 'No layer 1 tile is a stop tile (the star and pipe tiles left out).';
    case 'deadEndEventTile': return `The tile at ${cellText(r.cell)} is an event's layer 1 change, not the map before events'.`;
    case 'customSpritesPerSubmap': return `Submap ${r.submap} has ${r.count} custom sprites, at most ${r.max}.`;
    case 'customSpriteId': return `Custom overworld sprite ${hex(r.id, 2)}: the ids are 01–${hex(r.max, 2)}.`;
    case 'customSpritePos': return 'A custom overworld sprite is at most at 3F,3F (8px steps).';
    case 'customSpriteHeight': return 'A custom overworld sprite\'s height is at most 1F (8px steps).';
    case 'codePatched': return `"${r.what}": the game's code it changes was changed by a patch.`;
    case 'revealSpeedFade': return 'The path reveal speed applies with the event path fade off.';
    case 'revealSpeedRange': return `The path reveal speed is 01–${hex(r.max, 2)}.`;
    case 'koopaTableBowsie': return 'With BOWSIE\'s MaxTile there is no Koopa Kid table: its code is there.';
    case 'borderNoFile': return `${r.map} has no layer 3 tilemap file to copy.`;
    case 'borderNoExGfx': return 'No free ExGFX number left for the layer 3 tilemap.';
    case 'borderGameCell': return `Layer 3 cell ${hex(r.x, 2)},${hex(r.y, 2)}: the game writes the lives and the level name there.`;
    case 'borderOutsideFile': return `Layer 3 cell ${hex(r.x, 2)},${hex(r.y, 2)} is outside the part of the screen the layer 3 tilemap file holds.`;
    case 'importReplaced': return `${r.rom === 'other' ? 'The other ROM\'s' : 'This ROM\'s'} overworld is replaced by ${r.by}.`;
    case 'importLinkTables': return 'The overworld link tables of the two ROMs differ.';
  }
}

// "No path tile leads Mario from the left up …": a route's cell no path tile fits
export function routeNoTileText(r: Extract<OwRefusalData, { kind: 'routeNoTile' }>): string {
  const way = wayText(r.dir, r.out);
  return r.where === 'any' ? `No path tile leads Mario ${way}`
    : r.where !== 'stepBack' ? `No path tile leads Mario ${way} from where ${r.where === 'stopStep' ? 'his first step off the stop' : 'the path before'} leaves him`
    : `No path tile leads Mario ${way} to where his first step off the stop after it leaves him walking back`;
}

// a refused overworld edit, thrown; its message is the technical line
export class OwRefusal extends Error {
  readonly refusal: OwRefusalData;
  constructor(r: OwRefusalData) {
    super(refusalDetails(r));
    this.name = 'OwRefusal';
    this.refusal = r;
  }
}
// the refusal an error carries, null for another error
export function refusalOf(e: unknown): OwRefusalData | null {
  return e instanceof OwRefusal ? e.refusal : null;
}
