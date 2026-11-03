// What the overworld editor draws of its two layers: while a layer is painted (modes l1/l2) the other one dimmed, or
// gone while Q is held (solo); in the object modes (links, sprites) both at full strength. View → Layers' switches
// (showL1/showL2) win: a layer switched off is never drawn.
export type OwMode = 'l1' | 'l2' | 'links' | 'sprites';
export interface LayerView {
  mode: OwMode;
  showL1: boolean;
  showL2: boolean;
  dim: boolean; // "Dim the layer not painted" (View → Layers)
  solo: boolean; // Q held
}
// the strength the layer not painted is drawn at
export const DIM_STRENGTH = 0.4;
// each layer's strength: 1 full, DIM_STRENGTH dimmed, 0 not drawn
export function layerStrengths(v: LayerView): { l1: number; l2: number } {
  const painted = v.mode === 'l1' || v.mode === 'l2' ? v.mode : null;
  const other = !painted ? 1 : v.solo ? 0 : v.dim ? DIM_STRENGTH : 1;
  return {
    l1: !v.showL1 ? 0 : painted === 'l2' ? other : 1,
    l2: !v.showL2 ? 0 : painted === 'l1' ? other : 1,
  };
}
