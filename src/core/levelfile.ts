// Level export/import as a self-contained JSON file (raw level data in the ROM's own formats).

import { Rom } from './rom.ts';
import {
  type Level, parseLevelData, serializeLayer1, serializeLayer2, serializeSprites, isL1Vertical,
  encodeSecondaryHeader, decodeSecondaryHeader,
} from './level.ts';
import { editorPatch, levelGfx, customPalette } from './patches.ts';
import { encodeBg, decodeBg } from './bg.ts';
import { STRUCT_EXT, readStructure, listStructures, freeStructureNumber, writeStructure, installStructPatch, type Structure } from './structs.ts';

export const LEVEL_FILE_EXT = '.smwlevel';

interface LevelFileJson {
  format: 'smwe-level';
  version: 1;
  number: number; // level it was exported from (informational)
  layer1: string; // hex, incl. 5 byte primary header
  layer2: string | null; // hex layer 2 object data incl. header, or null (BG tilemap)
  layer2Pointer: number; // BG tilemap pointer (ROM address) when layer2 is null
  sprites: string; // hex, incl. header byte
  secondary: number[]; // 4 secondary header bytes
  gfx?: number[]; // GFX bypass slots (editor patch), $FF = default
  palette?: string; // hex, 512 bytes custom level palette
  bg?: string; // hex, edited BG tilemap (editor format of bg.ts, RLE)
  structs?: (Structure & { n: number })[]; // structures the level uses (structs.ts), by their number in the exporting ROM
}

export interface LevelFileData {
  level: Level;
  gfx: number[] | null;
  palette: Uint8Array | null;
}

const toHex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
function fromHex(s: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(s)) throw new Error('Ungültige Hex-Daten in der Level-Datei');
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}

// bg: the level's BG tiles when they are edited (not a vanilla tilemap in bank $0C)
export function exportLevelFile(rom: Rom, lv: Level, bg: Uint16Array | null = lv.bg ?? null): string {
  const l2 = serializeLayer2(rom, lv);
  const out: LevelFileJson = {
    format: 'smwe-level',
    version: 1,
    number: lv.number,
    layer1: toHex(serializeLayer1(rom, lv)),
    layer2: l2 ? toHex(l2) : null,
    layer2Pointer: lv.layer2Pointer,
    sprites: toHex(serializeSprites(lv.sprites, lv.spriteHeader, isL1Vertical(rom, lv.header.mode))),
    secondary: encodeSecondaryHeader(lv.secondary),
  };
  if (editorPatch(rom)) {
    const g = levelGfx(rom, lv.number);
    if (g.some((v) => v !== 0xff)) out.gfx = g;
  }
  const pal = customPalette(rom, lv.number);
  if (pal) out.palette = toHex(rom.bytes(pal, 512));
  if (bg && !l2) out.bg = toHex(encodeBg(bg));
  const used = new Set([...lv.objects, ...(lv.layer2Objects ?? [])].filter((o) => o.num === 0 && o.ext === STRUCT_EXT && o.struct !== undefined).map((o) => o.struct!));
  const structs = [...used].sort((a, b) => a - b).flatMap((n) => { const s = readStructure(rom, n); return s ? [{ n, ...s }] : []; });
  if (structs.length) out.structs = structs;
  return JSON.stringify(out, null, 1);
}

// parses a level file as level `n`; ROM locations (for in-place saving) are taken from `into`
export function importLevelFile(rom: Rom, text: string, into: Level): LevelFileData {
  let j: LevelFileJson;
  try { j = JSON.parse(text); } catch { throw new Error('Keine gültige Level-Datei (JSON)'); }
  if (j?.format !== 'smwe-level') throw new Error('Keine SMW-Editor-Level-Datei');
  if (j.version !== 1) throw new Error(`Nicht unterstützte Version ${j.version}`);
  if (!Array.isArray(j.secondary) || j.secondary.length !== 4) throw new Error('Sekundärer Header fehlt');
  const palette = j.palette ? fromHex(j.palette) : null;
  if (palette && palette.length !== 512) throw new Error('Palette in der Level-Datei hat nicht 512 Bytes');
  // structures: reuse an identical one of this ROM, else store under a free number
  const remap = new Map<number, number>();
  if (j.structs?.length) {
    installStructPatch(rom); // before parsing: extended object $03 is 4 bytes with the patch
    const have = listStructures(rom);
    const same = (a: Structure, b: Structure) => a.w === b.w && a.h === b.h && a.name === b.name && a.tiles.every((t, i) => t === b.tiles[i]);
    for (const s of j.structs) {
      const hit = [...have].find(([, x]) => same(x, s));
      if (hit) { remap.set(s.n, hit[0]); continue; }
      const n = freeStructureNumber(rom);
      if (n < 0) throw new Error('Kein freier Platz für die Strukturen der Level-Datei (256 belegt)');
      const st: Structure = { w: s.w, h: s.h, tiles: s.tiles, name: s.name };
      writeStructure(rom, n, st);
      have.set(n, st);
      remap.set(s.n, n);
    }
  }
  const level = parseLevelData(rom, into.number, fromHex(j.layer1), j.layer2 ? fromHex(j.layer2) : null,
    j.layer2 ? into.layer2Pointer : j.layer2Pointer, fromHex(j.sprites), decodeSecondaryHeader(j.secondary));
  if (j.bg && !level.layer2Objects) level.bg = decodeBg(fromHex(j.bg));
  for (const o of [...level.objects, ...(level.layer2Objects ?? [])]) if (o.struct !== undefined) o.struct = remap.get(o.struct) ?? o.struct;
  level.l1Addr = into.l1Addr; level.l1Size = into.l1Size; level.l2Size = into.l2Size;
  level.sprAddr = into.sprAddr; level.sprSize = into.sprSize;
  return { level, gfx: Array.isArray(j.gfx) && j.gfx.length === 8 ? j.gfx : null, palette };
}
