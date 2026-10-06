// Layer 3 (BG3) of a level, found by emulation. The level header's layer 3 setting (secondary
// header bits 7-6, 0-3) means different things depending on the tileset; what the game made of
// it is read after the level has loaded:
// - tides: $1403 = 1 water that rises and falls, 2 water at a fixed height; Mario swims below the
//   surface ($5B bit 7: layer 3 interacts with Mario like a layer of water blocks);
// - otherwise a layer 3 image when the BG3 tilemap has something on it (e.g. cave rocks, fish,
//   the graphics the layer 3 smash sprite moves around).
// How far the water of a rising and falling tide moves is found by letting the level run: the
// water height on screen is the layer 3 Y scroll ($24) against the camera ($1C).

import type { LevelEmulator, LevelOverride, LevelRender } from './levelemu.ts';
import { renderLayer3 } from './render.ts';
import { decodeSecondaryHeader, encodeSecondaryHeader } from './level.ts';

export type Layer3Kind = 'none' | 'tide-moving' | 'tide-fixed' | 'image';

export const LAYER3_KIND_TEXT: Record<Layer3Kind, string> = {
  'none': 'None',
  'tide-moving': 'Tide, rises and falls',
  'tide-fixed': 'Tide, fixed height',
  'image': 'Layer 3 image',
};

// what the loaded level does with layer 3
export function layer3Kind(r: LevelRender): Layer3Kind {
  const t = r.wram[0x1403];
  if (t === 1) return 'tide-moving';
  if (t === 2) return 'tide-fixed';
  return r.wram[0x1be3] && renderLayer3(r, 256, 432) ? 'image' : 'none';
}

// the kind for each of the four settings, in the level as given (its tileset decides)
export function layer3Kinds(emu: LevelEmulator, level: number, ov: LevelOverride): Layer3Kind[] {
  const sec = decodeSecondaryHeader(ov.secondaryHeader ?? [0, 0, 0, 0]);
  return [0, 1, 2, 3].map((v) => {
    const r = emu.load(level, { ...ov, sprites: undefined, byteOwner: undefined, secondaryHeader: encodeSecondaryHeader({ ...sec, layer3: v }) });
    return r.ok ? layer3Kind(r) : 'none';
  });
}

// layer 3 Y offset against the camera ($24 - $1C): at the end of the level load (where the level
// view draws layer 3) and its range while the tide rises and falls
export interface TideRange { load: number; min: number; max: number }

export const TIDE_FRAMES = 3000; // the vanilla tide starts after ~1000 frames, one cycle is ~1500

const dy = (w: Uint8Array) => (((w[0x24] | (w[0x25] << 8)) - (w[0x1c] | (w[0x1d] << 8))) << 16) >> 16;

// yields between slices of frames; null when the level has no rising and falling tide
export function* tideRangeJob(emu: LevelEmulator, level: number, ov: LevelOverride): Generator<void, TideRange | null> {
  const r = emu.load(level, ov);
  if (!r.ok || r.wram[0x1403] !== 1) return null;
  const s = emu.snes, w = s.wram;
  const range: TideRange = { load: dy(w), min: dy(w), max: dy(w) };
  yield;
  // Mario stays where he starts, can't be hurt, and the camera with him
  const x = w[0x94] | (w[0x95] << 8), y = w[0x96] | (w[0x97] << 8);
  for (let f = 0; f < TIDE_FRAMES; f++) {
    w[0x94] = x & 0xff; w[0x95] = x >> 8; w[0x96] = y & 0xff; w[0x97] = y >> 8;
    w[0x7b] = 0; w[0x7d] = 0; w[0x1497] = 0x40;
    s.runFrame();
    if (w[0x100] !== 0x14 && f > 200) break;
    if (w[0x100] === 0x14) { const d = dy(w); range.min = Math.min(range.min, d); range.max = Math.max(range.max, d); }
    if (f % 120 === 119) yield;
  }
  return range;
}

// level Y of the highest pixel layer 3 shows (the water surface of a tide as the level view draws it)
export function layer3Top(l3: { back: Uint32Array; front: Uint32Array } | null, width: number): number {
  if (!l3) return -1;
  for (let i = 0; i < l3.back.length; i++) if (l3.back[i] || l3.front[i]) return Math.floor(i / width);
  return -1;
}
