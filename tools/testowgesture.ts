// What is on in the overworld editor (ui/owgesture.ts, #554). The selection: a layer 1 tile with the link layer's
// choice at it, a sprite in the sprites mode, the pieces marked on layer 2 – and what a change of mode or map ends of
// them. The side panel's tabs (ADR 0015, #460, sideTabs): "Picker | Properties", the tab chosen shown while something
// is selected, the picker otherwise and while a reveal's new tile is picked in the layer 1 sheet; Properties disabled
// without a selection. And what a plain click selects rather than picking into the brush (#434, clickSelects): a link
// end, a star or pipe with or without a link.
// node tools/testowgesture.ts
import { OwGesture, sideTabs, clickSelects } from '../src/ui/owgesture.ts';
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
  const g = new OwGesture<string, string>();
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
  const g = new OwGesture<string, string>();
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

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
