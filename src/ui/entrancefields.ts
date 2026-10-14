// Fields shared by the entrance panels and dialogs: where an entrance puts Mario (the game's table position
// or Lunar Magic's tile), and where the camera starts (the game's FG/BG start Y, or Lunar Magic's rows
// above Mario, which a level with a size needs: the game's start positions don't reach its rows).

import { hex2 } from '../core/names.ts';
import { type EntranceSpot, type CameraStart, spotTile, cameraRows, setCameraRows, cameraAtMario } from '../core/level.ts';

export function spotText(p: EntranceSpot): string {
  if (!p.tile) return `Screen ${hex2(p.screen)}, X ${p.ex}, Y ${p.ey}`;
  const t = spotTile(p);
  return `Screen ${hex2(p.screen)}, tile ${t.x}, ${t.y}`;
}

// GAME_CAMERA: the game's FG/BG start Y; n: n rows above Mario
export const GAME_CAMERA = -100;
export function cameraOptions(cur: number): [number, string][] {
  const rows = (n: number): [number, string] => [n, n < 0 ? `${-n} rows below Mario` : `${n} rows above Mario`];
  const opts: [number, string][] = [[GAME_CAMERA, 'FG/BG start Y'], ...Array.from({ length: 17 }, (_, i) => rows(i))];
  return opts.some(([v]) => v === cur) ? opts : [...opts, rows(cur)];
}
export const cameraValue = (c: CameraStart): number => (c.cameraRelative ? cameraRows(c) : GAME_CAMERA);
// (a main entrance's BG is then bottom-aligned, 27 rows high unless it has a height)
export function setCamera(c: CameraStart & { bgHeight?: number; bgRelative?: number }, v: number): void {
  if (v === GAME_CAMERA) { c.cameraRelative = 0; c.cameraOffsetHi = 0; return; }
  cameraAtMario(c);
  setCameraRows(c, v);
}
