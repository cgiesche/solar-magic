// BG2/BG3 GFX slots (SMWG). The slots need VRAM $2000-$2FFF, where the original game keeps the layer 1
// tilemap, so without a VRAM patch they must stay off: an older install is switched off (its table is
// kept) and new ones are refused. With the VRAM patch this test also checks the upload itself.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { installEditorPatch, setGfxEntry, setLevelExtGfx, installExtGfxPatch, extGfxPatch, disableUnsafeExtGfx, levelExtGfx, setVramPatchCheck, vramPatchInstalled, EXT_GFX_HOOK } from '../src/core/patches.ts';
import { loadAsar } from '../src/core/asar.ts';
import { installVramPatch, uninstallVramPatch } from '../src/core/vrampatch.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const file = new Uint8Array(readFileSync('test/fixtures/smw.smc'));
const vanilla = new Rom(file.slice());
installEditorPatch(vanilla);
const ev = new LevelEmulator(vanilla); ev.boot();

await loadAsar();
// an install forced without the VRAM patch (the check pretends to pass); older versions of the slot
// code overwrote the layer 1 tilemap here - such installs are switched off when the ROM is opened
const rom = new Rom(vanilla.data.slice());
const real = vramPatchInstalled;
setVramPatchCheck(() => true);
installExtGfxPatch(rom);
const raw = new Uint8Array(0x1000).fill(0x5a);
setGfxEntry(rom, 0x80, rom.allocWrite(raw), true);
setLevelExtGfx(rom, 0x105, [0x80, 0xff]);
setVramPatchCheck(real);
const ep = new LevelEmulator(rom); ep.boot();
const broken = ep.load(0x105), ok = ev.load(0x105);
let tm = 0; for (let i = 0x4000; i < 0x5000; i++) if (broken.vram[i] !== ok.vram[i]) tm++;
check(tm === 0, `forced install without the VRAM patch: the slot code itself leaves the layer 1 tilemap alone (${tm} bytes changed)`);

check(disableUnsafeExtGfx(rom) && rom.r8(EXT_GFX_HOOK) === 0xa2, 'switched off, original code at $00AA50 restored');
check(!!extGfxPatch(rom) && !extGfxPatch(rom)!.active && levelExtGfx(rom, 0x105)[0] === 0xff, 'table kept, slots inactive');
const fixed = ep.load(0x105);
let d = 0; for (let i = 0; i < 0x10000; i++) if ((i < 0xc000 || i >= 0xc800) && fixed.vram[i] !== ok.vram[i]) d++;
check(fixed.ok && d === 0, `level loads like before (${d} VRAM bytes differ)`);
let refused = '';
try { installExtGfxPatch(new Rom(vanilla.data.slice())); } catch (e) { refused = (e as Error).message; }
check(refused.includes('VRAM patch'), 'new installs are refused without the VRAM patch');

// with the VRAM patch: the switched-off install comes back and BG2 loads into VRAM $2000, while the
// tilemaps (now at $3000/$3800) show exactly what the game shows without any of this
check(installVramPatch(rom).ok && extGfxPatch(rom)!.active && levelExtGfx(rom, 0x105)[0] === 0x80, 'VRAM patch installed: BG2/BG3 slots active again with their table');
const good = ep.load(0x105);
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
uninstallVramPatch(rom);
check(!extGfxPatch(rom)!.active, 'removing the VRAM patch switches the slots off again');

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
