// BG2/BG3 GFX slots (SMWG). The slots need VRAM $2000-$2FFF, where the original game keeps the layer 1
// tilemap: without the VRAM patch they are refused; with it the upload loads the file there.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { installEditorPatch, setGfxEntry, setLevelExtGfx, installExtGfxPatch, extGfxPatch, levelExtGfx } from '../src/core/patches.ts';
import { loadAsar } from '../src/core/asar.ts';
import { installVramPatch } from '../src/core/vrampatch.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const file = new Uint8Array(readFileSync('test/fixtures/smw.smc'));
const vanilla = new Rom(file.slice());
installEditorPatch(vanilla);
const ev = new LevelEmulator(vanilla); ev.boot();

await loadAsar();
// the slots need VRAM $2000-$2FFF, where the original game keeps the layer 1 tilemap
let refused = '';
try { installExtGfxPatch(new Rom(vanilla.data.slice())); } catch (e) { refused = (e as Error).message; }
check(refused.includes('VRAM patch'), 'refused without the VRAM patch');

// with the VRAM patch BG2 loads into VRAM $2000, while the tilemaps (now at $3000/$3800) show exactly
// what the game shows without any of this
const rom = new Rom(vanilla.data.slice());
check(installVramPatch(rom).ok, 'VRAM patch installed');
installExtGfxPatch(rom);
const raw = new Uint8Array(0x1000).fill(0x5a);
setGfxEntry(rom, 0x80, rom.allocWrite(raw), true);
setLevelExtGfx(rom, 0x105, [0x80, 0xff]);
check(levelExtGfx(rom, 0x105)[0] === 0x80 && !!extGfxPatch(rom), 'BG2 slot of level 105 set');
const ep = new LevelEmulator(rom); ep.boot();
const ok = ev.load(0x105), good = ep.load(0x105);
let g2 = 0; for (let i = 0; i < 0x1000; i++) if (good.vram[0x4000 + i] === raw[i]) g2++;
check(good.ok && g2 === 0x1000, `BG2 file in VRAM $2000 (tiles 200-27F): ${g2}/4096`);
const w16 = (w: Uint8Array, a: number) => w[a] | (w[a + 1] << 8);
let tmBad = 0;
for (const [layer, vb, pb] of [[1, 0x2000, 0x3000], [2, 0x3000, 0x3800]] as const) {
  const cx = w16(ok.wram, layer === 1 ? 0x1a : 0x1e) >> 3, cy = w16(ok.wram, layer === 1 ? 0x1c : 0x20) >> 3;
  for (let y = cy; y < cy + 28; y++) for (let x = cx; x < cx + 32; x++) {
    const xx = x & 63, yy = y & 63;
    const a = vb + (xx & 32 ? 0x400 : 0) + (yy & 32 ? 0x800 : 0) + (yy & 31) * 32 + (xx & 31);
    const b = pb + (xx & 32 ? 0x400 : 0) + (yy & 31) * 32 + (xx & 31);
    if ((ok.vram[a * 2] | (ok.vram[a * 2 + 1] << 8)) !== (good.vram[b * 2] | (good.vram[b * 2 + 1] << 8))) tmBad++;
  }
}
check(tmBad === 0, `visible tilemaps unchanged (${tmBad} tiles differ)`);

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
