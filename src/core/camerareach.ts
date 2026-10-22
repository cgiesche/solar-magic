// Where the camera goes in a level, learned by playing it (beyond Lunar Magic's scroll bands, which only tell
// where Mario is on the screen):
// - its reach: what of the level the camera can show. Mario is carried along the level's top and its bottom
//   (vertical levels: its left and right side), standing as far as the camera is concerned (climbing, so the
//   game lets it scroll up as it does for Mario on the ground), and the camera's place is read every frame; per
//   16-pixel column (vertical levels: row) the pixels across it that it showed. The game's own limits, the
//   header's scroll settings and the level's code decide, nothing here does: parts it never shows stay out.
//   With it where the camera itself went: the game view frame is kept inside that (cameraRange).
// - the camera at a place: Mario is put there, standing, and the game moves the camera until it rests.
// Mario can't be hurt, and when something kills him all the same he is up again the next frame.

import { levelDataKey, type LevelEmulator, type LevelOverride } from './levelemu.ts';
import type { ScanLevel } from './levelscan.ts';
import { GAME_VIEW_W, GAME_VIEW_H, MARIO_W, MARIO_H } from './camerabands.ts';
import { GM, RAM, cameraX, cameraY, setMarioPos } from './ram.ts';

// per column of the level (vertical levels: row), 16 pixels each: the pixels [from, to) down (across) it the
// camera showed; null: never. camera: where the camera (layer 1's place) went, from the first to the last pixel
// along the level (vertical levels: down it) and, per 16 pixels of that, from the first to the last across it;
// null: it was never read
export interface CameraReach {
  vertical: boolean; spans: ([number, number] | null)[];
  camera: { along: [number, number]; across: ([number, number] | null)[] } | null;
}
// the camera: layer 1's place in level pixels
export interface CameraAt { x: number; y: number }

const STEP = 4; // pixels Mario is carried per frame
const LOAD_FRAMES = 300; // until Mario can move after the level loaded (an entrance in a pipe …)
const REST = 16; // frames without the camera moving: it rests
const SETTLE_FRAMES = 600; // at most
const SLICE = 60; // frames between yields

// the result cache key of the camera at Mario standing at (x, y) in the level as edited
export function cameraAtKey(level: number, ov: LevelOverride, x: number, y: number): string {
  return `cam2:${levelDataKey(level, ov)}:${x},${y}`;
}

// The level loaded and ready for Mario; false when it failed or ended right away
function start(emu: LevelEmulator, lv: ScanLevel): boolean {
  if (!emu.load(lv.number, lv.ov).ok) return false;
  const s = emu.snes, w = s.wram;
  for (let f = 0; f < LOAD_FRAMES && !(w[RAM.gameMode] === GM.level && w[RAM.marioAnim] === 0 && !w[RAM.spritesLocked]); f++) s.runFrame();
  return w[RAM.gameMode] === GM.level;
}

// One frame with Mario standing at (x, y); false when the level ended
function stand(emu: LevelEmulator, x: number, y: number): boolean {
  const s = emu.snes, w = s.wram;
  setMarioPos(w, x, y);
  w[RAM.marioSpeedX] = 0; w[RAM.marioSpeedY] = 0; w[RAM.hurtTimer] = 0x40;
  w[RAM.marioClimbing] = 1;
  s.runFrame();
  if (w[RAM.marioAnim] === 9) { w[RAM.marioAnim] = 0; w[RAM.marioAnimTimer] = 0; w[RAM.spritesLocked] = 0; } // up again
  return w[RAM.gameMode] === GM.level;
}

// Mario stands at (x, y) until the camera rests (yielding between slices): whether it came to rest; null when
// the level ended
function* settle(emu: LevelEmulator, x: number, y: number): Generator<void, boolean | null> {
  const w = emu.snes.wram;
  let cx = -1, cy = -1, still = 0;
  for (let f = 0; f < SETTLE_FRAMES && still < REST; f++) {
    if (!stand(emu, x, y)) return null;
    still = cameraX(w) === cx && cameraY(w) === cy ? still + 1 : 0;
    cx = cameraX(w); cy = cameraY(w);
    if (f % SLICE === SLICE - 1) yield;
  }
  return still >= REST;
}

