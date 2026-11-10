// The test ROM: the clean game (test/fixtures/smw.smc, provided by hand), and the same as the editor
// opens it – with its own patches installed (editorpatches.ts)
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { installEditorPatches } from '../src/core/editorpatches.ts';
import type { Package } from '../src/core/pkgreg.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { JobRunner } from '../src/core/jobrunner.ts';
import { RenderQuery } from '../src/core/renderquery.ts';
import { renderLevel } from '../src/core/render.ts';
import { levelRows, type Level } from '../src/core/level.ts';
import type { LevelRender } from '../src/core/levelemu.ts';
import { pathKindsJob, pathShapesJob, levelTileTest, type PathKind, type PathShapes, type LevelTileTest } from '../src/core/owpaths.ts';
import { OW_EVENTS, gameL1, type OverworldLoads } from '../src/core/overworld.ts';
import { hardWalksJob, hardWalksInput, type HardWalk } from '../src/core/owhardpaths.ts';
import { progressSaves, type ProgressMap } from '../src/core/owprogress.ts';
import { RAM } from '../src/core/ram.ts';

// the render query of level lv's load r, its layers' geometry as the editor draws it (App.refresh)
export function levelQuery(rom: Rom, r: LevelRender, lv: Level): RenderQuery {
  const im = renderLevel(rom, r, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
  return new RenderQuery(r, im.geom1, im.geom2);
}

export const cleanImage = (): Uint8Array => new Uint8Array(readFileSync('test/fixtures/smw.smc'));

let patched: Uint8Array | null = null;
// a copy of the image with the editor patches
export async function editorImage(): Promise<Uint8Array> {
  if (!patched) {
    const rom = new Rom(cleanImage());
    await installEditorPatches(rom);
    patched = rom.data;
  }
  return patched.slice();
}

// the kinds of the overworld's layer 1 tiles in `rom` (owpaths.ts), the job run to its end as the result learner runs it
export function pathKinds(rom: Rom): PathKind[] {
  const runner = new JobRunner({ rom, results: new ResultCache(new RomFingerprint(rom)) });
  const run = runner.run({ key: 'owpk', keep: false, picture: false, start: pathKindsJob });
  for (;;) { const r = runner.step('owpk', run); if (r) return r.result; }
}
// the shapes of the overworld's path tiles in `rom` (owpaths.ts), as pathKinds
export function pathShapes(rom: Rom): PathShapes {
  const runner = new JobRunner({ rom, results: new ResultCache(new RomFingerprint(rom)) });
  const run = runner.run({ key: 'owsh', keep: false, picture: false, start: pathShapesJob });
  for (;;) { const r = runner.step('owsh', run); if (r) return r.result; }
}
// the game's hardcoded paths in `rom` (owhardpaths.ts) from its path kinds, as pathKinds (the input as App asks with)
export function hardWalks(rom: Rom, kinds: readonly PathKind[] = pathKinds(rom)): HardWalk[] {
  const runner = new JobRunner({ rom, results: new ResultCache(new RomFingerprint(rom)) }), { l1, tls, cells } = hardWalksInput(rom, kinds);
  const run = runner.run({ key: 'owhw', keep: false, picture: false, start: (emu) => hardWalksJob(emu, l1, tls, cells) });
  for (;;) { const r = runner.step('owhw', run); if (r) return r.result; }
}
// which tiles are level tiles in `rom`, learned as the editor learns them
export const levelTiles = (rom: Rom): LevelTileTest => levelTileTest(pathKinds(rom));

// The maps the game loads at every event progress 0 … OW_EVENTS (index: the progress), emulated: layer 1 and the
// translevels of the main map loaded there (layer 1 is the same whichever map is loaded), the level flags of the save
// there (owprogress.ts progressSaves) – what progressMapsFromEvents builds from the events is checked against. The
// saves in one step, then a step per progress (each kept by the loads while the ROM bytes it read are unchanged)
export function* loadedProgressMaps(loads: OverworldLoads): Generator<void, ProgressMap[]> {
  const saves = progressSaves(loads);
  yield;
  const out: ProgressMap[] = [];
  for (let p = 0; p <= OW_EVENTS; p++) {
    const m = loads.derive(`progressMap:${p}`, (load) => {
      const r = load(0, p);
      return { l1: gameL1(r), tls: r.wram.slice(RAM.owTranslevels, RAM.owTranslevelsEnd) };
    });
    out.push({ ...m, flags: saves[p].levelFlags });
    yield;
  }
  return out;
}

// bytes that differ between two ROM images (missing bytes count as 0), not counting `skip` and the patch
// registry (SMWA): it is rewritten into the first free space after every change, so it moves around
export function romDiff(a: Uint8Array, b: Uint8Array, skip: (i: number) => boolean = () => false): number {
  const reg = (d: Uint8Array) => new Rom(d.slice()).scanRats().filter((r) => [0x53, 0x4d, 0x57, 0x41].every((m, k) => d[r.start + 8 + k] === m)).map((r) => [r.start, r.start + 8 + r.size]);
  const regs = [...reg(a), ...reg(b)];
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0) && !skip(i) && !regs.some(([s, e]) => i >= s && i < e)) n++;
  return n;
}

// a package's record without what is new each install (its id, date, files' blob id, the patches' registry
// ids: their number), to compare two installs
export function recordShape(pkg: Package | undefined): string {
  if (!pkg) return '';
  const { id: _i, added: _a, srcId: _s, patches, ...rest } = pkg;
  return JSON.stringify({ ...rest, patches: patches.length });
}
