// Message boxes, two per translevel (SMWM, messages.ts): the game's messages moved to their levels when the
// patch is installed, text round trip, written messages read back, and what the game shows – a level's
// message, a switch palace's (its switch pressed), Yoshi's house's with Yoshi, message 3, an empty box (not
// the yellow switch palace's) in a level without a message – and whether the level goes on after it.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { translevelToLevel } from '../src/core/overworld.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { GM, PAD, RAM } from '../src/core/ram.ts';
import { readMessage, writeMessages, lineToText, textToLine, hasMessages, switchPalace, yoshiHouse, messagePatch, YOSHI_THANKS, PTRS, MSG_COLS, MSG_LINES, TRANSLEVELS, type Message } from '../src/core/messages.ts';
import { BlockProber, spriteMessage } from '../src/core/blockprobe.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase();
// the 144 character codes the box shows
const box = (m: Message) => Array.from({ length: MSG_LINES }, (_, l) => Array.from({ length: MSG_COLS }, (_, k) => m[l]?.[k] ?? 0x1f)).flat().join(',');
const text = (m: Message) => m.map(lineToText).join(' / ');

// the message box of translevel tl's level as the game shows it: the characters written to the stripe buffer
// ($7F837D, 4 byte header + 18 × (character, attribute) per row) once message `msg` opens, the switch pressed,
// and the game mode a second after B closed it
function shown(rom: Rom, tl: number, msg: number, yoshi = false) {
  const emu = new LevelEmulator(rom);
  emu.boot();
  const p = PlaySession.start(emu, translevelToLevel(tl), { game: { translevel: tl, setup: (w) => { w[RAM.yoshiCarried] = yoshi ? 1 : 0; } } });
  if (!p.ready) return null;
  const w = p.wram, chars: number[] = [];
  p.watch(() => ({ hook: { onWramWrite(a: number, v: number) { const rel = (a - 0x18381) % 40; if (a >= 0x18381 && a < 0x18381 + 8 * 40 && rel < 36 && !(rel & 1)) chars.push(v); } } as never, reset() {} }));
  const riding = w[RAM.ridingYoshi];
  w[RAM.message] = msg;
  for (let f = 0; f < 120 && chars.length < MSG_LINES * MSG_COLS; f++) p.frame();
  const palace = w[RAM.palaceSwitch];
  p.play(60);
  p.play(4, PAD.b);
  p.play(60);
  const mode = w[RAM.gameMode];
  p.close();
  return { chars: chars.slice(0, MSG_LINES * MSG_COLS).join(','), palace, mode, riding };
}

const rom = new Rom(await editorImage());
const vanilla = new Rom(await editorImage());
check(!!messagePatch(rom), 'installed with the editor patches');

// the game's messages in their levels (as the clean game's table names them)
check(text(readMessage(rom, 0x29, 1)).startsWith('-POINT OF ADVICE-'), `105 (translevel 29): Yoshi's Island 1's message 1 (${text(readMessage(rom, 0x29, 1)).slice(0, 30)})`);
check(text(readMessage(rom, yoshiHouse(rom), 2)).startsWith('It is possible  to'), "Yoshi's house: the game's message with Yoshi as message 2");
check(text(readMessage(rom, YOSHI_THANKS.translevel, YOSHI_THANKS.msg)).startsWith('Hooray!'), "message 3 (Yoshi's thank-you): translevel 0's message 2");
check(text(readMessage(rom, 0, 1)).startsWith('Welcome!'), "the intro's message: translevel 0's message 1");
check([0x14, 0x45, 0x3f, 0x08].every((tl, k) => switchPalace(rom, tl) === k && text(readMessage(rom, tl, 1)).includes('SWITCH PALACE')), 'the switch palaces from the game\'s table, their messages 1');
const used = Array.from({ length: TRANSLEVELS }, (_, tl) => tl).filter((tl) => hasMessages(rom, tl));
const named = new Set(Array.from({ length: 0x17 }, (_, x) => rom.r8(0x05a590 + x) & 0x7f));
check(used.length === named.size && used.every((tl) => named.has(tl)), `${used.length} translevels with messages, those the game's table names`);

// text conversion is lossless
for (const tl of used) for (const n of [1, 2]) for (const l of readMessage(rom, tl, n)) {
  if (box([textToLine(lineToText(l))]) !== box([l])) { console.log('  text round trip', hx(tl), n, lineToText(l)); bad++; }
}

