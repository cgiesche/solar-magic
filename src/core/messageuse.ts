// Where a translevel's messages are shown and what is wrong with them. The game's translevel goes along with
// Mario through a level's exits: a level's messages are shown in it and in the sub-levels reached from it; a level
// no overworld level reaches has translevel 0's (message 1 the intro's, 2 Yoshi's thank-you). Which message a
// placed sprite opens is what hitting it does in the game (the sprite probe, blockprobe.ts spriteMessage).

import type { Rom } from './rom.ts';
import { mainTranslevel, type LevelSprite } from './level.ts';
import type { ExitGraph } from './exitgraph.ts';
import { translevelToLevel } from './overworld.ts';
import { readMessage, isBlank, yoshiHouse, switchPalace, YOSHI_THANKS } from './messages.ts';
import { hex2, hex3, spriteName } from './names.ts';
import type { Problem } from './problems.ts';

// the translevel whose messages level n shows (0: no overworld level reaches it)
export function messageTranslevel(graph: ExitGraph, n: number): number {
  const t = mainTranslevel(n);
  if (t !== null) return t;
  const p = graph.parentOf(n);
  return p === null ? 0 : mainTranslevel(p)!;
}

// the levels showing translevel tl's messages: its level first, then the sub-levels reached from it (none for
// translevel 0: any level nothing reaches)
export function messageLevels(graph: ExitGraph, tl: number): number[] {
  if (!tl) return [];
  const main = translevelToLevel(tl), out = [main];
  for (let n = 0; n < 0x200; n++) if (n !== main && graph.parentOf(n) === main) out.push(n);
  return out;
}

export interface MessageLevel { number: number; sprites: LevelSprite[] }

const empty = (rom: Rom, tl: number, msg: number) => isBlank(readMessage(rom, tl, msg));

// Problems with translevel tl's messages seen from level `here` (its sprites as edited): a sprite opening an empty
// message, a message with text no sprite of here and `others` (the other levels sharing them) opens. opens(s): the
// message sprite s opens (1-3, 0 none), null while that is not known – nothing is reported then.
export function messageProblems(rom: Rom, tl: number, here: MessageLevel, others: MessageLevel[], opens: (s: LevelSprite) => number | null): Problem[] {
  const out: Problem[] = [];
  const all = [here, ...others].flatMap((l) => l.sprites.map((s) => ({ s, msg: opens(s) })));
  if (all.some((x) => x.msg === null)) return [];
  const name = (s: LevelSprite) => `Sprite ${hex2(s.num)} ${spriteName(s.num)} at ${hex2(s.x)}/${hex2(s.y)}`;
  for (const s of here.sprites) {
    const m = opens(s)!;
    if (!m) continue;
    // message 3: Yoshi's thank-you, translevel 0's message 2
    const t = m === 3 ? YOSHI_THANKS.translevel : tl, n = m === 3 ? YOSHI_THANKS.msg : m;
    if (!t && m === 1) {
      out.push({ key: `msg-intro:${s.uid}`, severity: 'info', text: `${name(s)} shows the intro's message`, where: { sprites: [s.uid] }, message: { translevel: 0, msg: 1 },
        title: 'No level on the overworld leads here (also not through exits), so the game shows translevel 0\'s messages – message 1 is the intro\'s. Connect the level to the overworld to give it messages of its own.' });
      continue;
    }
    if (!empty(rom, t, n)) continue;
    const other = m === 3 ? 0 : 3 - m;
    const only = other && !empty(rom, t, other) ? ` – only message ${other} has text` : '';
    out.push({ key: `msg-empty:${s.uid}`, severity: 'warn', text: `${name(s)} opens message ${m}, which is empty${only}`, where: { sprites: [s.uid] }, message: { translevel: t, msg: n },
      title: `Players see an empty box. ${only ? `Which message a message box opens depends on where it is (for the game's: message 1 at an even X, 2 at an odd X). ` : ''}Write the message or move the sprite.` });
  }
  // translevel 0's: the intro and Yoshi's thank-you, shown by the game itself
  if (!tl) return out;
  const opened = new Set(all.map((x) => x.msg));
  // Yoshi's house: message 2 is shown instead of 1 while Mario rides Yoshi; a switch palace's switch (an object)
  // opens its message 1
  if (tl === yoshiHouse(rom) && opened.has(1)) opened.add(2);
  if (switchPalace(rom, tl) >= 0) opened.add(1);
  const where = [here, ...others].map((l) => hex3(l.number)).join(', ');
  for (const m of [1, 2]) {
    if (opened.has(m) || empty(rom, tl, m)) continue;
    out.push({ key: `msg-unused:${tl}:${m}`, severity: 'warn', text: `Message ${m} has text, but no message box opens it`, message: { translevel: tl, msg: m },
      title: `No sprite in ${others.length ? `the levels showing these messages (${where})` : `level ${where}`} opens it, so players never see it.` });
  }
  return out;
}
