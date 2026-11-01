// BOWSIE (bowsie.ts): its sprites assembled with BOWSIE's own ASM as one patch, read by its loader from Lunar Magic's
// table (owcustom.ts). Checked by emulation: the patch goes in beside the editor's patches; the overworld's load puts
// the sprites of the submap Mario is on into BOWSIE's slots as the table says (its reader logic: number, position,
// height, extra bytes); a sprite placed shows (its OAM tiles where it is) and runs (its animation goes on); the size
// table follows the sprites' extra bytes and the placed sprites are rewritten for it; removing it gives the ROM back.
import { unzipSync, zipSync } from 'fflate';
import { inspectUpload, installPackage, type ReadyPreview } from '../src/core/packages.ts';
import { packageSummary } from '../src/core/pkgreg.ts';
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { OverworldEmulator, OverworldLoads } from '../src/core/overworld.ts';
import { customSpriteImages, customSpriteLooks } from '../src/core/owsprites.ts';
import { readPpuOam } from '../src/core/spritegfx.ts';
import { RAM, get16, getS16 } from '../src/core/ram.ts';
import { saveBowsieProject, loadBowsieProject, removeBowsie, bowsieInstalled, bowsieSprites, type BowsieProject } from '../src/core/bowsie.ts';
import { readCustomSprites, writeCustomSprites, customSizeTable, customSpriteRanges, type CustomOwSprite } from '../src/core/owcustom.ts';
import { editorImage, romDiff } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase();
await loadAsar();

