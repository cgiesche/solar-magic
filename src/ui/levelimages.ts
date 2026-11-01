// Levels as image files: File → "Level as PNG" (the open level) and "Levels as images" (Lunar Magic's "Export
// Multiple Levels to Image Files", LM help: file_export_directory_bitmap.htm): each level drawn as the level view
// shows it – the View menu's layers, sprites, exits, screen boundaries and grid – one PNG per level in a .zip.
// Better than Lunar Magic: a list of levels, a zoom, file names with the level's name; cropping to the screens a
// level uses (Lunar Magic's "Auto-Set Number of Screens") leaves the level as it is.

import { zipSync } from 'fflate';
import type { App } from './app.ts';
import { h, modal, toast, log } from './dom.ts';
import { downloadBytes } from './platform.ts';
import { levelNameOf } from './panels.ts';
import { hex2, hex3 } from '../core/names.ts';
import { composite, screenRect, type LevelImages, type LayerGeom } from '../core/render.ts';
import { loadLevel, spriteId, type Level, type LevelSprite } from '../core/level.ts';
import { LevelEmulator } from '../core/levelemu.ts';
import { exitTarget } from '../core/exitgraph.ts';
import { overworldExitText } from '../core/owteleport.ts';
import { renderLevelImages, usedScreens, screensSize, levelImageName, parseLevelList, SCREEN_PX } from '../core/levelimage.ts';
import type { SpriteImage } from '../core/spritegfx.ts';

// ---------------- overlays (shared with the level view) ----------------
// lw: a line's width, px: a screen pixel (labels), both in level pixels

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

// ---------------- a level's image ----------------

const MAX_CANVAS = 32767; // pixels a canvas may be wide or high (Chrome, Firefox)

// a level as drawn: its layers' images and its sprites' images
export interface LevelPicture { level: Level; images: LevelImages; sprite: (s: LevelSprite) => HTMLCanvasElement | undefined }

// The level as the level view shows it with the View menu's settings (layers, sprites, exits, screen boundaries,
// grid; nothing translucent), `zoom` times its size, its first `screens` screens only
export function drawLevelImage(app: App, p: LevelPicture, zoom = 1, screens = p.level.header.screens): HTMLCanvasElement {
  const show = app.show, im = p.images, lv = p.level;
  const full = document.createElement('canvas');
  full.width = im.width; full.height = im.height;
  const px = composite(im, show.layer1, show.layer2, 0, show.layer3);
  full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer), im.width, im.height), 0, 0);
  const { width, height } = screensSize(im, screens);
  if (Math.max(width, height) * zoom > MAX_CANVAS) throw new Error(`${width * zoom}×${height * zoom} pixels is too large for an image – a smaller zoom fits`);
  const c = document.createElement('canvas');
  c.width = width * zoom; c.height = height * zoom;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.scale(zoom, zoom);
  ctx.drawImage(full, 0, 0);
  if (show.sprites) for (const s of lv.sprites) {
    const img = p.sprite(s);
    if (img) ctx.drawImage(img, s.x * 16 + Number(img.dataset.ox), s.y * 16 + Number(img.dataset.oy));
  }
  // (lines one image pixel wide, labels as in the level view at 100%)
  const lw = 1 / zoom;
  if (show.grid) paintGrid(ctx, width, height, lw);
  if (show.screens) paintScreens(ctx, width, height, im.geom1.vertical, screens, lw, 1);
  if (show.exits) paintExits(ctx, app, { ...lv, exits: lv.exits.filter((e) => e.screen < screens) }, im.geom1, 1);
  return c;
}

const pngBytes = (c: HTMLCanvasElement) => new Promise<Uint8Array>((ok, fail) => c.toBlob((b) => {
  if (!b) { fail(new Error('the image could not be made')); return; }
  b.arrayBuffer().then((a) => ok(new Uint8Array(a)), fail);
}, 'image/png'));

// File → Level as PNG: the open level as edited, at its size
export async function exportLevelPng(app: App): Promise<void> {
  const lv = app.level;
  const c = drawLevelImage(app, { level: lv, images: app.images, sprite: (s) => app.spriteImageOf(s) });
  await downloadBytes(levelImageName(lv.number, levelNameOf(app, lv.number)), await pngBytes(c), 'image/png');
}

// ---------------- several levels ----------------

const LANE = 'level-images'; // the learn jobs of the sprites' images
const PROBE_WAIT = 30000; // ms a level waits for its sprites' probes at most (then: their images without variants)

// what the export waits for, unless it is cancelled before (then: null)
type Cancel = { cancelled: boolean; wake: (() => void) | null };
function until<T>(cancel: Cancel, p: Promise<T>): Promise<T | null> {
  return new Promise((ok) => {
    cancel.wake = () => ok(null);
    p.then(ok, () => ok(null)).finally(() => { cancel.wake = null; });
  });
}

