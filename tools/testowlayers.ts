// What the overworld editor draws of its two layers (core/owlayers.ts), each mode what its task needs (#412): painting
// layer 1 – its level tiles as objects (ADR 0012) – with its path marks, layer 2 dimmed or full (Q held: gone);
// painting layer 2 with all of layer 1 – pixels, path marks – dimmed or gone together (Q held: the other way); the
// object modes (links, sprites) both layers at full strength, no path marks.
import { layerStrengths, DIM_STRENGTH, type LayerView } from '../src/core/owlayers.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const v = (o: Partial<LayerView>): LayerView => ({ mode: 'l1', dimL2: true, l1InL2: true, solo: false, ...o });
const is = (s: { l1: number; l2: number; marks: number }, l1: number, l2: number, marks: number) => s.l1 === l1 && s.l2 === l2 && s.marks === marks;

check(DIM_STRENGTH > 0.3 && DIM_STRENGTH < 0.5, 'dimmed: about 40 % strength');
check(is(layerStrengths(v({ mode: 'l1' })), 1, DIM_STRENGTH, 1), 'painting layer 1: layer 2 dimmed, the path marks shown');
check(is(layerStrengths(v({ mode: 'l1', dimL2: false })), 1, 1, 1), 'painting layer 1, the dimming off: layer 2 full');
check(is(layerStrengths(v({ mode: 'l1', solo: true })), 1, 0, 1) && is(layerStrengths(v({ mode: 'l1', dimL2: false, solo: true })), 1, 0, 1), 'painting layer 1, Q held: layer 2 gone');
check(is(layerStrengths(v({ mode: 'l1', l1InL2: false })), 1, DIM_STRENGTH, 1), 'painting layer 1: the layer 2 mode\'s switch does nothing');
check(is(layerStrengths(v({ mode: 'l2' })), DIM_STRENGTH, 1, DIM_STRENGTH), 'painting layer 2: layer 1 and its path marks dimmed together');
check(is(layerStrengths(v({ mode: 'l2', l1InL2: false })), 0, 1, 0), 'painting layer 2, layer 1 switched off: it and its path marks gone');
check(is(layerStrengths(v({ mode: 'l2', solo: true })), 0, 1, 0), 'painting layer 2, Q held: layer 1 gone');
check(is(layerStrengths(v({ mode: 'l2', l1InL2: false, solo: true })), DIM_STRENGTH, 1, DIM_STRENGTH), 'painting layer 2 with layer 1 off, Q held: layer 1 dimmed');
check(is(layerStrengths(v({ mode: 'l2', dimL2: false })), DIM_STRENGTH, 1, DIM_STRENGTH), 'painting layer 2: the layer 1 mode\'s dimming does nothing');
for (const mode of ['links', 'sprites'] as const)
  check(is(layerStrengths(v({ mode })), 1, 1, 0) && is(layerStrengths(v({ mode, solo: true, l1InL2: false, dimL2: false })), 1, 1, 0), `${mode} mode: both layers full, no path marks, Q and the switches do nothing`);

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
