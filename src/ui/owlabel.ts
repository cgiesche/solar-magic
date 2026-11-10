// the overworld's small tile labels (a level tile's number, where an overworld link on another map leads): white
// bold text on a 7 pixel bar from (x, top), at least a tile wide; `bg` the bar's colour (a level tile's state)
export function tileLabel(ctx: CanvasRenderingContext2D, text: string, x: number, top: number, bg = 'rgba(0,0,0,0.6)'): void {
  ctx.font = 'bold 8px monospace';
  ctx.fillStyle = bg;
  ctx.fillRect(x, top, Math.max(16, ctx.measureText(text).width + 2), 7);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x + 1, top + 6);
}
