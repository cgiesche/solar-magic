// The overworld's Paint panel hidden for a selection (#421, ui/owselection.ts selectionHidesPaint): a level tile, star
// or pipe 5B selected by a click in the layer 1 mode shows only its properties; Paint stays for a tile's info
// (Alt/Ctrl+click), in the other modes, for other tiles (the pipe 82, a path), while the path kinds are learned (a star
// not known yet) and while a reveal's new tile is picked in the sheet; nothing selected: Paint.
// node tools/testowselection.ts
import { selectionHidesPaint, type OwSelection } from '../src/ui/owselection.ts';
import { STAR_TILE, PIPE_TILE } from '../src/core/owstars.ts';
import { ANY_WAY_TILE } from '../src/core/owreach.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const level: OwSelection = { mode: 'l1', selected: 0x123, tile: 0x56, byInfo: false, levelTile: true, kindsKnown: true, revealPick: false };
const star = { ...level, tile: STAR_TILE, levelTile: false };
check(selectionHidesPaint(level), 'a level tile clicked in the layer 1 mode: Paint hidden');
check(selectionHidesPaint(star), 'a star: hidden');
check(selectionHidesPaint({ ...star, tile: PIPE_TILE }), 'a pipe 5B: hidden');
check(selectionHidesPaint({ ...star, tile: 0x100 | STAR_TILE }), 'a star 15F: hidden');
check(!selectionHidesPaint({ ...star, tile: ANY_WAY_TILE }), 'the pipe 82 (no translevel of its own): Paint stays');
check(!selectionHidesPaint({ ...star, tile: 0x04 }), 'another tile (a link end, a path): Paint stays');
check(!selectionHidesPaint({ ...level, byInfo: true }) && !selectionHidesPaint({ ...star, byInfo: true }), 'a tile\'s info by Alt/Ctrl+click: Paint stays');
check(!selectionHidesPaint({ ...level, mode: 'l2' }) && !selectionHidesPaint({ ...level, mode: 'sprites' }), 'the layer 2 and sprite modes: Paint stays');
check(!selectionHidesPaint({ ...level, selected: -1 }), 'nothing selected: Paint');
check(!selectionHidesPaint({ ...star, kindsKnown: false }), 'the path kinds still learned (a star not known): Paint stays');
check(!selectionHidesPaint({ ...level, revealPick: true }), 'a reveal\'s new tile picked in the sheet: Paint shown');

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
