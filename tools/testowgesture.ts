// What is on in the overworld editor (ui/owgesture.ts, #554). The selection: a layer 1 tile with the link layer's
// choice at it, a sprite in the sprites mode, the pieces marked on layer 2 – and what a change of mode or map ends of
// them. The side panel's tabs (ADR 0015, #460, sideTabs): "Picker | Properties", the tab chosen shown while something
// is selected, the picker otherwise and while a reveal's new tile is picked in the layer 1 sheet; Properties disabled
// without a selection. And what a plain click selects rather than picking into the brush (#434, clickSelects): a link
// end, a star or pipe with or without a link.
// node tools/testowgesture.ts
import { OwGesture, sideTabs, clickSelects, type PressFacts } from '../src/ui/owgesture.ts';
import { STAR_TILE, PIPE_TILE } from '../src/core/owstars.ts';
import { ANY_WAY_TILE } from '../src/core/owreach.ts';
import type { PathKind } from '../src/core/owpaths.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// path kinds as learned in the clean game (owpaths.ts): the stars and pipes 5B, 5F, 82 warp on both pages
const kinds: PathKind[] = Array.from({ length: 0x200 }, (_, t) => ([0x5b, 0x5f, 0x82].includes(t & 0xff) ? 'warp' : (t & 0xff) === 0x56 ? 'level' : 'walk'));

check(sideTabs('l1', 'props', true, false).shown === 'props', 'a selection with Properties chosen: Properties shown');
check(sideTabs('l1', 'paint', true, false).shown === 'paint', 'Paint clicked with the selection kept: Paint shown');
check(sideTabs('l2', 'props', false, false).shown === 'paint', 'nothing selected: Paint');
check(!sideTabs('l1', 'paint', false, false).propsEnabled && sideTabs('l2', 'paint', true, false).propsEnabled, 'Properties enabled only with a selection');
check(sideTabs('l1', 'props', true, true).shown === 'paint' && !sideTabs('l1', 'props', true, true).propsEnabled, 'a reveal\'s new tile picked in the sheet: Paint shown, Properties disabled');
const l = sideTabs('l1', 'paint', false, false).labels, s = sideTabs('sprites', 'paint', false, false).labels;
check(l.paint === 'Picker' && l.props === 'Properties', 'the layer modes: Picker | Properties (#478)');
check(s.paint === 'Picker' && s.props === 'Properties', 'the sprites mode: Picker | Properties, as every editor');

// what a plain click (and a right click: its menu) on layer 1 takes as an object rather than a brush tile (#434)
check(clickSelects(STAR_TILE, false, kinds) && clickSelects(PIPE_TILE, false, kinds), 'a star or pipe 5B without a link: selected (Link to… reachable)');
check(clickSelects(0x100 | STAR_TILE, false, kinds), 'a star 15F without a link: selected');
check(clickSelects(ANY_WAY_TILE, false, kinds), 'the pipe 82 without a link: selected (it can be linked too)');
check(!clickSelects(0x04, false, kinds), 'a path tile: picked into the brush');
check(clickSelects(0x04, true, kinds), 'any link end (an exit path tile, a location): selected');

// ---- the selection ----
{
  const g = new OwGesture<string, string, string>();
  check(g.tile === -1 && g.tabs('l1', false).shown === 'paint' && !g.tabs('l1', false).selected, 'nothing selected: the picker');
  g.selectTile(0x123, 'a link');
  check(g.tile === 0x123 && g.link === 'a link' && g.tabs('l1', false).shown === 'props', 'a tile selected with the link meant at it: its properties shown');
  g.show('paint');
  check(g.tabs('l1', false).shown === 'paint' && g.tabs('l1', false).propsEnabled && g.tile === 0x123, 'the picker clicked: shown, the selection kept');
  g.selectTile(0x124, null, false);
  check(g.tile === 0x124 && g.link === null && g.tabs('l1', false).shown === 'paint', 'the selection kept on its tile by an edit: the tab stays, the link meant is the new tile\'s');
  g.link = 'another';
  g.selectTile(-1, null);
  check(g.tile === -1 && g.link === null, 'the tile\'s selection ended: the link meant at it too');
  g.selectTile(5, 'x');
  g.selectTile(-1, null);
  g.selectTile(6, null);
  check(g.tabs('l1', false).shown === 'props', 'after a selection ended the next one shows its properties again');
}
// ---- what a change of mode or map ends ----
{
  const g = new OwGesture<string, string, string>();
  const all = () => { g.selectTile(7, 'l'); g.sprite = 's'; g.pieces = { x: 0, y: 0, w: 4, h: 4 }; };
  all(); g.leave('mode', 'sprites');
  check(g.tile === -1 && g.link === null && g.sprite === null && g.pieces === null, 'another mode: the tile, the link meant, the sprite and the pieces marked end');
  all(); g.leave('mode', 'l2');
  check(g.tile === -1 && g.sprite === null && g.pieces !== null, 'to the layer 2 mode: the pieces marked stay');
  all(); g.leave('map', 'l2');
  check(g.tile === -1 && g.link === null && g.pieces === null && g.sprite === 's', 'another map: the tile and the pieces end, the sprite stays selected (the slots are the same on every submap)');
  g.leave('mode', 'sprites'); g.sprite = 's';
  check(g.tabs('sprites', false).selected && !g.tabs('l1', false).selected, 'in the sprites mode a sprite is the selection, in the layer modes a tile');
}