// The camera's reach in the level; null when it could not be played
export function* cameraReachJob(emu: LevelEmulator, lv: ScanLevel): Generator<void, CameraReach | null> {
  const size = lv.vertical ? lv.height : lv.width, across = lv.vertical ? GAME_VIEW_W : GAME_VIEW_H;
  const spans: ([number, number] | null)[] = new Array(Math.ceil(size / 16)).fill(null);
  const see = (along: number, from: number) => {
    const len = lv.vertical ? GAME_VIEW_H : GAME_VIEW_W;
    for (let i = Math.max(0, along >> 4); i <= Math.min(spans.length - 1, (along + len - 1) >> 4); i++) {
      const s = spans[i];
      spans[i] = s ? [Math.min(s[0], from), Math.max(s[1], from + across)] : [from, from + across];
    }
  };
  let along: [number, number] | null = null;
  const crossed: ([number, number] | null)[] = [];
  const went = (a: number, b: number) => {
    along = along ? [Math.min(along[0], a), Math.max(along[1], a)] : [a, a];
    const c = crossed[a >> 4];
    crossed[a >> 4] = c ? [Math.min(c[0], b), Math.max(c[1], b)] : [b, b];
  };
  let played = false;
  // Mario along one side: (a, b) his place at a pixel along the level
  for (const side of [0, 1]) {
    if (!start(emu, lv)) continue;
    yield;
    const w = emu.snes.wram;
    const at = (p: number): [number, number] => lv.vertical ? [side ? lv.width - MARIO_W * 2 : 0, p] : [p, side ? lv.height - MARIO_H - 16 : 0];
    if ((yield* settle(emu, ...at(0))) === null) continue;
    played = true;
    for (let p = 0, f = 0; p <= size - (lv.vertical ? MARIO_H : MARIO_W); p += STEP, f++) {
      if (!stand(emu, ...at(p))) break; // the level ended (something the level does)
      const [a, b] = lv.vertical ? [cameraY(w), cameraX(w)] : [cameraX(w), cameraY(w)];
      see(a, b); went(a, b);
      if (f % SLICE === SLICE - 1) yield;
    }
  }
  if (!played) return null;
  const camera = along ? { along, across: Array.from({ length: (along[1] >> 4) + 1 }, (_, i) => crossed[i] ?? null) } : null;
  return { vertical: lv.vertical, spans, camera };
}

// The camera place (x, y) kept where the game lets the camera go in the level (from its reach): along the level
// within the camera's first and last place, across it within where it went there (the nearest place it was read).
// The game's limits win over the 8x8 grid: a limit off the grid leaves the frame there.
export function cameraRange(r: CameraReach, x: number, y: number): CameraAt {
  const c = r.camera;
  if (!c) return { x, y };
  const clamp = (v: number, [lo, hi]: [number, number]) => Math.max(lo, Math.min(hi, v));
  const a = clamp(r.vertical ? y : x, c.along), i = a >> 4;
  let span: [number, number] | null = null;
  for (let d = 0; !span && d <= Math.max(i, c.across.length); d++) span = c.across[i - d] ?? c.across[i + d] ?? null;
  const b = span ? clamp(r.vertical ? x : y, span) : r.vertical ? x : y;
  return r.vertical ? { x: b, y: a } : { x: a, y: b };
}

// where the frame goes when it is put at level pixel (x, y): on the 8x8 grid, inside a level of w x h pixels
// and, once the camera's reach is known, where the game lets the camera go
export function gameViewAt(x: number, y: number, w: number, h: number, reach?: CameraReach | null): CameraAt {
  const at = (v: number, max: number) => Math.max(0, Math.min(Math.max(0, max), Math.round(v / 8) * 8));
  const p = { x: at(x, w - GAME_VIEW_W), y: at(y, h - GAME_VIEW_H) };
  return reach ? cameraRange(reach, p.x, p.y) : p;
}

// The camera (layer 1's place) the game puts at Mario standing at (x, y), coming from the level's entrance;
// null when the level could not be played or the camera never came to rest
export function* cameraAtJob(emu: LevelEmulator, lv: ScanLevel, x: number, y: number): Generator<void, CameraAt | null> {
  if (!start(emu, lv)) return null;
  yield;
  if (!(yield* settle(emu, x, y))) return null;
  const w = emu.snes.wram;
  return { x: cameraX(w), y: cameraY(w) };
}
