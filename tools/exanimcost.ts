// ExAnimation engine cost (kobo/exanimation.ts): level 106 played with the lag meter's input, the cycles the
// engine's hooks take per game frame – the animation step (JSL at $00A2A5, without the game's own animated
// tiles it calls, $05BB39) and the NMI's uploads (JSL at $00A390) – in scanlines; on the ROM as the editor
// opens it, and with the Romhack Races baserom's global animations and a level list that uses every slot
// type installed; the clean game's own animated tiles' uploads for comparison. The engine's part (over the clean
// game's) within a budget: 3.81 lines on the editor's ROM and 9.54 with the baserom's global animations before
// #151, 1.73 and 6.83 after. Also a hash of what the animation shows (VRAM, CGRAM, the palette copies in WRAM)
// per frame, to compare before and after a change of the engine (the animation must stay the same).
//   node tools/exanimcost.ts [--save=file.json] [--check=file.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { map16Source } from '../src/core/render.ts';
import { CYCLES_PER_LINE } from '../src/core/snes.ts';
import { RAM, PAD } from '../src/core/ram.ts';
import { hashBytes } from '../src/core/patchreg.ts';
import { inspectUpload, installPackage } from '../src/core/packages.ts';
import { emptyList, writeLevelList, writeAltFile, setLevelSettings, type ExSlot } from '../src/core/exanim.ts';
import { cleanImage, editorImage } from './fixture.ts';

await loadAsar();
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const LEVEL = 0x106, FRAMES = 420, FROM = 150;
// lines per frame the engine may add to the clean game's
const BUDGET: Record<string, number> = { editor: 2, global: 7.5 };
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// the hooks the engine's code is entered from (the bank's FastROM mirror bit ignored)
const STEP = 0x00a2a5, SETUP = 0x00a5fd, ENDING = 0x0095b5, NMI = 0x00a390, GAME_TILES = 0x05bb39;

function measure(rom: Rom): { step: number; nmi: number; hashes: number[] } {
  const emu = new LevelEmulator(rom);
  emu.boot();
  const s = emu.snes, cpu = s.cpu;
  const p = PlaySession.start(emu, LEVEL, { game: {} });
  if (!p.ready) throw new Error(`level ${LEVEL.toString(16)} did not get ready`);
  // cycles in the hooks: entered at the hook's JSL, left when the stack is back where it was
  // (the NMI's routine at $00A390, entered with JSR, until its RTS: the clean game's own for comparison)
  let where: 'step' | 'nmi' | null = null, sAt = 0, start = 0, gameAt = -1, gameStart = 0;
  const acc = { step: 0, nmi: 0 };
  // the palette copies in WRAM as the NMI's uploads begin (the game's frame done; at the end of runFrame the
  // game may be anywhere in its next frame, sooner with a faster engine)
  let palette = 0;
  const step = cpu.step.bind(cpu);
  cpu.step = () => {
    const pc = ((cpu.pbr << 16) | cpu.pc) & 0x7fffff;
    if (where === null && (pc === STEP || pc === SETUP || pc === ENDING || pc === NMI) && !cpu.nmiPending) {
      if (pc === NMI) palette = hashBytes([s.wram.subarray(RAM.palettes, RAM.palettesEnd)]);
      where = pc === NMI ? 'nmi' : 'step'; sAt = cpu.s + (pc === NMI ? 2 : 0); start = cpu.cycles;
    } else if (where !== null && cpu.s === sAt && !cpu.nmiPending) {
      acc[where] += cpu.cycles - start;
      where = null;
    }
    if (where !== null && gameAt < 0 && pc === GAME_TILES) { gameAt = cpu.s + 3; gameStart = cpu.cycles; }
    else if (gameAt >= 0 && cpu.s === gameAt && !cpu.nmiPending) { acc.step -= cpu.cycles - gameStart; gameAt = -1; }
    step();
  };
  const hashes: number[] = [];
  let step0 = 0, nmi0 = 0;
  for (let f = 0; f < FRAMES; f++) {
    if (f === FROM) { step0 = acc.step; nmi0 = acc.nmi; }
    p.frame(PAD.right | PAD.y | (f % 40 < 10 ? PAD.b : 0));
    hashes.push(hashBytes([s.vram, s.cgram]) ^ palette);
  }
  const lines = (c: number) => Math.round(c / (FRAMES - FROM) / CYCLES_PER_LINE * 100) / 100;
  return { step: lines(acc.step - step0), nmi: lines(acc.nmi - nmi0), hashes };
}

