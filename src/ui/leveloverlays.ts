// The level view's overlays, drawn by the level view (levelview.ts) and in a level's image (levelimages.ts) alike:
// grid, screen boundaries, exits, entrance markers, conditional Direct Map16 badges, object boxes, invisible tiles,
// collision, tides, block and sprite contents, death markers and the game view frame. What they are drawn from is
// an OverlayLevel: the open level's (openOverlay) or another level's for its image (levelOverlay), with that
// level's probes (in its tileset). Selection, hover and drag previews stay the level view's own.

import type { App, Marker } from './app.ts';
import { hex2, hex3 } from '../core/names.ts';
import { screenRect, invisibleTiles, type LayerGeom, type LevelImages } from '../core/render.ts';
import { spriteId, type Level, type LevelObject } from '../core/level.ts';
import type { LevelRender } from '../core/levelemu.ts';
import type { Rom } from '../core/rom.ts';
import { exitTarget } from '../core/exitgraph.ts';
import { overworldExitText } from '../core/owteleport.ts';
import { SCREEN_PX } from '../core/levelimage.ts';
import { probeAt, spriteProbeAt, collisionIn, type PosProbe, type CollisionCore, type SwitchState, type BlockProbe, type CollisionProbe, type SpriteProbe } from '../core/blockprobe.ts';
import { KILL_FILL, HURT_FILL, CLIMB_FILL, SPIKE_COLOR, NET_COLOR, spikeRow, netTile, drawSkull, switchMarks, drawSwitchMarks } from './collisionmarks.ts';
import { map16Tile } from '../core/ram.ts';
import { isDm16, dm16Tiles, prefabFlags } from '../core/cdm16.ts';
import { boxLabel, boxedObjects } from '../core/objboxes.ts';
import { paintObjectBox } from './objbox.ts';
import { PREFAB_EXT, readPrefab } from '../core/prefabs.ts';
import { tideLines, type TideLines, type TideRange } from '../core/layer3.ts';
import { GAME_VIEW_W, GAME_VIEW_H, MARIO_W, MARIO_H, type CameraBands } from '../core/camerabands.ts';
import { gameViewAt, type CameraReach } from '../core/camerareach.ts';
import { projectId } from '../core/projectid.ts';
import { loadDeaths, killerTile, levelVersion, type DeathMark } from './deathmarks.ts';

// ---------------- what the overlays are drawn from ----------------

// A level as its overlays are drawn: its load, its entrances, its probes (in its tileset: undefined while not
// known – asked for then –, null when they failed or don't tell), the view's switch states and flags
export interface OverlayLevel {
  rom: Rom;
  level: Level;
  images: LevelImages;
  render: Pick<LevelRender, 'wram' | 'touched'>;
  markers: Marker[];
  block(tile: number): BlockProbe | null | undefined;
  collision(tile: number): CollisionProbe | null | undefined;
  sprite(id: number): SpriteProbe | null | undefined;
  thumb(id: number): HTMLCanvasElement | undefined; // a sprite's image by its id (spriteId: the items blocks and sprites give)
  switches: SwitchState[]; // the switch states the view sets (App.viewSwitches)
  cdm16: ReadonlySet<number>; // the conditional Direct Map16 flags the view has on
  tide: TideLines | null;
  reach: CameraReach | null | undefined; // from the level scan (undefined: none yet, null: not found)
  bands(): CameraBands | null | undefined; // the scroll bands under its mode and vertical scroll setting
  deaths: DeathMark[]; // where Mario died in test play
  version: number; // the level's version (deathmarks.ts levelVersion): older deaths are faded
}

// the open level as the level view shows it
export function openOverlay(app: App): OverlayLevel {
  const lv = app.level, h = lv.header;
  return {
    rom: app.rom, level: lv, images: app.images, render: app.render, markers: app.markers(),
    block: (t) => app.probes.block(t), collision: (t) => app.probes.collision(t), sprite: (id) => app.probes.sprite(id),
    thumb: (id) => app.spriteThumbs.get(id), switches: app.viewSwitches(), cdm16: app.cdm16,
    tide: app.tide(), reach: app.cameraReach(), bands: () => app.probes.cameraBands(h.mode, h.verticalScroll),
    deaths: loadDeaths(projectId(app.rom), lv.number), version: levelVersion(app.rom, lv.number),
  };
}

