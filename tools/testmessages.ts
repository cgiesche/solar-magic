// Message boxes: text round trip, in-place and relocated writes, read back through the game's routine.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { translevelToLevel } from '../src/core/overworld.ts';
import { readMessage, writeMessages, lineToText, textToLine, messageUsers, MSG_COUNT, MSG_COLS, type Message } from '../src/core/messages.ts';

const file = new Uint8Array(readFileSync('Super Mario World (U) [!].smc'));
let bad = 0;
const pad = (m: Message) => m.map((l) => [...l, ...Array(MSG_COLS - l.length).fill(0x1f)].join(',')).join('|');

// characters the game writes to the stripe buffer ($7F837D) when showing message x in its level (the box
// opens first); the emulator has to set the translevel $13BF itself
function shown(rom: Rom, x: number): string | null {
  const u = messageUsers(rom)[x][0];
  if (!u) return null;
  const emu = new LevelEmulator(rom);
  emu.boot();
  const r = emu.load(translevelToLevel(u.translevel));
  if (!r.ok) return 'load failed';
  const s = emu.snes, w = s.wram;
  let guard = 0;
  while (w[0x100] !== 0x14 && guard++ < 80) s.runFrame();
  const chars: number[] = [];
  // stripe rows: 4 byte header + 18 × (character, attribute)
  s.hook = { onWramWrite(a: number, v: number) { const rel = (a - 0x18381) % 40; if (a >= 0x18381 && a < 0x18381 + 8 * 40 && rel < 36 && !(rel & 1)) chars.push(v); } } as never;
  w[0x1426] = u.msg;
  for (let f = 0; f < 300 && chars.length < 8 * 18; f++) s.runFrame();
  s.hook = null;
  return chars.slice(0, 8 * 18).join(',');
}
const expect = (m: Message) => m.map((l) => [...l, ...Array(MSG_COLS - l.length).fill(0x1f)]).flat().join(',');

{
  const rom = new Rom(file.slice());
  const msgs = Array.from({ length: MSG_COUNT }, (_, i) => readMessage(rom, i));
  // text conversion is lossless
  for (const [i, m] of msgs.entries()) for (const l of m) if (pad([textToLine(lineToText(l))]) !== pad([l])) { console.log('text round trip', i, lineToText(l)); bad++; }
  // in place: same display
  console.log('in place:', writeMessages(rom, msgs));
  for (let i = 0; i < MSG_COUNT; i++) if (pad(readMessage(rom, i)) !== pad(msgs[i])) { console.log('in place differs', i); bad++; }
  const g = shown(rom, 9);
  if (g !== expect(msgs[9])) { console.log('game shows different text (in place)'); bad++; }
}
{
  const rom = new Rom(file.slice());
  const msgs = Array.from({ length: MSG_COUNT }, (_, i) => readMessage(rom, i));
  msgs[9] = Array.from({ length: 8 }, (_, l) => textToLine(`Line ${"ABCDEFGH"[l]} of a long msg`.slice(0, 18)));
  for (let i = 4; i < MSG_COUNT; i++) if (i !== 9) msgs[i] = msgs[i].map((l) => [...l, ...Array(MSG_COLS - l.length).fill(0x1f)].map((c, k) => (k === 17 ? 0x1b : c)));
  console.log('relocated:', writeMessages(rom, msgs));
  for (let i = 0; i < MSG_COUNT; i++) if (pad(readMessage(rom, i)) !== pad(msgs[i])) { console.log('relocated differs', i); bad++; }
  const g = shown(rom, 9);
  if (g !== expect(msgs[9])) { console.log('game shows different text (relocated)', g?.slice(0, 60)); bad++; }
  console.log('again:', writeMessages(rom, msgs));
  if (shown(rom, 9) !== expect(msgs[9])) { console.log('game shows different text (rewritten)'); bad++; }
}
console.log('messages bad', bad);
if (bad) process.exitCode = 1;
