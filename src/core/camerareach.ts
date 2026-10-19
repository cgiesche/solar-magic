// Where the camera goes in a level, learned by playing it (beyond Lunar Magic's scroll bands, which only tell
// where Mario is on the screen):
// - its reach: what of the level the camera can show. Mario is carried along the level's top and its bottom
//   (vertical levels: its left and right side), standing as far as the camera is concerned (climbing, so the
//   game lets it scroll up as it does for Mario on the ground), and the camera's place is read every frame; per
//   16-pixel column (vertical levels: row) the pixels across it that it showed. The game's own limits, the
//   header's scroll settings and the level's code decide, nothing here does: parts it never shows stay out.
// - the camera at a place: Mario is put there, standing, and the game moves the camera until it rests.
// Mario can't be hurt, and when something kills him all the same he is up again the next frame.

import { levelDataKey, type LevelEmulator, type LevelOverride } from './levelemu.ts';
import type { ScanLevel } from './levelscan.ts';
import { GAME_VIEW_W, GAME_VIEW_H } from './camerabands.ts';
import { GM, RAM, cameraX, cameraY, setMarioPos } from './ram.ts';

// per column of the level (vertical levels: row), 16 pixels each: the pixels [from, to) down (across) it the
// camera showed; null: never
export interface CameraReach { vertical: boolean; spans: ([number, number] | null)[] }

const STEP = 4; // pixels Mario is carried per frame
const LOAD_FRAMES = 300; // until Mario can move after the level loaded (an entrance in a pipe …)
const REST = 16; // frames without the camera moving: it rests
const SETTLE_FRAMES = 600; // at most
const SLICE = 60; // frames between yields
const MARIO_W = 16, MARIO_H = 32;

// the result cache key of the camera at Mario standing at (x, y) in the level as edited
export function cameraAtKey(level: number, ov: LevelOverride, x: number, y: number): string {
  return `cam1:${levelDataKey(level, ov)}:${x},${y}`;
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

// Mario stands at (x, y) until the camera rests (yielding between slices); false when the level ended
function* settle(emu: LevelEmulator, x: number, y: number): Generator<void, boolean> {
  const w = emu.snes.wram;
  let cx = -1, cy = -1, still = 0;
  for (let f = 0; f < SETTLE_FRAMES && still < REST; f++) {
    if (!stand(emu, x, y)) return false;
    still = cameraX(w) === cx && cameraY(w) === cy ? still + 1 : 0;
    cx = cameraX(w); cy = cameraY(w);
    if (f % SLICE === SLICE - 1) yield;
  }
  return true;
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
  let played = false;
  // Mario along one side: (a, b) his place at a pixel along the level
  for (const side of [0, 1]) {
    if (!start(emu, lv)) continue;
    yield;
    const w = emu.snes.wram;
    const at = (p: number): [number, number] => lv.vertical ? [side ? lv.width - MARIO_W * 2 : 0, p] : [p, side ? lv.height - MARIO_H - 16 : 0];
    if (!(yield* settle(emu, ...at(0)))) continue;
    played = true;
    for (let p = 0, f = 0; p <= size - MARIO_H; p += STEP, f++) {
      if (!stand(emu, ...at(p))) break; // the level ended (something the level does)
      if (lv.vertical) see(cameraY(w), cameraX(w)); else see(cameraX(w), cameraY(w));
      if (f % SLICE === SLICE - 1) yield;
    }
  }
  return played ? { vertical: lv.vertical, spans } : null;
}

// The camera (layer 1's place) the game puts at Mario standing at (x, y), coming from the level's entrance;
// null when the level could not be played
export function* cameraAtJob(emu: LevelEmulator, lv: ScanLevel, x: number, y: number): Generator<void, { x: number; y: number } | null> {
  if (!start(emu, lv)) return null;
  yield;
  if (!(yield* settle(emu, x, y))) return null;
  const w = emu.snes.wram;
  return { x: cameraX(w), y: cameraY(w) };
}