// a sprite image learned (null: it failed)
function learned(app: App, j: ReturnType<App['spriteJobs']>['all']): Promise<unknown> {
  return new Promise((ok) => {
    const r = app.probes.learn(j.key, j.job, { input: j.input, lane: LANE, urgent: true, label: 'Level images: sprite graphics', done: ok, failed: () => ok(null) });
    if (r !== undefined) ok(r);
  });
}

// The images of the level's sprites, as the level view's (App.spriteImage) for this level: learned, the sprites'
// probes waited for (their variants)
async function levelSprites(app: App, lv: Level, cancel: Cancel): Promise<LevelPicture['sprite'] | null> {
  const jobs = app.spriteJobs(lv), ts = lv.header.tileset;
  const all = await until(cancel, learned(app, jobs.all)) as [number, SpriteImage][] | null;
  if (cancel.cancelled) return null;
  const base = new Map((all ?? []).map(([n, img]) => [n, app.spriteCanvas(img)]));
  // the variants: once every sprite's probe is known (or failed)
  const placed = lv.sprites.filter((s) => !(s.extra >= 2 && s.bytes?.some((b) => b)));
  const t0 = performance.now();
  while (placed.some((s) => app.spriteVariant(spriteId(s), s.x, s.y, ts) === undefined) && performance.now() - t0 < PROBE_WAIT) {
    await until(cancel, new Promise<void>((ok) => { const off = app.on('probes', () => { off(); ok(); }); setTimeout(() => { off(); ok(); }, 500); }));
    if (cancel.cancelled) return null;
  }
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
    const img = await until(cancel, learned(app, j)) as SpriteImage | null;
    if (cancel.cancelled) return null;
    if (img) own.set(s, app.spriteCanvas(img));
  }
  return (s) => own.get(s) ?? base.get(spriteId(s));
}

type Which = 'all' | 'used' | 'list';

