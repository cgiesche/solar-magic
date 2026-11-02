// BOWSIE (bowsie.ts): its sprites assembled with BOWSIE's own ASM as one patch, read by its loader from Lunar Magic's
// table (owcustom.ts). Checked by emulation: the patch goes in beside the editor's patches; the overworld's load puts
// the sprites of the submap Mario is on into BOWSIE's slots as the table says (its reader logic: number, position,
// height, extra bytes); a sprite placed shows (its OAM tiles where it is) and runs (its animation goes on); the size
// table follows the sprites' extra bytes and the placed sprites are rewritten for it; removing it gives the ROM back. With the event path fade off it goes in with MaxTile (#246), re-inserted when the fade
// is switched or an overworld imported.
import { unzipSync, zipSync } from 'fflate';
import { inspectUpload, installPackage, type ReadyPreview } from '../src/core/packages.ts';
import { packageSummary } from '../src/core/pkgreg.ts';
import { readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { OverworldEmulator, OverworldLoads } from '../src/core/overworld.ts';
import { customSpriteImages, customSpriteLooks } from '../src/core/owsprites.ts';
import { readPpuOam } from '../src/core/spritegfx.ts';
import { RAM, get16, getS16 } from '../src/core/ram.ts';
import { saveBowsieProject, loadBowsieProject, removeBowsie, bowsieInstalled, bowsieSprites, bowsieMaxTile, syncBowsieMaxTile, type BowsieProject } from '../src/core/bowsie.ts';
import { setOwOption, owOptionValue } from '../src/core/owoptions.ts';
import { hasKoopaKidTable, koopaKidPos, setKoopaKidPos } from '../src/core/owsprites.ts';
import { importOverworld } from '../src/core/owimport.ts';
import { readCustomSprites, writeCustomSprites, customSizeTable, customSpriteRanges, customEntryAddrs, type CustomOwSprite } from '../src/core/owcustom.ts';
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

// BOWSIE's reader on a list of two: an odd X (its low bit in the entry's first byte) and a sprite with 5 extra bytes,
// which its loader gives the address of its entry's extra bytes
{
  const r2 = new Rom(rom.data.slice()), l = readCustomSprites(r2);
  l[3] = [{ id: 4, x: 0x0b, y: 0x09, z: 1, extra: [] }, { id: 0x12, x: 0x0c, y: 0x0a, z: 0, extra: [1, 2, 3, 4, 5] }];
  writeCustomSprites(r2, l);
  const at = customEntryAddrs(r2, 3)[1] + 3, e2 = new OverworldEmulator(r2), ext = new Map<number, number>();
  // (the extra tables as the loader writes them: the first value written to each byte)
  e2.snes.hook = { onWramWrite: (a: number, v: number) => {
    for (const base of [RAM.bowsieExtra1, RAM.bowsieExtra2, RAM.bowsieNum, RAM.bowsieX, RAM.bowsieY]) if (a >= base && a < base + RAM.bowsieExtraLen && v && !ext.has(a)) ext.set(a, v);
  } };
  e2.load(3, 0);
  e2.snes.hook = null;
  // (as spawned: the sprite with 5 extra bytes may erase itself where no level tile is; writes of the title screen's
  // level to the same RAM left out by their numbers)
  const word = (base: number, k: number) => (ext.get(base + k * 2) ?? 0) | ((ext.get(base + k * 2 + 1) ?? 0) << 8);
  const got = Array.from({ length: 24 }, (_, k) => ({ k, num: word(RAM.bowsieNum, k), x: word(RAM.bowsieX, k), y: word(RAM.bowsieY, k) })).filter((g) => g.num && g.num <= 0x7e);
  const tile = got.find((g) => g.num === 0x12);
  const ptr = tile ? word(RAM.bowsieExtra1, tile.k) | (word(RAM.bowsieExtra2, tile.k) << 16) : -1;
  check(got.some((g) => g.num === 4 && g.x === 0x58 && g.y === 0x48) && got.some((g) => g.num === 0x12 && g.x === 0x60 && g.y === 0x50), `Forest of Illusion: both spawned, the odd X too ${JSON.stringify(got)}`);
  check(ptr === at, `5 extra bytes: their address ${hx(at)} in the extra tables (${hx(ptr)})`);
  let threw = false;
  try { l[3] = [{ id: 0x7f, x: 0, y: 0, z: 0, extra: [] }]; writeCustomSprites(r2, l); } catch { threw = true; }
  check(threw, 'with BOWSIE, sprite 7F refused (its tables end at 7E)');
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

// MaxTile (#246): BOWSIE runs with it while the event path fade is off (MaxTile needs that), without it with the fade on
// – re-inserted when the fade is switched. Its setup is called at $009AA4 (JSL) with it, BRA over it without. Either
// way the Piranha Plant shows where it is placed and animates.
{
  const shows = (r: Rom) => {
    const e = new OverworldEmulator(new Rom(r.data.slice()));
    const load = e.load(0, 0), sn = e.snes, seen = new Set<number>();
    let at = '';
    for (let f = 0; f < 40; f++) {
      sn.runFrame();
      const cx = getS16(sn.wram, RAM.layer1X), cy = getS16(sn.wram, RAM.layer1Y);
      for (const t of readPpuOam(sn.oam)) if (t.tile === 0x2a || t.tile === 0x2c) { seen.add(t.tile); at = `${hx(t.x + cx)},${hx(t.y + cy)}`; }
    }
    return load.ok && seen.size === 2 && at === `${hx(0x14 * 8)},${hx(0x0c * 8)}`;
  };
  check(!bowsieMaxTile(rom) && rom.r8(0x009aa4) === 0x80, 'with the fade on: BOWSIE without MaxTile');
  const r2 = new Rom(clean.slice());
  setOwOption(r2, 'pathFade', false);
  writeCustomSprites(r2, lists);
  const res = saveBowsieProject(r2, proj);
  check(res.ok && bowsieMaxTile(r2) && r2.r8(0x009aa4) === 0x22, `with the fade off: BOWSIE with MaxTile${res.ok ? '' : ': ' + res.errors.join(' | ')}`);
  check(shows(r2), 'with MaxTile: the Piranha Plant shows and animates');
  {
    const loads = new OverworldLoads(new OverworldEmulator(new Rom(r2.data.slice())), 2);
    const i = customSpriteImages(loads, 0, 0)[0]?.image, j = customSpriteImages(loads, 1, 0)[0]?.image;
    check(!!i && i.ox === 0xa0 && i.oy === 0x60 && !!j && j.ox === 0x50 && j.oy === 0x60, `with MaxTile: drawn by emulation at ${i && `${hx(i.ox)},${hx(i.oy)}`} and ${j && `${hx(j.ox)},${hx(j.oy)}`}`);
  }
  check(syncBowsieMaxTile(r2).length === 0 && bowsieMaxTile(r2), 'nothing to re-insert while the fade is unchanged');
  setOwOption(r2, 'pathFade', true);
  syncBowsieMaxTile(r2);
  check(!bowsieMaxTile(r2) && bowsieInstalled(r2) && shows(r2), 'fade switched on: re-inserted without MaxTile, the sprite shows');
  check(JSON.stringify(readCustomSprites(r2)) === JSON.stringify(readCustomSprites(rom)), 'the placed sprites kept');
  setOwOption(r2, 'pathFade', false);
  syncBowsieMaxTile(r2);
  check(bowsieMaxTile(r2) && shows(r2), 'fade switched off again: re-inserted with MaxTile');
  // MaxTile's code is where the Koopa Kids' table was: no table, moving one refused; without MaxTile it is there
  {
    let threw = false;
    try { setKoopaKidPos(r2, 0, { x: 0x10, y: 0x10 }); } catch { threw = true; }
    check(!hasKoopaKidTable(r2) && threw && hasKoopaKidTable(rom), 'with MaxTile: no Koopa Kid table, moving one refused; without it, there');
  }
  // an overworld imported from a ROM with the fade on: BOWSIE re-inserted without MaxTile, the Koopa Kids copied
  {
    const r4 = new Rom(r2.data.slice()), src = new Rom(clean.slice());
    r4.extra = new Map(r2.extra);
    setKoopaKidPos(src, 1, { x: 0x123, y: 0x45 });
    const { warnings } = importOverworld(r4, src);
    check(owOptionValue(r4, 'pathFade') === true && !bowsieMaxTile(r4) && bowsieInstalled(r4) && koopaKidPos(r4, 1).x === 0x123,
      `overworld imported with the fade on: BOWSIE without MaxTile, the Koopa Kids copied (${warnings.filter((w) => /BOWSIE/.test(w)).join(' | ') || 'no BOWSIE warning'})`);
  }
  // … from a ROM with the fade off into one with MaxTile: MaxTile's code kept, the Koopa Kids not copied
  {
    const r4 = new Rom(r2.data.slice()), src = new Rom(clean.slice());
    r4.extra = new Map(r2.extra);
    setOwOption(src, 'pathFade', false);
    const code = (r: Rom) => r.data.slice(snesToPc(0x04f8a6), snesToPc(0x04ffb1)).join();
    const { warnings } = importOverworld(r4, src);
    check(bowsieMaxTile(r4) && warnings.some((w) => /Koopa Kids jump out is not copied/.test(w)) && code(r4) === code(r2),
      'imported with the fade off: MaxTile kept, its code unchanged, the Koopa Kids not copied (warned)');
  }
  // without its sources (a ROM exported without the editor data): left as it is, with a warning
  {
    const r5 = new Rom(r2.data.slice());
    setOwOption(r5, 'pathFade', true);
    const w = syncBowsieMaxTile(r5);
    check(bowsieMaxTile(r5) && w.length === 1 && /not re-inserted/.test(w[0]), `without its sources: not re-inserted, warned (${w.join(' | ')})`);
  }
  // without BOWSIE the switch changes nothing else
  const r3 = new Rom(clean.slice());
  setOwOption(r3, 'pathFade', false);
  const before = r3.data.slice();
  check(syncBowsieMaxTile(r3).length === 0 && romDiff(before, r3.data) === 0, 'without BOWSIE: nothing inserted');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
