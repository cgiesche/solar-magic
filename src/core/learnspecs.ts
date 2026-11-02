// What some of the editor's learn jobs (probeprotocol.ts LearnJob) are asked for with: their key, job and input
// (inputs.ts), as App asks for them; here so that tests ask with the same.

import type { Rom } from './rom.ts';
import { SPRITE_MEMORY, serializeLayer1, type Level } from './level.ts';
import type { LevelOverride } from './levelemu.ts';
import type { SpriteLevel } from './spritegfx.ts';
import type { LearnJob } from './probeprotocol.ts';
import { levelGfx, defaultGfx } from './patches.ts';
import { gfxFilesHash } from './gfxpages.ts';
import { inputHash, levelInput } from './inputs.ts';

// a learn job: its key, the job and its input
export interface LearnSpec { key: string; job: LearnJob; input: unknown }

// the sprite graphics files level lv loads (its own setting, else its tileset's and sprite GFX setting's)
export function spriteGfxFiles(rom: Rom, lv: Level): number[] {
  const hd = lv.header, set = levelGfx(rom, lv.number), def = defaultGfx(rom, hd.tileset, hd.spriteGfx);
  return [0, 1, 2, 3].map((k) => (set[k] !== 0xff ? set[k] : def[k]));
}

// What sprite images depend on besides the ROM bytes they read: the level's sprite settings (sprite memory: a sprite
// whose OAM range is too small is captured as the game shows it), the content of its sprite graphics files (graphics
// data isn't among the bytes read, see gfxSkipMask; filesHash: gfxFilesHash, or a kept one) and the custom sprites'
// ids (pixi.ts)
export function spriteInput(rom: Rom, lv: Level, custom: number[], filesHash = (files: number[]) => gfxFilesHash(rom, files)): { custom: number[] } & Record<string, unknown> {
  const hd = lv.header;
  return { gfx: hd.spriteGfx, palette: hd.spritePalette, memory: lv.spriteHeader & SPRITE_MEMORY, files: filesHash(spriteGfxFiles(rom, lv)), custom };
}

// What the images of level lv's sprites are learned with: all sprites (nums: the ids the picker lists), a custom sprite
// with extra bytes, a sprite's variant at a place; input: spriteInput's
export function spriteJobs(lv: Level, nums: number[], input: { custom: number[] } & Record<string, unknown>): { all: LearnSpec; bytes: (id: number, bytes: number[]) => LearnSpec; at: (id: number, x: number, y: number) => LearnSpec } {
  const hd = lv.header, set = `${hd.spriteGfx}-${hd.spritePalette}`;
  // (the level as sprite images are captured in it)
  const level: SpriteLevel = { number: lv.number, header: { ...hd }, spriteHeader: lv.spriteHeader, bgPointer: lv.layer2Pointer >> 16 === 0xff ? lv.layer2Pointer : 0xffd900 };
  // i6: with the input; sprites from $C9 on (shells, groups), failed batches retried one by one, sprites
  // that draw nothing shown by what they spawn, sprites erasing themselves at once by what they drew
  // (each test level load is kept on its own, with what spriteInput gives but the custom sprites: a custom sprite
  // added or changed captures only its load again)
  const { custom: _, ...loadInput } = input;
  return {
    all: { key: `i6${set}`, job: { kind: 'sprites', level, nums, input: inputHash(loadInput) }, input },
    bytes: (id, b) => ({ key: `b3${set}:${id}:${b.join(',')}`, job: { kind: 'spriteBytes', level, id, bytes: b }, input }),
    at: (id, x, y) => ({ key: `v5${set}:${id}:${x}:${y}`, job: { kind: 'spriteAt', level, id, x, y }, input }),
  };
}

// What the four layer 3 settings do in a tileset (layer3.ts) is learned with: level lv as edited (ov, buildOverrides)
// loaded with the tileset, kept per tileset; its input the level as loaded so
export function layer3Spec(rom: Rom, lv: Level, ov: LevelOverride, tileset: number): LearnSpec {
  const load = { ...ov };
  if (tileset !== lv.header.tileset) load.layer1 = serializeLayer1(rom, { ...lv, header: { ...lv.header, tileset } });
  const input = levelInput(lv.number, load);
  // (the load leaves out the sprites and the owners of level bytes: not sent)
  return { key: `l3k2:${tileset}`, job: { kind: 'layer3', level: lv.number, ov: { ...load, sprites: undefined, byteOwner: undefined } }, input };
}
