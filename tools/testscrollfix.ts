// The sprite scroll fix (scrollfix.ts, after HammerBrother's patch): sprites spawn by the direction the
// camera really moves. Level 105 with the camera scrolled left by hand ($1411 clear, $1462 moved) while
// Mario stays on the screen's right: the clean game keeps spawning on the right ($55 by Mario's place on
// the screen), the editor's ROM spawns the sprites the left edge passes. Patches whose work an editor
// patch does are replaced: uploaded alone nothing is installed, in a Callisto project they are left out
// with a note.
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel } from '../src/core/level.ts';
import { GM, RAM, SPR, SPRITE_SLOTS, SCROLL_FIX_RAM, setCameraX, setMarioPos, get16 } from '../src/core/ram.ts';
import { inspectUpload } from '../src/core/packages.ts';
import { cleanImage, editorImage } from './fixture.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase();

// ---------- spawning by the camera's direction ----------

// the camera from `from` 2 pixels left per frame, Mario holding right on the screen's right side (kept
// there, as HammerBrother's test code does: no layer 1 interaction, not hurt): the sprites (their index
// in the level's sprite data) that were in a slot meanwhile, and $55 at the end
function scrollLeft(rom: Rom, from: number, frames: number): { seen: Set<number>; dir: number; cam: number } {
  const emu = new LevelEmulator(rom); emu.boot();
  emu.load(0x105);
  const s = emu.snes, w = s.wram;
  let g = 0; while (w[RAM.gameMode] !== GM.level && g++ < 200) s.runFrame();
  setCameraX(w, from);
  const seen = new Set<number>();
  for (let f = 0; f < frames; f++) {
    w[RAM.scrollH] = 0;
    const x = get16(w, RAM.layer1XNext) - 2;
    setCameraX(w, x);
    setMarioPos(w, x + 0xc0, 0x140);
    w[RAM.marioSpeedY] = 0; w[RAM.hurtTimer] = 0xff; w[RAM.noLayer1Contact] = 0xff;
    s.joy1 = 0x0100;
    s.runFrame();
    for (let i = 0; i < SPRITE_SLOTS; i++) if (w[SPR.status + i]) seen.add(w[SPR.loadIndex + i]);
  }
  return { seen, dir: w[RAM.scrollDir], cam: get16(w, RAM.layer1X) };
}

{
  const patched = new Rom(await editorImage());
  const lv = loadLevel(patched, 0x105);
  // the sprites between the end and the start of the camera's left edge (x in 16 px blocks)
  const passed = lv.sprites.map((s, i) => ({ s, i })).filter(({ s }) => s.x >= 0x70 && s.x < 0x80).map(({ i }) => i);
  const clean = scrollLeft(new Rom(cleanImage()), 0x900, 256);
  const fixed = scrollLeft(patched, 0x900, 256);
  const names = (r: { seen: Set<number> }) => passed.filter((i) => r.seen.has(i)).map((i) => `${hx(lv.sprites[i].num)}@${hx(lv.sprites[i].x)}`).join(' ') || 'none';
  check(passed.length >= 2 && clean.cam === 0x700 && clean.dir === 2 && passed.every((i) => !clean.seen.has(i)),
    `the clean game: the camera moving left, Mario on the right – $55 = ${clean.dir} (right), the sprites the left edge passes stay (${names(clean)})`);
  check(fixed.cam === 0x700 && fixed.dir === 0 && passed.every((i) => fixed.seen.has(i)),
    `the editor's ROM: $55 = ${fixed.dir} (left), the sprites the left edge passes spawn (${names(fixed)})`);
}

// the position of the frame before is the level's own from its first frame on (the level load runs the
// camera code): RAM left over from before (another level, power-on garbage) doesn't set $55
{
  const emu = new LevelEmulator(new Rom(await editorImage())); emu.boot();
  const s = emu.snes, w = s.wram;
  const prev = SCROLL_FIX_RAM[0] - 0x7e0000;
  emu.load(0x105);
  w[prev] = 0x34; w[prev + 1] = 0x12; w[prev + 2] = 0x34; w[prev + 3] = 0x12;
  emu.load(0x105, { continueState: true });
  let g = 0; while (w[RAM.gameMode] !== GM.level && g++ < 200) s.runFrame();
  w[RAM.scrollDir] = 0x55; // (no direction: shows whether the first frame sets one)
  s.runFrame();
  check(w[RAM.scrollDir] === 0x55 && get16(w, prev) === get16(w, RAM.layer1XNext),
    `a level's first frame: $55 left as it is (${hx(w[RAM.scrollDir])}), the camera's position kept (${hx(get16(w, prev))})`);
}

// ---------- replaced patches ----------

const enc = new TextEncoder();
const dec = new TextDecoder();
const baserom = unzipSync(new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip')));
const GFXLOAD = 'resources/patches/optimizations/level_gfxload_optimization.asm';
const SCROLLFIX = 'resources/patches/fixes/sprite_scroll_fix.asm';
const VRAMOPT = 'resources/patches/optimizations/vram_optimize.asm';
{
  // by its content, not its name
  const p = inspectUpload('faster.asm', baserom[GFXLOAD]);
  check(p.status === 'replaced' && p.notes.length === 1 && p.notes[0].includes('faster.asm') && /already/.test(p.notes[0]),
    'the GFX load optimization uploaded alone: replaced, nothing to install – ' + (p.status === 'replaced' ? p.notes[0] : p.status));
  // HammerBrother's patch as SMW Central has it (no Callisto header)
  const plain = dec.decode(baserom[SCROLLFIX]).replace(/^incsrc "callisto.asm"\n%import_library\("freeram.asm"\)\n/, '').replace('!scroll_fix_freeram_bank', '$7FA430');
  const q = inspectUpload('SpriteScrollFix.zip', zipSync({ 'SpriteScrollFix.asm': enc.encode(plain), 'Readme.txt': enc.encode('Sprite scroll fix, by GreenHammerBro') }));
  check(q.status === 'replaced' && q.notes[0].includes('SpriteScrollFix.asm'), 'the sprite scroll fix uploaded alone: replaced – ' + (q.status === 'replaced' ? q.notes[0] : q.status));
  const other = inspectUpload('fix.asm', enc.encode('org $00F713\n  db $EA\n'));
  check(other.status === 'ready', 'another patch at one of its places: a patch');
  const v = inspectUpload('vram_optimize.asm', baserom[VRAMOPT]);
  check(v.status === 'replaced' && v.notes[0].includes('VRAM Patch optimization'), 'the VRAM Patch optimization uploaded alone: replaced – ' + (v.status === 'replaced' ? v.notes[0] : v.status));
}
{
  const p = inspectUpload('rhr-baserom-5.15.zip', new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip')));
  const patches = p.status === 'ready' ? p.parts.filter((x) => x.kind === 'patch').map((x) => x.file) : [];
  const notes = p.status === 'ready' ? p.notes : [];
  check(patches.length === 85 && ![GFXLOAD, SCROLLFIX, VRAMOPT].some((f) => patches.includes(f)), `the baserom: all three left out of its patches (${patches.length})`);
  check([GFXLOAD, SCROLLFIX, VRAMOPT].every((f) => notes.some((n) => n.includes(f)) && !(p.status === 'ready' && p.unclaimed.includes(f))),
    'each with a note:\n       ' + notes.filter((n) => /gfxload|scroll_fix|vram_optimize/.test(n)).join('\n       '));
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
