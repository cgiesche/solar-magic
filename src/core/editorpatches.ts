// The editor opens two kinds of ROMs: the clean game, which gets the editor's own patches right away,
// and ROMs it made itself (they have them). The patches are all of them except SMWM (messages in free
// space), which breaks VWF dialog patches and is installed only when the texts outgrow their place.

import type { Rom } from './rom.ts';
import { crc32 } from './bps.ts';
import { loadAsar } from './asar.ts';
import { editorPatch, madeByEditor, installEditorPatch, installCustomPalettePatch, installBgPatch, installMusicPatch, installExtGfxPatch } from './patches.ts';
import { installVramPatch } from './vrampatch.ts';
import { installExAnim } from './exanim.ts';
import { installL2ScrollPatch } from './l2scroll.ts';
import { installLevelHeightPatch } from './levelheight.ts';
import { installLayer3Patch } from './layer3gfx.ts';
import { installOwTeleportPatch } from './owteleport.ts';
import { installScrollFix } from './scrollfix.ts';
import { installTranslevelPatch, installLevelFlagsPatch, installDestroyPatch } from './overworld.ts';
import { installEventPatch } from './owevents.ts';
import { installMap16Ext, enableBlocks } from './map16ext.ts';
import { installBgMap16Ext } from './bgmap16.ts';
import { installStructPatch } from './structs.ts';
import { newStyleExits } from './exitgraph.ts';
import { LevelEmulator } from './levelemu.ts';
import { map16Source } from './render.ts';
import type { ApplyResult } from './patchapply.ts';

export const SMW_CLEAN_CRC = 0xb19ed489; // Super Mario World (U), headerless

export function isCleanRom(rom: Rom): boolean {
  return rom.size === 0x80000 && crc32(rom.data) === SMW_CLEAN_CRC;
}

// makes a ROM ready to edit: a clean one gets the patches (true), one made by the editor stays as it is
// (false); any other ROM throws
export async function prepareRom(rom: Rom): Promise<boolean> {
  if (isCleanRom(rom)) { await installEditorPatches(rom); return true; }
  if (editorPatch(rom) && madeByEditor(rom)) return false;
  if (madeByEditor(rom)) throw new Error('This ROM was made with an older version of Solar Magic, whose patches this version does not read. Open a clean Super Mario World (U) ROM.');
  throw new Error('Only a clean Super Mario World (U) ROM or a ROM made with Solar Magic can be opened.');
}

export async function installEditorPatches(rom: Rom): Promise<void> {
  await loadAsar();
  const asar = (r: ApplyResult) => { if (!r.ok) throw new Error(r.errors.join(' ')); };
  installEditorPatch(rom);
  asar(installVramPatch(rom));
  installExtGfxPatch(rom);
  installCustomPalettePatch(rom);
  installBgPatch(rom);
  installMusicPatch(rom);
  installBgMap16Ext(rom);
  installStructPatch(rom);
  asar(installExAnim(rom));
  asar(installL2ScrollPatch(rom));
  asar(installLevelHeightPatch(rom));
  asar(installLayer3Patch(rom));
  asar(installOwTeleportPatch(rom));
  asar(installScrollFix(rom));
  installTranslevelPatch(rom);
  installLevelFlagsPatch(rom);
  installEventPatch(rom);
  installDestroyPatch(rom);
  newStyleExits(rom);
  // new Map16 tiles start as the empty tile 025 of the ROM
  const blank = map16Source(rom, new LevelEmulator(rom).load(0x105)).fg(0x025);
  installMap16Ext(rom, blank);
  enableBlocks(rom, blank);
}
