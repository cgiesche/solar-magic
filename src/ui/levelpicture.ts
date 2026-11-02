// What a level's image is drawn with (levelimages.ts): its load, its sprites' images, what its overlays are drawn from
// – its probes (in its tileset), its level scan and its sprite memory check when the overlays shown draw from them –
// and the jump arcs pinned in the open level; each learned (result cache entries kept) and waited for.

import type { App, AppEvent } from './app.ts';
import type { LearnSpec } from '../core/learnspecs.ts';
import type { LevelImages } from '../core/render.ts';
import { spriteId, type Level, type LevelSprite } from '../core/level.ts';
import type { LevelRender } from '../core/levelemu.ts';
import { scanKey, type ScanResult } from '../core/levelscan.ts';
import { levelOverlay, overlayPending, type OverlayLevel, type ArcsDraw } from './leveloverlays.ts';
import type { SpriteImage } from '../core/spritegfx.ts';
import { lostSprites, type SpriteMemResult } from '../core/spritemem.ts';
import { tideLines } from '../core/layer3.ts';
import type { Shown } from '../core/viewsettings.ts';
import type { LearnLane } from '../core/probeprotocol.ts';

// a level as drawn: its layers' images, its sprites' images, what its overlays are drawn from, the uids of the sprites
// sprite memory draws incompletely and the pinned jump arcs (the open level's only)
export interface LevelPicture {
  level: Level; images: LevelImages; sprite: (s: LevelSprite) => HTMLCanvasElement | undefined; overlay: OverlayLevel; incomplete: ReadonlySet<number>; arcs?: ArcsDraw;
}

// the jump arcs' tile when they are pinned (LevelView.arcPin)
export type ArcPin = { tx: number; ty: number } | null;

const SPRITE_LABEL = 'Level images: sprite graphics'; // (the busy label of their learn jobs)
export const SPRITE_GFX = 'Sprite graphics …'; // (what an export waits for while its sprites' images are learned)
const PROBE_WAIT = 30000; // ms a level waits for its probes at most (then: drawn with those known)

// An export's waits: lane: the learn jobs of its sprites' images (each export its own, dropped when it ends);
// cancelled, wake: ends the wait it is in; status: tells what it waits for now
export type ExportWait = { lane: LearnLane; cancelled: boolean; wake: (() => void) | null; status?: (what: string) => void };
export const cancelWait = (w: ExportWait) => { w.cancelled = true; w.wake?.(); };

// what the export waits for, unless it is cancelled before (then: null)
function until<T>(cancel: ExportWait, p: Promise<T>): Promise<T | null> {
  return new Promise((ok) => {
    const wake = () => ok(null);
    cancel.wake = wake;
    p.then(ok, () => ok(null)).finally(() => { if (cancel.wake === wake) cancel.wake = null; });
  });
}

// while probes are pending (their count; looked at again when the asked probes are all done – or the event: what
// the App says when they are –, or after half a second): false when cancelled
async function probed(app: App, cancel: ExportWait, what: string, pending: () => number, event: AppEvent = 'probes'): Promise<boolean> {
  const t0 = performance.now();
  for (let n = pending(); n > 0 && performance.now() - t0 < PROBE_WAIT; n = pending()) {
    cancel.status?.(`${what} (${n}) …`);
    await until(cancel, new Promise<void>((ok) => { const off = app.on(event, () => { off(); ok(); }); setTimeout(() => { off(); ok(); }, 500); }));
    if (cancel.cancelled) return false;
  }
  return !cancel.cancelled;
}

// a learn job's result (null: it failed, or its job was dropped)
function learned(app: App, cancel: ExportWait, j: LearnSpec, label: string): Promise<unknown> {
  return new Promise((ok) => {
    const r = app.probes.learn(j.key, j.job, { input: j.input, lane: cancel.lane, urgent: true, label, done: ok, failed: () => ok(null), dropped: () => ok(null) });
    if (r !== undefined) ok(r);
  });
}