// ---- the cell request ----
{
  const g = new OwGesture<string, string, string>();
  check(g.request === null && g.asksFor() === null && !g.endRequest(), 'no cell asked for');
  g.ask({ kind: 'link', what: 'from a star' });
  g.ask({ kind: 'reveal', at: -1 });
  check(g.request?.kind === 'reveal', 'asking for another cell ends the request before: at most one');
  check(g.asksFor() === 'cell', 'a reveal\'s tile: a layer 1 cell asked for on the map');
  g.ask({ kind: 'reveal', at: 0x42 });
  check(g.asksFor() === null && g.request?.kind === 'reveal', 'its cell chosen: the tile it becomes is asked for in the sheet, not on the map');
  g.ask({ kind: 'replace', from: null });
  check(g.asksFor() === 'piece', 'the piece to replace: a piece asked for');
  g.ask({ kind: 'link', what: 'x' });
  check(g.asksFor() === 'cell' && g.endRequest() && g.request === null, 'a link\'s other end: a cell; ended');

  // what it outlives
  const after = (r: Parameters<typeof g.ask>[0], what: 'mode' | 'map', mode: 'l1' | 'l2' | 'sprites') => { g.ask(r); const ended = g.leave(what, mode); const still = g.request !== null; g.endRequest(); return ended === !still && still; };
  check(after({ kind: 'reveal', at: -1 }, 'mode', 'sprites') && after({ kind: 'destroy', at: -1 }, 'map', 'l1'), 'a reveal\'s or destroy\'s cell stays asked for over a change of mode and of map');
  check(after({ kind: 'reveal', at: 5 }, 'mode', 'l1') && !after({ kind: 'reveal', at: 5 }, 'mode', 'l2') && after({ kind: 'reveal', at: 5 }, 'map', 'l1'), 'a reveal\'s new tile: ends outside layer 1 (its sheet), stays over the map');
  check(after({ kind: 'replace', from: null }, 'mode', 'l2') && !after({ kind: 'replace', from: null }, 'mode', 'l1') && !after({ kind: 'replace', from: [1] }, 'map', 'l2'), 'the piece to replace: ends outside layer 2 and with the map');
  check(!after({ kind: 'link', what: 'x' }, 'mode', 'l2') && after({ kind: 'link', what: 'x' }, 'map', 'l1'), 'a link\'s other end: ends with the mode, stays over the map (the tile may be on another one)');
}

