// The Game workspace's "Start of game" page (CONTEXT.md: intro, new file data): what a new save file starts with, as
// the emulated game was seen to start one (gamestart.ts) – the intro (on or off, its level, its message, whether the
// game saves after it), the lives, the start position and the initial level flags (edited on the overworld: shown and
// linked here). A value the game reads from a byte of the ROM is a field; what it computes, or a patch chooses
// (Random Intro Level; No Title, No Intro, No Problems), is shown as what the game does, without a field; a byte a
// package's patch writes (Retry System's lives) names the package's setting instead.

import type { App } from './app.ts';
import { h, toast, hexInput } from './dom.ts';
import { icon } from './icons.ts';
import type { LevelEmulator } from '../core/levelemu.ts';
import type { SnesState } from '../core/snes.ts';
import { gameStart, introIsField, writeIntroLevel, writeStartLives, valueOwner, sameSpot, MAX_LIVES, type GameStart, type StartSpot } from '../core/gamestart.ts';
import { readMessage, lineToText, isBlank } from '../core/messages.ts';
import { readStart } from '../core/owsprites.ts';
import { MAP_NAMES, MAX_TRANSLEVEL, FLAG, l1Index, initialFlags, hasLevelFlagsPatch } from '../core/overworld.ts';
import { pcToSnes } from '../core/rom.ts';

export interface StartPageHost {
  openLevel(n: number): void; // the level editor on a level
  editMessage(level: number, translevel: number, msg: number): void; // the message editor beside that level
  showTile(i: number): void; // the overworld on a layer 1 tile
}
export interface StartPage {
  state: SnesState | null; // the machine whose picture the page shows: the intro, or a new file's first overworld
  status: string;
  body: HTMLElement[];
}

const hex = (n: number, d = 2) => n.toString(16).toUpperCase().padStart(d, '0');
const addr = (pc: number) => { const a = pcToSnes(pc) & 0x7fffff; return `$${hex(a >> 16)}:${hex(a & 0xffff, 4)}`; };
const where = (s: { submap: number; tx: number; ty: number }) => `${MAP_NAMES[s.submap] ?? `submap ${s.submap}`}, tile ${hex(s.tx)},${hex(s.ty)}`;