// Any level as its image draws it (levelimages.ts): its load (render, images), its probes in its tileset, its
// sprites' images (thumb), the tide range and camera reach of its level scan when there is one (scan)
export function levelOverlay(app: App, lv: Level, render: OverlayLevel['render'], images: LevelImages,
  thumb: OverlayLevel['thumb'], scan?: { tide?: TideRange | null; camera?: CameraReach | null } | null): OverlayLevel {
  const ts = lv.header.tileset, h = lv.header;
  return {
    rom: app.rom, level: lv, images, render, markers: app.markers(lv),
    block: (t) => app.probes.blockIn(t, ts), collision: (t) => app.probes.collisionIn(t, ts), sprite: (id) => app.probes.spriteIn(id, ts),
    thumb, switches: app.viewSwitches(), cdm16: app.cdm16,
    tide: tideLines(render, images.layer3, images.width, scan?.tide ?? null),
    reach: scan ? scan.camera ?? null : undefined,
    bands: () => app.probes.cameraBands(h.mode, h.verticalScroll, ts),
    deaths: loadDeaths(projectId(app.rom), lv.number), version: levelVersion(app.rom, lv.number),
  };
}

type Show = App['show'];

// What of the level's probes the overlays shown draw from and aren't known yet (asking for them): an image waits
// for them (levelimages.ts)
export function overlayPending(src: OverlayLevel, show: Show): number {
  let n = 0;
  const g = src.images.geom1, w = src.render.wram;
  if (show.layer1 && (show.items || show.collision)) {
    const tiles = new Set<number>();
    for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
      const a = g.addr(x, y);
      if (a >= 0) tiles.add(map16Tile(w, a));
    }
    for (const t of tiles) {
      if (show.items && src.block(t) === undefined) n++;
      if (show.collision && src.collision(t) === undefined) n++;
    }
  }
  if (show.sprites && show.items) for (const id of new Set(src.level.sprites.map(spriteId))) if (src.sprite(id) === undefined) n++;
  if (show.gameView && show.scrollBands && src.bands() === undefined) n++;
  return n;
}

// ---------------- the overlays, in the level view's order ----------------

// tiles x0..x1, y0..y1 (exclusive) of layer 1
export interface TileArea { x0: number; y0: number; x1: number; y1: number }
export const wholeLevel = (g: LayerGeom): TileArea => ({ x0: 0, y0: 0, x1: g.width, y1: g.height });

// the game view frame (camerabands.ts): its top left corner, its label and Mario when it is placed by him
export interface GameViewFrame { x: number; y: number; label: string; mario: { x: number; y: number } | null; held: boolean }

// The frame in a level: in the open level the camera at Mario when it is placed by him; else where it was put
// (first: the level's top left corner), inside the level and where the camera goes (reach)
export function gameViewIn(app: App, src: Pick<OverlayLevel, 'level' | 'images' | 'reach'>, held = false): GameViewFrame {
  const im = src.images, m = src.level === app.level ? app.gameViewMario : null;
  const p = m?.camera ?? gameViewAt(app.gameView?.x ?? 0, app.gameView?.y ?? 0, im.width, im.height, src.reach);
  const label = !m ? 'Game view' : m.camera === undefined ? 'Game view (emulating …)' : m.camera === null ? 'Game view (camera not found)' : 'Game view at Mario';
  return { x: p.x, y: p.y, label, mario: m && { x: m.x, y: m.y }, held };
}

// how the overlays are drawn: by the View settings (show), one line `lw` and one label pixel `px` wide (level
// pixels: the level view's screen pixels, an image's pixels), on the tiles of `area` (the level view: those in
// view), the first `screens` screens of `width`×`height` pixels
export interface OverlayDraw {
  show: Show;
  lw: number;
  px: number;
  area: TileArea;
  width: number;
  height: number;
  screens: number;
  exits: boolean; // drawn (the level view also in exit mode)
  chosenExit: number; // the screen the exit panel has chosen (-1: none)
  marker?: (m: Marker) => { big: boolean; ring: boolean }; // an entrance marker dragged (big), chosen in exit mode (ring)
  layer2: boolean; // the conditional Direct Map16 badges of layer 2's objects (the level view in layer 2 mode)
  tideLabelX: number; // where the tide's labels start
  spriteAlpha: number;
  sprites: () => void; // draws the sprites (after the block contents, before what they give)
  arcs?: () => void; // the level view's jump arcs
  gameView?: GameViewFrame; // while show.gameView
}

