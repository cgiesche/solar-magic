// An object thumbnail's (or a placement preview's) pixels on a canvas (core/objthumbs.ts)

import type { ObjThumb } from '../core/objthumbs.ts';

export function thumbCanvas(t: Pick<ObjThumb, 'w' | 'h' | 'px'>): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = t.w; c.height = t.h;
  const ctx = c.getContext('2d')!;
  const id = ctx.createImageData(t.w, t.h);
  new Uint32Array(id.data.buffer).set(t.px);
  ctx.putImageData(id, 0, 0);
  return c;
}