// the Romhack Races baserom's global animations, installed as a package
async function withGlobal(rom: Rom): Promise<void> {
  const zip = unzipSync(new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip')));
  const BPS = 'export/global/exanimation.bps', ALT = 'workspace/ExGraphics/ExGFX61.bin';
  const p = inspectUpload('baserom-anim.zip', zipSync({ [BPS]: zip[BPS], [ALT]: zip[ALT] }));
  if (p.status !== 'ready') throw new Error(`baserom animation: ${p.status}`);
  const blank = map16Source(rom, new LevelEmulator(rom).load(0x105)).fg(0x025);
  const r = await installPackage(rom, p, { level: 0x105, blank, tileWords: () => blank, setup: false });
  if (!r.ok) throw new Error(r.errors.join(' '));
}

// a level list for 106 with every kind of slot and trigger
function withLevelList(rom: Rom): void {
  const alt = new Uint8Array(0x800);
  for (let i = 0; i < alt.length; i++) alt[i] = (i * 7 + (i >> 5)) & 0xff;
  writeAltFile(rom, 2, alt);
  const l = emptyList();
  l.altFile = 2;
  l.customSet = 0x0005;
  l.manual.set(3, 1);
  const slots: ExSlot[] = [
    { type: 0x01, trigger: 0x00, framesLess1: 3, dest: 0x8000 | 0x0600, frames: [0, 0x20, 0x40, 0x60] },
    { type: 0x04, trigger: 0x03, framesLess1: 1, dest: 0x8000 | 0x0610, frames: [0x80, 0x100, 0x180, 0x200] },
    { type: 0x11, trigger: 0x01, framesLess1: 0, dest: 0x0640, frames: [0xad00, 0xad80] },
    { type: 0x0f, trigger: 0x05, framesLess1: 1, dest: 0x8000 | 0x2000, frames: [0, 0x10, 0x20, 0x30] },
    { type: 0x13, trigger: 0x00, framesLess1: 2, dest: 0x0021, frames: [0x001f, 0x03e0, 0x7c00] },
    { type: 0x14, trigger: 0x20, framesLess1: 1, dest: 0x8231, frames: [0x300, 0x306, 0x30c, 0x312] },
    { type: 0x15, trigger: 0x07, framesLess1: 1, dest: 0x0041, frames: [0x1111, 0x2222, 0x3333, 0x4444] },
    { type: 0x16, trigger: 0x00, framesLess1: 2, dest: 0, frames: [0x0123, 0x0456, 0x0789] },
    { type: 0x17, trigger: 0x04, framesLess1: 0, dest: 0, frames: [0x7fff, 0x0000] },
    { type: 0x18, trigger: 0x00, framesLess1: 1, dest: 0x0350, frames: [] },
    { type: 0x19, trigger: 0x03, framesLess1: 0, dest: 0x0258, frames: [] },
    { type: 0x1a, trigger: 0x0f, framesLess1: 2, dest: 0x0560, frames: [] },
    { type: 0x1b, trigger: 0x21, framesLess1: 1, dest: 0x0368, frames: [] },
    { type: 0x02, trigger: 0x13, framesLess1: 2, dest: 0x8000 | 0x0700, frames: [0x400, 0x440, 0x480] },
    { type: 0x01, trigger: 0x0f, framesLess1: 1, dest: 0x8000 | 0x0720, frames: [0x500, 0x520] },
    { type: 0x08, trigger: 0x00, framesLess1: 1, dest: 0x8000 | 0x0740, frames: [0x600, 0x700] },
    { type: 0x01, trigger: 0x30, framesLess1: 3, dest: 0x8000 | 0x0760, frames: [0, 0x20, 0x40, 0x60] },
    { type: 0x01, trigger: 0x08, framesLess1: 2, dest: 0x8000 | 0x0770, frames: [0, 0x20, 0x40] },
  ];
  // spread over the 8 phases, some slots past 8
  const at = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 15, 17, 19, 20, 24, 26, 29];
  slots.forEach((e, i) => l.slots.set(at[i], e));
  l.count = 30;
  writeLevelList(rom, LEVEL, l);
  setLevelSettings(rom, LEVEL, 0);
}

const results: Record<string, { step: number; nmi: number; hashes: number[] }> = {};
results.clean = measure(new Rom(cleanImage()));
const editor = new Rom(await editorImage());
results.editor = measure(editor);
const global = new Rom(await editorImage());
await withGlobal(global);
results.global = measure(global);
const levelList = new Rom(global.data.slice());
withLevelList(levelList);
results.levelList = measure(levelList);
for (const [k, r] of Object.entries(results)) {
  console.log(`${k.padEnd(10)} step ${r.step.toFixed(2).padStart(6)} lines  nmi ${r.nmi.toFixed(2).padStart(6)} lines  total ${(r.step + r.nmi).toFixed(2).padStart(6)} lines per frame (frames ${FROM}–${FRAMES})`);
}
const total = (k: string) => results[k].step + results[k].nmi;
for (const [k, b] of Object.entries(BUDGET)) {
  const own = total(k) - total('clean');
  check(own <= b, `${k}: the engine adds ${own.toFixed(2)} lines a frame to the clean game's (at most ${b})`);
}
check(new Set(results.levelList.hashes.slice(FROM)).size > 50, 'the level list animates (what it shows changes from frame to frame)');
const save = arg('save'), against = arg('check');
if (save) writeFileSync(save, JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.hashes]))));
if (against) {
  const want = JSON.parse(readFileSync(against, 'utf8')) as Record<string, number[]>;
  for (const [k, r] of Object.entries(results)) {
    const f = r.hashes.findIndex((h, i) => h !== want[k]?.[i]);
    check(f < 0, `${k}: the same animation as before${f < 0 ? ` in all ${r.hashes.length} frames` : ` – it differs from frame ${f} on`}`);
  }
}
if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