export function paintOverlays(ctx: CanvasRenderingContext2D, app: App, src: OverlayLevel, d: OverlayDraw): void {
  const show = d.show, im = src.images;
  if (show.grid) paintGrid(ctx, d.width, d.height, d.lw);
  if (show.screens) paintScreens(ctx, d.width, d.height, im.geom1.vertical, d.screens, d.lw, d.px);
  if (d.exits) {
    if (d.chosenExit >= 0) {
      // the chosen screen, also without an exit
      const r = screenRect(im.geom1, d.chosenExit);
      ctx.strokeStyle = 'rgba(255,200,0,0.9)';
      ctx.lineWidth = 2 * d.px;
      ctx.strokeRect(r.x + d.px, r.y + d.px, r.w - 2 * d.px, r.h - 2 * d.px);
    }
    paintExits(ctx, app, { ...src.level, exits: src.level.exits.filter((e) => e.screen < d.screens) }, im.geom1, d.px, d.chosenExit);
  }
  paintMarkers(ctx, src, d.marker);
  if (d.layer2 ? show.layer2 : show.layer1) paintConds(ctx, src, d.layer2, d.lw);
  paintBoxes(ctx, src, show);
  if (show.invisible) paintInvisible(ctx, src, show, d.area, d.lw);
  if (show.collision && show.layer1) paintCollision(ctx, src, d.area, 2 * d.px);
  if (show.collision || show.layer3) paintTide(ctx, src, show.collision, d.tideLabelX, d.px);
  if (show.items && show.layer1) paintItems(ctx, src, d.area);
  if (show.sprites) d.sprites();
  if (show.sprites && show.items) paintSpriteItems(ctx, src, d.spriteAlpha);
  if (show.deaths) paintDeaths(ctx, src, d.lw);
  if (show.arcs) d.arcs?.();
  if (show.gameView && d.gameView) paintGameView(ctx, src, d.gameView, show.scrollBands, d.px);
}

export function paintGrid(ctx: CanvasRenderingContext2D, width: number, height: number, lw: number): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = lw;
  ctx.beginPath();
  for (let x = 0; x <= width; x += 16) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
  for (let y = 0; y <= height; y += 16) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
  ctx.stroke();
}

// dashed lines between the screens and each screen's number
export function paintScreens(ctx: CanvasRenderingContext2D, width: number, height: number, vertical: boolean, screens: number, lw: number, px: number): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.setLineDash([4 * lw, 4 * lw]);
  ctx.lineWidth = lw;
  ctx.beginPath();
  if (vertical) for (let y = SCREEN_PX; y < height; y += SCREEN_PX) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
  else for (let x = SCREEN_PX; x < width; x += SCREEN_PX) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
  ctx.stroke();
  ctx.setLineDash([]);
  // on a dark box like the exit labels, readable on light backgrounds too
  ctx.font = `${11 * px}px sans-serif`;
  for (let s = 0; s < screens; s++) {
    const x = vertical ? 0 : s * SCREEN_PX, y = vertical ? s * SCREEN_PX : 0, txt = hex2(s);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y, ctx.measureText(txt).width + 4 * px, 14 * px);
    ctx.fillStyle = '#fff';
    ctx.fillText(txt, x + 2 * px, y + 11 * px);
  }
}

// the screens with an exit, tinted (selected: the exit panel's), and where each leads
export function paintExits(ctx: CanvasRenderingContext2D, app: App, lv: Level, geom: LayerGeom, px: number, selected = -1): void {
  const g = app.entrances.graph();
  for (const ex of lv.exits) {
    const { x, y, w, h: rh } = screenRect(geom, ex.screen);
    ctx.fillStyle = selected === ex.screen ? 'rgba(255,200,0,0.25)' : 'rgba(255,160,0,0.08)';
    ctx.fillRect(x, y, w, rh);
    const t = exitTarget(app.rom, lv.number, ex);
    const ok = t.entrance < 0 || t.overworld || g.entrancesOf(t.to).includes(t.entrance);
    ctx.font = `bold ${12 * px}px sans-serif`;
    const line = (txt: string, i: number) => {
      const ty = y + (12 + i * 14) * px;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x + 18 * px, ty - 11 * px, ctx.measureText(txt).width + 4 * px, 14 * px);
      ctx.fillStyle = ok ? '#ffb000' : '#ff5050';
      ctx.fillText(txt, x + 20 * px, ty);
    };
    line(t.overworld ? 'Exit → Overworld' : `Exit → ${g.label(t.to)}`, 0);
    if (t.overworld) line(overworldExitText(app.rom, app.entrances.get(t.entrance).overworld!), 1);
    else if (t.entrance >= 0) line(ok ? `via sec. entrance ${hex3(t.entrance)}` : `sec. entrance ${hex3(t.entrance)} missing`, 1);
  }
}

export const MARKER_STYLE: Record<Marker['kind'], { color: string; label: string; title: string }> = {
  main: { color: 'rgba(255,40,40,0.9)', label: 'M', title: 'Main entrance' },
  midway: { color: 'rgba(255,150,0,0.9)', label: 'Z', title: 'Midway point' },
  sec: { color: 'rgba(40,120,255,0.9)', label: 'S', title: 'Secondary entrance' },
};

