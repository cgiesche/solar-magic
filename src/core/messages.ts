// Level message boxes: two per translevel, in Lunar Magic's layout (SMWM, an editor patch). The game's routine
// ($05B10C) looks its 25 messages up in a table of 22 translevels ($05A590) and shows the yellow switch
// palace's in any other level; the patch replaces the lookup at $05B1A3 with a JSL to $03BB90 as Lunar Magic
// (FuSoYa) does: the message is translevel × 2 + (message − 1), pointers at $03BE80 (16 bit, from the text's
// start), the text in free space – 8 lines of 18 characters, $FE ends a message early (the rest blank).
// As in the game, the table's entries 0–3 are the switch palaces (message 1 also presses the switch there) and
// entry $16 Yoshi's house (message 2 while riding Yoshi); message 3 ($1426 = 3, Yoshi's thank-you) is
// translevel 0's message 2. From $03BBC9 on the code is Lunar Magic's, byte for byte, so that hijacks of its
// copy of the switch palace routine find it (the Retry System's JSL at $03BC72).

import { Rom, snesToPc } from './rom.ts';
import { assemble } from './asar.ts';
import { RAM } from './ram.ts';
import { missingPatch } from './patches.ts';

export const MSG_LINES = 8;
export const MSG_COLS = 18;
export const TRANSLEVELS = 0x60;
// the game's table: translevels of its messages (bit 7 = message 2); 0-3 the switch palaces, $16 Yoshi's house
const GAME_INDEX = 0x05a590;
const PALACES = 4, YOSHI_HOUSE = 0x16;
const GAME_PTRS = 0x05a5a7, GAME_TEXT = 0x05a5d9, GAME_MESSAGES = 25;
const HOOK = 0x05b1a3, ROUTINE = 0x03bb90, LM_PART = 0x03bbc9;
const TEXT_OP = 0x03bc0b; // operand of LDA.l text,x
export const PTRS = 0x03be80;
export const MSG_HOOKS: [number, number][] = [[HOOK, 7]];
const MAGIC = [0x53, 0x4d, 0x57, 0x4d]; // "SMWM", before the text
const END = 0xfe;
export const SPACE = 0x1f;
// message 3 ($1426 = 3): Yoshi's thank-you, the first time Mario frees him
export const YOSHI_THANKS = { translevel: 0, msg: 2 } as const;

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
// the font's code of a character, its character (undefined: none – Yoshi's signature, symbols, custom glyphs)
export const charCode = (ch: string): number | undefined => CHAR_TO_CODE.get(ch);
export const codeChar = (c: number): string | undefined => CODE_TO_CHAR.get(c);

export type Message = number[][]; // 8 lines of character codes

