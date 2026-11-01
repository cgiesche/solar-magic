// Resizing an object from any of its edges. The tiles an object covers at each size are found by emulating
// it alone (in batches, as objkinds.ts does), no built-in object tables. A drag aims at the tile under the
// mouse: of the sizes the dragged part of the settings byte can take, the one whose dragged edge lands
// nearest, with the origin moved so the edges opposite the dragged ones stay where they were.

import type { LevelEmulator, ObjectTrace } from './levelemu.ts';
import { OV_L1, MAP_BASE } from './levelemu.ts';
import { layerGeom } from './render.ts';
import { encodePrimaryHeader, serializeObjects, newUid, type LevelObject } from './level.ts';
import { objectLength2D, fitExtension } from './obj2d.ts';
import type { ObjKind, KindLevel } from './objkinds.ts';

// tiles covered, relative to the object's origin (or absolute, where said)
export interface Box { x0: number; y0: number; x1: number; y1: number }

// what of an object a probe depends on besides its size
export type SizeSpec = Pick<LevelObject, 'num' | 'ext' | 'size' | 'tile' | 'extension'>;

// objects per emulated load: each starts a screen with an empty one to its left (routines may grow to the left)
const PER = 13;

// an object's key among the probed ones: what the probe depends on
export function sizeKey(s: SizeSpec): string {
  return `${s.num}:${s.ext}:${s.size}:${s.tile ?? ''}:${s.extension?.join(',') ?? ''}`;
}

export class SizeProbe {
  private boxes = new Map<string, Box | null>();
  private pos: (off: number) => [number, number] | undefined;
  emu: LevelEmulator; // (another one may take over: the probe worker's job, sizesJob)
  private level: KindLevel;
  private layer2Pointer: number;

  constructor(emu: LevelEmulator, level: KindLevel, layer2Pointer: number) {
    this.emu = emu;
    this.level = level;
    this.layer2Pointer = layer2Pointer;
    const g = layerGeom(emu.rom, 0, 0, 32);
    const inv = new Map<number, [number, number]>();
    for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) inv.set(g.addr(x, y) - MAP_BASE, [x, y]);
    this.pos = (off) => inv.get(off);
  }

  // the tiles the object covers at its size (null: it draws nothing or its load fails), undefined while not probed
  box(s: SizeSpec): Box | null | undefined {
    return this.boxes.get(sizeKey(s));
  }

  // probes the objects not probed yet, at most `loads` emulated loads; whether all are known now
  probe(specs: SizeSpec[], loads = Infinity): boolean {
    const todo = new Map<string, SizeSpec>();
    for (const s of specs) { const k = sizeKey(s); if (!this.boxes.has(k)) todo.set(k, s); }
    // each batch from large to small sizes across the whole range: the widest starts leftmost, so wide
    // objects (a width up to 255) still end inside the level
    const sorted = [...todo.values()].sort((a, b) => b.size - a.size), nb = Math.ceil(sorted.length / PER);
    const list = Array.from({ length: nb }, (_, j) => sorted.filter((_, i) => i % nb === j)).flat(), queue: [number, number][] = [];
    for (let i = 0, j = 0; j < nb; j++) { const n = Math.ceil((sorted.length - j) / nb); queue.push([i, i + n]); i += n; }
    while (queue.length && loads-- > 0) {
      const [a, b] = queue.shift()!;
      const r = this.run(list.slice(a, b));
      // a crashing object spoils its whole batch: the halves are loaded again
      if (r) r.forEach((box, i) => this.boxes.set(sizeKey(list[a + i]), box));
      else { const h = a + ((b - a) >> 1); queue.unshift([a, h], [h, b]); }
    }
    return !queue.length;
  }

  // null: the load failed and the batch has to be split
  private run(batch: SizeSpec[]): (Box | null)[] | null {
    const len2d = objectLength2D(this.emu.rom);
    const objs: LevelObject[] = batch.map((s, i) => ({ uid: newUid(), num: s.num, ext: s.ext, size: s.size, x: i * 32 + 16, y: 4,
      ...(s.tile !== undefined ? { tile: s.tile } : {}), ...(s.extension ? { extension: [...s.extension] } : {}) }));
    for (const o of objs) fitExtension(o, len2d);
    const owners: number[] = [-1, -1, -1, -1, -1];
    const body = serializeObjects(objs, [], false, owners);
    const l1 = new Uint8Array(5 + body.length);
    l1.set(encodePrimaryHeader({ ...this.level.header, screens: 32, mode: 0 }));
    l1.set(body, 5);
    const byteOwner = new Int32Array(0x10000).fill(-1);
    owners.forEach((o, i) => (byteOwner[OV_L1 + i] = o));
    const r = this.emu.load(this.level.number, { layer1: l1, layer2Pointer: this.layer2Pointer, sprites: new Uint8Array([0, 0xff]), byteOwner, trace: true });
    if (!r.ok && batch.length > 1) return null;
    const tr = r.trace as ObjectTrace;
    return objs.map((o, i) => {
      const w = r.ok ? tr.writes.get(i) : undefined;
      if (!w?.size) return null;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const off of w.keys()) {
        const p = this.pos(off);
        if (!p) continue;
        x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
      }
      return x1 < x0 ? null : { x0: x0 - o.x, y0: y0 - o.y, x1: x1 - o.x, y1: y1 - o.y };
    });
  }
}