// entrance markers (Mario's start position, drawn at his lower 16x16 half)
export function paintMarkers(ctx: CanvasRenderingContext2D, src: OverlayLevel, how?: OverlayDraw['marker']): void {
  const im = src.images;
  ctx.font = `bold 9px sans-serif`;
  for (const m of src.markers) {
    if (m.x >= im.width || m.y >= im.height + 32) continue;
    const st = MARKER_STYLE[m.kind], k = how?.(m);
    ctx.fillStyle = st.color;
    ctx.beginPath();
    ctx.arc(m.x + 8, m.y + 24, k?.big ? 8 : 6, 0, Math.PI * 2);
    ctx.fill();
    if (k?.ring) {
      ctx.strokeStyle = '#ffd800';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(m.x + 8, m.y + 24, 9.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.fillText(st.label, m.x + 5, m.y + 27.5);
    if (m.kind === 'sec') ctx.fillText(hex3(m.index), m.x + 15, m.y + 27.5);
  }
}

// the key of a layer's object in the level's load (LevelRender.touched)
const objectKey = (l2: boolean, i: number) => (l2 ? 0x8000 | i : i);

// conditional Direct Map16 (cdm16.ts): a flag badge on each object of the layer that depends on a flag (prefabs by
// their tiles' flags), green while the view shows it with the flag on; where one left nothing in the level's
// load, its tiles dashed
export function paintConds(ctx: CanvasRenderingContext2D, src: OverlayLevel, l2: boolean, lw: number): void {
  const objs = (l2 ? src.level.layer2Objects : src.level.objects) ?? [];
  const prefabs = new Map<number, number[]>();
  ctx.font = 'bold 7px sans-serif';
  objs.forEach((o, i) => {
    let flags: number[];
    if (isDm16(o)) flags = o.cond ? [o.cond.flag] : [];
    else if (o.num === 0 && o.ext === PREFAB_EXT && o.prefab !== undefined) {
      if (!prefabs.has(o.prefab)) prefabs.set(o.prefab, prefabFlags(readPrefab(src.rom, o.prefab)));
      flags = prefabs.get(o.prefab)!;
    } else return;
    if (!flags.length) return;
    if (isDm16(o) && o.cond && !src.render.touched.get(objectKey(l2, i))?.size) {
      ctx.strokeStyle = 'rgba(255,190,60,0.8)';
      ctx.lineWidth = lw;
      ctx.setLineDash([3 * lw, 3 * lw]);
      for (const t of dm16Tiles(o)) ctx.strokeRect((t & 0xffff) * 16 + 0.5, (t >> 16) * 16 + 0.5, 15, 15);
      ctx.setLineDash([]);
    }
    const on = flags.some((f) => src.cdm16.has(f));
    const txt = `⚑${flags.slice(0, 2).map(hex2).join(',')}${flags.length > 2 ? '…' : ''}`;
    const x = o.x * 16 + 1, y = o.y * 16 + 1, w = ctx.measureText(txt).width + 3;
    ctx.fillStyle = on ? 'rgba(30,140,60,0.9)' : 'rgba(150,90,0,0.9)';
    ctx.fillRect(x, y, w, 9);
    ctx.fillStyle = '#fff';
    ctx.fillText(txt, x + 1.5, y + 7.5);
  });
}

// the objects of the layers shown that draw nothing (objboxes.ts): a box on their tile
export function boxLayers(show: Show, lv: Level): boolean[] {
  return [false, true].filter((l2) => (l2 ? show.layer2 && !!lv.layer2Objects : show.layer1));
}
export function boxedIn(src: Pick<OverlayLevel, 'level' | 'render'>, l2: boolean): LevelObject[] {
  return boxedObjects((l2 ? src.level.layer2Objects : src.level.objects) ?? [], src.render.touched, (i) => objectKey(l2, i));
}
export function paintBoxes(ctx: CanvasRenderingContext2D, src: OverlayLevel, show: Show): void {
  for (const l2 of boxLayers(show, src.level)) for (const o of boxedIn(src, l2)) paintObjectBox(ctx, o.x * 16, o.y * 16, boxLabel(o));
}

// tiles that are there but cannot be seen (render.ts invisibleTiles): areas of them tinted, their edges dashed;
// layer 2 objects' too while layer 2 is shown
const invisibles = new WeakMap<LevelImages, { l1: (x: number, y: number) => boolean; l2: (x: number, y: number) => boolean }>();
export function paintInvisible(ctx: CanvasRenderingContext2D, src: OverlayLevel, show: Show, area: TileArea, lw: number): void {
  const im = src.images;
  let inv = invisibles.get(im);
  if (!inv) invisibles.set(im, inv = { l1: invisibleTiles(src.rom, im, false), l2: invisibleTiles(src.rom, im, true) });
  const { x0, y0, x1, y1 } = area;
  const layers = [...show.layer1 ? [inv.l1] : [], ...show.layer2 && src.level.layer2Objects ? [inv.l2] : []];
  for (const at of layers) {
    const edges = new Path2D();
    ctx.fillStyle = 'rgba(150,70,255,0.4)';
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!at(x, y)) continue;
      const px = x * 16, py = y * 16;
      ctx.fillRect(px, py, 16, 16);
      if (!at(x - 1, y)) { edges.moveTo(px, py); edges.lineTo(px, py + 16); }
      if (!at(x + 1, y)) { edges.moveTo(px + 16, py); edges.lineTo(px + 16, py + 16); }
      if (!at(x, y - 1)) { edges.moveTo(px, py); edges.lineTo(px + 16, py); }
      if (!at(x, y + 1)) { edges.moveTo(px, py + 16); edges.lineTo(px + 16, py + 16); }
    }
    ctx.lineWidth = 2 * lw;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.stroke(edges);
    ctx.strokeStyle = '#e4d8ff';
    ctx.setLineDash([3 * lw, 3 * lw]);
    ctx.stroke(edges);
    ctx.setLineDash([]);
  }
}

