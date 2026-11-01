// Lunar Magic's "Extra Options" of the overworld (Overworld → Extra Options; 3.71's help
// ov_overworld_extra_options.htm) that the community uses, as switches (ADR 0005). Each changes a few bytes of the
// game's code in the places Lunar Magic changes, to the bytes Lunar Magic writes; turned back, the clean game's.
// The places and bytes are read from Lunar Magic 3.71's code (Lunar Magic.exe: its table of ROM places and the
// routine that writes the options), the ROMs Lunar Magic saved with options set show the same, SMW Central's hijack
// map names most of them. What each does in the game is checked by emulation (tools/testowoptions.ts).
//
// - hardcoded paths: the game's 5 paths between levels that cross other paths ($049301: levels 9–15, 23–1B,
//   11F–120, 10C–10D, and 24 to a pipe by position) – a BRA over the lookup ($049307)
// - path fade: the event path's fade-in (palettes, translucent sprites); off, each step's tiles are written at once
//   and the next one follows after $40 / speed frames (Lunar Magic's "Path Reveal Speed", 6 by default; the ADC's
//   operand in its routine at $04EACC). Off also turns off the sprites' translucency the fade needs ($00A0EB,
//   Lunar Magic's "Enable translucency for palettes C-F in sprites" unchecked)
// - Start+Select on passed levels ($00A267), Start to scroll the main map ($048380)
// - the save prompt after the game's castle, fortress, ghost house and switch palace tiles ($04E622, and the switch
//   in the save prompt routine at $03BA26, overworld.ts) – a level tile's own "save prompt" flag still brings it up
// - Luigi's map position saved as his own instead of Mario's ($048F9F)
// - life exchange ($04828D, the window), L/R opening it ($04836E)
import type { Rom } from './rom.ts';
import { LF_SAVE_SWITCH } from './overworld.ts';

export type OwOptionId = 'startSelect' | 'startScroll' | 'hardcodedPaths' | 'pathFade' | 'savePrompt' | 'saveLuigi' | 'lifeExchange' | 'lrExchange';

interface Bytes { at: number; game: number[]; changed: number[] }
export interface OwOption {
  id: OwOptionId;
  label: string;
  title: string;
  // the switch's value with the clean game's bytes (true: the game's behavior is the option turned on)
  game: boolean;
  bytes: Bytes[];
  needs?: OwOptionId; // has an effect only while that one is on
}

const FADE_SPEED = 0x04ead1; // the ADC's operand in Lunar Magic's step routine
export const DEFAULT_REVEAL_SPEED = 0x06; // Lunar Magic's
export const MAX_REVEAL_SPEED = 0x40; // a step a frame

