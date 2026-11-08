// What the overworld editor draws of its two layers, each mode what its task needs (#412): painting layer 1 (the level
// tiles as objects on it, ADR 0012) with its path marks, layer 2 dimmed (View → Layers) or full, gone while Q is held;
// painting layer 2 with all of layer 1 – its pixels, path marks, level numbers, unreached tiles – dimmed together, or
// gone (View → Layers), Q held the other way; the sprites mode both layers at full strength without path marks.
export type OwMode = 'l1' | 'l2' | 'sprites';
// whether mode m paints a layer (l1, l2) rather than objects
export const isLayerMode = (m: OwMode): m is 'l1' | 'l2' => m === 'l1' || m === 'l2';
export interface LayerView {
  mode: OwMode;
  dimL2: boolean; // "Dim layer 2 while painting layer 1" (View → Layers)
  l1InL2: boolean; // "Layer 1 while painting layer 2" (View → Layers)
  solo: boolean; // Q held
}
// the strength the layer not painted is drawn at
export const DIM_STRENGTH = 0.4;
// each layer's strength and its path marks' (layer 1's overlays): 1 full, DIM_STRENGTH dimmed, 0 not drawn; the marks
// go with layer 1 where a layer is painted, the object modes show layer 1 without them
export interface LayerStrengths { l1: number; l2: number; marks: number }
export function layerStrengths(v: LayerView): LayerStrengths {
  if (v.mode === 'l1') return { l1: 1, l2: v.solo ? 0 : v.dimL2 ? DIM_STRENGTH : 1, marks: 1 };
  if (v.mode === 'l2') {
    const l1 = v.l1InL2 !== v.solo ? DIM_STRENGTH : 0;
    return { l1, l2: 1, marks: l1 };
  }
  return { l1: 1, l2: 1, marks: 0 };
}