// How Mario collides with layer 1 (found by emulation): the level is dimmed, solid sides are white lines (`lw`
// wide) where they face something passable, platforms (solid from above only) dashed, slopes diagonal; red: hurts,
// with spikes on the sides that hurt (stronger, with a skull: kills), blue: water, green with a net: climbable. All
// in the switch states the view sets (P-switches, OFF); a tile that a switch state makes act otherwise has that
// switch's color at its bottom.
export function paintCollision(ctx: CanvasRenderingContext2D, src: OverlayLevel, area: TileArea, lw: number): void {
  const g = src.images.geom1, w = src.render.wram, on = src.switches;
  const { x0, y0, x1, y1 } = area;
  const info = new Map<number, { c: CollisionCore; sw: SwitchState[] } | undefined>();
  const probe = (x: number, y: number) => {
    const a = g.addr(x, y);
    if (a < 0) return undefined;
    const t = map16Tile(w, a);
    if (!info.has(t)) { const p = src.collision(t); info.set(t, p ? { c: collisionIn(p, on), sw: switchMarks([p]) } : undefined); }
    return info.get(t);
  };
  const at = (x: number, y: number): CollisionCore | undefined => probe(x, y)?.c; // (neighbors)
  const switched: [number, number, SwitchState[]][] = [];
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x0 * 16, y0 * 16, (x1 - x0) * 16, (y1 - y0) * 16);
  const solidLines = new Path2D(), platLines = new Path2D(), net = new Path2D(), spikes = new Path2D();
  const skulls: [number, number][] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const here = probe(x, y);
    if (!here) continue;
    const c = here.c, px = x * 16, py = y * 16;
    if (here.sw.length) switched.push([px, py, here.sw]);
    const fill = c.kills ? KILL_FILL : c.hurtsTop || c.hurtsSide ? HURT_FILL
      : c.water ? 'rgba(60,140,255,0.35)' : c.climb ? CLIMB_FILL : null;
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(px, py, 16, 16); }
    if (c.kills) skulls.push([px, py]);
    else {
      // spikes on the sides that hurt, where they face something Mario can come from
      if (c.hurtsTop && !at(x, y - 1)?.bottom) spikeRow(spikes, px, py, 0);
      if (c.hurtsSide && !at(x - 1, y)?.right) spikeRow(spikes, px, py, 1);
      if (c.hurtsSide && !at(x + 1, y)?.left) spikeRow(spikes, px, py, 2);
    }
    if (c.climb) netTile(net, px, py);
    if (c.slope) {
      // the surface within the tile (steep slopes measure beyond it)
      const [l, r] = c.slope, k = (r - l) / 16, xAt = (yy: number) => (yy - l) / k;
      let xa = 0, xb = 16;
      if (k !== 0) {
        const lo = Math.min(xAt(0), xAt(16)), hi = Math.max(xAt(0), xAt(16));
        xa = Math.max(0, lo); xb = Math.min(16, hi);
      }
      const yAt = (xx: number) => Math.max(0, Math.min(16, l + k * xx));
      solidLines.moveTo(px + xa, py + yAt(xa));
      solidLines.lineTo(px + xb, py + yAt(xb));
      continue;
    }
    const full = c.bottom || c.left || c.right;
    if (c.top && !full) {
      if (!at(x, y - 1)?.bottom) { platLines.moveTo(px, py); platLines.lineTo(px + 16, py); }
      continue;
    }
    // sides facing a tile that doesn't close them off
    if (c.top && !at(x, y - 1)?.bottom) { solidLines.moveTo(px, py); solidLines.lineTo(px + 16, py); }
    if (c.bottom && !at(x, y + 1)?.top) { solidLines.moveTo(px, py + 16); solidLines.lineTo(px + 16, py + 16); }
    if (c.left && !at(x - 1, y)?.right) { solidLines.moveTo(px, py); solidLines.lineTo(px, py + 16); }
    if (c.right && !at(x + 1, y)?.left) { solidLines.moveTo(px + 16, py); solidLines.lineTo(px + 16, py + 16); }
  }
  ctx.lineWidth = lw;
  ctx.strokeStyle = '#fff';
  ctx.stroke(solidLines);
  ctx.strokeStyle = '#7fe0ff';
  ctx.setLineDash([3 * lw, 2 * lw]);
  ctx.stroke(platLines);
  ctx.setLineDash([]);
  ctx.lineWidth = lw / 2;
  ctx.strokeStyle = NET_COLOR;
  ctx.stroke(net);
  ctx.fillStyle = SPIKE_COLOR;
  ctx.fill(spikes);
  ctx.fillStyle = '#fff';
  for (const [px, py] of skulls) drawSkull(ctx, px, py);
  for (const [px, py, sw] of switched) drawSwitchMarks(ctx, px, py, sw);
}

