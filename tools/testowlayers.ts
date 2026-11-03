// What the overworld editor draws of its two layers (core/owlayers.ts): the layer not painted dimmed (or hidden while
// Q is held) in the painting modes, both at full strength in the object modes, View → Layers' switches winning.
import { layerStrengths, DIM_STRENGTH, type LayerView } from '../src/core/owlayers.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const v = (o: Partial<LayerView>): LayerView => ({ mode: 'l1', showL1: true, showL2: true, dim: true, solo: false, ...o });
const is = (s: { l1: number; l2: number }, l1: number, l2: number) => s.l1 === l1 && s.l2 === l2;

check(DIM_STRENGTH > 0.3 && DIM_STRENGTH < 0.5, 'dimmed: about 40 % strength');
check(is(layerStrengths(v({ mode: 'l1' })), 1, DIM_STRENGTH), 'painting layer 1: layer 2 dimmed');
check(is(layerStrengths(v({ mode: 'l2' })), DIM_STRENGTH, 1), 'painting layer 2: layer 1 dimmed');
check(is(layerStrengths(v({ mode: 'links' })), 1, 1) && is(layerStrengths(v({ mode: 'sprites' })), 1, 1), 'links/sprites modes: nothing dimmed');
check(is(layerStrengths(v({ mode: 'l1', solo: true })), 1, 0) && is(layerStrengths(v({ mode: 'l2', solo: true })), 0, 1), 'Q held: the layer not painted gone');
check(is(layerStrengths(v({ mode: 'links', solo: true })), 1, 1) && is(layerStrengths(v({ mode: 'sprites', solo: true })), 1, 1), 'Q does nothing in the object modes');
check(is(layerStrengths(v({ mode: 'l1', dim: false })), 1, 1) && is(layerStrengths(v({ mode: 'l2', dim: false })), 1, 1), 'the switch off: nothing dimmed');
check(is(layerStrengths(v({ mode: 'l1', dim: false, solo: true })), 1, 0), 'Q hides the other layer also with the dimming off');
check(is(layerStrengths(v({ mode: 'l1', showL2: false })), 1, 0) && is(layerStrengths(v({ mode: 'l2', showL1: false, solo: true })), 0, 1), 'View → Layers\' switches win (the other layer hidden)');
check(is(layerStrengths(v({ mode: 'l1', showL1: false })), 0, 1) && is(layerStrengths(v({ mode: 'l2', showL2: false, solo: true })), 1, 0), 'the painted layer switched off: the other one at full strength (nothing to set it apart from), Q too');
check(is(layerStrengths(v({ mode: 'links', showL2: false })), 1, 0) && is(layerStrengths(v({ mode: 'sprites', showL1: false, showL2: false })), 0, 0), 'the switches also in the object modes');

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