// The images of the level's sprites, as the level view's (App.spriteImage) for this level: learned, the sprites'
// probes waited for (their variants; placed: the placed sprites' own images, else only those by sprite id – the
// items blocks and sprites give)
async function levelSprites(app: App, lv: Level, cancel: ExportWait, placed: boolean): Promise<Pick<LevelPicture, 'sprite'> & Pick<OverlayLevel, 'thumb'> | null> {
  const jobs = app.spriteJobs(lv), ts = lv.header.tileset;
  cancel.status?.(SPRITE_GFX);
  const all = await until(cancel, learned(app, cancel, jobs.all, SPRITE_LABEL)) as [number, SpriteImage][] | null;
  if (cancel.cancelled) return null;
  const base = new Map((all ?? []).map(([n, img]) => [n, app.spriteCanvas(img)]));
  const thumb = (id: number) => base.get(id);
  if (!placed) return { sprite: () => undefined, thumb };
  // the variants: once every sprite's probe is known (or failed)
  const plain = lv.sprites.filter((s) => !(s.extra >= 2 && s.bytes?.some((b) => b)));
  if (!await probed(app, cancel, 'Sprite probes', () => plain.filter((s) => app.spriteVariant(spriteId(s), s.x, s.y, ts) === undefined).length)) return null;
  cancel.status?.(SPRITE_GFX);
  const own = new Map<LevelSprite, HTMLCanvasElement>();
  for (const s of lv.sprites) {
    const id = spriteId(s), bytes = s.extra >= 2 ? s.bytes : undefined;
    let j = null;
    if (bytes?.some((b) => b)) j = jobs.bytes(id, [...bytes]);
    else {
      const at = app.spriteVariant(id, s.x, s.y, ts);
      if (at) j = jobs.at(id, at.x, at.y);
    }
    if (!j) continue;
    const img = await until(cancel, learned(app, cancel, j, SPRITE_LABEL)) as SpriteImage | null;
    if (cancel.cancelled) return null;
    if (img) own.set(s, app.spriteCanvas(img));
  }
  return { sprite: (s) => own.get(s) ?? base.get(spriteId(s)), thumb };
}

// Whether the overlays shown draw from the level's scan: the game view frame (the camera's reach), a tide that rises
// and falls (its highest and lowest water line)
function scanShown(show: Shown, render: LevelRender, images: LevelImages): boolean {
  return show.gameView || ((show.collision || show.layer3) && !!tideLines(render, images.layer3, images.width, null)?.moving);
}

// The level's scan (levelscan.ts), played for the level as edited unless the result cache holds it (null: it failed)
async function levelScan(app: App, lv: Level, images: LevelImages, cancel: ExportWait): Promise<ScanResult | null> {
  const ov = app.buildOverrides(lv);
  cancel.status?.('Level scan …');
  return await until(cancel, learned(app, cancel, { key: scanKey(lv.number, ov), job: { kind: 'scan', level: app.scanLevel(lv, ov, images) }, input: undefined }, 'Level images: level scan')) as ScanResult | null;
}

// The uids of the level's sprites sprite memory draws incompletely (spritemem.ts), checked for the level as edited
// unless the result cache holds the check (none when it failed)
async function incompleteIn(app: App, lv: Level, cancel: ExportWait): Promise<Set<number>> {
  const sm = app.spriteMemCheck(lv);
  cancel.status?.('Sprite memory …');
  const r = await until(cancel, learned(app, cancel, { key: sm.key, job: { kind: 'spriteMem', level: sm.level }, input: sm.input }, 'Level images: sprite memory')) as SpriteMemResult | null;
  return new Set(r ? lostSprites(sm.level, r) : []);
}

// The jump arcs from the pinned tile of the open level as edited (App.jumpArcs), once emulated (or the wait for them
// ends; undefined: cancelled)
async function pinnedArcs(app: App, at: { tx: number; ty: number }, cancel: ExportWait): Promise<ArcsDraw | undefined> {
  if (!await probed(app, cancel, 'Jump arcs', () => app.jumpArcs(at.tx, at.ty) === undefined ? 1 : 0, 'arcs')) return undefined;
  return { ...at, pinned: true, arcs: app.jumpArcs(at.tx, at.ty) };
}

// What the level is drawn with: its load (render, images), its sprites' images, its overlays with its probes (in its
// tileset), its level scan and its sprite memory check (when the overlays shown draw from them), the jump arcs from
// the tile they are pinned to (arcPin; the open level's) – waited for; null: cancelled
export async function levelPicture(app: App, lv: Level, images: LevelImages, render: LevelRender, cancel: ExportWait, arcPin: ArcPin = null): Promise<LevelPicture | null> {
  const show = app.view.show;
  const imgs = show.sprites || show.items ? await levelSprites(app, lv, cancel, show.sprites) : { sprite: () => undefined, thumb: () => undefined };
  if (!imgs) return null;
  const scan = scanShown(show, render, images) ? await levelScan(app, lv, images, cancel) : undefined;
  if (cancel.cancelled) return null;
  const incomplete = show.sprites && lv.sprites.length ? await incompleteIn(app, lv, cancel) : new Set<number>();
  if (cancel.cancelled) return null;
  const overlay = levelOverlay(app, lv, render, images, imgs.thumb, scan);
  if (!await probed(app, cancel, 'Block behavior for the overlays', () => overlayPending(overlay, show))) return null;
  const arcs = show.arcs && arcPin && lv === app.level ? await pinnedArcs(app, arcPin, cancel) : undefined;
  if (cancel.cancelled) return null;
  return { level: lv, images, sprite: imgs.sprite, overlay, incomplete, arcs };
}

