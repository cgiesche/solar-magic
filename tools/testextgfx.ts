// BG2/BG3 GFX slots (SMWG). The slots need VRAM $2000-$2FFF, where the original game keeps the layer 1
// tilemap, so without a VRAM patch they must stay off: an older install is switched off (its table is
// kept) and new ones are refused. With the VRAM patch this test also checks the upload itself.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { installEditorPatch, setGfxEntry, setLevelExtGfx, installExtGfxPatch, extGfxPatch, disableUnsafeExtGfx, levelExtGfx, setVramPatchCheck, vramPatchInstalled, EXT_GFX_HOOK } from '../src/core/patches.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const file = new Uint8Array(readFileSync('Super Mario World (U) [!].smc'));
const vanilla = new Rom(file.slice());
installEditorPatch(vanilla);
const ev = new LevelEmulator(vanilla); ev.boot();

// an install from before the fix (the VRAM check pretended to pass)
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
check(tm > 0, `old install: the layer 1 tilemap (VRAM $2000) is overwritten (${tm} bytes) – the reported bug`);

check(disableUnsafeExtGfx(rom) && rom.r8(EXT_GFX_HOOK) === 0xa2, 'switched off, original code at $00AA50 restored');
check(!!extGfxPatch(rom) && !extGfxPatch(rom)!.active && levelExtGfx(rom, 0x105)[0] === 0xff, 'table kept, slots inactive');
ep.syncRom();
const fixed = ep.load(0x105);
let d = 0; for (let i = 0; i < 0x10000; i++) if ((i < 0xc000 || i >= 0xc800) && fixed.vram[i] !== ok.vram[i]) d++;
check(fixed.ok && d === 0, `level loads like before (${d} VRAM bytes differ)`);
let refused = '';
try { installExtGfxPatch(new Rom(vanilla.data.slice())); } catch (e) { refused = (e as Error).message; }
check(refused.includes('VRAM-Patch'), 'new installs are refused without the VRAM patch');

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
