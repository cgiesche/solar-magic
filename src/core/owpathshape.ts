// A path tile's shape shown (CONTEXT.md "Path shape"): the ways Mario takes over a tile – the lines the overworld
// editor draws through its mark (the "Path tiles" overlay, the layer 1 sheet) and the words its popup and status bar
// say – derived from the path shapes learned by emulation (owpaths.ts). Pure: nothing drawn.
import { DX, DY, NO_SHAPE, PATH_KIND_NAMES, reverse, turnedAt, type PathKind, type PathShapes } from './owpaths.ts';

// the kinds whose tiles move Mario by their shape (an exit takes him to another submap, its vector unused; a stop or
// level tile stops him)
export const SHAPED_KINDS: readonly PathKind[] = ['walk', 'climb', 'swim'];

// A way over a path tile: Mario steps onto it in direction `dir` (DIR_NAMES order) at `from` on the side behind him
// (pixels in the tile); the shape's vector moves him to `to` on another side (the low 2 bits cleared) and turns him
// there to direction `out`.
export interface PathWay { dir: number; out: number; from: [number, number]; to: [number, number] }
const ALONG = [4, 8, 12]; // where along a side he may step on (not at a corner)

// The ways over tile t of kind `kind` (none while the shapes are learned, or for a kind not shaped), each followed by
// its way back (the same line). Where he steps on isn't the tile's own – the tile before leaves him there (a straight
// tile at the middle of the side, a stair higher or lower) –, so it is the point of the side (4, 8 or 12 along it)
// from which the vector leads to another side of the tile, the line most centred in the tile. A way counts where the
// way back is one too: from `to` in the opposite direction the tile's vector leads back to `from`, turning him back (a
// tile's vector for another direction moves him somewhere he never comes from).
export function pathWays(t: number, kind: PathKind | undefined, shapes: PathShapes | null): PathWay[] {
  if (!shapes || !kind || !SHAPED_KINDS.includes(kind)) return [];
  // stepping on at (x, y) in direction dir: where the vector moves him and the direction he goes on in (null: not to
  // another side of the tile)
  const step = (x: number, y: number, dir: number): { to: [number, number]; out: number } | null => {
    const k = (t * 4 + dir) * 2, vx = shapes.walk[k], vy = shapes.walk[k + 1];
    if (vx === undefined || vx === NO_SHAPE) return null;
    const tx = (x + vx) & ~3, ty = (y + vy) & ~3;
    if (tx < 0 || ty < 0 || tx > 16 || ty > 16 || ((tx & 15) && (ty & 15))) return null;
    // (not back to the side he stepped on at)
    if (DX[dir] ? tx === x : ty === y) return null;
    return { to: [tx, ty], out: turnedAt(tx, ty, vx, vy, dir) };
  };
  const ways: PathWay[] = [], taken = (dir: number) => ways.some((w) => w.dir === dir);
  for (let dir = 0; dir < 4; dir++) {
    if (taken(dir)) continue;
    let best: PathWay | null = null, bestScore = Infinity;
    for (const along of ALONG) {
      // (on the side behind him: moving right at x 0)
      const x = DX[dir] ? 8 - DX[dir] * 8 : along, y = DY[dir] ? 8 - DY[dir] * 8 : along, there = step(x, y, dir);
      if (!there || taken(reverse(there.out))) continue;
      const back = step(there.to[0], there.to[1], reverse(there.out));
      if (!back || back.to[0] !== x || back.to[1] !== y || back.out !== reverse(dir)) continue;
      // (the line's middle nearest the tile's; at a tie the point nearest the side's middle)
      const score = Math.abs((x + there.to[0]) / 2 - 8) + Math.abs((y + there.to[1]) / 2 - 8) + Math.abs(along - 8) / 100;
      if (score < bestScore) { bestScore = score; best = { dir, out: there.out, from: [x, y], to: there.to }; }
    }
    if (best) ways.push(best, { dir: reverse(best.out), out: reverse(dir), from: best.to, to: best.from });
  }
  return ways;
}

// the ways in words: "from below to the right, from the right down" (the side he steps on from, the direction he
// goes on in)
const FROM_SIDE = ['from below', 'from above', 'from the right', 'from the left'], GOES_ON = ['up', 'down', 'to the left', 'to the right'];
export const pathWaysText = (ways: readonly PathWay[]): string => ways.map((w) => `${FROM_SIDE[w.dir]} ${GOES_ON[w.out]}`).join(', ');
export const SHAPES_LEARNING = 'its shape is being learned…';
// what a path tile (owpaths.ts isPathKind) is called with its shape: "Path: walk · from below to the right, …"
// (shapes: null while they are learned)
export function pathTileText(t: number, kind: PathKind, shapes: PathShapes | null): string {
  if (!SHAPED_KINDS.includes(kind)) return PATH_KIND_NAMES[kind];
  const ways = shapes ? pathWaysText(pathWays(t, kind, shapes)) : SHAPES_LEARNING;
  return ways ? `${PATH_KIND_NAMES[kind]} · ${ways}` : PATH_KIND_NAMES[kind];
}
