// Levels as image files: File → "Level as PNG" (the open level) and "Levels as images" (Lunar Magic's "Export
// Multiple Levels to Image Files", LM help: file_export_directory_bitmap.htm): each level drawn as the level view
// shows it with the View menu's settings – its layers, sprites and every overlay (leveloverlays.ts, the level view's
// own drawing, with that level's probes, level scan and sprite memory check, levelpicture.ts; the open level's with
// its pinned jump arcs), without the selection, hover and drag previews – one PNG per level in a .zip.
// Better than Lunar Magic: a list of levels, a zoom, file names with the level's name; cropping to the screens a
// level uses (Lunar Magic's "Auto-Set Number of Screens") leaves the level as it is.

import { zipSync } from 'fflate';
import type { App } from './app.ts';
import { h, modal, toast, log } from './dom.ts';
import { downloadBytes } from './platform.ts';
import { levelNameOf } from './panels.ts';
import { hex3 } from '../core/names.ts';
import { composite } from '../core/render.ts';
import { loadLevel } from '../core/level.ts';
import { LevelEmulator } from '../core/levelemu.ts';
import { paintOverlays, gameViewIn, wholeLevel } from './leveloverlays.ts';
import { renderLevelImages, usedScreens, screensSize, levelImageName, parseLevelList } from '../core/levelimage.ts';
import { levelPicture, cancelWait, SPRITE_GFX, type LevelPicture, type ArcPin, type ExportWait } from './levelpicture.ts';

// ---------------- a level's image ----------------

const MAX_CANVAS = 32767; // pixels a canvas may be wide or high (Chrome, Firefox)

// The level as the level view shows it with the View menu's settings (layers, sprites, the overlays; no layer
// ghosted), `zoom` times its size, its first `screens` screens only
export function drawLevelImage(app: App, p: LevelPicture, zoom = 1, screens = p.level.header.screens): HTMLCanvasElement {
  const show = app.view.show, im = p.images;
  const { width, height } = screensSize(im, screens);
  if (Math.max(width, height) * zoom > MAX_CANVAS) throw new Error(`${width * zoom}×${height * zoom} pixels is too large for an image – a smaller zoom fits`);
  const full = document.createElement('canvas');
  full.width = im.width; full.height = im.height;
  const px = composite(im, show.layer1, show.layer2, 0, show.layer3);
  full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer), im.width, im.height), 0, 0);
  const c = document.createElement('canvas');
  c.width = width * zoom; c.height = height * zoom;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.scale(zoom, zoom);
  ctx.drawImage(full, 0, 0);
  // (lines one image pixel wide, labels as in the level view at 100%)
  paintOverlays(ctx, app, p.overlay, {
    show, lw: 1 / zoom, px: 1, area: wholeLevel(im.geom1), width, height, screens,
    exits: show.exits, chosenExit: -1, layer2: app.model.mode === 'l2', tideLabelX: 8, spriteAlpha: 1,
    // (the sprites as outside sprite mode, their images opaque)
    sprites: { image: p.sprite, imageAlpha: 1, active: false, selected: () => false, incomplete: p.incomplete },
    arcs: p.arcs, gameView: show.gameView ? gameViewIn(app, p.overlay) : undefined,
  });
  return c;
}

const pngBytes = (c: HTMLCanvasElement) => new Promise<Uint8Array>((ok, fail) => c.toBlob((b) => {
  if (!b) { fail(new Error('the image could not be made')); return; }
  b.arrayBuffer().then((a) => ok(new Uint8Array(a)), fail);
}, 'image/png'));

const SHOW_WAIT = 300; // ms Level as PNG waits before it shows what it waits for

