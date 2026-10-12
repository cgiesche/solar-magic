// The editor's own patches, installed when a ROM is opened (all except SMWM, the messages in free
// space, which breaks VWF dialog patches and stays installed only when the texts outgrow their place).
// Every installer leaves an existing installation alone, so this only adds what an older ROM lacks.
// A ROM whose hooks hold other code (a third-party patch, Lunar Magic) is not opened: the editor
// relies on all of them.

import type { Rom } from './rom.ts';
import { loadAsar } from './asar.ts';
import { installEditorPatch, installCustomPalettePatch, installBgPatch, installMusicPatch, installExtGfxPatch } from './patches.ts';
import { installVramPatch } from './vrampatch.ts';
import { installExAnim, exanimEntry } from './exanim.ts';
import { installMap16Ext, enableBlocks, map16Ext } from './map16ext.ts';
import { installBgMap16Ext } from './bgmap16.ts';
import { installStructPatch } from './structs.ts';
import { setPatchKind } from './patchreg.ts';
import { listPackages, removePackageRecord } from './pkgreg.ts';
import { LevelEmulator } from './levelemu.ts';
import { map16Source } from './render.ts';
import type { ApplyResult } from './patchapply.ts';

// installs what is missing; true if anything changed. Throws (ROM unchanged) if a patch cannot be installed.
export async function installEditorPatches(rom: Rom): Promise<boolean> {
  await loadAsar();
  const before = rom.gen;
  const snapshot = rom.snapshot();
  const errors = new Set<string>(); // patches building on the editor patch report its conflict again
  const run = (f: () => unknown) => { try { f(); } catch (e) { errors.add(e instanceof Error ? e.message : String(e)); } };
  const asar = (f: () => ApplyResult) => run(() => { const r = f(); if (!r.ok) throw new Error(r.errors.join(' ')); });
  adoptExAnim(rom);
  run(() => installEditorPatch(rom));
  asar(() => installVramPatch(rom));
  run(() => installExtGfxPatch(rom));
  run(() => installCustomPalettePatch(rom));
  run(() => installBgPatch(rom));
  run(() => installMusicPatch(rom));
  run(() => installBgMap16Ext(rom));
  run(() => installStructPatch(rom));
  asar(() => installExAnim(rom));
  if (!errors.size && !map16Ext(rom)?.blocks) run(() => {
    // new Map16 tiles start as the empty tile 025 of the ROM
    const blank = map16Source(rom, new LevelEmulator(rom).load(0x105)).fg(0x025);
    installMap16Ext(rom, blank);
    enableBlocks(rom, blank);
  });
  if (errors.size) {
    rom.restore(snapshot);
    throw new Error(`This ROM cannot be edited: code of another patch (or Lunar Magic) sits where the editor's own patches go.\n${[...errors].map((e) => `• ${e}`).join('\n')}`);
  }
  return rom.gen !== before;
}

// ROMs patched before the engine had a kind of its own list it as a third-party patch (and opening them
// wrapped it in a legacy package)
function adoptExAnim(rom: Rom): void {
  const e = exanimEntry(rom);
  if (!e || e.kind === 'exanim') return;
  setPatchKind(rom, e.id, 'exanim');
  for (const p of listPackages(rom)) if (p.legacy && p.patches.length === 1 && p.patches[0] === e.id) removePackageRecord(rom, p.id);
}