// The boxes of objects (SizeProbe) in a level (layer2Pointer: its layer 2 objects as the probe loads take them) as a
// job (the result learner's, in the probe worker; no picture): a load per step, the boxes in the order of specs. The
// probe keeps the boxes between jobs (the owner drops it when the ROM changes or the level is another).
export function* sizesJob(probe: SizeProbe, specs: SizeSpec[]): Generator<void, (Box | null)[]> {
  while (!probe.probe(specs, 1)) yield;
  return specs.map((s) => probe.box(s) ?? null);
}

// ---- which part of the settings byte sizes which axis ----

// a nibble, or the whole byte (a width up to 255)
export type Part = 'lo' | 'hi' | 'byte';
const MASK: Record<Part, number> = { lo: 0x0f, hi: 0xf0, byte: 0xff };

// the parts that size the object (a type nibble and an ignored one don't); kind null: plain (low = width, high = height)
export function sizeParts(kind: ObjKind | null | undefined): Part[] {
  if (!kind) return ['lo', 'hi'];
  if (kind.lo === 'w' && kind.hi === 'w') return ['byte'];
  return [...kind.lo ? ['lo' as const] : [], ...kind.hi ? ['hi' as const] : []];
}

// every settings byte the part can give, the rest as in size
export function partSizes(size: number, part: Part): number[] {
  const n = part === 'byte' ? 256 : 16, sh = part === 'hi' ? 4 : 0;
  return Array.from({ length: n }, (_, v) => (size & ~MASK[part] & 0xff) | (v << sh));
}

// the part that sizes each axis: the one whose sizes move that axis' edges, the one the kind names for it first
export interface Drivers { x: Part | null; y: Part | null }
export function drivers(kind: ObjKind | null | undefined, size: number, box: (size: number) => Box | null | undefined): Drivers {
  const parts = sizeParts(kind);
  const named = (p: Part) => (p === 'byte' ? 'w' : kind ? kind[p] : p === 'lo' ? 'w' : 'h');
  // (value 0 left out: it is often taken as 256 and runs into the level's edges)
  const moves = (p: Part, axis: 'x' | 'y') => {
    const ext = new Set<number>();
    for (const s of partSizes(size, p).slice(1, 16)) { const b = box(s); if (b) ext.add(axis === 'x' ? b.x1 - b.x0 : b.y1 - b.y0); }
    return ext.size > 1;
  };
  const pick = (axis: 'x' | 'y') => {
    const ps = parts.filter((p) => moves(p, axis));
    return ps.find((p) => named(p) === (axis === 'x' ? 'w' : 'h')) ?? ps[0] ?? null;
  };
  return { x: pick('x'), y: pick('y') };
}

// the axes a kind sizes, before the emulated boxes are known
export function namedDrivers(kind: ObjKind | null | undefined): Drivers {
  const parts = sizeParts(kind);
  const axis = (p: Part) => (p === 'byte' ? 'w' : kind ? kind[p] : p === 'lo' ? 'w' : 'h');
  return { x: parts.find((p) => axis(p) === 'w') ?? null, y: parts.find((p) => axis(p) === 'h') ?? null };
}

// ---- aiming a drag ----

// the grabbed edges: -1 left/top, 1 right/bottom, 0 neither
export interface Grab { hx: -1 | 0 | 1; hy: -1 | 0 | 1 }
export interface Sized { x: number; y: number; size: number; box: Box } // box absolute

const absBox = (x: number, y: number, b: Box): Box => ({ x0: x + b.x0, y0: y + b.y0, x1: x + b.x1, y1: y + b.y1 });