// Water of a layer 3 tide (layer3.ts tideLines): in the collision overlay the area Mario swims in is blue (lighter
// where only at high tide); a tide that rises and falls gets dashed lines at its highest and lowest water line,
// labelled from labelX on
export function paintTide(ctx: CanvasRenderingContext2D, src: OverlayLevel, collision: boolean, labelX: number, px: number): void {
  const t = src.tide, im = src.images;
  if (!t) return;
  if (collision) {
    ctx.fillStyle = 'rgba(60,140,255,0.18)';
    ctx.fillRect(0, t.high, im.width, t.low - t.high);
    ctx.fillStyle = 'rgba(60,140,255,0.35)';
    ctx.fillRect(0, t.low, im.width, im.height - t.low);
  }
  if (!t.moving || t.high === t.low) return;
  const lw = 1.5 * px;
  ctx.lineWidth = lw;
  ctx.strokeStyle = '#7fc8ff';
  ctx.setLineDash([6 * lw, 4 * lw]);
  ctx.beginPath();
  for (const y of [t.high, t.low]) { ctx.moveTo(0, y); ctx.lineTo(im.width, y); }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `bold ${11 * px}px sans-serif`;
  for (const [y, txt] of [[t.high, 'Tide: highest water'], [t.low, 'Tide: lowest water']] as [number, string][]) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(labelX - 2 * px, y - 14 * px, ctx.measureText(txt).width + 4 * px, 13 * px);
    ctx.fillStyle = '#7fc8ff';
    ctx.fillText(txt, labelX, y - 4 * px);
  }
}

// translucent image of the item a block (visible part of layer 1) gives, drawn over it; arrows for the directions
// it can be entered in
export function paintItems(ctx: CanvasRenderingContext2D, src: OverlayLevel, area: TileArea): void {
  const g = src.images.geom1, w = src.render.wram;
  ctx.globalAlpha = 0.65;
  for (let y = area.y0; y < area.y1; y++) for (let x = area.x0; x < area.x1; x++) {
    const a = g.addr(x, y);
    if (a < 0) continue;
    const p = src.block(map16Tile(w, a));
    if (!p) continue;
    if (p.summary !== null) drawItem(ctx, src, probeAt(p, x), x * 16, y * 16);
    if (p.enter) drawEnter(ctx, p.enter, x * 16, y * 16);
  }
  ctx.globalAlpha = 1;
}

