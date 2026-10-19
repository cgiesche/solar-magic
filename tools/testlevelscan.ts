// Level scan (levelscan.ts): slowdown per screen and sprites that fall out or get stuck, found by
// playing the level through.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { levelScanJob, scanKey, type ScanResult } from '../src/core/levelscan.ts';
import { loadLevel, serializeLayer1, serializeSprites, spriteLoadOrder, newUid, isL1Vertical, type Level, type LevelSprite } from '../src/core/level.ts';
import { installEditorPatch, DM16_EXT } from '../src/core/patches.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
installEditorPatch(rom);
const emu = new LevelEmulator(rom); emu.boot();

function scan(lv: Level): ScanResult {
  const vertical = isL1Vertical(rom, lv.header.mode);
  const job = levelScanJob(emu, {
    number: lv.number, vertical,
    ov: { layer1: serializeLayer1(rom, lv), sprites: serializeSprites(lv.sprites, lv.spriteHeader, vertical) },
    width: vertical ? 512 : lv.header.screens * 256, height: vertical ? lv.header.screens * 256 : 27 * 16,
  });
  for (;;) { const r = job.next(); if (r.done) return r.value; }
}
const lagged = (r: ScanResult) => r.screens.filter((s) => s.lag >= 3);
const fate = (lv: Level, r: ScanResult, uid: number) => {
  const i = spriteLoadOrder(lv.sprites, isL1Vertical(rom, lv.header.mode)).findIndex((s) => s.uid === uid);
  return r.sprites.find((f) => f.index === i)?.kind;
};

for (const n of [0x105, 0x106, 0x10b]) {
  const r = scan(loadLevel(rom, n));
  check(r.ok && !lagged(r).length && !r.sprites.length, `level ${n.toString(16)}: no slowdown, no sprite problems (${r.frames} frames; ${r.sprites.map((f) => `${f.kind} ${f.index}`).join(', ')})`);
  check(!!r.camera && r.camera.spans.every((s) => !!s), `level ${n.toString(16)}: the camera's reach, every column shown`);
}

// eight Wigglers on screen 3 slow the game down there
{
  const lv = loadLevel(rom, 0x105);
  for (let i = 0; i < 8; i++) lv.sprites.push({ uid: newUid(), num: 0x86, x: 0x30 + i, y: 0x14, extra: 0 });
  const r = scan(lv);
  check(lagged(r).some((s) => s.screen === 3 || s.screen === 2), `eight Wigglers: slowdown on ${lagged(r).map((s) => `screen ${s.screen} (${s.lag}/${s.frames})`).join(', ')}`);
}

// a Koopa in the ground falls out of the level; a Koopa inside a wall is stuck
{
  const lv = loadLevel(rom, 0x105);
  const add = (s: Omit<LevelSprite, 'uid'>) => { const q = { uid: newUid(), ...s }; lv.sprites.push(q); return q.uid; };
  const falls = add({ num: 0x04, x: 0x48, y: 0x19, extra: 0 });
  lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 0x60, y: 0x14, size: 0x32, tile: 0x130 }); // 3×4 wall
  const stuck = add({ num: 0x04, x: 0x61, y: 0x16, extra: 0 });
  const r = scan(lv);
  check(fate(lv, r, falls) === 'fell', `a Koopa below the ground falls out (${fate(lv, r, falls)})`);
  check(fate(lv, r, stuck) === 'stuck', `a Koopa inside a wall is stuck (${fate(lv, r, stuck)})`);
}

// the cache key follows the level data played
{
  const lv = loadLevel(rom, 0x105), vertical = isL1Vertical(rom, lv.header.mode);
  const ov = () => ({ layer1: serializeLayer1(rom, lv), sprites: serializeSprites(lv.sprites, lv.spriteHeader, vertical), switchPalaces: false });
  const a = scanKey(lv.number, ov());
  check(scanKey(lv.number, ov()) === a, 'scan key: same level data, same key');
  const moved = { ...ov(), sprites: serializeSprites(lv.sprites.map((s, i) => (i ? s : { ...s, x: s.x + 1 })), lv.spriteHeader, vertical) };
  check(scanKey(lv.number, moved) !== a, 'scan key: a sprite moved, another key');
  check(scanKey(lv.number, { ...ov(), switchPalaces: true }) !== a, 'scan key: switch palaces on, another key');
  check(scanKey(0x106, ov()) !== a, 'scan key: another level, another key');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
