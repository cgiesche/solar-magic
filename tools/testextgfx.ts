// BG2/BG3 GFX slots (SMWG): an ExGFX file set as BG2/BG3 of a level lands in VRAM $2000/$2800 (tiles
// 200-2FF) of that level only; everything else loads unchanged.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { installEditorPatch, setGfxEntry, setLevelExtGfx, levelExtGfx, installExtGfxPatch } from '../src/core/patches.ts';
import { lz2Compress } from '../src/core/lz2.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const file = new Uint8Array(readFileSync('Super Mario World (U) [!].smc'));
const vanilla = new Rom(file.slice());
installEditorPatch(vanilla);
const rom = new Rom(vanilla.data.slice());
installExtGfxPatch(rom);
const ev = new LevelEmulator(vanilla); ev.boot();
const ep = new LevelEmulator(rom); ep.boot();

// 1. with the patch but no slots set, levels load exactly as before
const levels = [...Array(0x25).keys(), ...Array.from({ length: 0x3b }, (_, i) => 0x101 + i)];
let diff = 0;
for (const n of levels) {
  const a = ev.load(n), b = ep.load(n);
  let d = !b.ok ? 1 : 0;
  for (let i = 0; i < 0x10000 && !d; i++) if (a.vram[i] !== b.vram[i]) d++;
  for (let i = 0xc800; i < 0x10000 && !d; i++) if (a.wram[i] !== b.wram[i]) d++;
  if (d) { diff++; console.log('     level', n.toString(16), 'differs', b.error ?? ''); }
}
check(diff === 0, `all levels unchanged with the patch (${diff} differ)`);

// 2. raw 4bpp ExGFX $80 as BG2, LZ2 3bpp ExGFX $81 as BG3 of level 105
const raw = new Uint8Array(0x1000); for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + 3) & 0xff;
setGfxEntry(rom, 0x80, rom.allocWrite(raw), true);
const packed = lz2Compress(new Uint8Array(0xc00).map((_, i) => (i * 13) & 0xff));
setGfxEntry(rom, 0x81, rom.allocWrite(packed), false);
setLevelExtGfx(rom, 0x105, [0x80, 0x81]);
check(levelExtGfx(rom, 0x105).join() === '128,129' && levelExtGfx(rom, 0x106).join() === '255,255', 'slots per level');
ep.syncRom();
const r = ep.load(0x105), base = ev.load(0x105), other = ep.load(0x106), otherBase = ev.load(0x106);
let eq = 0; for (let i = 0; i < 0x1000; i++) if (r.vram[0x4000 + i] === raw[i]) eq++;
check(r.ok && eq === 0x1000, `BG2: raw file in VRAM $4000-$4FFF (${eq}/4096)`);
let bg3 = 0; for (let i = 0; i < 0x1000; i++) if (r.vram[0x5000 + i] !== base.vram[0x5000 + i]) bg3++;
check(bg3 > 0x800, `BG3: LZ2 file uploaded to VRAM $5000 (${bg3} bytes changed)`);
// ($C000-$C7FF: Mario's graphics, uploaded every frame – the extra upload shifts the load by a frame)
let rest = 0; for (let i = 0; i < 0x10000; i++) if ((i < 0x4000 || i >= 0x6000) && (i < 0xc000 || i >= 0xc800) && r.vram[i] !== base.vram[i]) rest++;
check(rest === 0, `rest of level VRAM unchanged (${rest})`);
let o = 0; for (let i = 0; i < 0x10000; i++) if (other.vram[i] !== otherBase.vram[i]) o++;
check(o === 0, 'other levels unaffected');

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