// arrows for the directions a tile can be entered in (pipes, doors), white in the upper right
// corner like the items; drawn as shapes, text glyphs blur at 16 px tiles
function drawEnter(ctx: CanvasRenderingContext2D, dirs: string, x: number, y: number): void {
  const a = ctx.globalAlpha, n = dirs.length, bx = x + 16 - n * 5 - 1;
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(bx, y, n * 5 + 1, 6);
  ctx.fillStyle = '#fff';
  [...dirs].forEach((d, i) => {
    const cx = bx + 3 + i * 5, cy = y + 3; // 4x4 triangle around (cx, cy)
    const pts = d === '↓' ? [[-2, -2], [2, -2], [0, 2]] : d === '↑' ? [[-2, 2], [2, 2], [0, -2]]
      : d === '←' ? [[2, -2], [2, 2], [-2, 0]] : [[-2, -2], [-2, 2], [2, 0]];
    ctx.beginPath();
    pts.forEach(([px, py], k) => (k ? ctx.lineTo(cx + px, cy + py) : ctx.moveTo(cx + px, cy + py)));
    ctx.fill();
  });
  ctx.globalAlpha = a;
}

// the same for sprites that give items (flying ? blocks …), drawn over the sprite images
export function paintSpriteItems(ctx: CanvasRenderingContext2D, src: OverlayLevel, alpha: number): void {
  ctx.globalAlpha = 0.65 * alpha;
  for (const s of src.level.sprites) {
    const p = src.sprite(spriteId(s));
    if (p?.summary) drawItem(ctx, src, spriteProbeAt(p, s.x, s.y), s.x * 16, s.y * 16);
  }
  ctx.globalAlpha = 1;
}

// item of a probe result at pixel (x, y); a different item for big Mario at half size, upper right
function drawItem(ctx: CanvasRenderingContext2D, src: OverlayLevel, r: PosProbe, x: number, y: number): void {
  const small = r.small.sprites[0], big = r.big.sprites[0];
  const main = small ?? big ?? r.stomp?.sprites[0];
  const img = main !== undefined ? src.thumb(main) : undefined;
  if (!img) return;
  ctx.drawImage(img, x + Number(img.dataset.ox), y + Number(img.dataset.oy));
  const alt = big !== undefined && big !== main ? src.thumb(big) : undefined;
  if (alt) ctx.drawImage(alt, x + 8 + Number(alt.dataset.ox) / 2, y + Number(alt.dataset.oy) / 2, alt.width / 2, alt.height / 2);
}

// where Mario died in test play (deathmarks.ts), by his tile inside the level (a pit's below it: its bottom row)
export function deathsAt(src: Pick<OverlayLevel, 'images' | 'deaths'>): Map<string, { tx: number; ty: number; marks: DeathMark[] }> {
  const w = src.images.width >> 4, hgt = src.images.height >> 4, at = new Map<string, { tx: number; ty: number; marks: DeathMark[] }>();
  for (const d of src.deaths) {
    const tx = Math.max(0, Math.min(w - 1, d.tx)), ty = Math.max(0, Math.min(hgt - 1, d.ty)), k = `${tx},${ty}`;
    const e = at.get(k) ?? { tx, ty, marks: [] };
    e.marks.push(d);
    at.set(k, e);
  }
  return at;
}

// a red cross at Mario's tile (with the number of deaths there), a dashed red box at what killed him and a
// line to it; faded: deaths before the level was last changed (saved)
export function paintDeaths(ctx: CanvasRenderingContext2D, src: OverlayLevel, lw: number): void {
  const at = deathsAt(src), w = (src.images.width >> 4) - 1, hgt = (src.images.height >> 4) - 1;
  const old = (d: DeathMark) => d.version !== src.version;
  if (!at.size) return;
  ctx.lineWidth = 2 * lw;
  ctx.strokeStyle = 'rgba(255,60,60,0.9)';
  ctx.setLineDash([3 * lw, 3 * lw]);
  for (const { tx, ty, marks } of at.values()) for (const d of marks) {
    const kt = killerTile(d.killer);
    if (!kt) continue;
    const k = { tx: Math.max(0, Math.min(w, kt.tx)), ty: Math.max(0, Math.min(hgt, kt.ty)) };
    ctx.globalAlpha = old(d) ? 0.35 : 1;
    ctx.strokeRect(k.tx * 16 + 1, k.ty * 16 + 1, 14, 14);
    ctx.beginPath();
    ctx.moveTo(tx * 16 + 8, ty * 16 + 8);
    ctx.lineTo(k.tx * 16 + 8, k.ty * 16 + 8);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = 'bold 8px sans-serif';
  for (const { tx, ty, marks } of at.values()) {
    const x = tx * 16, y = ty * 16;
    ctx.globalAlpha = marks.every(old) ? 0.35 : 1;
    ctx.lineCap = 'round';
    for (const [width, color] of [[4, 'rgba(0,0,0,0.7)'], [2, '#ff3c3c']] as const) {
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x + 3, y + 3); ctx.lineTo(x + 13, y + 13);
      ctx.moveTo(x + 13, y + 3); ctx.lineTo(x + 3, y + 13);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    if (marks.length > 1) {
      const txt = String(marks.length);
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(x + 10, y - 2, ctx.measureText(txt).width + 3, 9);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, x + 11.5, y + 5);
    }
  }
  ctx.globalAlpha = 1;
}

