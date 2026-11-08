// A path tile's shape shown (CONTEXT.md "Path shape"): the ways Mario takes over a tile – the lines the overworld
// editor draws through its mark (the "Path tiles" overlay, the layer 1 sheet) and the words its popup and status bar
// say – derived from the path shapes learned by emulation (owpaths.ts). Pure: nothing drawn.
import { DX, DY, NO_SHAPE, PATH_KIND_NAMES, reverse, turnedAt, type PathKind, type PathShapes } from './owpaths.ts';
import { walkFrom, neighbor, type ReachInput } from './owreach.ts';

// the kinds whose tiles Mario walks over by their shape, on the map they are on (the route solver's, owroute.ts; a
// stop or level tile stops him)
export const WALKED_KINDS: readonly PathKind[] = ['walk', 'climb', 'swim'];
// the kinds whose tiles show a shape: those walked over, and an exit, whose vector moves him on from where the exit
// path takes him on the other submap – shown as its axis (exitAxis)
export const SHAPED_KINDS: readonly PathKind[] = [...WALKED_KINDS, 'exit'];

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
// tile's vector for another direction moves him somewhere he never comes from). An exit tile's ways are the straight
// line along its axis, both ways (exitAxis; the way back isn't tested: its vector acts on the other submap).
export function pathWays(t: number, kind: PathKind | undefined, shapes: PathShapes | null): PathWay[] {
  if (!shapes || !kind || !SHAPED_KINDS.includes(kind)) return [];
  if (kind === 'exit') return exitWays(t, shapes);
  const all = waysOver(t, shapes);
  const ways: PathWay[] = [], taken = (dir: number) => ways.some((w) => w.dir === dir);
  for (let dir = 0; dir < 4; dir++) {
    if (taken(dir)) continue;
    let best: PathWay | null = null, bestScore = Infinity;
    for (const w of all) {
      if (w.dir !== dir || taken(reverse(w.out))) continue;
      // (the line's middle nearest the tile's; at a tie the point nearest the side's middle)
      const along = DX[dir] ? w.from[1] : w.from[0];
      const score = Math.abs((w.from[0] + w.to[0]) / 2 - 8) + Math.abs((w.from[1] + w.to[1]) / 2 - 8) + Math.abs(along - 8) / 100;
      if (score < bestScore) { bestScore = score; best = w; }
    }
    if (best) ways.push(best, back(best));
  }
  return ways;
}

// The ways Mario takes over each path tile of a map (l1: both maps, l1Index order), as the game moves him: a tile's
// shape alone doesn't say where on its side he steps on – a straight tile (02, 04, 06) moves him a tile on at the
// height the tile before left him –, so he is followed from every stop and level tile in each direction there is a
// tile to walk onto (owreach.ts walkFrom, whatever the level flags open; to the next stop, level or exit tile) and each
// path tile gets the lines he walks on over it, each way followed by its way back (as pathWays). A cell no walk from
// a stop or level tile leads over has none.
export function mapWays(l1: ArrayLike<number>, kinds: readonly PathKind[], shapes: PathShapes): Map<number, PathWay[]> {
  const inp: ReachInput = { l1, tls: new Uint8Array(l1.length), flags: [], kinds, shapes, start: 0, stars: new Map(), exitPaths: [], hard: [] };
  const out = new Map<number, PathWay[]>(), key = (w: PathWay) => `${w.dir} ${w.from} ${w.to}`;
  const add = (cell: number, from: [number, number], to: [number, number], dir: number, out_: number) => {
    const w: PathWay = { dir, out: out_, from, to }, ways = out.get(cell) ?? [];
    if (!ways.some((v) => key(v) === key(w) || key(v) === key(back(w)))) ways.push(w, back(w));
    out.set(cell, ways);
  };
  for (let i = 0; i < l1.length; i++) {
    const k = kinds[l1[i]];
    if (k !== 'stop' && k !== 'level') continue;
    for (let d = 0; d < 4; d++) {
      const n = neighbor(i, d);
      if (n >= 0 && kinds[l1[n]] !== 'none') walkFrom(inp, i, d, add);
    }
  }
  return out;
}