// BOWSIE's originals (yoshifanatic) as a project: Piranha Plant at 04, the flying switch block (an extra byte) at 0C,
// the level tile sprite (5 extra bytes) at 12
const zip = unzipSync(new Uint8Array(readFileSync('test/fixtures/BOWSIE originals.zip')));
const files = new Map(Object.entries(zip).map(([k, v]) => [k.replace(/^originals\//, 'sprites/originals/'), v]));
const proj: BowsieProject = { files, list: [{ num: 4, file: 'sprites/originals/OWSpr04_PiranhaPlant.asm' }, { num: 0x0c, file: 'sprites/originals/OWSpr0C_FlyingSwitchBlock.asm' }, { num: 0x12, file: 'sprites/originals/OWSpr12_SpriteLevelTile.asm' }] };

const clean = await editorImage();
const rom = new Rom(clean.slice());
const lists: CustomOwSprite[][] = Array.from({ length: 7 }, () => []);
lists[0] = [{ id: 4, x: 0x14, y: 0x0c, z: 0, extra: [0x77] }];
lists[1] = [{ id: 4, x: 0x0a, y: 0x0e, z: 2, extra: [] }];
lists[2] = [{ id: 0x0c, x: 0x08, y: 0x10, z: 0, extra: [0x5a] }];
writeCustomSprites(rom, lists); // placed before BOWSIE: 4 bytes an entry (Lunar Magic's default)
const r = saveBowsieProject(rom, proj);
check(r.ok, `BOWSIE with 3 sprites installed${r.ok ? '' : ': ' + r.errors.join(' | ')}`);
if (!r.ok) process.exit(1);
check(bowsieInstalled(rom) && (rom.r8(0x0fffe0) & 8) === 0, 'its signature at $04EF3E, bit 3 of $0FFFE0 cleared');
const sizes = customSizeTable(rom);
const info = bowsieSprites(loadBowsieProject(rom)!);
check(!!sizes && sizes[3] === 3 && sizes[0x0b] === 4 && sizes[0x11] === 8 && sizes[0x10] === 3 && info.find((s) => s.num === 0x12)!.extra === 5,
  `the size table: 04 ${sizes?.[3]}, 0C ${sizes?.[0x0b]}, 12 ${sizes?.[0x11]}, others 3`);
const back = readCustomSprites(rom);
check(JSON.stringify(back[0]) === JSON.stringify([{ ...lists[0][0], extra: [] }]) && back[1].length === 1 && JSON.stringify(back[2][0].extra) === '[90]',
  `the placed sprites rewritten for the sizes (meOWmeOW): ${JSON.stringify(back[0])}, ${JSON.stringify(back[2])}`);
if (r.warnings.length) console.log('     warnings: ' + r.warnings.join(' | '));

// the overworld loaded: BOWSIE's reader puts the main map's sprite into a slot
const emu = new OverworldEmulator(rom);
const slots = (w: Uint8Array) => Array.from({ length: 24 }, (_, k) => ({ num: get16(w, RAM.bowsieNum + k * 2), x: get16(w, RAM.bowsieX + k * 2), y: get16(w, RAM.bowsieY + k * 2), z: get16(w, RAM.bowsieZ + k * 2) })).filter((s) => s.num);
{
  const load = emu.load(0, 0);
  const s = slots(load.wram);
  check(load.ok && s.length === 1 && s[0].num === 4 && s[0].x === 0x14 * 8 && s[0].y === 0x0c * 8 && s[0].z === 0, `main map: BOWSIE's slots ${JSON.stringify(s)}`);
  // it shows and runs: its tiles (2A/2C) in OAM where it is, both frames within a few dozen frames
  const sn = emu.snes, seen = new Set<number>();
  let at = '';
  for (let f = 0; f < 40; f++) {
    sn.runFrame();
    const cx = getS16(sn.wram, RAM.layer1X), cy = getS16(sn.wram, RAM.layer1Y);
    for (const t of readPpuOam(sn.oam)) if (t.tile === 0x2a || t.tile === 0x2c) { seen.add(t.tile); at = `${hx(t.x + cx)},${hx(t.y + cy)}`; }
  }
  check(seen.size === 2 && at === `${hx(0x14 * 8)},${hx(0x0c * 8)}`, `the Piranha Plant shows at ${at} (placed at A0,60) and animates (tiles ${[...seen].map(hx).join(', ')})`);
}
{
  const load = emu.load(1, 0);
  const s = slots(load.wram);
  check(load.ok && s.length === 1 && s[0].x === 0x50 && s[0].y === 0x70 && s[0].z === 0x10, `Yoshi's Island: BOWSIE's slots ${JSON.stringify(s)}`);
}
{
  // the extra byte: in BOWSIE's first extra table when the sprite spawns
  let extra = -1;
  const sn = emu.snes;
  sn.hook = { onWramWrite: (a: number, v: number) => { if (a >= RAM.bowsieExtra1 && a < RAM.bowsieExtra1 + 48 && !(a & 1) && v) extra = v; } };
  const load = emu.load(2, 0);
  sn.hook = null;
  check(load.ok && extra === 0x5a, `Vanilla Dome: the flying switch block's extra byte ${hx(extra)} in BOWSIE's extra table`);
}

// drawn by emulation: the main map's Piranha Plant where it is, Yoshi's Island's at its height; the palette's looks
{
  const loads = new OverworldLoads(new OverworldEmulator(new Rom(rom.data.slice())), 2);
  const main = customSpriteImages(loads, 0, 0), yi = customSpriteImages(loads, 1, 0);
  const i = main[0]?.image, j = yi[0]?.image;
  check(main.length === 1 && !!i && i.ox === 0xa0 && i.oy === 0x60 && i.w >= 16, `main map: drawn at ${i && `${hx(i.ox)},${hx(i.oy)} ${i.w}x${i.h}`}`);
  check(yi.length === 1 && !!j && j.ox === 0x50 && j.oy === 0x70 - 0x10 && yi[0].z === 0x10, `Yoshi's Island: drawn at ${j && `${hx(j.ox)},${hx(j.oy)}`}, height ${yi[0]?.z}`);
  const looks = customSpriteLooks(loads, [4, 0x0c, 0x30]);
  check(!!looks[0] && looks[0].w === 16 && !looks[2], `the palette: 04 ${looks[0] && `${looks[0].w}x${looks[0].h} at ${looks[0].ox},${looks[0].oy}`}, 0C ${looks[1] ? 'drawn' : 'none'}, 30 (no sprite) none`);
}

// removed: the ROM as before but the table (now with 3-byte entries… back to 4) and its pointer
{
  const r2 = new Rom(rom.data.slice());
  removeBowsie(r2);
  check(!bowsieInstalled(r2) && customSizeTable(r2) === null, 'removed: no signature, no size table');
  check(JSON.stringify(readCustomSprites(r2)[0]) === JSON.stringify([{ ...lists[0][0], extra: [0] }]), 'the placed sprites back at 4 bytes');
  const r3 = new Rom(clean.slice());
  writeCustomSprites(r3, readCustomSprites(r2));
  // (the table elsewhere: its RATS block and pointer left out)
  const skip = [...customSpriteRanges(r2), ...customSpriteRanges(r3)].map(([a, b]) => [a - 8, b]);
  const n = romDiff(r3.data, r2.data, (i) => skip.some(([a, b]) => i >= a && i < b));
  check(n === 0, `otherwise the ROM as before it (${n} bytes differ)`);
}

// as a package: BOWSIE's originals are overworld sprite parts (their .json and the defines they include go with
// them, nothing is taken for a PIXI sprite, UberASM or a patch); installed, they get the numbers a list.txt gives,
// else the next free ones
{
  const pv = inspectUpload('BOWSIE originals.zip', new Uint8Array(readFileSync('test/fixtures/BOWSIE originals.zip')));
  const parts = pv.status === 'ready' ? pv.parts : [];
  check(parts.length === 18 && parts.every((p) => p.kind === 'owsprite') && pv.status === 'ready' && !pv.unclaimed.length, `the originals: ${parts.length} overworld sprites, ${pv.status === 'ready' ? pv.unclaimed.length : '?'} files unclaimed`);
  const pick = Object.fromEntries(Object.entries(zip).filter(([k]) => /PiranhaPlant|Cloud\.|OriginalSMWSpriteDefines/.test(k)));
  pick['list.txt'] = new TextEncoder().encode('20 OWSpr05_Cloud.asm\n');
  const r2 = new Rom(clean.slice());
  const up = inspectUpload('Two.zip', zipSync(pick)) as ReadyPreview;
  const res = await installPackage(r2, up, { level: 0x105, blank: [0, 0, 0, 0], tileWords: () => [0, 0, 0, 0] });
  const p = loadBowsieProject(r2);
  check(res.ok && !!res.pkg && JSON.stringify(p?.list.map((e) => [e.num, e.file]).sort()) === JSON.stringify([[0x01, 'sprites/originals/OWSpr04_PiranhaPlant.asm'], [0x20, 'sprites/originals/OWSpr05_Cloud.asm']].sort()),
    `installed: ${JSON.stringify(p?.list)} (${res.pkg && packageSummary(res.pkg).join(', ')})`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
