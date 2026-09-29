// Level export/import as a self-contained JSON file (raw level data in the ROM's own formats).

import { Rom } from './rom.ts';
import {
  type Level, parseLevelData, serializeLayer1, serializeLayer2, serializeSprites, isL1Vertical,
  encodeSecondaryHeader, decodeSecondaryHeader,
} from './level.ts';
import { editorPatch, levelGfx, customPalette } from './patches.ts';

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

export function exportLevelFile(rom: Rom, lv: Level): string {
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
  return JSON.stringify(out, null, 1);
}

// parses a level file as level `n`; ROM locations (for in-place saving) are taken from `into`
export function importLevelFile(rom: Rom, text: string, into: Level): LevelFileData {
  let j: LevelFileJson;
  try { j = JSON.parse(text); } catch { throw new Error('Keine gültige Level-Datei (JSON)'); }
  if (j?.format !== 'smwe-level') throw new Error('Keine SMW-Editor-Level-Datei');
  if (j.version !== 1) throw new Error(`Nicht unterstützte Version ${j.version}`);
  if (!Array.isArray(j.secondary) || j.secondary.length !== 4) throw new Error('Sekundärer Header fehlt');
  const level = parseLevelData(rom, into.number, fromHex(j.layer1), j.layer2 ? fromHex(j.layer2) : null,
    j.layer2 ? into.layer2Pointer : j.layer2Pointer, fromHex(j.sprites), decodeSecondaryHeader(j.secondary));
  level.l1Addr = into.l1Addr; level.l1Size = into.l1Size; level.l2Size = into.l2Size;
  level.sprAddr = into.sprAddr; level.sprSize = into.sprSize;
  const palette = j.palette ? fromHex(j.palette) : null;
  if (palette && palette.length !== 512) throw new Error('Palette in der Level-Datei hat nicht 512 Bytes');
  return { level, gfx: Array.isArray(j.gfx) && j.gfx.length === 8 ? j.gfx : null, palette };
}