export const OW_OPTIONS: readonly OwOption[] = [
  {
    id: 'startSelect', label: 'Start+Select exits passed levels', game: true,
    title: 'Whether the player can leave a level that is already passed with Start+Select while paused (the passed flag itself is not affected)',
    bytes: [{ at: 0x00a267, game: [0x10], changed: [0x80] }],
  },
  {
    id: 'startScroll', label: 'Start scrolls the main map', game: true,
    title: 'Whether the player can look around the main map with Start',
    bytes: [{ at: 0x048380, game: [0x10], changed: [0x00] }],
  },
  {
    id: 'hardcodedPaths', label: 'The game\'s 5 hardcoded paths', game: true,
    title: 'The game walks 5 paths by a table instead of path tiles, so that they can cross other paths: levels 9–15 (Donut Plains), 23–1B and 24 to a pipe (Chocolate Island), 11F–120 (Forest of Illusion), 10C–10D (Valley of Bowser). A path tile next to a level tile is walked instead anyway; turn them off when those levels or places are used differently.',
    bytes: [{ at: 0x049307, game: [0xa6, 0x08], changed: [0x80, 0x71] }],
  },
  {
    id: 'pathFade', label: 'Event path fade effect', game: true,
    title: 'The game fades in each step of an event\'s path on layer 2. The fade overwrites colors 1–7 of palettes 0–3 and C–F, zeroes colors 8–F of palettes C–E, keeps colors 8–F of palettes 0–2 set, makes palettes C–F translucent in sprites, needs SP3/SP4 to be FG1/FG2 and the path tiles to use only FG1/FG2 tiles with colors 0–7 of palettes 4–7. Turned off, each step appears at once at the path reveal speed and none of this applies.',
    bytes: [
      { at: 0x04e6fa, game: [0x62, 0xea], changed: [0x96, 0xe4] },
      { at: 0x04e73e, game: [0xef], changed: [0xff] },
      { at: 0x04e75e, game: [0x20, 0x96, 0xe4], changed: [0x9c, 0x94, 0x14] },
      { at: 0x04eaae, game: [0x20, 0x30], changed: [0x80, 0x04] },
      // LDA $1495 : CLC : ADC #speed : STA $1495 : RTS (the speed not compared)
      { at: 0x04eacc, game: [0xc2, 0x30, 0xa0, 0x8c, 0x00, 0xa2, 0x06, 0x00, 0xad, 0x84], changed: [0xad, 0x95, 0x14, 0x18, 0x69, DEFAULT_REVEAL_SPEED, 0x8d, 0x95, 0x14, 0x60] },
      { at: 0x00a0eb, game: [0x30], changed: [0x20] },
    ],
  },
  {
    id: 'savePrompt', label: 'Save prompt after castles, fortresses, ghost houses, switch palaces', game: true,
    title: 'The game brings up the save prompt when a castle, fortress, ghost house or switch palace (and level tiles 7E and 80) is passed. A level tile\'s own "Save prompt" flag brings it up either way.',
    bytes: [{ at: 0x04e622, game: [0xd0], changed: [0x80] }, { at: LF_SAVE_SWITCH, game: [0x01], changed: [0x00] }],
  },
  {
    id: 'saveLuigi', label: 'Save Luigi\'s map position', game: false,
    title: 'The game saves Mario\'s map position for Luigi as well. On, Luigi\'s own position is saved – needed when the two start in different places.',
    bytes: [{ at: 0x048f9f, game: [0xc2, 0x30], changed: [0x80, 0x3b] }],
  },
  {
    id: 'lifeExchange', label: 'Players can exchange lives', game: true,
    title: 'Whether the two players of a 2-player game can exchange lives (with L/R on the overworld, or at a game over)',
    bytes: [{ at: 0x04828d, game: [0xf0], changed: [0x80] }],
  },
  {
    id: 'lrExchange', label: 'L/R opens the life exchange', game: true, needs: 'lifeExchange',
    title: 'Whether L/R on the overworld opens the life exchange; off, only a game over does',
    bytes: [{ at: 0x04836e, game: [0xf0], changed: [0x80] }],
  },
];

export const owOption = (id: OwOptionId): OwOption => OW_OPTIONS.find((o) => o.id === id)!;

const isSpeed = (b: Bytes, k: number) => b.at + k === FADE_SPEED;
const has = (rom: Rom, list: Bytes[], which: 'game' | 'changed') =>
  list.every((b) => b[which].every((v, k) => (which === 'changed' && isSpeed(b, k)) || rom.r8(b.at + k) === v));

// the switch's value in the ROM; null: its bytes are neither the game's nor Lunar Magic's (a patch changed them)
export function owOptionValue(rom: Rom, id: OwOptionId): boolean | null {
  const o = owOption(id);
  if (has(rom, o.bytes, 'game')) return o.game;
  if (has(rom, o.bytes, 'changed')) return !o.game;
  return null;
}

// turns the option on or off (its bytes as the clean game's or Lunar Magic's); throws when a patch changed them
export function setOwOption(rom: Rom, id: OwOptionId, on: boolean): void {
  const o = owOption(id), cur = owOptionValue(rom, id);
  if (cur === null) throw new Error(`"${o.label}": its code in the ROM was changed by a patch`);
  if (cur === on) return;
  const which = on === o.game ? 'game' : 'changed';
  for (const b of o.bytes) b[which].forEach((v, k) => rom.w8(b.at + k, v));
}

// the path reveal speed with the path fade off (added to the step timer each frame; a step at $40); null with the fade
export function revealSpeed(rom: Rom): number | null {
  return owOptionValue(rom, 'pathFade') === false ? rom.r8(FADE_SPEED) : null;
}
export function setRevealSpeed(rom: Rom, v: number): void {
  if (owOptionValue(rom, 'pathFade') !== false) throw new Error('The path reveal speed applies with the event path fade off');
  if (v < 1 || v > MAX_REVEAL_SPEED) throw new Error(`The path reveal speed is 1–${MAX_REVEAL_SPEED.toString(16).toUpperCase()}`);
  rom.w8(FADE_SPEED, v);
}

// the frames between two steps of an event's path as the game shows them: the fade's 14, without it the speed's
// steps to $40 and 2 frames to write the tiles (measured by emulation, tools/testowoptions.ts)
export function revealStepFrames(rom: Rom): number {
  const v = revealSpeed(rom);
  return v === null ? 14 : Math.ceil(0x40 / v) + 2;
}
