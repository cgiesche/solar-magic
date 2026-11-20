// The overworld's animation on the map and its pickers (#420), the overworld's counterpart of the level view's
// (levelanimplayer.ts): what the game keeps rewriting in 8x8 tiles and colors on a submap – its water and waves, the
// ExAnimation slots (the submap's list and the global one, their event triggers as the save shown has them), the color
// rotations (the level dots, the lightning, …) – as steps of ANIM_STEP_FRAMES frames each, played in the game's
// rhythm. Found by emulation, no tables: the overworld loaded at the event progress shown, run on MAX_ANIM_STEPS steps,
// the steps until they repeat kept (animPeriod). Each step is the console's VRAM and CGRAM; the map and the pickers are
// drawn from the editor's own tilemaps with a step's 8x8 tiles and colors (OwTileAnimation), so a stroke being painted
// animates too and the steps hold while only the tilemaps change (owTilemapRanges left out of what they read).

import { loadKey, owCharBase, owTileCaches, owTileWords, l1Index, l2Index, owTilemapRanges, type OverworldLoads, type OwRender, type OwTileCaches } from './overworld.ts';
import type { EventProgress } from './eventset.ts';
import { blit8, clearCell, drawMap16, stepChanges, MAX_ANIM_STEPS, type AnimStep, type PictureAnimation, type TilePixels } from './render.ts';
import type { RomRead } from './exanim.ts';

export const ANIM_STEP_FRAMES = 8; // the frames of a step: the level animation's (levelanimplayer.ts)
const BG_COLORS = 128; // the colors layers 1 and 2 draw with: 8 palettes of 16 (4bpp)
const CHAR_BYTES = 0x400 * 32; // a layer's 8x8 tiles (4bpp, tile numbers 000–3FF)

// the bytes of a step layers 1 and 2 show: their 8x8 tiles from each character base and their colors, as one number
// (FNV-1a over them)
function stepHash(r: Pick<OwRender, 'ppuRegs'>, s: AnimStep): number {
  let h = 0x811c9dc5;
  const bases = [...new Set([owCharBase(r, 1), owCharBase(r, 2)])];
  for (const base of bases) for (let i = 0; i < CHAR_BYTES; i++) h = Math.imul(h ^ s.vram[(base + i) & 0xffff], 0x01000193);
  for (let i = 0; i < BG_COLORS * 2; i++) h = Math.imul(h ^ s.cgram[i], 0x01000193);
  return h >>> 0;
}

// the steps until the animation repeats: the fewest p for which every step looks as the one p later (of those
// emulated, seen to come round at least twice), all of them when none does (a lightning at random); keys: what each
// step looks like (stepHash)
export function animPeriod(keys: readonly number[]): number {
  for (let p = 1; 2 * p <= keys.length; p++) {
    let same = true;
    for (let i = 0; i + p < keys.length && same; i++) same = keys[i] === keys[i + p];
    if (same) return p;
  }
  return keys.length;
}

// The animation's steps on map `map` at event progress `progress`, from `loads` (the learner's own): the console after
// the load run on MAX_ANIM_STEPS steps of ANIM_STEP_FRAMES frames, the steps until they repeat (animPeriod; fewer when
// the game fails). A step per step of the job, each saying the step it makes ("Animations n/m": the first after the
// load, m the steps emulated – how many repeat is known once all are); kept for the map and
// progress while the ROM bytes they read are unchanged, the tilemaps' left out (they show no 8x8 tile or color)
export function* owAnimStepsJob(loads: OverworldLoads, map: number, progress: EventProgress): Generator<string | void, AnimStep[]> {
  return yield* loads.deriveSteps<AnimStep[], string | void>('owAnimSteps', function* () {
    loads.restore(map, progress);
    const r = loads.get(map, progress), s = loads.emu.snes, steps: AnimStep[] = [], keys: number[] = [];
    for (let i = 0; i < MAX_ANIM_STEPS; i++) {
      yield `Animations ${i + 1}/${MAX_ANIM_STEPS}`;
      try {
        for (let f = 0; f < ANIM_STEP_FRAMES; f++) s.runFrame();
      } catch (e) { console.error(e); break; }
      // (a VRAM as the step before shares its array: sent and kept once)
      const last = steps[steps.length - 1], same = last && last.vram.every((v, k) => v === s.vram[k]);
      steps.push({ vram: same ? last.vram : s.vram.slice(), cgram: s.cgram.slice() });
      keys.push(stepHash(r, steps[i]));
    }
    return steps.slice(0, animPeriod(keys));
  }, loadKey(map, progress), owTilemapRanges);
}

