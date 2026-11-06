// The editor opens two kinds of ROMs: the clean game, which gets the editor's own patches right away,
// and ROMs it made itself (they have them).

import type { Rom } from './rom.ts';
import { loadAsar } from './asar.ts';
import { editorPatch, madeByEditor, installEditorPatch, installCustomPalettePatch, installBgPatch, installMusicPatch, installExtGfxPatch } from './patches.ts';
import { installVramPatch, updateVramPatch, vramPatchUpToDate } from './vrampatch.ts';
import { installExAnim } from './exanim.ts';
import { installL2ScrollPatch } from './l2scroll.ts';
import { installLevelHeightPatch } from './levelheight.ts';
import { installLayer3Patch } from './layer3gfx.ts';
import { installOwTeleportPatch } from './owteleport.ts';
import { installScrollFixPatch } from './scrollfix.ts';
import { installTranslevelPatch, installOwMap16Patch, installLevelFlagsPatch, installDestroyPatch } from './overworld.ts';
import { installEventPatch } from './owevents.ts';
import { installMessagePatch } from './messages.ts';
import { installLevelNamePatch } from './levelnames.ts';
import { installSubmapPalettePatch, installSubmapGfxPatch } from './submapgfx.ts';
import { installMap16Ext, enableBlocks } from './map16ext.ts';
import { installBgMap16Ext } from './bgmap16.ts';
import { installPrefabPatch } from './prefabs.ts';
import { newStyleExits } from './exitgraph.ts';
import { installFastRom } from './fastrom.ts';
import { keepCleanSharedPalettes } from './sharedpal.ts';
import { keepCleanGame, isCleanRom } from './cleangame.ts';
import { LevelEmulator } from './levelemu.ts';
import { blankTile } from './render.ts';
import type { ApplyResult } from './patchapply.ts';


// what opening a ROM did to it: patches installed or updated (save it), or a VRAM patch update that failed
export interface Prepared { note: string; failed?: true }

// makes a ROM ready to edit: a clean one gets the patches, one made by the editor stays as it is but for a VRAM
// layout patch from an older source (updateVramPatch; if that fails, the ROM is opened with it); any other ROM
// throws. Null if the ROM is unchanged
export async function prepareRom(rom: Rom): Promise<Prepared | null> {
  if (isCleanRom(rom)) { await installEditorPatches(rom); return { note: 'Editor patches installed.' }; }
  if (editorPatch(rom) && madeByEditor(rom)) {
    if (vramPatchUpToDate(rom)) return null;
    await loadAsar();
    try {
      return updateVramPatch(rom) ? { note: 'VRAM layout patch updated.' } : null;
    } catch (e) {
      return { note: `${e instanceof Error ? e.message : e} – the ROM keeps its older one.`, failed: true };
    }
  }
  if (madeByEditor(rom)) throw new Error('This ROM was made with an older version of Solar Magic, whose patches this version does not read. Open a clean Super Mario World (U) ROM.');
  throw new Error('Only a clean Super Mario World (U) ROM or a ROM made with Solar Magic can be opened.');
}

export async function installEditorPatches(rom: Rom): Promise<void> {
  await loadAsar();
  const asar = (r: ApplyResult) => { if (!r.ok) throw new Error(r.errors.join(' ')); };
  const clean = rom.data.slice();
  // (bytes of the clean game that Lunar Magic data exported as BPS takes are read where the ROM still has them)
  keepCleanGame(rom);
  // (what a package's shared palettes change is told by the clean game's)
  keepCleanSharedPalettes(rom);
  installEditorPatch(rom);
  asar(installVramPatch(rom));
  installExtGfxPatch(rom);
  installCustomPalettePatch(rom);
  installBgPatch(rom);
  installMusicPatch(rom);
  installBgMap16Ext(rom);
  installPrefabPatch(rom);
  asar(installExAnim(rom));
  asar(installL2ScrollPatch(rom));
  asar(installLevelHeightPatch(rom));
  asar(installLayer3Patch(rom));
  asar(installOwTeleportPatch(rom));
  asar(installScrollFixPatch(rom));
  installTranslevelPatch(rom);
  installOwMap16Patch(rom);
  installLevelFlagsPatch(rom);
  installEventPatch(rom);
  installDestroyPatch(rom);
  installMessagePatch(rom);
  installLevelNamePatch(rom);
  installSubmapPalettePatch(rom);
  installSubmapGfxPatch(rom);
  newStyleExits(rom);
  // new Map16 tiles start as the empty tile 025 of the ROM
  const blank = blankTile(rom, new LevelEmulator(rom).load(0x105));
  installMap16Ext(rom, blank);
  enableBlocks(rom, blank);
  // last: the long jumps the other patches' hooks took are theirs
  installFastRom(rom, clean);
}