// The size and origin that bring the grabbed edges of the object (as it was: x, y, size) nearest the target
// tiles (tx for a grabbed left/right edge, ty for top/bottom), the opposite edges staying where they are, the
// origin inside the level (w × h tiles). Ties: the least change of the axis not dragged, then the size nearest
// the one it had. null when the object's box at its size is not known.
export function aimResize(o: { x: number; y: number; size: number }, d: Drivers, box: (size: number) => Box | null | undefined,
  grab: Grab, tx: number, ty: number, w: number, h: number): Sized | null {
  const b0 = box(o.size);
  if (!b0) return null;
  const a0 = absBox(o.x, o.y, b0);
  const px = grab.hx ? d.x : null, py = grab.hy ? d.y : null;
  // the origin that keeps the opposite edges of a box (its x range from bx, its y range from by)
  const place = (size: number, bx: Box, by: Box): Sized | null => {
    const x = grab.hx === 1 ? a0.x0 - bx.x0 : grab.hx === -1 ? a0.x1 - bx.x1 : o.x;
    const y = grab.hy === 1 ? a0.y0 - by.y0 : grab.hy === -1 ? a0.y1 - by.y1 : o.y;
    if (x < 0 || x >= w || y < 0 || y >= h) return null;
    return { x, y, size, box: { x0: x + bx.x0, x1: x + bx.x1, y0: y + by.y0, y1: y + by.y1 } };
  };
  const edgeX = (b: Box) => (grab.hx === 1 ? b.x1 : b.x0), edgeY = (b: Box) => (grab.hy === 1 ? b.y1 : b.y0);
  const ext = (b: Box, axis: 'x' | 'y') => (axis === 'x' ? b.x1 - b.x0 : b.y1 - b.y0);
  // the best size of a part for the axes it is aimed by
  const best = (part: Part, ax: boolean, ay: boolean): Sized | null => {
    let win: Sized | null = null, score: number[] = [];
    for (const s of partSizes(o.size, part)) {
      const b = box(s);
      if (!b) continue;
      const p = place(s, b, b);
      if (!p) continue;
      const sh = part === 'hi' ? 4 : 0, m = MASK[part];
      const sc = [(ax ? Math.abs(edgeX(p.box) - tx) : 0) + (ay ? Math.abs(edgeY(p.box) - ty) : 0),
        (ax ? 0 : Math.abs(ext(b, 'x') - ext(b0, 'x'))) + (ay ? 0 : Math.abs(ext(b, 'y') - ext(b0, 'y'))),
        Math.abs(((s & m) >> sh) - ((o.size & m) >> sh))];
      if (!win || sc[0] < score[0] || (sc[0] === score[0] && (sc[1] < score[1] || (sc[1] === score[1] && sc[2] < score[2])))) { win = p; score = sc; }
    }
    return win;
  };
  if (!px && !py) return { x: o.x, y: o.y, size: o.size, box: a0 };
  if (!px || !py || px === py) return best((px ?? py)!, !!px, !!py) ?? { x: o.x, y: o.y, size: o.size, box: a0 };
  // two parts: each aimed on its own axis, put together
  const sx = best(px, true, false), sy = best(py, false, true);
  const size = ((sx?.size ?? o.size) & MASK[px]) | ((sy?.size ?? o.size) & MASK[py]) | (o.size & ~(MASK[px] | MASK[py]) & 0xff);
  const bx = (sx && box(sx.size)) ?? b0, by = (sy && box(sy.size)) ?? b0;
  return place(size, bx, by) ?? { x: o.x, y: o.y, size: o.size, box: a0 };
}

// The origin that keeps an object's edges after a size change (from size to `size`): the left/top ones, or with
// far the right/bottom ones; null when the boxes are not known or it would leave the level (w × h tiles)
export function keepEdges(o: { x: number; y: number; size: number }, size: number, box: (size: number) => Box | null | undefined,
  far: boolean, w: number, h: number): { x: number; y: number } | null {
  const b0 = box(o.size), b1 = box(size);
  if (!b0 || !b1) return null;
  const x = far ? o.x + b0.x1 - b1.x1 : o.x + b0.x0 - b1.x0, y = far ? o.y + b0.y1 - b1.y1 : o.y + b0.y0 - b1.y0;
  return x < 0 || x >= w || y < 0 || y >= h ? null : { x, y };
}

