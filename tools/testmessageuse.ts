// Where a translevel's messages are shown (messageuse.ts): its level and the sub-levels reached from it, the
// translevel 0 levels no overworld level reaches; and the problems with them, the message each sprite opens as
// learned by hitting it (the game's code, blockprobe.ts): a sprite opening an empty message (the other one has
// text), a message with text no sprite of the levels sharing it opens.
import { Rom } from '../src/core/rom.ts';
import { ExitGraph } from '../src/core/exitgraph.ts';
import { levelTranslevel, loadLevel, newUid, type LevelSprite } from '../src/core/level.ts';
import { translevelToLevel } from '../src/core/overworld.ts';
import { BlockProber, spriteMessage } from '../src/core/blockprobe.ts';
import { messageLevels, messageTranslevel, messageProblems, type MessageLevel } from '../src/core/messageuse.ts';
import { readMessage, writeMessages, hasMessages, isBlank, yoshiHouse, textToLine } from '../src/core/messages.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase();

const rom = new Rom(await editorImage());
const graph = new ExitGraph(rom);

// the levels sharing a translevel's messages: as the game's translevel goes along with Mario through the exits
{
  for (const tl of [0x29, 0x14, 0x15, 0x13]) {
    const ls = messageLevels(graph, tl);
    check(ls.length > 0 && ls.every((n) => levelTranslevel(rom, n) === tl && messageTranslevel(graph, n) === tl), `translevel ${hx(tl)}: ${ls.map((n) => hx(n)).join(' ')}`);
  }
  const subs = messageLevels(graph, 0x15);
  check(subs[0] === translevelToLevel(0x15) && subs.length > 1, 'its level first, then its sub-levels');
  check(!messageLevels(graph, 0).length, 'translevel 0: no list');
  const sub = subs[1];
  check(messageTranslevel(graph, sub) === 0x15, `a sub-level shows its level's messages (${hx(sub)})`);
}

const probe = new BlockProber(new Rom(await editorImage()));
const opens = (s: LevelSprite) => (s.extra >= 2 ? 0 : spriteMessage(probe.probeSprite(s.num), s.x, s.y));
const level = (n: number): MessageLevel => ({ number: n, sprites: loadLevel(rom, n).sprites });
const box = (x: number, y = 0x10): LevelSprite => ({ uid: newUid(), num: 0xb9, x, y, extra: 0 });

// vanilla 105: its message boxes open message 1 and 2, both with text
{
  const here = level(0x105);
  const b9 = here.sprites.filter((s) => s.num === 0xb9);
  check(b9.map(opens).join(',') === '1,2', `105's message boxes open message 1 and 2 (at ${b9.map((s) => `${hx(s.x)}/${hx(s.y)}`).join(', ')})`);
  check(messageProblems(rom, 0x29, here, messageLevels(graph, 0x29).slice(1).map(level), opens).length === 0, 'vanilla 105: no problems');
}

// translevel 13 (a Star World message): only message 1 has text
const STAR = 0x13;
{
  const odd = box(0x31);
  const p = messageProblems(rom, STAR, { number: STAR, sprites: [box(0x30), odd] }, [], opens);
  const q = p.find((x) => x.where && 'sprites' in x.where && x.where.sprites[0] === odd.uid);
  check(p.length === 1 && !!q && /message 2/.test(q.text) && /only message 1 has text/.test(q.text) && q.message?.msg === 2 && q.message.translevel === STAR, `a sprite opening the empty message 2 (${q?.text})`);
  const n = messageProblems(rom, STAR, { number: STAR, sprites: [] }, [], opens);
  check(n.length === 1 && n[0].message?.msg === 1 && !n[0].where && /Message 1 has text/.test(n[0].text), `message 1 with text, no sprite opens it (${n[0]?.text})`);
}

// a message with text no sprite opens
{
  const r = new Rom(await editorImage());
  writeMessages(r, [{ translevel: STAR, msg: 2, message: [textToLine('Never seen')] }]);
  const p = messageProblems(r, STAR, { number: STAR, sprites: [box(0x30)] }, [], opens);
  check(p.length === 1 && p[0].message?.msg === 2 && !p[0].where && /Message 2 has text/.test(p[0].text), `message 2 with text, no sprite opens it (${p[0]?.text})`);
  check(!messageProblems(r, STAR, { number: STAR, sprites: [box(0x30), box(0x31)] }, [], opens).length, 'a box opening it: no problem');
  check(!messageProblems(r, STAR, { number: STAR, sprites: [box(0x30)] }, [{ number: 0x1cb, sprites: [box(0x31)] }], opens).length, 'a box in a level sharing it: no problem');
  check(!messageProblems(r, STAR, { number: STAR, sprites: [box(0x30)] }, [], () => null).length, 'nothing reported while it is not known what the sprites open');
}

// a level without messages: the box shows an empty box; no text: nothing to show
{
  const tl = Array.from({ length: 0x60 }, (_, t) => t).find((t) => t > 0x24 && !hasMessages(rom, t))!;
  const p = messageProblems(rom, tl, { number: tl + 0xdc, sprites: [box(0x30)] }, [], opens);
  check(p.length === 1 && /message 1, which is empty/.test(p[0].text) && !/only/.test(p[0].text), `no messages: an empty box (${p[0]?.text})`);
}

// a switch palace: its switch opens message 1
check(!messageProblems(rom, 0x14, { number: 0x14, sprites: [] }, [], opens).length, 'yellow switch palace: message 1 is opened by its switch');

// Yoshi's house: message 2 is shown riding Yoshi through a box opening message 1; translevel 0: the intro and Yoshi's thank-you
{
  const y = yoshiHouse(rom);
  check(!isBlank(readMessage(rom, y, 2)) && messageProblems(rom, y, level(translevelToLevel(y)), [], opens).every((x) => x.message?.msg !== 2), "Yoshi's house: message 2 is shown riding Yoshi");
  const p = messageProblems(rom, 0, { number: 0x1f0, sprites: [box(0x30)] }, [], opens);
  check(p.length === 1 && p[0].severity === 'info' && /intro/.test(p[0].text), `translevel 0: the box shows the intro's message (${p[0]?.text})`);
}

console.log('message use bad', bad);
if (bad) process.exitCode = 1;
