// Level scan: the edited level is played through once, with Mario carried along the level from
// where he starts (horizontal levels: above the screen, so he touches nothing), so the camera
// scrolls and sprites appear as in the game; he can't be hurt (flashing timer $1497),
// and two things are observed:
// - slowdown: for every frame, whether the game's main loop finished before the next NMI (the
//   CPU reached its wait loop, see Snes.busyLines); frames where it didn't are lag frames, counted
//   per screen of the camera;
// - sprites from the level data (slot → load index $161A) that fall out of the level right after
//   appearing, or that stay stuck: they bump into blocks ($1588) in the direction they move, to
//   both sides, without getting more than a tile away (inside a wall, trapped in a gap; bumping
//   on one side only is often chasing Mario, who is somewhere else here).
// Afterwards, in levels whose layer 3 tide rises and falls, how far it moves (layer3.ts).

import type { LevelEmulator, LevelOverride } from './levelemu.ts';
import { tideRangeJob, type TideRange } from './layer3.ts';

export interface ScreenLoad { screen: number; frames: number; lag: number; maxBusy: number }
export interface SpriteFate { index: number; kind: 'fell' | 'stuck'; frame: number }
export interface ScanResult { screens: ScreenLoad[]; sprites: SpriteFate[]; frames: number; ok: boolean; tide?: TideRange | null }

export interface ScanLevel {
  number: number;
  ov: LevelOverride; // as for rendering, with the sprites
  vertical: boolean;
  width: number; // level size in pixels
  height: number;
}

const STEP = 2; // pixels Mario is carried per frame
const ABOVE = -48; // Mario's Y in horizontal levels: above the level (vertical levels: he keeps his X)
const FELL_WINDOW = 90; // frames after appearing within which falling out is reported
const STUCK_FRAMES = 90; // frames within one tile …
const STUCK_RANGE = 16;
const STUCK_BUMPS = 4; // … bumping into blocks in at least every 4th of them, both sides
const STUCK_WINDOW = 300; // after appearing
const SLICE = 60; // frames between yields
const NORMAL = 8; // sprite status of a sprite going about its business

const w16 = (w: Uint8Array, lo: number, hi: number, i: number) => ((w[lo + i] | (w[hi + i] << 8)) << 16) >> 16;

// yields between slices of frames; the result when done
export function* levelScanJob(emu: LevelEmulator, lv: ScanLevel): Generator<void, ScanResult> {
  const r = emu.load(lv.number, lv.ov);
  if (!r.ok) return { screens: [], sprites: [], frames: 0, ok: false };
  yield;
  const s = emu.snes, w = s.wram;
  for (let g = 0; g < 200 && w[0x100] !== 0x14; g++) s.runFrame();
  if (w[0x100] !== 0x14) return { screens: [], sprites: [], frames: 0, ok: false };
  const loads = new Map<number, ScreenLoad>();
  const fates: SpriteFate[] = [];
  // per load index: first frame seen, last position and status, the tile-wide window it stays in
  const seen = new Map<number, { first: number; x: number; y: number; status: number; x0: number; x1: number; n: number; left: number; right: number; done: boolean }>();
  let prevSlots: number[] = new Array(12).fill(-1);
  // from where Mario starts to the far end of the level (vertical levels: up or down)
  const sx = w[0x94] | (w[0x95] << 8), sy = w16(w, 0x96, 0x97, 0);
  let pos = lv.vertical ? sy : sx;
  const step = lv.vertical && sy < lv.height / 2 ? STEP : lv.vertical ? -STEP : STEP;
  const end = lv.vertical ? (step > 0 ? lv.height : 0) : lv.width;
  let f = 0;
  try {
    for (; step > 0 ? pos < end : pos > end; f++) {
      pos += step;
      const mx = lv.vertical ? sx : pos, my = lv.vertical ? pos : ABOVE;
      w[0x94] = mx & 0xff; w[0x95] = (mx >> 8) & 0xff; w[0x96] = my & 0xff; w[0x97] = (my >> 8) & 0xff;
      w[0x7b] = 0; w[0x7d] = 0; w[0x1497] = 0x40;
      s.runFrame();
      if (w[0x100] !== 0x14 || w[0x71] === 9) break; // level ended (goal, death or something the level does)
      // the frame counts for the screen in the middle of the camera
      const cam = lv.vertical ? (w[0x1c] | (w[0x1d] << 8)) + 112 : (w[0x1a] | (w[0x1b] << 8)) + 128;
      const scr = cam >> 8;
      let l = loads.get(scr);
      if (!l) loads.set(scr, (l = { screen: scr, frames: 0, lag: 0, maxBusy: 0 }));
      l.frames++;
      if (s.busyLines < 0) l.lag++;
      else l.maxBusy = Math.max(l.maxBusy, s.busyLines);
      // sprites of the level data
      const slots: number[] = [];
      for (let i = 0; i < 12; i++) {
        const st = w[0x14c8 + i], idx = w[0x161a + i];
        slots.push(st && idx !== 0xff ? idx : -1);
        if (slots[i] < 0) continue;
        const x = w16(w, 0xe4, 0x14e0, i), y = w16(w, 0xd8, 0x14d4, i);
        let q = seen.get(idx);
        if (!q) seen.set(idx, (q = { first: f, x, y, status: st, x0: x, x1: x, n: 0, left: 0, right: 0, done: false }));
        if (prevSlots[i] !== idx) Object.assign(q, { x0: x, x1: x, n: 0, left: 0, right: 0 }); // (again) on screen
        else if (!q.done && f - q.first < STUCK_WINDOW) {
          q.x0 = Math.min(q.x0, x); q.x1 = Math.max(q.x1, x);
          if (q.x1 - q.x0 > STUCK_RANGE) Object.assign(q, { x0: x, x1: x, n: 0, left: 0, right: 0 });
          q.n++;
          const vx = (w[0xb6 + i] << 24) >> 24;
          if (vx > 0 && (w[0x1588 + i] & 1)) q.right++; // blocked in the direction it moves
          if (vx < 0 && (w[0x1588 + i] & 2)) q.left++;
          if (q.n >= STUCK_FRAMES && q.left >= 2 && q.right >= 2 && (q.left + q.right) * STUCK_BUMPS >= q.n) { q.done = true; fates.push({ index: idx, kind: 'stuck', frame: f }); }
        }
        q.x = x; q.y = y; q.status = st;
      }
      // gone since the last frame
      prevSlots.forEach((idx, i) => {
        if (idx < 0 || slots[i] === idx) return;
        const q = seen.get(idx)!;
        if (!q.done && q.status === NORMAL && q.y >= lv.height - 16 && f - q.first < FELL_WINDOW) {
          q.done = true;
          fates.push({ index: idx, kind: 'fell', frame: f });
        }
      });
      prevSlots = slots;
      if (f % SLICE === SLICE - 1) yield;
    }
  } catch { /* what was observed */ }
  let tide: TideRange | null = null;
  try { tide = yield* tideRangeJob(emu, lv.number, lv.ov); } catch { /* none */ }
  return { screens: [...loads.values()].sort((a, b) => a.screen - b.screen), sprites: fates, frames: f, ok: true, tide };
}
