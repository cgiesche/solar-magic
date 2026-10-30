// The Romhack Races baserom (test/fixtures/rhr-baserom-5.15.zip) as a user uploads it: the zip unchanged, one
// package with its sample levels 105 and 13B, into a ROM the editor opened (level 106 open). Every patch of
// patches.toml is installed or named as a replaced patch; its UberASM, GPS blocks, PIXI sprite, ExGFX, Map16,
// shared palette colors, global animation, global GFX files and sound effect are part of the package; the
// sample levels play. The Retry System plays within a game as test play starts it (13B's object B1 sets the
// prompt): Mario dies, the prompt opens, A retries – he is back in 13B at its start without the overworld;
// after the midway tape he is back at 13B's midway point, where the editor shows its marker. The parts in detail are
// tested on their own (testcallisto.ts, testsamples.ts, testrommap16.ts, testsharedpal.ts, testglobalanim.ts,
// testglobalgfx.ts, testsfx.ts, testobj2d.ts, testobjectool.ts).
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { loadApu } from '../src/core/apu.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { GM, RAM, PAD, marioX, marioY, setMarioPos } from '../src/core/ram.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { map16Source, renderLevel } from '../src/core/render.ts';
import { installEditorPatch } from '../src/core/patches.ts';
import { enableBlocks } from '../src/core/map16ext.ts';
import { inspectUpload, installPackage, planUpload } from '../src/core/packages.ts';
import { listPatches } from '../src/core/patchreg.ts';
import { listPackages } from '../src/core/pkgreg.ts';
import { loadLevel, readSecondaryHeader, entrancePos, midwaySpot } from '../src/core/level.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
await loadApu();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase();
const L = (n: string) => `export/levels/level ${n}.mwl`;

const zip = new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip'));
const files = unzipSync(zip);
const toml = new TextDecoder().decode(files['tools/Callisto/patches.toml']);
const listed = [...toml.matchAll(/"\{patches_folder\}\/([^"]+)"/g)].map((m) => 'resources/patches/' + m[1]);

// ---------- the upload ----------

const p = inspectUpload('rhr-baserom-5.15.zip', zip);
if (p.status !== 'ready') throw new Error(`upload: ${p.status}`);
const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom); emu.boot();
const src = map16Source(rom, emu.load(0x106));
const blank = src.fg(0x025);
installEditorPatch(rom);
enableBlocks(rom, blank);
const before = listPatches(rom).length;
const r = await installPackage(rom, p, { level: 0x106, blank, tileWords: (t) => src.fg(t), setup: false, plan: planUpload(rom, p, blank), samples: [L('105'), L('13B')] });
if (!r.ok) console.log(r.errors.slice(0, 5).join('\n'));
check(r.ok && r.samples?.join() === [0x105, 0x13b].join(), `installed as one upload with the sample levels 105 and 13B (${r.samples?.map(hx).join(', ')})`);

const pkg = listPackages(rom);
const base = (f: string) => f.slice(f.lastIndexOf('/') + 1).replace(/\.asm$/, '');
const applied = new Set(listPatches(rom).slice(before).map((x) => x.name));
const replaced = listed.filter((f) => p.notes.some((n) => n.startsWith(`Not installed: ${f} `) && n.includes('a replaced patch')));
const missing = listed.filter((f) => !applied.has(base(f)) && !replaced.includes(f));
check(listed.length === 88 && replaced.length === 3 && !missing.length && pkg[0]?.patches.length === 85,
  `patches.toml's ${listed.length} patches: ${listed.filter((f) => applied.has(base(f))).length} installed, ${replaced.length} named as replaced (${replaced.map(base).join(', ')})${missing.length ? ` – neither: ${missing.join(', ')}` : ''}`);
if (pkg.length !== 1) check(false, `one package (${pkg.length})`);
else {
  const k = pkg[0];
  const parts = {
    'UberASM calls': k.uberasm.calls.length, 'GPS block tiles': k.block.tiles.length, 'PIXI sprite files': k.sprite.files.length, ExGFX: k.gfx.length,
    'FG Map16 tiles': k.map16?.length ?? 0, 'BG Map16 tiles': k.bgMap16?.length ?? 0, 'shared palette colors': k.sharedPal?.length ?? 0,
    'global animation slots': k.globalAnim?.slots.length ?? 0, 'global GFX files': k.globalGfx?.length ?? 0, 'sound effects': k.sfx?.length ?? 0,
  };
  check(Object.values(parts).every((n) => n > 0) && parts['global animation slots'] === 7 && parts['global GFX files'] === 20 && parts['sound effects'] === 1,
    `one package with all its parts: ${Object.entries(parts).map(([a, n]) => `${n} ${a}`).join(', ')}`);
}

// ---------- playing it ----------

// a new game with level n entered as test play does (the overworld's tile of its translevel, else the start)
const play = (n: number) => {
  const e = new LevelEmulator(rom); e.boot();
  const p = PlaySession.start(e, n, { game: {} });
  if (!p.ready) throw new Error(`level ${hx(n)} did not load`);
  return p;
};
const where = (w: Uint8Array) => `${hx(marioX(w))},${hx(marioY(w))}`;