const hx = (n: number) => '$' + n.toString(16).toUpperCase().padStart(6, '0');
const dp = (n: number) => '$' + n.toString(16).toUpperCase().padStart(2, '0');
const abs16 = (n: number) => '$' + (n & 0xffff).toString(16).toUpperCase().padStart(4, '0');
const messageAsm = () => `lorom
org ${hx(HOOK)}
  JSL Message
  JMP $B250
org ${hx(ROUTINE)}
Message:                             ; A/X/Y 8; the game's table read long, whatever the data bank
  LDY ${abs16(RAM.message)} : CPY #$03 : BEQ .thanks
  LDA ${abs16(RAM.translevel)} : TAX
  CMP.l ${hx(GAME_INDEX + YOSHI_HOUSE)} : BEQ .yoshi
  DEY : BNE .index                   ; message 2
  LDX #${PALACES - 1}
- CMP.l ${hx(GAME_INDEX)},x : BEQ +  ; a switch palace: message 1 presses its switch
  DEX : BPL -
  BRA ++
+ TXY : JSR Palace
++ LDX ${abs16(RAM.translevel)} : LDY #$00 : BRA .index
.thanks:
  LDX #$00 : BRA +
.yoshi:
  LDY #$00 : LDA ${abs16(RAM.ridingYoshi)} : BEQ .index
+ LDY #$01
warnpc ${hx(LM_PART)}
padbyte $EA : pad ${hx(LM_PART)}
.index:                              ; X translevel, Y message - 1
  REP #$30
  TXA : ASL : STA $00 : TYA : CLC : ADC $00 : ASL : TAX
  PHB : PHK : PLB
  LDA ${abs16(PTRS)},x : STA $00
  PEA $7F7F : PLB : PLB
  LDA $837B : TAY
  LDX #$000E
  STZ $02
.line:
  PHB : PHK : PLB
  LDA.w Stripes,x
  PLB
  STA $837D,y
  LDA #$2300 : STA $837F,y
  PHX
  SEP #$20
  LDA #$12 : STA $02
  LDX $00
.char:
  LDA #$1F
  BIT $03 : BMI +
  .text: LDA.l $000000,x             ; the text
  INX
  CMP #$FE : BNE +
  STA $03
  LDA #$1F
+ STA $8381,y
  LDA #$39 : STA $8382,y
  INY #2
  DEC $02 : BNE .char
  STX $00
  REP #$20
  INY #4
  PLX
  DEX #2 : BPL .line
  LDA #$00FF : STA $837D,y
  TYA : STA $837B
  PLB
  STZ ${dp(RAM.layer3X)} : STZ ${dp(RAM.layer3Y)}
  SEP #$30
  LDA #$01 : STA $13D5
  RTL
Palace:                              ; Y the switch palace (0-3): its switch pressed, its sprite tiles
  PHX
  TYX : INX : STX ${abs16(RAM.palaceSwitch)} : DEX
  TXA : ASL #4 : TAX
  STZ $00
  REP #$20
  LDY #$1C
- LDA $B29B,x : STA ${abs16(RAM.oam + 2)},y
  PHX
  LDX $00
  LDA $B2DB,x : STA ${abs16(RAM.oam)},y
  PLX
  INX #2
  INC $00 : INC $00
  DEY #4                             ; $03BC72, hijacked by the Retry System
  BPL -
  STZ ${abs16(RAM.oam + 0x200)}
  SEP #$20
  PLX
  RTS
Stripes:
  dw $A751, $8751, $6751, $4751, $2751, $0751, $E750, $C750
End:
`;

export function messagePatch(rom: Rom): { text: number } | null {
  if (rom.r8(HOOK) !== 0x22 || (rom.r24(HOOK + 1) & 0x7fffff) !== ROUTINE) return null;
  const text = rom.r24(TEXT_OP);
  for (let i = 0; i < 4; i++) if (rom.r8(text - 4 + i) !== MAGIC[i]) return null;
  return { text };
}
const patch = (rom: Rom) => messagePatch(rom) ?? missingPatch('Messages (SMWM)');

const ptrAt = (tl: number, msg: number) => PTRS + (tl * 2 + msg - 1) * 2;

// msg 1 or 2; lines end where the message does
export function readMessage(rom: Rom, tl: number, msg: number): Message {
  let p = patch(rom).text + rom.r16(ptrAt(tl, msg));
  const codes: number[] = [];
  while (codes.length < MSG_LINES * MSG_COLS) {
    const c = rom.r8(p++);
    if (c === END) break;
    codes.push(c);
  }
  return Array.from({ length: MSG_LINES }, (_, l) => codes.slice(l * MSG_COLS, (l + 1) * MSG_COLS));
}

export const isBlank = (m: Message): boolean => m.every((l) => l.every((c) => c === SPACE));
// a translevel with a message that shows text
export const hasMessages = (rom: Rom, tl: number): boolean => [1, 2].some((n) => !isBlank(readMessage(rom, tl, n)));

// the switch palace (0-3) whose switch message 1 of translevel tl presses, -1 none – from the game's table
export function switchPalace(rom: Rom, tl: number): number {
  for (let k = PALACES - 1; k >= 0; k--) if (rom.r8(GAME_INDEX + k) === tl) return k;
  return -1;
}
// the translevel whose message 2 shows while Mario rides Yoshi (Yoshi's house)
export const yoshiHouse = (rom: Rom): number => rom.r8(GAME_INDEX + YOSHI_HOUSE);