// The ways tile t is shown with where no walk says (the layer 1 sheet, a cell Mario doesn't walk over): those the map's
// cells with it are walked on most (mapWays; per way onto it, the one most cells have), then pathWays' for the ways
// onto it none of them takes – its most centred lines. Page 1 acts as page 0, so its tiles count together.
export function usualWays(t: number, kind: PathKind | undefined, shapes: PathShapes | null, l1: ArrayLike<number>, walked: ReadonlyMap<number, readonly PathWay[]>): PathWay[] {
  const centred = pathWays(t, kind, shapes);
  if (!centred.length || kind === 'exit') return centred;
  const count = new Map<string, { w: PathWay; n: number }>();
  for (const [cell, ways] of walked) {
    if ((l1[cell] & 0xff) !== (t & 0xff)) continue;
    for (const w of ways) {
      const c = count.get(`${w.dir} ${w.from} ${w.to}`) ?? { w, n: 0 };
      c.n++;
      count.set(`${w.dir} ${w.from} ${w.to}`, c);
    }
  }
  const ways: PathWay[] = [], taken = (dir: number) => ways.some((w) => w.dir === dir);
  const byUse = [...count.values()].sort((a, b) => b.n - a.n).map((c) => c.w);
  for (const w of [...byUse, ...centred]) if (!taken(w.dir) && !taken(reverse(w.out))) ways.push(w, back(w));
  return ways;
}

// Every way over tile t, from any of the points along a side he may step on at – not only the most centred line
// pathWays shows: a stair leaves him higher or lower, and the tile after takes him on from there (the route solver,
// owroute.ts). Each way's way back is in the list too.
export function tileWays(t: number, kind: PathKind | undefined, shapes: PathShapes | null): PathWay[] {
  if (!shapes || !kind || !WALKED_KINDS.includes(kind)) return [];
  const out: PathWay[] = [], key = (w: PathWay) => `${w.dir} ${w.from}`;
  for (const w of waysOver(t, shapes)) for (const v of [w, back(w)]) if (!out.some((o) => key(o) === key(v))) out.push(v);
  return out;
}

const back = (w: PathWay): PathWay => ({ dir: reverse(w.out), out: reverse(w.dir), from: w.to, to: w.from });

// An exit tile's axis: the game moves Mario on by the exit tile's "walk" vector from where the exit path table put
// him on the other submap ($04971D), so he comes out going on along it – up or down ('vertical'), left or right
// ('horizontal'); entered across it he is turned by 90°, off the path (docs/research/overworld-submap-exit-tiles.md).
// From the learned vectors of the four ways onto it; null where none is known or they don't share one axis.
export type ExitAxis = 'vertical' | 'horizontal';
export function exitAxis(t: number, shapes: PathShapes): ExitAxis | null {
  const vs = learnedVectors(shapes.walk, t);
  if (!vs.length) return null;
  if (vs.every(([x, y]) => x === 0 && y !== 0)) return 'vertical';
  if (vs.every(([x, y]) => y === 0 && x !== 0)) return 'horizontal';
  return null;
}
// tile t's learned vectors (v: PathShapes' first or walk) for the ways onto it that have one: x, y, the way
const learnedVectors = (v: readonly number[], t: number): [number, number, number][] =>
  [0, 1, 2, 3].flatMap((d) => {
    const k = (t * 4 + d) * 2;
    return v[k] === undefined || v[k] === NO_SHAPE ? [] : [[v[k], v[k + 1], d] as [number, number, number]];
  });
