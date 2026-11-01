// Levels as image files (Lunar Magic's "Export Multiple Levels to Image Files"): a level's layers drawn as the
// level view draws them (its load emulated), the screens it uses (Lunar Magic's "Auto-Set Number of Screens",
// here only to crop the image), the image's file name and the levels chosen by number.

import type { Rom } from './rom.ts';
import { renderLevel, type LevelImages } from './render.ts';
import { levelRows, type Level } from './level.ts';
import type { LevelEmulator, LevelOverride, LevelRender } from './levelemu.ts';

export const SCREEN_PX = 256; // a screen's width (vertical levels: its height) in pixels

// The level's images as the level view draws them, its load emulated with ov (App.buildOverrides) – what the
// overlays are drawn from; error: the load failed
export function renderLevelImages(rom: Rom, emu: LevelEmulator, lv: Level, ov: LevelOverride): { images: LevelImages; render: LevelRender } | { error: string } {
  const r = emu.load(lv.number, ov);
  if (!r.ok) return { error: r.error ?? 'the level did not load' };
  return { images: renderLevel(rom, r, lv.header.mode, lv.header.screens, levelRows(lv.secondary)), render: r };
}

// The screens from the first to the last one the level uses: one that layer 1 draws on (in a level with layer 2
// objects layer 2 too; a BG fills every screen) or that holds a sprite. At least one.
export function usedScreens(im: LevelImages, lv: Pick<Level, 'sprites' | 'layer2Objects'>): number {
  const vertical = im.geom1.vertical, w = im.width, h = im.height;
  const count = Math.ceil((vertical ? h : w) / SCREEN_PX);
  let last = 0;
  const layers = [im.layer1, ...lv.layer2Objects ? [im.layer2] : []];
  for (const px of layers) for (let y = 0; y < h; y++) {
    const row = y * w;
    // (from the right: the furthest screen first)
    for (let x = w - 1; x >= 0; x--) {
      if (!px[row + x]) continue;
      last = Math.max(last, Math.floor((vertical ? y : x) / SCREEN_PX));
      break;
    }
  }
  for (const s of lv.sprites) last = Math.max(last, Math.floor((vertical ? s.y : s.x) * 16 / SCREEN_PX));
  return Math.min(count, last + 1);
}

// The image's size in pixels with only the first `screens` screens
export function screensSize(im: LevelImages, screens: number): { width: number; height: number } {
  return im.geom1.vertical ? { width: im.width, height: Math.min(im.height, screens * SCREEN_PX) } : { width: Math.min(im.width, screens * SCREEN_PX), height: im.height };
}

// "105 Yoshi's Island 1.png": the level's number and name (characters file systems refuse replaced by "_")
export function levelImageName(n: number, name: string): string {
  const num = n.toString(16).toUpperCase().padStart(3, '0');
  const clean = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return `${num}${clean ? ' ' + clean : ''}.png`;
}

// Level numbers (hex 0–1FF) and ranges, separated by commas or spaces: "105, 106-10A". Ascending, each once.
export function parseLevelList(text: string): { levels: number[] } | { error: string } {
  const out = new Set<number>();
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) return { error: 'No levels given' };
  for (const p of parts) {
    const m = /^([0-9a-f]{1,3})(?:-([0-9a-f]{1,3}))?$/i.exec(p);
    if (!m) return { error: `“${p}” is not a level number (hex) or range` };
    const a = parseInt(m[1], 16), b = m[2] !== undefined ? parseInt(m[2], 16) : a;
    if (a > 0x1ff || b > 0x1ff) return { error: `“${p}”: levels go up to 1FF` };
    if (b < a) return { error: `“${p}”: the range goes backwards` };
    for (let i = a; i <= b; i++) out.add(i);
  }
  return { levels: [...out].sort((x, y) => x - y) };
}