// ---- what a press means ----
{
  const g = new OwGesture<string, string, string>();
  // a left click on a plain path tile of the map in the layer 1 mode, the tile brush
  const base: PressFacts = { button: 0, shift: false, alt: false, ctrl: false, mode: 'l1', jump: false, viewsKnown: true, grab: false, onMap: true, levelTile: false,
    tile: 0x04, linkEnd: false, kinds, brush: 'tiles', unpaintable: null };
  const on = (f: Partial<PressFacts>) => { const a = g.press({ ...base, ...f }); return a.kind === 'menu' ? `menu ${a.of}${a.route ? ' route' : ''}` : a.kind === 'refused' ? `refused ${a.why}` : a.kind; };
  const right = { button: 2 }, shiftClick = { shift: true };
  check(on({}) === 'pick' && on({ mode: 'l2' }) === 'pick', 'a click: tiles taken into the brush');
  check(on(right) === 'stroke' && on(shiftClick) === 'stroke' && on({ ...right, mode: 'l2' }) === 'stroke', 'a right click or Shift+click paints');
  check(on({ alt: true }) === 'info' && on({ alt: true, mode: 'l2' }) === 'info', 'Alt+click: the tile\'s info');
  check(on({ button: 1 }) === 'none', 'the middle button: nothing');
  check(on({ levelTile: true }) === 'moveLevelTile' && on({ levelTile: true, ...right }) === 'menu level' && on({ levelTile: true, ...shiftClick }) === 'menu level',
    'a level tile (ADR 0012): a click selects it and a drag moves it, a right click or Shift+click its menu');
  check(on({ levelTile: true, alt: true }) === 'info' && on({ levelTile: true, ctrl: true }) === 'pick', 'a level tile with Alt: its info; with Ctrl: a pick starts there');
  check(on({ linkEnd: true }) === 'select' && on({ linkEnd: true, ...right }) === 'menu link', 'a link end: a click selects it, a right click its menu');
  check(on({ tile: STAR_TILE }) === 'select' && on({ tile: STAR_TILE, ...right }) === 'stroke', 'a star without a link: selected by a click, painted over by a right click (#434)');
  check(on({ tile: STAR_TILE, kinds: null }) === 'pick', 'while the path kinds are learned a star is a tile like any');
  check(on({ levelTile: true, ...right, brush: 'route' }) === 'menu level route' && on({ linkEnd: true, ...right, brush: 'route' }) === 'menu link route' && on({ ...right, brush: 'route' }) === 'route',
    'the route brush: a route drawn; on a level tile or link end its menu once released without a drag');
  check(on({ ...right, brush: 'look' }) === 'placeLevel' && on({ ...right, brush: 'look', onMap: false }) === 'none' && on({ brush: 'look' }) === 'pick' && on({ ...right, brush: 'look', levelTile: true }) === 'menu level',
    'a level tile\'s look as the brush: a right click places a level, on a level tile its menu; a click picks tiles');
  check(on({ ...right, unpaintable: 'learning' }) === 'refused learning' && on({ ...right, unpaintable: 'emulating', levelTile: true }) === 'menu level' && on({ unpaintable: 'noMap' }) === 'pick',
    'layer 1 not paintable just now: a stroke is refused with the reason, a menu and a pick are not');
  check(on({ grab: true }) === 'grab' && on({ grab: true, ...right }) === 'stroke' && on({ grab: true, alt: true }) === 'info', 'on what the selection leads to: a plain click drags it');
  check(on({ jump: true }) === 'jump' && on({ jump: true, levelTile: true }) === 'jump', 'a label\'s link symbol: the other end shown, before anything under it');
  check(on({ mode: 'sprites' }) === 'sprite' && on({ mode: 'sprites', ...right }) === 'none' && on({ mode: 'sprites', viewsKnown: false }) === 'none', 'the sprites mode: the left button is the sprites\'; not before the submaps\' views are known');
  // a cell asked for takes the left click
  g.ask({ kind: 'reveal', at: -1 });
  check(on({ levelTile: true }) === 'answer' && on({ mode: 'sprites' }) === 'answer' && on({ mode: 'l2' }) === 'answer', 'a reveal\'s cell asked for: the left click answers, in every mode, on a level tile too');
  check(on(right) === 'stroke' && on({ levelTile: true, ...right }) === 'menu level' && on({ jump: true }) === 'jump', 'a right click paints or opens a menu meanwhile; a label\'s link symbol still jumps');
  g.ask({ kind: 'reveal', at: 7 });
  check(on({}) === 'pick', 'a reveal\'s new tile is asked for in the sheet: a click on the map is a click');
  g.ask({ kind: 'replace', from: null });
  check(on({ mode: 'l2' }) === 'answer', 'the piece to replace asked for: the left click answers');
  g.ask({ kind: 'link', what: 'x' });
  check(on({ levelTile: true }) === 'answer' && on({ grab: true }) === 'answer' && on({ levelTile: true, shift: true }) === 'answer', 'a link\'s other end asked for: the left click answers, on a level tile and with Shift too');
  g.endRequest();
}

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
