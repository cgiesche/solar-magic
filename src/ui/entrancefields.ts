// Fields shared by the entrance panels and dialogs: where an entrance puts Mario (the game's table position
// or Lunar Magic's tile), and where the camera starts (the game's FG/BG start Y, or Lunar Magic's rows
// above Mario, which a level with a size needs: the game's start positions don't reach its rows).

import { hex2 } from '../core/names.ts';
import { h, hexInput, select } from './dom.ts';
import {
  type EntranceSpot, type CameraStart, type EntranceTileFields, type SecondaryHeader, type BgStart, spotTile, cameraRows, setCameraRows, cameraAtMario,
  setEntranceTile, bgStart, setBgStart, GAME_BG_ROWS,
} from '../core/level.ts';

export function spotText(p: EntranceSpot): string {
  if (!p.tile) return `Screen ${hex2(p.screen)}, X ${p.ex}, Y ${p.ey}`;
  const t = spotTile(p);
  return `Screen ${hex2(p.screen)}, tile ${t.x}, ${t.y}`;
}

// GAME_CAMERA: the game's FG/BG start Y; n: n rows above Mario (horizontal levels only, `relative`)
export const GAME_CAMERA = -100;
export function cameraOptions(cur: number, relative: boolean): [number, string][] {
  const rows = (n: number): [number, string] => [n, n < 0 ? `${-n} rows below Mario` : `${n} rows above Mario`];
  const opts: [number, string][] = [[GAME_CAMERA, 'FG/BG start Y'], ...(relative ? Array.from({ length: 17 }, (_, i) => rows(i)) : [])];
  return opts.some(([v]) => v === cur) ? opts : [...opts, rows(cur)];
}
export const cameraValue = (c: CameraStart): number => (c.cameraRelative ? cameraRows(c) : GAME_CAMERA);
// with the camera relative to Mario, where the BG starts (the level's setting): its bottom at the level's,
// rows below the FG, or at 0; `refresh` shows a change made elsewhere (cameraAtMario gives a BG its height)
const BG_KINDS: [number, string][] = [[0, 'Its bottom at the level\'s bottom'], [1, 'Relative to the FG'], [2, 'At 0 (absolute)']];
const KIND_OF: BgStart['kind'][] = ['bottom', 'fg', 'zero'];
const signed = (n: number) => `${n < 0 ? '−' : '+'}${Math.abs(n)} row${Math.abs(n) === 1 ? '' : 's'}`;
export function bgStartFields(s: Pick<SecondaryHeader, 'bgRelative' | 'bgHeight'>): { kind: HTMLSelectElement; rows: HTMLSelectElement; refresh: () => void } {
  const b = bgStart(s);
  const rows = h('select');
  const fill = () => {
    const c = bgStart(s);
    rows.style.display = c.kind === 'zero' ? 'none' : '';
    const opts: [number, string][] = c.kind === 'fg' ? Array.from({ length: 31 }, (_, i) => [i - 15, signed(i - 15)])
      : Array.from({ length: 32 }, (_, i) => [i + 1, `${i + 1} rows high`]);
    rows.replaceChildren(...opts.map(([v, l]) => h('option', { value: String(v), selected: c.kind !== 'zero' && v === c.rows }, l)));
  };
  const kind = select(BG_KINDS, KIND_OF.indexOf(b.kind), (k) => {
    const c = bgStart(s), want = KIND_OF[k];
    // the BG's height comes back when it was set, else the game's BG height; offsets start at +0
    setBgStart(s, want === 'bottom' ? { kind: want, rows: c.kind === 'bottom' ? c.rows : GAME_BG_ROWS } : want === 'fg' ? { kind: want, rows: 0 } : { kind: want });
    fill();
  });
  rows.addEventListener('change', () => {
    const c = bgStart(s);
    if (c.kind !== 'zero') setBgStart(s, { kind: c.kind, rows: Number(rows.value) });
  });
  const refresh = () => { kind.value = String(KIND_OF.indexOf(bgStart(s).kind)); fill(); };
  fill();
  return { kind, rows, refresh };
}
// (a main entrance's BG is then bottom-aligned, 27 rows high unless it has a height)
export function setCamera(c: CameraStart & { bgHeight?: number; bgRelative?: number }, v: number): void {
  if (v === GAME_CAMERA) { c.cameraRelative = 0; c.cameraOffsetHi = 0; return; }
  cameraAtMario(c);
  setCameraRows(c, v);
}

// a panel's rows as [label, input]; `set` applies an edit under its label
type Rows = [string, HTMLElement][];
type Set<T> = (label: string, f: (x: T) => void) => void;
const range4: [number, string][] = [[0, '0'], [1, '1'], [2, '2'], [3, '3']];

// a tile entrance's tile X and Y (Lunar Magic's tile position of the entrance screen)
export function tileFields<T extends EntranceTileFields>(t: { x: number; y: number }, set: Set<T>): Rows {
  return [
    ['Tile X', hexInput(t.x, 2, (v) => set('Tile X', (x) => setEntranceTile(x, { x: v })), 0x1f)],
    ['Tile Y', hexInput(t.y, 3, (v) => set('Tile Y', (x) => setEntranceTile(x, { y: v })), 0x3ff)],
  ];
}

// the camera start and, unless it is relative to Mario, the FG/BG start Y; `relative`: the entrance's level is
// horizontal (the camera can start relative to Mario)
export function cameraFields<T extends CameraStart>(c: T, set: Set<T>, relative: boolean): Rows {
  const v = cameraValue(c);
  return [
    ['Camera start', select(cameraOptions(v, relative), v, (n) => set('Camera start', (x) => setCamera(x, n)))],
    ...(c.cameraRelative ? [] : [
      ['FG start Y', select(range4, c.fgInitY, (n) => set('FG start Y', (x) => (x.fgInitY = n)))],
      ['BG start Y', select(range4, c.bgInitY, (n) => set('BG start Y', (x) => (x.bgInitY = n)))],
    ] as Rows),
  ];
}