// File → Level as PNG: the open level as edited, at its size (once its sprites' images, probes, level scan, sprite
// memory check and pinned jump arcs are known). A wait one notices shows in a dialog, as Levels as images shows it,
// with a Cancel (then nothing is saved).
export async function exportLevelPng(app: App, arcPin: ArcPin = null): Promise<void> {
  const lv = app.level;
  let ended = false;
  const shown: { dlg?: { close(force?: boolean): void } } = {};
  const status = h('div', { class: 'hint' }, SPRITE_GFX);
  const wait: ExportWait = { lane: 'level-png', cancelled: false, wake: null, status: (s) => { status.textContent = s; } };
  const stop = () => { if (!ended) cancelWait(wait); };
  const show = setTimeout(() => {
    shown.dlg = modal('Level as PNG', h('div', { style: 'min-width:360px' }, h('p', {}, `Level ${hex3(lv.number)}: waiting for what it is drawn with`), status), [{ label: 'Cancel' }], stop);
  }, SHOW_WAIT);
  // (the probes run while the dialog is open)
  const release = app.probes.urge();
  try {
    const p = await levelPicture(app, lv, app.images, app.render, wait, arcPin).finally(() => {
      ended = true;
      clearTimeout(show);
      release();
      app.probes.unlearn(wait.lane);
      shown.dlg?.close(true);
    });
    if (!p) return;
    await downloadBytes(levelImageName(lv.number, levelNameOf(app, lv.number)), await pngBytes(drawLevelImage(app, p)), 'image/png');
  } catch (e) {
    console.error(e);
    toast(`Level as PNG: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
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

// File → Levels as images: the dialog, then the export with its progress; listed: the levels the level list shows;
// arcPin: where the open level's jump arcs are pinned
export function openLevelImages(app: App, listed: () => number[], arcPin: ArcPin = null): void {
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
    h('p', { class: 'hint', style: 'max-width:520px' }, 'Each level as a PNG drawn as the level view shows it (the View menu\'s layers, sprites and overlays, without the selection), named after its number and name, all in one .zip.'),
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
  const cancel: ExportWait = { lane: 'level-images', cancelled: false, wake: null };
  let running = false, closed = false;
  let save: (() => Promise<void>) | null = null; // after a cancel: saves the levels drawn until then
  const stop = () => { cancelWait(cancel); app.probes.unlearn(cancel.lane); };
  const dlg = modal('Levels as images', body, [
    { label: 'Export', primary: true, onClick: () => {
      if (save) { void save(); return; }
      const l = levels();
      if (typeof l === 'string') { toast(l, 'error'); return false; }
      if (!l.length) { toast('No levels to export', 'error'); return false; }
      void run(l);
      return false;
    } },
    { label: 'Cancel', onClick: () => { if (running) { stop(); return false; } } },
  ], () => { closed = true; stop(); }, () => { if (running) stop(); return true; });
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
    // (the probes run while the dialog is open)
    const release = app.probes.urge();
    try {
      for (let i = 0; i < nums.length && !cancel.cancelled; i++) {
        const n = nums[i];
        const at = `Level ${hex3(n)} (${i + 1} of ${nums.length})`;
        status.textContent = `${at} …`;
        cancel.status = (what) => { status.textContent = `${at}: ${what}`; };
        bar.value = i;
        await new Promise((ok) => setTimeout(ok, 0)); // (the progress shown, a click on Cancel taken)
        if (cancel.cancelled) break;
        try {
          // (the open level as edited, as Level as PNG)
          const lv = n === app.level.number ? app.level : loadLevel(app.rom, n);
          const r = renderLevelImages(app.rom, emu, lv, app.buildOverrides(lv));
          if ('error' in r) { fail(n, r.error); continue; }
          const p = await levelPicture(app, lv, r.images, r.render, cancel, arcPin);
          if (!p) break;
          const c = drawLevelImage(app, p, zoom, crop ? usedScreens(r.images, lv) : lv.header.screens);
          files[levelImageName(n, levelNameOf(app, n))] = [await pngBytes(c), { level: 0 }]; // (PNG is compressed)
        } catch (e) {
          console.error(e);
          fail(n, e instanceof Error ? e.message : String(e));
        }
      }
    } finally {
      cancel.status = undefined;
      release();
      app.probes.unlearn(cancel.lane);
    }
    running = false;
    cancelBtn.textContent = 'Close';
    const done = Object.keys(files).length;
    const zip = async () => {
      const base = app.romName.replace(/\.(smc|sfc|bin|smwproj)$/i, '');
      if (await downloadBytes(`${base} levels.zip`, zipSync(files), 'application/zip')) log(`Levels as images: ${done} level${done === 1 ? '' : 's'} in “${base} levels.zip”`);
    };
    if (cancel.cancelled) {
      status.textContent = `Cancelled after ${done} level${done === 1 ? '' : 's'} – nothing saved yet.`;
      // (the levels drawn until then on request)
      if (done && !closed) { save = zip; exportBtn.textContent = `Save the ${done} level${done === 1 ? '' : 's'} drawn`; exportBtn.style.display = ''; }
      return;
    }
    bar.value = bar.max;
    status.textContent = `${done} level${done === 1 ? '' : 's'} exported${failed.length ? `, ${failed.length} could not be drawn:` : '.'}`;
    if (failed.length) log(`Levels as images: ${failed.length} could not be drawn – ${failed.join('; ')}`, 'warn');
    if (done) await zip();
  };
}