// the game view's scroll bands: X bands are columns of the frame, Y bands rows; the look-ahead ones outlined
export const BAND_STYLE: Record<keyof CameraBands, { color: string; label: string; axis: 'x' | 'y'; look?: boolean }> = {
  right: { color: '255,60,60', label: 'scrolling right', axis: 'x' },
  left: { color: '60,220,90', label: 'scrolling left', axis: 'x' },
  up: { color: '70,130,255', label: 'scrolling up', axis: 'y' },
  down: { color: '190,80,255', label: 'scrolling down', axis: 'y' },
  lookRight: { color: '255,200,40', label: 'after R (look ahead)', axis: 'x', look: true },
  lookLeft: { color: '60,220,255', label: 'after L (look ahead)', axis: 'x', look: true },
};

// the label in the frame's top left corner (`px`: a screen pixel, it stays the same size on the screen)
export function gameViewLabelBox(f: Pick<GameViewFrame, 'x' | 'y' | 'label'>, px: number): { x: number; y: number; w: number; h: number } {
  return { x: f.x, y: f.y, w: (10 + f.label.length * 6) * px, h: 14 * px };
}

// The game view frame (camerabands.ts) over the level darkened where the camera never goes (camerareach.ts),
// with the scroll bands inside when they are shown, and Mario when it is placed by him
export function paintGameView(ctx: CanvasRenderingContext2D, src: OverlayLevel, f: GameViewFrame, scrollBands: boolean, px: number): void {
  const lw = px;
  paintCameraReach(ctx, src);
  if (f.mario) {
    ctx.fillStyle = 'rgba(255,60,60,0.45)';
    ctx.fillRect(f.mario.x, f.mario.y, MARIO_W, MARIO_H);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * lw;
    ctx.strokeRect(f.mario.x, f.mario.y, MARIO_W, MARIO_H);
  }
  const bands = scrollBands ? src.bands() : undefined;
  for (const [k, st] of Object.entries(BAND_STYLE) as [keyof CameraBands, (typeof BAND_STYLE)[keyof CameraBands]][]) {
    const b = bands?.[k];
    if (!b) continue;
    const [x, y, w, bh] = st.axis === 'x' ? [f.x + b.from, f.y, b.to - b.from, GAME_VIEW_H] : [f.x, f.y + b.from, GAME_VIEW_W, b.to - b.from];
    ctx.fillStyle = `rgba(${st.color},${st.look ? 0.12 : 0.22})`;
    ctx.fillRect(x, y, w, bh);
    if (st.look) {
      ctx.strokeStyle = `rgba(${st.color},0.9)`;
      ctx.lineWidth = 1.5 * lw;
      ctx.setLineDash([4 * lw, 3 * lw]);
      ctx.strokeRect(x, y, w, bh);
      ctx.setLineDash([]);
    }
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 4 * lw;
  ctx.strokeRect(f.x, f.y, GAME_VIEW_W, GAME_VIEW_H);
  ctx.strokeStyle = f.held ? '#ffd800' : '#ffffff';
  ctx.lineWidth = 2 * lw;
  ctx.strokeRect(f.x, f.y, GAME_VIEW_W, GAME_VIEW_H);
  const l = gameViewLabelBox(f, px);
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(l.x, l.y, l.w, l.h);
  ctx.fillStyle = '#fff';
  ctx.font = `${11 * px}px sans-serif`;
  ctx.fillText(f.label, l.x + 5 * px, l.y + 11 * px);
}

// the level darkened where the camera never shows it, a rectangle per run of columns (vertical levels: rows)
// with the same span
function paintCameraReach(ctx: CanvasRenderingContext2D, src: OverlayLevel): void {
  const r = src.reach, im = src.images;
  if (!r) return;
  const across = r.vertical ? im.width : im.height;
  const rect = (along: number, n: number, from: number, to: number) => {
    if (to > from) { if (r.vertical) ctx.fillRect(from, along, to - from, n); else ctx.fillRect(along, from, n, to - from); }
  };
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  for (let i = 0, j = 0; i < r.spans.length; i = j) {
    const s = r.spans[i];
    for (j = i + 1; j < r.spans.length && r.spans[j]?.[0] === s?.[0] && r.spans[j]?.[1] === s?.[1]; j++);
    const [from, to] = s ?? [across, across];
    rect(i * 16, (j - i) * 16, 0, from);
    rect(i * 16, (j - i) * 16, to, across);
  }
}