export function startPage(app: App, emu: LevelEmulator, host: StartPageHost): StartPage {
  const rom = app.rom, g: GameStart = gameStart(emu), out: HTMLElement[] = [];
  const edit = (what: string, fn: () => void) => { try { app.romEdit(what, fn); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); } };
  const p = (...body: (Node | string)[]) => h('p', { class: 'hint game-screen-about' }, ...body);
  const warn = (text: string) => h('p', { class: 'hint warn-text game-screen-about' }, icon('warning'), text);
  const row = (label: string, title: string, ...body: (HTMLElement | string)[]) => h('div', { class: 'prop game-field', title }, h('label', null, label), ...body);
  const title = (t: string) => h('div', { class: 'panel-title' }, t);
  const intro = g.intro, level = intro.level, field = introIsField(g);

  out.push(title('Start of game'), p('What a new save file starts with, as the game was seen to start one: the editor plays a new file from the title screen to its first overworld. A field is a byte of the ROM the game was seen to read the value from.'));
  if (!g.reached) out.push(warn(level !== null
    ? `A new file does not get to the overworld: the game loads level ${hex(level, 3)} as the intro and stays there (the intro ends when a message box in it is closed).`
    : 'A new file does not get to the overworld the way a player starts one: a button on the title screen, the first choice of each menu.'));

  // ---- the intro ----
  out.push(title('Intro'));
  if (field) {
    const set = (n: number | null) => edit(n === null ? 'No intro' : `Intro level ${hex(n, 3)}`, () => writeIntroLevel(emu, g, n));
    const inp = hexInput(level ?? 0, 3, (v) => { if (v !== level) set(v); }, 0x1ff);
    if (level === null) inp.value = '';
    inp.placeholder = 'none';
    out.push(row('Intro level', 'The level a new file shows before its first overworld (hex). The game chooses it by one byte, so not every level can be it.', inp,
      ...(level !== null ? [h('button', { title: 'A new file starts on the overworld (the byte the game chooses the level by set to 0)', onclick: () => set(null) }, 'No intro')] : [])));
    out.push(p(level !== null ? `The game chooses it by the byte at ${addr(intro.armed!.at)} ($${hex(intro.armed!.value)}); 0 there is no intro.`
      : `No intro: a new file starts on the overworld (the byte at ${addr(intro.armed!.at)} is 0). Enter a level to have one.`));
  } else if (level !== null) {
    out.push(row('Intro level', 'The level a new file was seen to load before its first overworld', h('span', null, hex(level, 3))),
      p('No field: the game computes which level it is, or a patch chooses it (as Random Intro Level does) – the level above is the one it loaded in the editor\'s run.'));
  } else out.push(p('No intro: a new file starts on the overworld, and no byte of the ROM chooses an intro level (a patch removed it, as No Title, No Intro, No Problems does).'));
  if (level !== null) {
    out.push(h('div', { class: 'prop game-field' }, h('label', null, ''), h('button', { onclick: () => host.openLevel(level) }, `Edit level ${hex(level, 3)}`)));
    const m = intro.message;
    if (m) {
      let text: string[] = [];
      try { const msg = readMessage(rom, m.translevel, m.msg); text = isBlank(msg) ? [] : msg.map(lineToText); } catch { /* no message text to read */ }
      out.push(row('Message', 'The message box the intro level opens; closing it ends the intro', h('span', null, `Translevel ${hex(m.translevel)}, message ${m.msg}`),
        h('button', { onclick: () => host.editMessage(level, m.translevel, m.msg) }, 'Edit …')));
      if (text.length) out.push(h('pre', { class: 'hint game-screen-about game-start-message' }, text.join('\n').replace(/\s+$/, '')));
      else out.push(p('The message is empty.'));
    } else if (g.reached) out.push(p('The intro level opened no message box in the editor\'s run.'));
    out.push(p(intro.saves ? 'The game saves after the intro: the new file is in SRAM before its first overworld.'
      : 'The game does not save after the intro: the file stays empty until the player first saves. (Lunar Magic\'s "Save game after intro message" is not a switch here yet: #536.)'));
    if (intro.spot && g.spot && !sameSpot(intro.spot, g.spot)) out.push(warn(`After the intro Mario stands on ${where(intro.spot)} – not at the start position (${where(g.spot)}). The game's intro sets his submap and Y position itself, for the clean game's start position.`));
  }

  // ---- the lives ----
  out.push(title('Lives'));
  const lives = g.lives;
  if (!lives) out.push(p('The game was not seen to set the lives of a new file.'));
  else {
    const owner = valueOwner(rom, lives), shown = lives.value + 1;
    if (lives.at >= 0 && !owner) {
      const inp = h('input', { type: 'number', min: 1, max: MAX_LIVES, value: String(shown), class: 'game-num' });
      inp.addEventListener('change', () => {
        const v = Math.round(Number(inp.value));
        if (inp.value.trim() === '' || !(v >= 1 && v <= MAX_LIVES)) inp.value = String(shown);
        else if (v !== shown) edit(`A new file starts with ${v} lives`, () => writeStartLives(rom, g, v));
      });
      out.push(row('Lives', `The lives a new file starts with, as the status bar shows them (1–${MAX_LIVES}; the game keeps one less, at ${addr(lives.at)})`, inp));
    } else {
      out.push(row('Lives', 'The lives a new file starts with, as the status bar shows them', h('span', null, String(shown))));
      if (owner) {
        const who = owner.pkg ? `${owner.pkg} (${owner.patch})` : `the patch "${owner.patch}"`;
        out.push(p(owner.setting ? `Set by ${who}: !${owner.setting.define} in ${owner.setting.file}. Change it there – its code writes the byte at ${addr(lives.at)} whenever it is applied.`
          : `The byte at ${addr(lives.at)} is written by ${who}: change it in its settings.`));
      } else out.push(p('No field: the game computes the lives, or a patch sets them.'));
    }
  }

  // ---- the start position ----
  out.push(title('Start position'));
  try {
    [0, 1].forEach((player) => {
      const s = readStart(rom, player), spot = { submap: s.submap, tx: s.x, ty: s.y };
      out.push(row(player ? 'Luigi' : 'Mario', 'Where the player stands when a new file gets to the overworld; moved in the overworld editor\'s Sprites mode', h('span', null, where(spot)),
        h('button', { title: 'Show the tile on the overworld', onclick: () => host.showTile(l1Index(s.submap ? 1 : 0, s.x, s.y)) }, 'Show')));
    });
  } catch (e) { out.push(p(String(e instanceof Error ? e.message : e))); }
  const stood: StartSpot | null = g.spot;
  if (stood) out.push(p(`In the editor's run Mario stood on ${where(stood)}.`));

  // ---- the initial level flags ----
  out.push(title('Initial level flags'));
  if (hasLevelFlagsPatch(rom)) {
    let passed = 0, ways = 0, other = 0;
    for (let tl = 0; tl <= MAX_TRANSLEVEL; tl++) {
      const f = initialFlags(rom, tl);
      if (f & FLAG.passed) passed++;
      if (f & (FLAG.up | FLAG.down | FLAG.left | FLAG.right)) ways++;
      if (f & (FLAG.savePrompt | FLAG.noEntry | FLAG.midway)) other++;
    }
    out.push(p(`Of the ${MAX_TRANSLEVEL + 1} overworld levels, a new file has ${passed} passed, ${ways} with ways open from the start${other ? ` and ${other} with another flag set (save prompt, no entry, midway point)` : ''}. They are set per level tile on the overworld (a level tile's "Initial flags").`));
  } else out.push(p('The initial level flags are the game\'s own: the editor\'s patch for them is not installed.'));

  const status = level !== null ? `The intro, as the game shows it on a new file (level ${hex(level, 3)})` : g.reached ? 'A new file\'s first overworld, as the game shows it (no intro)' : 'A new file does not get to the overworld';
  return { state: intro.shown ?? g.overworld, status, body: out };
}