// what the game shows
{
  const s = shown(rom, 0x29, 1);
  check(s?.chars === box(readMessage(rom, 0x29, 1)) && s.palace === 0 && s.mode === GM.level, `105: its message 1, the level goes on (switch ${s?.palace}, game mode ${hx(s?.mode ?? 0)})`);
}
{
  const s = shown(rom, 0x14, 1);
  check(s?.chars === box(readMessage(rom, 0x14, 1)) && s.palace === 1 && s.mode !== GM.level, `yellow switch palace: its message, switch 1 pressed, back to the overworld (switch ${s?.palace}, game mode ${hx(s?.mode ?? 0)})`);
}
{
  const s = shown(rom, 0x08, 2);
  check(s?.chars === box(readMessage(rom, 0x08, 2)) && s.palace === 0 && s.mode === GM.level, `red switch palace's message 2: no switch (switch ${s?.palace}, game mode ${hx(s?.mode ?? 0)})`);
}
{
  const y = yoshiHouse(rom), s = shown(rom, y, 1, true);
  check(!!s?.riding && s.chars === box(readMessage(rom, y, 2)), `Yoshi's house riding Yoshi: its message 2 (riding ${s?.riding})`);
  const n = shown(rom, y, 1);
  check(n?.chars === box(readMessage(rom, y, 1)), "Yoshi's house without Yoshi: its message 1");
}
{
  const s = shown(rom, 0x29, 3);
  check(s?.chars === box(readMessage(rom, YOSHI_THANKS.translevel, YOSHI_THANKS.msg)), "message 3: Yoshi's thank-you");
}
const empty = Array.from({ length: TRANSLEVELS }, (_, tl) => tl).find((tl) => tl > 0x24 && !hasMessages(rom, tl) && switchPalace(rom, tl) < 0)!;
{
  const s = shown(rom, empty, 1);
  check(s?.chars === box([]) && s.palace === 0 && s.mode === GM.level, `${hx(translevelToLevel(empty))} (no message): an empty box, no switch, the level goes on (switch ${s?.palace}, game mode ${hx(s?.mode ?? 0)})`);
}

// written messages: read back, shown by the game, the others unchanged; identical ones share their data
{
  const m = Array.from({ length: 8 }, (_, l) => textToLine(`Line ${'ABCDEFGH'[l]} of a long msg`.slice(0, 18)));
  const short = [textToLine('Hello!'), [], textToLine('  bye')];
  console.log('  written:', writeMessages(rom, [{ translevel: empty, msg: 1, message: m }, { translevel: empty, msg: 2, message: short }]));
  check(box(readMessage(rom, empty, 1)) === box(m) && box(readMessage(rom, empty, 2)) === box(short), 'read back');
  check(shown(rom, empty, 1)?.chars === box(m) && shown(rom, empty, 2)?.chars === box(short), 'shown by the game (a short one: the rest blank)');
  const others = Array.from({ length: TRANSLEVELS }, (_, tl) => tl).filter((tl) => tl !== empty);
  check(others.every((tl) => [1, 2].every((n) => box(readMessage(rom, tl, n)) === box(readMessage(vanilla, tl, n)))), 'the other messages unchanged');
  console.log('  again:', writeMessages(rom, [{ translevel: 0x29, msg: 2, message: m }]));
  check(box(readMessage(rom, 0x29, 2)) === box(m) && rom.r16(PTRS + (0x29 * 2 + 1) * 2) === rom.r16(PTRS + empty * 4), 'written again: an identical message shares its data');
  check(shown(rom, 0x29, 2)?.chars === box(m), 'shown by the game after rewriting');
}

// which message a message box sprite opens: learned by hitting it (the game's B9 reads its X position)
{
  const p = new BlockProber(new Rom(await editorImage())).probeSprite(0xb9);
  const by = Array.from({ length: 16 }, (_, x) => spriteMessage(p, x, 0x10));
  check(by.every((m, x) => m === (x & 1) + 1), `message box B9: message 1 at even X, 2 at odd X (${by.join('')}; ${p.summary})`);
  const koopa = new BlockProber(new Rom(await editorImage())).probeSprite(0x04);
  check(Array.from({ length: 16 }, (_, x) => spriteMessage(koopa, x, 0x10)).every((m) => !m), 'a koopa opens none');
}

console.log('messages bad', bad);
if (bad) process.exitCode = 1;