for (const n of [0x105, 0x13b]) {
  const p = play(n);
  let live = 0;
  for (let f = 0; f < 120; f++) { p.frame(PAD.right); if (p.mode === GM.level) live++; }
  const lv = loadLevel(rom, n);
  check(live === 120 && p.wram[0x1931] === lv.header.tileset && p.wram[RAM.screens] === lv.header.screens, `sample level ${hx(n)} plays (${live} of 120 frames, Mario at ${where(p.wram)})`);
}

// the Retry System in 13B: into the pit, then A a few frames after the prompt opened (its first choice, Retry). The game modes it
// passes, where Mario is in which level after it
const h13b = loadLevel(rom, 0x13b).header;
const retry = (tape: { x: number; y: number } | null) => {
  const p = play(0x13b), w = p.wram;
  p.until('settled');
  if (tape) {
    setMarioPos(w, tape.x, tape.y);
    p.play(20);
  }
  const touched = w[RAM.midwayTouched];
  setMarioPos(w, marioX(w), 0x1f0); // into the pit
  const modes: number[] = [];
  let prompt = -1;
  for (let f = 0; f < 600; f++) {
    p.frame(prompt >= 0 && f >= prompt + 30 && f < prompt + 34 ? PAD.a : 0);
    if (modes.at(-1) !== w[RAM.gameMode]) modes.push(w[RAM.gameMode]);
    if (prompt < 0 && w[0x1b40c]) prompt = f; // !retry_ram_prompt_phase ($7FB40C)
    if (modes.length > 1 && w[RAM.gameMode] === GM.level) { p.play(60); break; } // back in a level: a second to settle
  }
  const in13b = w[0x1931] === h13b.tileset && w[RAM.screens] === h13b.screens;
  return { touched, prompt: prompt >= 0, modes: modes.map(hx).join(' '), in13b, back: modes.at(-1) === GM.level && !modes.includes(GM.overworldReturn), x: marioX(w), y: marioY(w), at: where(w) };
};
{
  const start = play(0x13b).wram;
  const sec = readSecondaryHeader(rom, 0x13b), marker = entrancePos(rom, midwaySpot(sec), (sec.verticalPositioning & 1) !== 0);
  const lv = loadLevel(rom, 0x13b);
  const im = renderLevel(rom, new LevelEmulator(rom).load(0x13b), lv.header.mode, lv.header.screens);
  const i = [...im.tiles1].indexOf(0x38); // the tape's right end
  const tape = { x: (i % im.geom1.width) * 16, y: Math.floor(i / im.geom1.width) * 16 - 8 };
  const d = retry(null);
  check(d.prompt && d.back && d.in13b && Math.abs(d.x - marioX(start)) < 16 && Math.abs(d.y - marioY(start)) < 16,
    `13B: Mario dies, the prompt opens, Retry: back at 13B's start ${d.at} (game modes ${d.modes})`);
  const m = retry(tape);
  check(i >= 0 && m.touched !== 0 && m.prompt && m.back && m.in13b && Math.abs(m.x - marker.x) < 16 && Math.abs(m.y - marker.y) < 16 && m.x !== marioX(start),
    `13B: the midway tape touched (${hx(tape.x)},${hx(tape.y)}), Mario dies, Retry: back at its midway point ${m.at} (its marker: ${hx(marker.x)},${hx(marker.y)}; game modes ${m.modes})`);
}

// 13B's message box (sprite B9): big Mario jumps into it from below – its message opens, no switch palace's
// switch is pressed and the level goes on after B closed it (the game's lookup showed the yellow switch palace's
// in any level its table doesn't name)
{
  const b9 = loadLevel(rom, 0x13b).sprites.find((s) => s.num === 0xb9)!;
  const p = play(0x13b), w = p.wram;
  p.until('settled');
  w[RAM.powerup] = 1;
  setMarioPos(w, b9.x * 16, b9.y * 16 + 0x40);
  p.play(30);
  let msg = 0;
  for (let f = 0; f < 90 && !msg; f++) { p.frame(f < 30 ? PAD.b : 0); msg = w[RAM.message]; }
  p.play(60); p.play(4, PAD.b); p.play(120);
  check(msg === 1 && w[RAM.palaceSwitch] === 0 && w[RAM.gameMode] === GM.level,
    `13B: Mario hits the message box at ${hx(b9.x)},${hx(b9.y)} – message ${msg}, switch ${w[RAM.palaceSwitch]}, game mode ${hx(w[RAM.gameMode])} after it closed`);
}
// the Retry System's hijack of Lunar Magic's switch palace routine ($03BC72, the loop drawing the switch's tiles)
// lands in the editor's: the yellow switch palace's message still presses its switch and returns to the overworld
{
  const p = play(0x14), w = p.wram;
  p.until('settled');
  w[RAM.message] = 1;
  p.play(90); p.play(4, PAD.b); p.play(120);
  check(rom.r8(0x03bc72) === 0x22 && w[RAM.palaceSwitch] === 1 && w[RAM.gameMode] !== GM.level,
    `level 14: the switch palace's message with the Retry System's hijack at $03BC72 – switch ${w[RAM.palaceSwitch]}, game mode ${hx(w[RAM.gameMode])} after it closed`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
