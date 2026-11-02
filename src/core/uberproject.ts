// The ROM's UberASM project, a tool project stored as a patch (toolproject.ts): saved by rebuilding
// and reapplying the generated patch.

import type { Rom } from './rom.ts';
import { buildUberPatch, parseList, emptyList, writeList, type UberList, type UberContext } from './uberasm.ts';
import { toolStore, folderProject, listRoot, type ToolFormat, type ToolProject } from './toolproject.ts';

export type UberProject = ToolProject<UberList>;

export function emptyProject(): UberProject {
  return { files: new Map(), list: emptyList() };
}

// an UberASM Tool list.txt: it has the sections of UberASM Tool
export const isUberList = (text: string) => /^\s*(level|gamemode|overworld)\s*:/im.test(text);

// assigns a file to a level, game mode or overworld map (num: ALL for every level), unless that call
// (with these extra bytes) is there already – for installing and for the UberASM tab
export function addCall(p: UberProject, ctx: UberContext, num: number, file: string, bytes: number[] = []): void {
  const calls = p.list[ctx].get(num) ?? [];
  if (!calls.some((c) => c.file === file && c.bytes.join() === bytes.join())) calls.push({ file, bytes });
  p.list[ctx].set(num, calls);
}

const UBER: ToolFormat<UberList> = {
  kind: 'uberasm',
  what: 'UberASM',
  parseList,
  writeList,
  // the tool's own files are not needed (the editor generates the main patch)
  keeps: (rel) => rel === 'list.txt' || !/^(asm\/|UberASMTool|asar\.|.*\.(exe|dll|config|html|txt)$)/i.test(rel),
  hasEntries: (l) => !!(l.level.size || l.gamemode.size || l.overworld.size || l.global || l.statusbar),
  build: (_rom, p) => buildUberPatch(p.files, p.list),
};

// project from a zip/folder in UberASM Tool's layout (list.txt at the root or one folder down)
export function projectFromFiles(files: Map<string, Uint8Array>): UberProject {
  const root = listRoot(files.keys());
  if (root === null) throw new Error('No list.txt found – is this an UberASM Tool folder?');
  return folderProject(UBER, files, root);
}

// the ROM's UberASM project; saving assembles and (re)applies it, an empty project removes the UberASM patch
export const { entry: uberEntry, load: loadProject, save: saveProject, toZip: projectToZip, fromZip: projectFromZip } = toolStore(UBER);

// the free RAM the installed UberASM patch claims (its !freeram, which GPS's defines share)
export function uberFreeRam(rom: Rom): number | undefined {
  return uberEntry(rom)?.ram?.[0]?.[0];
}