// the straight line through an exit tile along its axis, both ways (up then down, or left then right)
function exitWays(t: number, shapes: PathShapes): PathWay[] {
  const axis = exitAxis(t, shapes);
  if (!axis) return [];
  const w: PathWay = axis === 'vertical' ? { dir: 0, out: 0, from: [8, 16], to: [8, 0] } : { dir: 2, out: 2, from: [16, 8], to: [0, 8] };
  return [w, back(w)];
}
// whether Mario's first step off a stop or level tile onto exit tile t misses the exit: it doesn't end half a tile on,
// in the middle of the side between the tiles, where the exit path table expects him (4D: +4, −8 in every direction;
// the exit matches no entry and he walks back) – from the learned "first" vectors, any way onto it
export function exitFirstStepMisses(t: number, shapes: PathShapes): boolean {
  return learnedVectors(shapes.first, t).some(([x, y, d]) => x !== DX[d] * 8 || y !== DY[d] * 8);
}
// whether stepping onto tile t gives Mario the climbing pose (owpaths.ts PathShapes pose, bit 4), any way onto it
const POSE_CLIMB = 0x10;
export const climbedOnto = (t: number, shapes: PathShapes): boolean => [0, 1, 2, 3].some((d) => {
  const p = shapes.pose[t * 4 + d] ?? -1;
  return p >= 0 && (p & POSE_CLIMB) !== 0;
});

// the ways over tile t whose way back leads back (by direction, then the point along the side, ALONG order)
function waysOver(t: number, shapes: PathShapes): PathWay[] {
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
  const ways: PathWay[] = [];
  for (let dir = 0; dir < 4; dir++) {
    for (const along of ALONG) {
      // (on the side behind him: moving right at x 0)
      const x = DX[dir] ? 8 - DX[dir] * 8 : along, y = DY[dir] ? 8 - DY[dir] * 8 : along, there = step(x, y, dir);
      if (!there) continue;
      const b = step(there.to[0], there.to[1], reverse(there.out));
      if (!b || b.to[0] !== x || b.to[1] !== y || b.out !== reverse(dir)) continue;
      ways.push({ dir, out: there.out, from: [x, y], to: there.to });
    }
  }
  return ways;
}

// the ways in words: "from below to the right, from the right down" (the side he steps on from, the direction he
// goes on in)
const FROM_SIDE = ['from below', 'from above', 'from the right', 'from the left'], GOES_ON = ['up', 'down', 'to the left', 'to the right'];
// one way in words: "from below to the right" (stepping on in direction dir, going on in direction out)
export const wayText = (dir: number, out: number): string => `${FROM_SIDE[dir]} ${GOES_ON[out]}`;
export const pathWaysText = (ways: readonly PathWay[]): string => ways.map((w) => wayText(w.dir, w.out)).join(', ');
export const SHAPES_LEARNING = 'its shape is being learned…';
// what an exit tile's axis says (exitAxis)
export const EXIT_AXIS_TEXT: Record<ExitAxis, string> = {
  vertical: 'from above or below (Mario comes out going on that way)',
  horizontal: 'from the left or right (Mario comes out going on that way)',
};
export const EXIT_FIRST_STEP_MISSES = 'Not next to a stop or level tile: Mario\'s first step off it misses the exit';
export const CLIMBED_ONTO = 'Climbed onto';
// what a path tile (owpaths.ts isPathKind) is called with its shape, a line each: "Path: walk · from below to the
// right, …"; an exit tile's axis ("Path: exit to another submap · from above or below …") and where its first step
// misses or it is climbed onto, a line each (shapes: null while they are learned)
export function pathTileLines(t: number, kind: PathKind, shapes: PathShapes | null): string[] {
  if (!SHAPED_KINDS.includes(kind)) return [PATH_KIND_NAMES[kind]];
  if (!shapes) return [`${PATH_KIND_NAMES[kind]} · ${SHAPES_LEARNING}`];
  if (kind === 'exit') {
    const axis = exitAxis(t, shapes);
    return [
      axis ? `${PATH_KIND_NAMES.exit} · ${EXIT_AXIS_TEXT[axis]}` : PATH_KIND_NAMES.exit,
      exitFirstStepMisses(t, shapes) ? EXIT_FIRST_STEP_MISSES : '',
      climbedOnto(t, shapes) ? CLIMBED_ONTO : '',
    ].filter(Boolean);
  }
  const ways = pathWaysText(pathWays(t, kind, shapes));
  return [ways ? `${PATH_KIND_NAMES[kind]} · ${ways}` : PATH_KIND_NAMES[kind]];
}
// pathTileLines in one line (the status bar's)
export const pathTileText = (t: number, kind: PathKind, shapes: PathShapes | null): string => pathTileLines(t, kind, shapes).join(' · ');
