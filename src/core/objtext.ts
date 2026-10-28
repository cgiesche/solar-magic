// Object names and tooltips from Lunar Magic's side files (FuSoYa's formats), as a package brings them: the
// Romhack Races baserom ships RHRv5.mw0t and RHRv5.osc for the UberASM Objects that ObjecTool's custom extended
// objects switch on (issue #104). Emulation finds what these objects do, never what they are called.
// - `.mw0t` (Custom Collections of Objects): per line an extended object's number (2 hex digits), a tab, its
//   name. Lines without the number name a group of the `.mw0` (LM's object groups), which is left out.
// - `.osc` (Custom Tooltips for Objects): per line the object (hex), its ExType (the extended number, object 2D's
//   custom number, else 0), a type and the text, with LM's escapes. Only a type for the object's default
//   appearance is read (0, or its X/Y or byte variant 0); the tileset-specific ones (by the "T" value) and the
//   GFX information (types 8, A) are left out.
// A package upload reads every one in it (installPackage) and keeps them in its record: they go with the
// package. Of two packages naming one object, the newer one's text is shown.

import type { Rom } from './rom.ts';
import { listPackages } from './pkgreg.ts';
import { hex2 } from './names.ts';

// what a package's side files say (as stored in its record): extended number → name, tipKey → tooltip
export interface ObjectText { names: [number, string][]; tips: [string, string][] }

const OBJ_2D = 0x2d;

// the object a tooltip belongs to: an extended object by its number, object 2D by its custom number (its 4th
// byte), the others by their number
export function tipKey(num: number, ext: number): string {
  return num === 0 ? `x${hex2(ext)}` : num === OBJ_2D ? `c${hex2(ext)}` : `s${hex2(num)}`;
}

const lines = (text: string) => text.replace(/^﻿/, '').split(/\r?\n/);

export function parseMw0t(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const l of lines(text)) {
    const m = /^([0-9A-Fa-f]{2})\t(.*)$/.exec(l);
    const name = m?.[2].trim();
    if (m && name) out.set(parseInt(m[1], 16), name);
  }
  return out;
}

// LM's escapes: \n a new line, \\ a backslash, \r nothing; the colors, time and width (\b \f \d \w and 6 hex
// digits) are LM's tooltip's looks, dropped; another backslash stays as it is
function unescape(s: string): string {
  return s.replace(/\\(?:[bfdw][0-9A-Fa-f]{6}|[nr\\])/g, (e) => (e === '\\n' ? '\n' : e === '\\\\' ? '\\' : ''));
}

export function parseOsc(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of lines(text)) {
    if (l.startsWith(';')) continue;
    const m = /^\s*([0-9A-Fa-f]+)\s+([0-9A-Fa-f]+)\s+([0-9A-Fa-f]+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const t = parseInt(m[3], 16);
    // the low byte is the type (4: by a byte's upper nibble), above it the X/Y bits or (5 digits) the byte's
    // number and value
    const variant = m[3].length >= 5 ? (t >> 8) & 0xff : t >> 8;
    if ((t & 0xfb) !== 0 || variant) continue;
    const text = unescape(m[4]).trim();
    if (text) out.set(tipKey(parseInt(m[1], 16), parseInt(m[2], 16)), text);
  }
  return out;
}

export const isObjectTextFile = (path: string) => /\.(mw0t|osc)$/i.test(path);

// the side files of an upload (every .mw0t and .osc in it, in path order), null when it has none
export function uploadObjectText(files: Map<string, Uint8Array>): ObjectText | null {
  const dec = new TextDecoder();
  const names = new Map<number, string>(), tips = new Map<string, string>();
  let any = false;
  for (const p of [...files.keys()].sort()) {
    if (!isObjectTextFile(p)) continue;
    const isNames = /\.mw0t$/i.test(p);
    any = true;
    const text = dec.decode(files.get(p)!);
    if (isNames) for (const [k, v] of parseMw0t(text)) names.set(k, v);
    else for (const [k, v] of parseOsc(text)) tips.set(k, v);
  }
  return any ? { names: [...names], tips: [...tips] } : null;
}

// one object of a clash in a note ("extended 98", "2D 41", "10")
function objectLabel(key: string): string {
  const n = key.slice(1);
  return key[0] === 'x' ? `extended ${n}` : key[0] === 'c' ? `2D ${n}` : n;
}

// the notes of installing a package's text over the installed packages': the objects whose name or tooltip it
// changes, per package it replaces them of
export function objectTextNotes(rom: Rom, name: string, text: ObjectText): string[] {
  const shown = shownText(rom);
  const by = new Map<string, Set<string>>();
  const add = (pkg: string | undefined, key: string) => { if (pkg !== undefined) by.set(pkg, (by.get(pkg) ?? new Set()).add(key)); };
  for (const [k, v] of text.names) { const was = shown.names.get(k); if (was && was.text !== v) add(was.pkg, tipKey(0, k)); }
  for (const [k, v] of text.tips) { const was = shown.tips.get(k); if (was && was.text !== v) add(was.pkg, k); }
  return [...by].map(([pkg, keys]) => `Object names and tooltips of “${name}” replace those of “${pkg}” for ${[...keys].sort().map(objectLabel).join(', ')}.`);
}

// the text shown: of all installed packages, a newer one's (installed later) over an older one's
interface Shown { names: Map<number, { text: string; pkg: string }>; tips: Map<string, { text: string; pkg: string }> }
const memo = new WeakMap<Rom, { gen: number; shown: Shown }>();
function shownText(rom: Rom): Shown {
  const m = memo.get(rom);
  if (m?.gen === rom.gen) return m.shown;
  const shown: Shown = { names: new Map(), tips: new Map() };
  for (const p of listPackages(rom)) {
    for (const [k, v] of p.objectText?.names ?? []) shown.names.set(k, { text: v, pkg: p.name });
    for (const [k, v] of p.objectText?.tips ?? []) shown.tips.set(k, { text: v, pkg: p.name });
  }
  memo.set(rom, { gen: rom.gen, shown });
  return shown;
}

// an extended object's name from a package's .mw0t, null without one
export function packageObjectName(rom: Rom, ext: number): string | null {
  return shownText(rom).names.get(ext)?.text ?? null;
}

// an object's tooltip from a package's .osc (num 0: extended object ext; 2D: its custom number), null without one
export function objectTooltip(rom: Rom, num: number, ext: number): string | null {
  return shownText(rom).tips.get(tipKey(num, ext))?.text ?? null;
}
