// Symbols for how a tile treats Mario (found by emulation, see CollisionProbe), drawn as shapes in
// tile pixels, text glyphs blur at 16 px: spikes on the sides that hurt, a skull on tiles that kill,
// a net over climbable ones. The collision overlay draws them over the level, the picker as badges.

import type { CollisionProbe } from '../core/blockprobe.ts';

export const SPIKE_COLOR = '#ffd24a';
export const NET_COLOR = 'rgba(150,255,170,0.8)';
export const HURT_FILL = 'rgba(255,70,70,0.4)', KILL_FILL = 'rgba(255,30,30,0.6)', CLIMB_FILL = 'rgba(60,220,90,0.35)';

// 8x8 px, drawn in the middle of the tile
const SKULL = ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'X..XX..X', 'X..XX..X', 'XXXX.XXX', '.XXXXXX.', '.X.XX.X.'];

export function drawSkull(ctx: CanvasRenderingContext2D, px: number, py: number): void {
  SKULL.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === 'X') ctx.fillRect(px + 4 + i, py + 4 + j, 1, 1); }));
}

// three spikes along a side of the tile at (px, py), pointing out of it: 0 top, 1 left, 2 right
export function spikeRow(p: Path2D, px: number, py: number, side: 0 | 1 | 2): void {
  for (const o of [0, 5, 10]) {
    const a = o + 0.5, m = o + 3, b = o + 5.5; // along the side
    const pts = side === 0 ? [[a, 4], [m, 0], [b, 4]] : side === 1 ? [[4, a], [0, m], [4, b]] : [[12, a], [16, m], [12, b]];
    p.moveTo(px + pts[0][0], py + pts[0][1]);
    for (const [qx, qy] of pts.slice(1)) p.lineTo(px + qx, py + qy);
    p.closePath();
  }
}

// diagonals every 8 px, which join into a net across neighboring tiles
export function netTile(p: Path2D, px: number, py: number): void {
  for (const d of [0, 8]) {
    p.moveTo(px + d, py); p.lineTo(px + 16, py + 16 - d);
    p.moveTo(px + 16 - d, py); p.lineTo(px, py + 16 - d);
    if (d) { p.moveTo(px, py + d); p.lineTo(px + 16 - d, py + 16); p.moveTo(px + 16, py + d); p.lineTo(px + d, py + 16); }
  }
}

export type CollisionMark = 'kills' | 'hurts' | 'climb';
export const MARK_TEXT: Record<CollisionMark, string> = { kills: 'kills', hurts: 'hurts', climb: 'climbable' };

// the marks any of the tiles has (kills over hurts, as in the overlay)
export function collisionMarks(probes: (CollisionProbe | undefined)[]): CollisionMark[] {
  const kills = probes.some((c) => c?.kills);
  return [
    ...(kills ? ['kills' as const] : probes.some((c) => c?.hurtsTop || c?.hurtsSide) ? ['hurts' as const] : []),
    ...(probes.some((c) => c?.climb) ? ['climb' as const] : []),
  ];
}

// a 16x16 badge of a mark, as the overlay draws such a tile on its own (hurts: spikes on a block)
export function markCanvas(mark: CollisionMark): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, 16, 16);
  ctx.fillStyle = mark === 'kills' ? KILL_FILL : mark === 'hurts' ? HURT_FILL : CLIMB_FILL;
  ctx.fillRect(0, 0, 16, 16);
  if (mark === 'kills') { ctx.fillStyle = '#fff'; drawSkull(ctx, 0, 0); }
  else if (mark === 'hurts') {
    // larger spikes than the overlay's, on a block
    const p = new Path2D();
    for (const o of [0, 5, 10]) { p.moveTo(o + 0.5, 11); p.lineTo(o + 3, 2); p.lineTo(o + 5.5, 11); p.closePath(); }
    ctx.fillStyle = SPIKE_COLOR;
    ctx.fill(p);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 11, 16, 5);
  }
  else { const p = new Path2D(); netTile(p, 0, 0); ctx.lineWidth = 1; ctx.strokeStyle = NET_COLOR; ctx.stroke(p); }
  return c;
}