// The animation on pixels of the overworld's tiles drawn with a load `r` (the map's layers, the pickers' sheets): between
// two steps only the tiles that look different in one of them are drawn anew, what a step changes found once per step
// and tile. Pixels of layer 1 (TilePixels bg false) show its 16x16 tiles (cells: layer 1 tile numbers), of layer 2 (bg
// true) 8x8 tilemap entries (cells: the entries).
export class OwTileAnimation implements PictureAnimation {
  readonly r: OwRender;
  private rom: RomRead;
  private base: OwTileCaches;
  private caches = new WeakMap<AnimStep, OwTileCaches>();
  private known = new WeakMap<AnimStep, { differs: ReturnType<typeof stepChanges>; l1: Map<number, boolean>; l2: Map<number, boolean>; tiles: Map<number, boolean> }>();

  constructor(rom: RomRead, r: OwRender) {
    this.rom = rom;
    this.r = r;
    this.base = owTileCaches(r);
  }

  private stepKnown(s: AnimStep) {
    let k = this.known.get(s);
    if (!k) this.known.set(s, k = { differs: stepChanges(this.r, s.vram, s.cgram), l1: new Map(), l2: new Map(), tiles: new Map() });
    return k;
  }
  // whether layer `layer`'s 8x8 tile of tilemap entry w looks different at step s than the load shows it
  entryChanges(s: AnimStep, layer: 1 | 2, w: number): boolean {
    const k = this.stepKnown(s);
    if (!k.differs) return false;
    const m = layer === 1 ? k.l1 : k.l2;
    let v = m.get(w);
    if (v === undefined) m.set(w, v = k.differs(w, owCharBase(this.r, layer), 4));
    return v;
  }
  // whether layer 1 tile t (its four 8x8 tiles) looks different at step s
  tileChanges(s: AnimStep, t: number): boolean {
    const k = this.stepKnown(s);
    if (!k.differs) return false;
    let v = k.tiles.get(t);
    if (v === undefined) k.tiles.set(t, v = owTileWords(this.rom, t).some((w) => this.entryChanges(s, 1, w)));
    return v;
  }
  // whether step s changes anything layers 1 and 2 can show
  stepChanges(s: AnimStep): boolean {
    return !!this.stepKnown(s).differs;
  }

  private tileCaches(s: AnimStep | null): OwTileCaches {
    if (!s) return this.base;
    let c = this.caches.get(s);
    if (!c) this.caches.set(s, c = owTileCaches({ ...this.r, vram: s.vram, cgram: s.cgram }));
    return c;
  }

  redraw(pixels: TilePixels, from: AnimStep | null, to: AnimStep | null, all = false): boolean {
    const l2 = pixels.bg, size = l2 ? 8 : 16, c = pixels.cells;
    const changes = (s: AnimStep | null, v: number) => !!s && (l2 ? this.entryChanges(s, 2, v) : this.tileChanges(s, v));
    const tcs = this.tileCaches(to), tc = l2 ? tcs.l2 : tcs.l1;
    let any = false;
    if (all) clearCell(pixels, 0, 0, Math.max(pixels.w, pixels.h));
    for (let i = 0; i < c.length; i += 3) {
      const v = c[i + 2];
      if (!all && !changes(from, v) && !changes(to, v)) continue;
      const x0 = c[i], y0 = c[i + 1];
      clearCell(pixels, x0, y0, size);
      if (l2) blit8(pixels.px, pixels.w, pixels.h, tc.get(v), x0, y0);
      else drawMap16(pixels.px, pixels.w, pixels.h, tc, owTileWords(this.rom, v), x0, y0);
      any = true;
    }
    return any;
  }

  // A map region's layer (overworld.ts drawOwMap: 512x512, transparent where it has no pixel) drawn with the load from
  // `tiles` (layer 1's tiles or layer 2's entries, all the regions'), as step `to` shows it: a copy of `img` with the
  // cells it changes drawn anew; null when it changes none
  stepLayer(img: Uint32Array, layer: 1 | 2, region: number, tiles: ArrayLike<number>, to: AnimStep): Uint32Array | null {
    if (!this.stepChanges(to)) return null;
    const n = layer === 1 ? 32 : 64, size = 512 / n, cells: number[] = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = tiles[layer === 1 ? l1Index(region, x, y) : l2Index(region, x, y)];
      if (layer === 1 ? this.tileChanges(to, v) : this.entryChanges(to, 2, v)) cells.push(x * size, y * size, v);
    }
    if (!cells.length) return null;
    const px = img.slice();
    this.redraw({ px, w: 512, h: 512, cells, bg: layer === 2, back: 0 }, null, to);
    return px;
  }
}
