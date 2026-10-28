// The box of an object that draws no tile (objboxes.ts): a tile with its number, in the level view and as its
// thumbnail in the picker; editor-only. Its name, where known, is a label beside it while hovered or selected.

// one tile at x, y (level pixels)
export function paintObjectBox(ctx: CanvasRenderingContext2D, x: number, y: number, label: string): void {
  ctx.fillStyle = 'rgba(120,60,200,0.7)';
  ctx.fillRect(x, y, 16, 16);
  ctx.strokeStyle = '#d8c0ff';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, 15, 15);
  // as large as fits in the tile
  let size = 8;
  ctx.font = `bold ${size}px sans-serif`;
  const w = ctx.measureText(label).width;
  if (w > 14) { size = Math.max(4, (size * 14) / w); ctx.font = `bold ${size}px sans-serif`; }
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(label, x + 8, y + 8 + size * 0.36);
  ctx.textAlign = 'start';
}

export function objectBoxCanvas(label: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  paintObjectBox(c.getContext('2d')!, 0, 0, label);
  return c;
}

// the name right of the box at x, y, its letters the same size on the screen at any zoom
export function paintBoxName(ctx: CanvasRenderingContext2D, x: number, y: number, name: string, zoom: number): void {
  ctx.font = `${11 / zoom}px sans-serif`;
  const w = ctx.measureText(name).width + 4 / zoom, hh = 14 / zoom;
  const lx = x + 17, ly = y + 8 - hh / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(lx, ly, w, hh);
  ctx.fillStyle = '#fff';
  ctx.fillText(name, lx + 2 / zoom, ly + 11 / zoom);
}