// A keyboard step from the object's size to `size`: the origin that keeps its left/top edges (with far the
// right/bottom ones). One that draws nothing at either size (or whose boxes could not be learned) keeps its
// origin; null when it would leave the level (w × h tiles).
export function keyResize(o: { x: number; y: number; size: number }, size: number, box: (size: number) => Box | null | undefined,
  far: boolean, w: number, h: number): { x: number; y: number; size: number } | null {
  if (!box(o.size) || !box(size)) return { x: o.x, y: o.y, size };
  const at = keepEdges(o, size, box, far, w, h);
  return at && { ...at, size };
}

// the edges a handle grabs (the edges at the pixel) that the drivers move: the others stay
export function grabFor(handle: Grab, d: Drivers): Grab {
  return { hx: d.x ? handle.hx : 0, hy: d.y ? handle.hy : 0 };
}

// ---- the boxes known ----

// learns the boxes of specs (the probe worker's 'sizes' job, for the level and ROM state named by key): done with them
// in the order of specs, or failed; either may be called at once
export type LearnBoxes = (key: string, specs: SizeSpec[], done: (boxes: (Box | null)[]) => void, failed: () => void) => void;

// The boxes of objects at their sizes as learned for one level and ROM state (at: those of another are dropped), and
// the drivers that follow from them. A job that failed gives null boxes, as a load that fails did in the probe (a
// keyboard step keeps the origin), and the drivers the kind names (a drag grabs and resizes as it started).
export class ObjectBoxes {
  private key = '';
  private boxes = new Map<string, Box | null>();
  private failed = new Set<string>(); // (specs whose job failed)
  private memo = new Map<string, Drivers>(); // (emulated ones, per object as resized and its kind)
  private learn: LearnBoxes;

  constructor(learn: LearnBoxes) {
    this.learn = learn;
  }

  // for the level and ROM state named by key
  at(key: string): this {
    if (this.key !== key) { this.key = key; this.boxes = new Map(); this.failed.clear(); this.memo.clear(); }
    return this;
  }

  // the object's box (null: it draws nothing, or its job failed), undefined while not learned
  box(s: SizeSpec): Box | null | undefined {
    return this.boxes.get(sizeKey(s));
  }

  // asks for the boxes of specs not known; whether all are known now (then is not called), else then once they are
  // (or the level or ROM state is another by then: they are asked for anew)
  ask(specs: SizeSpec[], then?: () => void): boolean {
    const todo = [...new Map(specs.filter((s) => !this.boxes.has(sizeKey(s))).map((s) => [sizeKey(s), s])).values()];
    if (!todo.length) return true;
    const key = this.key;
    let now = true, settled = false;
    const put = (boxes: (Box | null)[] | null) => {
      if (settled) return;
      settled = true;
      if (this.key === key) todo.forEach((s, i) => { this.boxes.set(sizeKey(s), boxes ? boxes[i] : null); if (!boxes) this.failed.add(sizeKey(s)); });
      if (!now) then?.();
    };
    this.learn(key, todo, (boxes) => put(boxes), () => put(null));
    now = false;
    return settled;
  }

  // which part sizes which axis of the object (o: as it is now) for its kind: as the boxes of all the sizes its parts
  // can take say, those the kind names when their job failed; undefined while not all are known
  drivers(kind: ObjKind | null | undefined, o: SizeSpec): Drivers | undefined {
    const sizes = sizeParts(kind).flatMap((p) => partSizes(o.size, p)).map((size) => ({ ...o, size }));
    if (sizes.some((s) => !this.boxes.has(sizeKey(s)))) return undefined;
    if (sizes.some((s) => this.failed.has(sizeKey(s)))) return namedDrivers(kind);
    const key = `${sizeKey(o)}:${JSON.stringify(kind)}`;
    let d = this.memo.get(key);
    if (!d) this.memo.set(key, (d = drivers(kind, o.size, (size) => this.box({ ...o, size }))));
    return d;
  }
}

// Steps run one at a time in the order added: a step that waits (returns false) is run again when it calls retry, the
// ones added meanwhile wait behind it (keyboard resizes waiting for boxes end up as without the wait)
export type Step = (retry: () => void) => boolean;
export class StepQueue {
  private steps: Step[] = [];
  add(step: Step): void {
    this.steps.push(step);
    if (this.steps.length === 1) this.pump();
  }
  private pump = (): void => {
    while (this.steps.length) {
      let waits = true;
      try { waits = !this.steps[0](this.pump); } catch (e) { this.steps = []; throw e; } // (one that throws: the queue starts anew)
      if (waits) return;
      this.steps.shift();
    }
  };
}
