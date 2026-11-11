// The overworld's side panel tabs (ADR 0015, #460, ui/owselection.ts sideTabs): "Paint | Properties" ("Sprites |
// Sprite" in the sprites mode); the tab chosen shown while something is selected, Paint otherwise and while a reveal's
// new tile is picked in the layer 1 sheet; Properties disabled without a selection. And what a plain click selects
// rather than picking into the brush (#434, clickSelects): a link end, a star or pipe with or without a link.
// node tools/testowselection.ts
import { sideTabs, clickSelects } from '../src/ui/owselection.ts';
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

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
