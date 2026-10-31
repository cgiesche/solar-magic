// The camera's reach (camerareach.ts): what of the level the camera can show, found by carrying Mario along
// the level's top and bottom (vertical levels: its sides); and the camera the game puts at Mario standing at a
// chosen place (the game view frame placed by Mario).
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { cameraReachJob, cameraAtJob, cameraAtKey, type CameraReach } from '../src/core/camerareach.ts';
import { runJob } from '../src/core/jobrunner.ts';
import type { ScanLevel } from '../src/core/levelscan.ts';
import { loadLevel, serializeLayer1, serializeSprites, isL1Vertical, newUid, type Level } from '../src/core/level.ts';
import { installEditorPatch, DM16_EXT } from '../src/core/patches.ts';
import { RAM, cameraY, setMarioPos } from '../src/core/ram.ts';
import { VERTICAL_SCROLL } from '../src/core/names.ts';
import { GAME_VIEW_W, GAME_VIEW_H } from '../src/core/camerabands.ts';
import { PlaySession } from '../src/core/playsession.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
installEditorPatch(rom);
const emu = new LevelEmulator(rom); emu.boot();

function scanLevel(lv: Level): ScanLevel {
  const vertical = isL1Vertical(rom, lv.header.mode);
  return {
    number: lv.number, vertical,
    ov: { layer1: serializeLayer1(rom, lv), sprites: serializeSprites(lv.sprites, lv.spriteHeader, vertical) },
    width: vertical ? 512 : lv.header.screens * 256, height: vertical ? lv.header.screens * 256 : 27 * 16,
  };
}
const reach = (lv: Level) => runJob(cameraReachJob(emu, scanLevel(lv)));
const fmt = (r: CameraReach | null) => {
  if (!r) return 'none';
  const runs: string[] = [];
  r.spans.forEach((s, i) => {
    const t = s ? `${s[0]}-${s[1]}` : 'never';
    if (runs.length && runs[runs.length - 1].endsWith(` ${t}`)) return;
    runs.push(`${i}: ${t}`);
  });
  return runs.join(', ');
};
const every = (r: CameraReach | null, f: (s: [number, number] | null) => boolean) => !!r && r.spans.every(f);

// Yoshi's Island 2: the camera goes up to the top (Mario standing up there) and down as far as the game lets it,
// $C0: the lowest row it never shows
{
  const r = reach(loadLevel(rom, 0x105));
  check(!!r && !r.vertical && r.spans.length === 0x14 * 16, `105: a span per column (${r?.spans.length})`);
  check(every(r, (s) => !!s && s[0] === 0 && s[1] === 0xc0 + GAME_VIEW_H), `105: every column from the top to $C0 + 224 (${fmt(r)})`);
}
// the same level without vertical scrolling (the header's setting as edited; 0: the game's vertical scrolling,
// $00F7F4, returns at once): the camera stays where it starts
{
  const lv = loadLevel(rom, 0x105);
  lv.header.verticalScroll = 0;
  const r = reach(lv);
  check(every(r, (s) => !!s && s[0] === 0xc0 && s[1] === 0xc0 + GAME_VIEW_H), `105 without vertical scrolling: only the bottom of the level (${fmt(r)})`);
}
// what the header's vertical scroll settings do (their names, names.ts): Mario lands on a ledge high up, standing
// or climbing; the camera follows him up where the setting lets it
{
  const camY = (v: number, climb: boolean) => {
    const lv = loadLevel(rom, 0x105);
    lv.header.verticalScroll = v;
    lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 0x20, y: 0x06, size: 0x0f, tile: 0x130 });
    PlaySession.start(emu, 0x105, { ov: { layer1: serializeLayer1(rom, lv), sprites: serializeSprites(lv.sprites, lv.spriteHeader, false) }, until: 'settled' });
    const s = emu.snes, w = s.wram;
    setMarioPos(w, 0x220, 0x60 - 40);
    for (let f = 0; f < 200; f++) { if (climb) w[RAM.marioClimbing] = 1; w[RAM.hurtTimer] = 0x40; s.runFrame(); }
    return cameraY(w);
  };
  const follows = (v: number) => `${camY(v, false) < 0xc0 ? 'standing' : '-'}/${camY(v, true) < 0xc0 ? 'climbing' : '-'}`;
  const got = [0, 1, 2, 3].map(follows);
  check(JSON.stringify(got) === JSON.stringify(['-/-', 'standing/climbing', '-/climbing', '-/-']), `the camera follows Mario up: ${got.map((g, v) => `${VERTICAL_SCROLL[v]}: ${g}`).join('; ')}`);
}

// a vertical level: spans per row, across the level's width as far as the camera goes sideways
{
  const lv = loadLevel(rom, 0x134), r = reach(lv);
  check(!!r && r.vertical && r.spans.length === lv.header.screens * 16, `134 (vertical): a span per row (${r?.spans.length})`);
  check(!!r && r.spans.slice(16, -16).every((s) => !!s && s[0] === 0 && s[1] === 512), `134: rows inside the level from the left to the right edge (${fmt(r)})`);
}

// the camera for Mario standing at a place: he is on the screen, the camera inside the level
{
  const lv = scanLevel(loadLevel(rom, 0x105));
  const at = (x: number, y: number) => runJob(cameraAtJob(emu, lv, x, y));
  const onScreen = (c: { x: number; y: number } | null, x: number, y: number) =>
    !!c && x >= c.x && x + 16 <= c.x + GAME_VIEW_W && y >= c.y && y + 32 <= c.y + GAME_VIEW_H;
  const high = at(0xbb8, 0x20), low = at(0xbb8, 0x160), start = at(0x40, 0x160);
  check(onScreen(high, 0xbb8, 0x20) && high!.y === 0, `105: Mario high up in the middle of the level: the camera at the top (${JSON.stringify(high)})`);
  check(onScreen(low, 0xbb8, 0x160) && low!.y === 0xc0 && low!.x === high!.x, `105: Mario low: the camera at the bottom, the same X (${JSON.stringify(low)})`);
  check(!!start && start.x === 0 && start.y === 0xc0, `105: Mario at the start: the camera at the level's start (${JSON.stringify(start)})`);
  const end = at(lv.width - 32, 0x160);
  check(!!end && end.x === lv.width - GAME_VIEW_W, `105: Mario at the end: the camera at the level's end (${JSON.stringify(end)})`);
  check(cameraAtKey(lv.number, lv.ov, 1, 2) === cameraAtKey(lv.number, lv.ov, 1, 2), 'camera key: same level data and place, same key');
  check(cameraAtKey(lv.number, lv.ov, 1, 2) !== cameraAtKey(lv.number, lv.ov, 1, 3), 'camera key: another place, another key');
  check(cameraAtKey(lv.number, lv.ov, 1, 2) !== cameraAtKey(lv.number, { ...lv.ov, switchPalaces: true }, 1, 2), 'camera key: other level data, another key');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
