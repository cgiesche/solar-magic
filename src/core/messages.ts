// Level message boxes (vanilla format, routine at $05B10C): 25 messages of 8 lines with up to
// 18 characters; the last character of a line has bit 7 set, shorter lines are padded with spaces.
// Pointers at $05A5A7 are offsets from the text base ($05A5D9). $05A590+1..$16 assign messages to
// translevels (bit 7 = message 2); 0-3 are the switch palaces, $17 Yoshi's house with Yoshi, $18 message 3.

import { Rom } from './rom.ts';
import { Asm } from './asm.ts';
import { ownerNote } from './patchreg.ts';

export const MSG_COUNT = 25;
export const MSG_LINES = 8;
export const MSG_COLS = 18;
const MSG_INDEX = 0x05a590;
const MSG_PTRS = 0x05a5a7;
const MSG_TEXT = 0x05a5d9;
const MSG_TEXT_END = 0x05b100; // code follows
const MSG_HOOK = 0x05b20f; // LDA $A5D9,y : STA $0003
export const MSG_HOOKS: [number, number][] = [[MSG_HOOK, 6]];
const MSG_MAGIC = [0x53, 0x4d, 0x57, 0x4d]; // "SMWM"

// character codes of the message font (tile $100 + code in the layer 3 GFX)
const CHARS: [number, string][] = [
  ...Array.from({ length: 26 }, (_, i) => [i, String.fromCharCode(65 + i)] as [number, string]),
  ...Array.from({ length: 26 }, (_, i) => [0x40 + i, String.fromCharCode(97 + i)] as [number, string]),
  [0x1a, '!'], [0x1b, '.'], [0x1c, '-'], [0x1d, ','], [0x1e, '?'], [0x1f, ' '],
  [0x5a, '#'], [0x5b, '('], [0x5c, ')'], [0x5d, "'"],
  ...Array.from({ length: 7 }, (_, i) => [0x64 + i, String(i + 1)] as [number, string]), [0x6b, '0'],
];
const CODE_TO_CHAR = new Map(CHARS);
const CHAR_TO_CODE = new Map(CHARS.map(([c, s]) => [s, c]));

export type Message = number[][]; // 8 lines of character codes (without the end bit)

export function textBase(rom: Rom): number {
  const p = messagePatch(rom);
  return p ? p.text : MSG_TEXT;
}

export function messagePatch(rom: Rom): { base: number; text: number } | null {
  if (rom.r8(MSG_HOOK) !== 0x22) return null;
  const base = rom.r24(MSG_HOOK + 1) - 8;
  for (let i = 0; i < 4; i++) if (rom.r8(base + i) !== MSG_MAGIC[i]) return null;
  return { base, text: rom.r24(base + 4) };
}

export function readMessage(rom: Rom, i: number): Message {
  const base = textBase(rom);
  let p = base + rom.r16(MSG_PTRS + i * 2);
  const lines: Message = [];
  for (let l = 0; l < MSG_LINES; l++) {
    const line: number[] = [];
    for (let k = 0; k < MSG_COLS; k++) {
      const c = rom.r8(p++);
      line.push(c & 0x7f);
      if (c & 0x80) break;
    }
    lines.push(line);
  }
  return lines;
}

// "{xx}" for codes without a character
export function lineToText(line: number[]): string {
  return line.map((c) => CODE_TO_CHAR.get(c) ?? `{${c.toString(16).padStart(2, '0')}}`).join('').replace(/ +$/, '');
}

export function textToLine(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const m = /^\{([0-9a-fA-F]{2})\}/.exec(s.slice(i));
    if (m) { out.push(parseInt(m[1], 16) & 0x7f); i += m[0].length - 1; continue; }
    const c = CHAR_TO_CODE.get(s[i]);
    if (c === undefined) throw new Error(`Character “${s[i]}” does not exist in the message font`);
    out.push(c);
  }
  if (out.length > MSG_COLS) throw new Error(`Line too long (${out.length} of ${MSG_COLS} characters)`);
  return out;
}

function encodeMessage(m: Message): number[] {
  const out: number[] = [];
  for (const line of m) {
    const l = line.length ? line : [0x1f];
    l.forEach((c, k) => out.push(k === l.length - 1 ? c | 0x80 : c));
  }
  return out;
}

// which translevel/message uses each entry (for labels)
export function messageUsers(rom: Rom): { translevel: number; msg: number }[][] {
  const users: { translevel: number; msg: number }[][] = Array.from({ length: MSG_COUNT }, () => []);
  for (let x = 1; x <= 0x16; x++) {
    const v = rom.r8(MSG_INDEX + x);
    users[x].push({ translevel: v & 0x7f, msg: (v >> 7) + 1 });
  }
  return users;
}

// writes all messages (identical ones share their data); in place if they fit, otherwise the text
// moves to free space and the hook at $05B20F reads it from there
export function writeMessages(rom: Rom, msgs: Message[]): string {
  const data: number[] = [];
  const offsets: number[] = [];
  const seen = new Map<string, number>();
  for (const m of msgs) {
    const enc = encodeMessage(m);
    const key = enc.join(',');
    let off = seen.get(key);
    if (off === undefined) { off = data.length; seen.set(key, off); data.push(...enc); }
    offsets.push(off);
  }
  const bytes = Uint8Array.from(data);
  let p = messagePatch(rom);
  let where: string;
  if (!p && bytes.length <= MSG_TEXT_END - MSG_TEXT) {
    rom.writeBytes(MSG_TEXT, bytes);
    where = 'in place';
  } else {
    if (!p) p = installMessagePatch(rom);
    else rom.freeAt(p.text);
    const addr = rom.allocWrite(bytes);
    rom.w24(p.base + 4, addr);
    rom.w24(p.base + 8 + 3, addr); // operand of LDA.l in the routine
    where = `in free space @ $${addr.toString(16).toUpperCase()}`;
  }
  offsets.forEach((o, i) => rom.w16(MSG_PTRS + i * 2, o));
  return `${bytes.length} bytes ${where}`;
}

function installMessagePatch(rom: Rom): { base: number; text: number } {
  if (rom.r8(MSG_HOOK) !== 0xb9 || rom.r16(MSG_HOOK + 1) !== 0xa5d9 || rom.r8(MSG_HOOK + 3) !== 0x8d) {
    throw new Error(`Unexpected code at $05B20F${ownerNote(rom, MSG_HOOK, 6)} – messages cannot be moved`);
  }
  const a = new Asm();
  a.b(...MSG_MAGIC); a.fill(4); // +4: text address
  a.label('Msg');
  // (M=8, X/Y=16) PHX : TYX : LDA.l text,x : PLX : STA $0003 : RTL
  a.b(0xda, 0xbb, 0xbf, 0, 0, 0, 0xfa, 0x8d, 0x03, 0x00, 0x6b);
  const addr = rom.allocWrite(new Uint8Array(a.bytes.length));
  rom.writeBytes(addr, a.link(addr));
  const r = a.addrOf('Msg', addr);
  rom.writeBytes(MSG_HOOK, Uint8Array.from([0x22, r & 0xff, (r >> 8) & 0xff, r >> 16, 0xea, 0xea]));
  return { base: addr, text: 0 };
}