// what makes the game show message msg of translevel tl in a level of tl: the message box number ($1426) and
// whether Mario rides Yoshi (Yoshi's house shows its message 2 then); translevel 0's message 2 is message 3
export function messageToShow(rom: Rom, tl: number, msg: number): { message: number; yoshi: boolean } {
  if (tl === YOSHI_THANKS.translevel && msg === YOSHI_THANKS.msg) return { message: 3, yoshi: false };
  if (tl === yoshiHouse(rom)) return { message: 1, yoshi: msg === 2 };
  return { message: msg, yoshi: false };
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

// the lines padded with spaces, trailing spaces left out, $FE at the end
function encodeMessage(m: Message): number[] {
  const out = Array.from({ length: MSG_LINES }, (_, l) => Array.from({ length: MSG_COLS }, (_, k) => m[l]?.[k] ?? SPACE)).flat();
  while (out.length && out[out.length - 1] === SPACE) out.pop();
  return [...out, END];
}

// all messages, [translevel][msg - 1]
function readAll(rom: Rom): Message[][] {
  return Array.from({ length: TRANSLEVELS }, (_, tl) => [readMessage(rom, tl, 1), readMessage(rom, tl, 2)]);
}

// writes all messages (identical ones share their data) into a new block of free space
function writeAll(rom: Rom, msgs: Message[][], old: number | null): string {
  const data: number[] = [...MAGIC];
  const offsets: number[] = [];
  const seen = new Map<string, number>();
  for (const m of msgs.flat()) {
    const enc = encodeMessage(m);
    const key = enc.join(',');
    let off = seen.get(key);
    if (off === undefined) { off = data.length - MAGIC.length; seen.set(key, off); data.push(...enc); }
    offsets.push(off);
  }
  if (old !== null) rom.freeAt(old - MAGIC.length);
  const text = rom.allocWrite(Uint8Array.from(data)) + MAGIC.length;
  rom.w24(TEXT_OP, text);
  offsets.forEach((o, i) => rom.w16(PTRS + i * 2, o));
  return `${data.length} bytes`;
}

export interface MessageChange { translevel: number; msg: number; message: Message }
export function writeMessages(rom: Rom, changes: MessageChange[]): string {
  const msgs = readAll(rom);
  for (const c of changes) msgs[c.translevel][c.msg - 1] = c.message;
  return writeAll(rom, msgs, patch(rom).text);
}

const blank = (): Message => Array.from({ length: MSG_LINES }, () => []);
// translevel tl without messages
export function clearMessages(rom: Rom, tl: number): void {
  if (hasMessages(rom, tl)) writeMessages(rom, [1, 2].map((msg) => ({ translevel: tl, msg, message: blank() })));
}

// the game's 25 messages (8 lines; the last character of a line has bit 7 set)
function gameMessage(rom: Rom, i: number): Message {
  let p = GAME_TEXT + rom.r16(GAME_PTRS + i * 2);
  return Array.from({ length: MSG_LINES }, () => {
    const line: number[] = [];
    for (let k = 0; k < MSG_COLS; k++) {
      const c = rom.r8(p++);
      line.push(c & 0x7f);
      if (c & 0x80) break;
    }
    return line;
  });
}

// needs Asar (loadAsar) to be loaded; the game's messages become the messages of the translevels its table
// names (of two entries naming the same the later one, as the game searches from the end), its Yoshi's house
// message with Yoshi message 2 there, its message 3 translevel 0's message 2
export function installMessagePatch(rom: Rom): void {
  if (messagePatch(rom)) return;
  const msgs = Array.from({ length: TRANSLEVELS }, () => [blank(), blank()]);
  for (let x = 0; x <= YOSHI_HOUSE; x++) {
    const v = rom.r8(GAME_INDEX + x);
    msgs[v & 0x7f][v >> 7] = gameMessage(rom, x);
  }
  msgs[yoshiHouse(rom) & 0x7f][1] = gameMessage(rom, YOSHI_HOUSE + 1);
  msgs[YOSHI_THANKS.translevel][YOSHI_THANKS.msg - 1] = gameMessage(rom, GAME_MESSAGES - 1);
  const r = assemble(rom.data, new Map([['messages.asm', messageAsm()]]), 'messages.asm');
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join(' '));
  if (r.labels['Message_text'] + 1 !== TEXT_OP) throw new Error('Messages (SMWM): the text address is not where the editor reads it');
  for (const [a, n] of [...MSG_HOOKS, [ROUTINE, r.labels['End'] - ROUTINE]]) rom.writeAt(snesToPc(a), r.rom.subarray(snesToPc(a), snesToPc(a) + n));
  writeAll(rom, msgs, null);
}