// level numbers as parseLevelList reads them, runs as ranges: "105-10A, 110"
function ranges(nums: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${hex3(nums[i])}-${hex3(nums[j])}` : hex3(nums[i]));
    i = j;
  }
  return out.join(', ');
}

// File → Levels as images: the dialog, then the export with its progress; listed: the levels the level list shows
export function openLevelImages(app: App, listed: () => number[]): void {
  let which: Which = 'used';
  let zoom = 1, crop = true;
  const listInput = h('input', { type: 'text', class: 'li-list', spellcheck: false, value: hex3(app.level.number),
    title: 'Level numbers (hex) and ranges, e.g. 105, 106-10A', placeholder: '105, 106-10A' });
  const listError = h('div', { class: 'hint warn' });
  const radio = (v: Which, label: string, title: string) => h('label', { class: 'toggle', title },
    h('input', { type: 'radio', name: 'li-which', value: v, checked: which === v, onchange: () => { which = v; update(); } }), label);
  const zoomSel = h('select', { onchange: () => { zoom = Number(zoomSel.value); } }, [1, 2, 3, 4].map((z) => h('option', { value: String(z) }, `${z}×`)));
  const cropBox = h('input', { type: 'checkbox', checked: crop, onchange: () => { crop = cropBox.checked; } });
  const levels = (): number[] | string => {
    if (which === 'all') return Array.from({ length: 0x200 }, (_, i) => i);
    if (which === 'used') return [...app.usedLevels()].sort((a, b) => a - b);
    const r = parseLevelList(listInput.value);
    return 'error' in r ? r.error : r.levels;
  };
  const count = h('span', { class: 'hint' });
  const update = () => {
    const l = levels();
    listError.textContent = typeof l === 'string' && which === 'list' ? l : '';
    count.textContent = typeof l === 'string' ? '' : `${l.length} level${l.length === 1 ? '' : 's'}`;
  };
  // (typing levels chooses them)
  const chooseList = () => {
    which = 'list';
    for (const r of settings.querySelectorAll<HTMLInputElement>('input[name="li-which"]')) r.checked = r.value === 'list';
    update();
  };
  listInput.addEventListener('input', chooseList);
  const settings = h('div', { class: 'li-settings' },
    h('p', { class: 'hint', style: 'max-width:520px' }, 'Each level as a PNG drawn as the level view shows it (the View menu\'s layers, sprites, exits, screen boundaries and grid), named after its number and name, all in one .zip.'),
    h('div', { class: 'row' }, radio('used', 'Used levels', 'The levels the level list shows with “used only”'), radio('all', 'All levels', 'All 512 levels, also the unused ones'),
      radio('list', 'These levels:', 'Level numbers (hex) and ranges')),
    h('div', { class: 'row' }, listInput, h('button', { title: 'The levels the level list shows (its filter and “used only” applied)', onclick: () => {
      const l = listed();
      if (!l.length) { toast('The level list shows no levels', 'error'); return; }
      listInput.value = ranges(l);
      chooseList();
    } }, 'From the level list')), listError,
    h('div', { class: 'row' }, h('label', { title: 'Each image pixel as 1–4 pixels' }, 'Zoom ', zoomSel)),
    h('label', { class: 'row', title: 'Each image ends with the last screen the level uses (layer 1, layer 2 objects, sprites) – the level\'s number of screens stays (Lunar Magic: Auto-Set Number of Screens)' }, cropBox, ' Crop to the screens the level uses'),
    h('div', { class: 'row' }, count));
  const bar = h('progress', { max: 1, value: 0, style: 'width:100%' });
  const status = h('div', { class: 'hint' });
  const failures = h('ul', { class: 'li-failed' });
  const progress = h('div', { class: 'li-progress', style: 'display:none;min-width:360px' }, status, bar, failures);
  const body = h('div', {}, settings, progress);
  const cancel: Cancel = { cancelled: false, wake: null };
  let running = false;
  const stop = () => { cancel.cancelled = true; cancel.wake?.(); app.probes.unlearn(LANE); };
  const dlg = modal('Levels as images', body, [
    { label: 'Export', primary: true, onClick: () => {
      const l = levels();
      if (typeof l === 'string') { toast(l, 'error'); return false; }
      if (!l.length) { toast('No levels to export', 'error'); return false; }
      void run(l);
      return false;
    } },
    { label: 'Cancel', onClick: () => { if (running) { stop(); return false; } } },
  ], () => stop(), () => { if (running) stop(); return true; });
  const [exportBtn, cancelBtn] = dlg.buttons;
  update();

  const run = async (nums: number[]) => {
    running = true;
    settings.style.display = 'none';
    progress.style.display = '';
    exportBtn.style.display = 'none';
    bar.max = nums.length;
    const files: Record<string, [Uint8Array, { level: 0 }]> = {};
    const failed: string[] = [];
    const fail = (n: number, why: string) => { failed.push(`${hex3(n)}: ${why}`); failures.append(h('li', {}, `Level ${hex3(n)}: ${why}`)); };
    // (an emulator of its own: the level view's keeps its level and its animation)
    const emu = new LevelEmulator(app.rom);
    emu.skipMask = () => app.gfxSkipMask();
    emu.adoptBoot(app.emu);
    for (let i = 0; i < nums.length && !cancel.cancelled; i++) {
      const n = nums[i];
      status.textContent = `Level ${hex3(n)} (${i + 1} of ${nums.length}) …`;
      bar.value = i;
      await new Promise((ok) => setTimeout(ok, 0)); // (the progress shown, a click on Cancel taken)
      if (cancel.cancelled) break;
      try {
        // (the open level as edited, as Level as PNG)
        const lv = n === app.level.number ? app.level : loadLevel(app.rom, n);
        const r = renderLevelImages(app.rom, emu, lv, app.buildOverrides(lv));
        if ('error' in r) { fail(n, r.error); continue; }
        const sprite = app.show.sprites ? await levelSprites(app, lv, cancel) : () => undefined;
        if (!sprite) break;
        const c = drawLevelImage(app, { level: lv, images: r.images, sprite }, zoom, crop ? usedScreens(r.images, lv) : lv.header.screens);
        files[levelImageName(n, levelNameOf(app, n))] = [await pngBytes(c), { level: 0 }]; // (PNG is compressed)
      } catch (e) {
        console.error(e);
        fail(n, e instanceof Error ? e.message : String(e));
      }
    }
    app.probes.unlearn(LANE);
    running = false;
    cancelBtn.textContent = 'Close';
    const done = Object.keys(files).length;
    bar.value = bar.max;
    if (cancel.cancelled) { status.textContent = 'Cancelled – nothing was saved.'; return; }
    status.textContent = `${done} level${done === 1 ? '' : 's'} exported${failed.length ? `, ${failed.length} could not be drawn:` : '.'}`;
    if (failed.length) log(`Levels as images: ${failed.length} could not be drawn – ${failed.join('; ')}`, 'warn');
    if (!done) return;
    const base = app.romName.replace(/\.(smc|sfc|bin|smwproj)$/i, '');
    if (await downloadBytes(`${base} levels.zip`, zipSync(files), 'application/zip')) log(`Levels as images: ${done} level${done === 1 ? '' : 's'} in “${base} levels.zip”`);
  };
}
