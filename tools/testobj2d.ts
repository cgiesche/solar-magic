// Object 2D (Lunar Magic's "user defined" object, obj2d.ts): its length is found by emulation – 3 bytes in the
// clean game, 5 with a hook at $0DA415 that reads two more (ObjecTool, the Retry System's custom midway bars).
// With 5 bytes its two extra bytes (the extension) are parsed, written, kept by level files and Lunar Magic's
// level files; without, 2D stays a 3-byte object. The object list probes its custom numbers (thumbnails, the
// effect probe). With the Romhack Races baserom installed, the Retry System's midway bars load, draw, save and
// import from a Lunar Magic level file.
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { loadApu } from '../src/core/apu.ts';
import { map16Source } from '../src/core/render.ts';
import { installEditorPatch } from '../src/core/patches.ts';
import { enableBlocks } from '../src/core/map16ext.ts';
import { inspectUpload, installPackage, type ReadyPreview } from '../src/core/packages.ts';
import { MAP_BASE, map16Tile } from '../src/core/ram.ts';
import { loadAsar } from '../src/core/asar.ts';
import { applyPatch } from '../src/core/patchapply.ts';
import { parseObjects, serializeObjects, serializeLayer1, newUid, loadLevel, type LevelObject } from '../src/core/level.ts';
import { objectLength2D, fitExtension } from '../src/core/obj2d.ts';
import { saveLevel } from '../src/core/save.ts';
import { parseLmObjects, sampleLevel, mwlSections } from '../src/core/mwl.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { objectEffects } from '../src/core/objeffects.ts';
import { renderObjectThumbs } from '../src/ui/thumbs.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
await loadApu();
let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };
const hex = (d: Uint8Array) => [...d].map((b) => b.toString(16).padStart(2, '0')).join(' ');

const obj = (num: number, x: number, y: number, size: number, extension?: number[]): LevelObject =>
  ({ uid: newUid(), num, ext: 0, x, y, size, ...(extension ? { extension } : {}) });

// ---------- the clean game: 3 bytes ----------
const clean = new Rom(await editorImage());
check(objectLength2D(clean) === 3, `clean game: object 2D is 3 bytes (${objectLength2D(clean)})`);
{
  // 2D then object 01, as the clean game reads them
  const d = new Uint8Array([0x40, 0xd3, 0x12, 0x00, 0x14, 0x00, 0xff]);
  const p = parseObjects(d, 0, false);
  check(p.objects.length === 2 && p.objects[0].num === 0x2d && p.objects[0].size === 0x12 && !p.objects[0].extension && p.objects[1].num === 1,
    '3 bytes: 2D and the object after it');
}

// ---------- a hook that makes 2D 5 bytes (as the Retry System's) ----------
const HOOK = `lorom
org $0DA415
  JML NewNorm
freecode
NewNorm:
  SEP #$30
  LDA $5A : CMP #$2D : BEQ .custom
  LDA $1931|!addr
  JML $0DA41A
.custom
  LDY #$00 : LDA [$65],y : STA $5A
  INY : LDA [$65],y : STA $58
  INY : TYA : CLC : ADC $65 : STA $65
  LDA $66 : ADC #$00 : STA $66
  LDA $5A : CMP #$01 : BNE +
  LDA #$01 : STA $7FA400      ; custom 01: a flag other code reads
+ LDA $5A : CMP #$02 : BNE +
  LDY $57 : LDA #$25 : STA [$6B],y : LDA #$01 : STA [$6E],y   ; custom 02: tile 125
+ JML $0DA53C
`;
const hooked = new Rom(await editorImage());
check(objectLength2D(hooked) === 3, 'before the hook: 3 bytes');
const res = applyPatch(hooked, { name: 'Obj2D', main: 'main.asm', files: new Map([['main.asm', HOOK]]), defines: { addr: '$0000' } });
check(res.ok, 'hook patch applied ' + (res.ok ? '' : JSON.stringify(res).slice(0, 300)));
check(objectLength2D(hooked) === 5, `once the hook is installed (the same ROM): object 2D is 5 bytes (${objectLength2D(hooked)})`);
{
  const d = new Uint8Array([0x40, 0xd3, 0x12, 0x07, 0x81, 0x00, 0x14, 0x00, 0xff]);
  const p = parseObjects(d, 0, false, false, undefined, 5);
  const o = p.objects[0];
  check(p.objects.length === 2 && o.num === 0x2d && o.size === 0x12 && o.extension?.join() === '7,129' && p.objects[1].num === 1 && p.size === d.length,
    '5 bytes: 2D with its extension, then the next object');
  const back = serializeObjects(p.objects, [], false);
  check(hex(back) === hex(d), `written back the same (${hex(back)})`);
  const owners: number[] = [];
  serializeObjects([obj(0x2d, 3, 0x13, 0x12, [7, 0x81])], [], false, owners);
  check(owners.join() === '0,0,0,0,0,-1', 'its five bytes belong to it');
}

// a level with a 2D object loads with its extension and saves unchanged
{
  const lv = loadLevel(hooked, 0x105);
  lv.objects.push(obj(0x2d, 0x14, 0x13, 0x00, [0x00, 0x00]), obj(1, 0x16, 0x14, 0x00));
  saveLevel(hooked, lv);
  const again = loadLevel(hooked, 0x105);
  const o = again.objects.find((q) => q.num === 0x2d);
  check(!!o && o.extension?.join() === '0,0' && o.x === 0x14 && again.objects.at(-1)?.num === 1 && again.objects.length === lv.objects.length,
    'saved and loaded again: 2D with its extension, the object after it');
}

// a level loaded with the hook, written once it is gone: 2D as the game then reads it (3 bytes)
{
  const lv = loadLevel(hooked, 0x105);
  lv.objects.push(obj(0x2d, 0x14, 0x13, 0x00, [5, 6]), obj(1, 0x16, 0x14, 0x00));
  const n = serializeLayer1(clean, lv).length, m = serializeLayer1(hooked, lv).length;
  const n2d = lv.objects.filter((o) => o.num === 0x2d).length; // (with the one saved above)
  check(m - n === 2 * n2d && lv.objects.at(-2)?.extension?.join() === '5,6', `written for the ROM it goes into: 2 bytes less per 2D object without the hook (${n}, ${m}), the level unchanged`);
}

// an object given the extension the ROM reads: 2D with a hook keeps its bytes (missing ones 0), others have none
{
  const a = obj(0x2d, 0, 0, 0); fitExtension(a, 5);
  const b = obj(0x2d, 0, 0, 0, [9, 8, 7]); fitExtension(b, 5);
  const c = obj(0x2d, 0, 0, 0, [9, 8]); fitExtension(c, 3);
  const d = obj(0x14, 0, 0, 0, [9, 8]); fitExtension(d, 5);
  check(a.extension?.join() === '0,0' && b.extension?.join() === '9,8' && !('extension' in c) && !('extension' in d), 'extension fitted to the object and the ROM');
}

// the object list: custom numbers that draw tiles get a thumbnail, those that only change RAM are found by the
// effect probe, the others (doing nothing) by neither
{
  const emu = new LevelEmulator(hooked); emu.boot();
  const lv = loadLevel(hooked, 0x105);
  const specs = [0, 1, 2, 3].map((n) => ({ num: 0x2d, ext: 0, size: 0, extension: [n, 0] }));
  const thumbs = renderObjectThumbs(hooked, emu, lv, specs, (s) => `c${s.extension?.[0]}`);
  const drawn = thumbs.filter((t) => !t.effect), fxOnly = thumbs.filter((t) => t.effect);
  check(drawn.map((t) => t.key).join() === 'c2' && drawn[0].m16.join() === '293', `thumbnails: custom 02 draws tile 125 (${drawn.map((t) => t.key + ':' + t.m16).join(' ')})`);
  check(fxOnly.map((t) => t.key).join() === 'c1' && fxOnly[0].w === 0, `listed without a picture: custom 01, which changes RAM (${fxOnly.map((t) => t.key)})`);
  const quiet = [0, 1, 3].map((n) => obj(0x2d, 0, 0, 0, [n, 0]));
  const fx = objectEffects(emu, lv, quiet);
  check(fx.join() === 'false,true,false', `effects: custom 01 changes RAM, 00 and 03 nothing (${fx})`);
}

// Lunar Magic's level files: 2D is always 5 bytes there; kept where the ROM reads it so, else left out with a note
{
  const d = new Uint8Array([0x40, 0xd3, 0x12, 0x07, 0x81, 0x00, 0x14, 0x00, 0xff]);
  const notes: string[] = [];
  const kept = parseLmObjects(d, 0, false, notes, false, undefined, 5).objects;
  check(kept.length === 2 && kept[0].num === 0x2d && kept[0].extension?.join() === '7,129' && kept[1].num === 1 && !notes.length, '.mwl: 2D kept with its extension');
  const left = parseLmObjects(d, 0, false, notes).objects;
  check(left.length === 1 && left[0].num === 1 && notes.some((n) => n.includes('2D')), '.mwl without the hook: 2D left out with a note');
}

// ---------- the Romhack Races baserom: the Retry System's custom midway bars ----------
{
  const files = unzipSync(new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip')));
  const keep: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) if (!/^(export\/|resources\/original_graphics\/|workspace\/Graphics\/)/.test(k)) keep[k] = v;
  const pkg = inspectUpload('baserom.zip', zipSync(keep)) as ReadyPreview;
  const rom = new Rom(await editorImage());
  const emu = new LevelEmulator(rom); emu.boot();
  const src = map16Source(rom, emu.load(0x105));
  const blank = src.fg(0x025);
  installEditorPatch(rom); enableBlocks(rom, blank);
  const r = await installPackage(rom, pkg, { level: 0x105, blank, tileWords: (t) => src.fg(t), setup: false });
  check(r.ok && objectLength2D(rom) === 5, `installed: object 2D is 5 bytes (${objectLength2D(rom)})`);

  // a midway bar (2D 00) in level 105: loads, shows the tape (Map16 35, 38), saves and loads again unchanged
  const lv = loadLevel(rom, 0x105);
  lv.objects.push(obj(0x2d, 0x26, 0x16, 0x00, [0x00, 0x00]));
  saveLevel(rom, lv);
  const again = loadLevel(rom, 0x105);
  check(serializeLayer1(rom, again).join() === serializeLayer1(rom, lv).join() && again.objects.at(-1)?.extension?.join() === '0,0', 'midway bar: saved and loaded again unchanged');
  const w = emu.load(0x105).wram;
  const at = (x: number, y: number) => map16Tile(w, MAP_BASE + (x >> 4) * 0x1b0 + y * 16 + (x & 15));
  check(at(0x26, 0x16) === 0x38 && at(0x25, 0x16) === 0x35, `midway bar: the game draws the tape (${at(0x25, 0x16).toString(16)} ${at(0x26, 0x16).toString(16)})`);

  // the object list: the bars 00–1F, 41, 50, 51 draw the tape (each alone: Retry takes only so many per level),
  // 40 (the level's main entrance, where Mario starts anyway) registers itself without drawing; ObjecTool's
  // numbers are an RTS here, listed neither
  const specs = Array.from({ length: 0x100 }, (_, c) => ({ num: 0x2d, ext: 0, size: 0, extension: [c, 0] }));
  const thumbs = renderObjectThumbs(rom, emu, lv, specs, (s) => (s.extension?.[0] ?? 0).toString(16).padStart(2, '0'));
  const keys = (effect: boolean) => thumbs.filter((t) => !!t.effect === effect).map((t) => t.key).sort().join(' ');
  const bars = [...Array.from({ length: 0x20 }, (_, c) => c), 0x41, 0x50, 0x51].map((c) => c.toString(16).padStart(2, '0')).join(' ');
  check(keys(false) === bars && thumbs.filter((t) => !t.effect).every((t) => t.m16.join() === '53,56'), `listed with the tape: ${keys(false)}`);
  check(keys(true) === '40', `listed for what it does: ${keys(true)}`);

  // Lunar Magic's level file with a midway bar imports with it (13B with 2D 00 put first)
  const mwl = files['export/levels/level 13B.mwl'];
  const l1off = mwl[0x48] | (mwl[0x49] << 8) | (mwl[0x4a] << 16) | (mwl[0x4b] << 24);
  const bar = [0x40, 0xd5, 0x00, 0x00, 0x00]; // 2D at X 5, Y 0: custom 00, settings 00
  const d = new Uint8Array(mwl.length + 5);
  d.set(mwl.subarray(0, l1off + 8 + 5));
  d.set(bar, l1off + 8 + 5);
  d.set(mwl.subarray(l1off + 8 + 5), l1off + 8 + 10);
  const dv = new DataView(d.buffer);
  for (let i = 0; i < 8; i++) {
    const o = dv.getUint32(0x40 + i * 8, true);
    if (i === 1) dv.setUint32(0x44 + i * 8, dv.getUint32(0x44 + i * 8, true) + 5, true);
    else if (o > l1off) dv.setUint32(0x40 + i * 8, o + 5, true);
  }
  check(mwlSections(d).layer1.length === mwlSections(mwl).layer1.length + 5, '(the level file with the bar)');
  const sample = sampleLevel(rom, d, loadLevel(rom, 0x13b), { tile: (t) => t, sprite: () => null }, true);
  const o = sample.level.objects[0];
  check(o?.num === 0x2d && o.x === 5 && o.extension?.join() === '0,0' && !sample.notes.some((n) => n.includes('2D')), `level file: the bar imported (${sample.notes.join('; ')})`);
}

process.exit(fail ? 1 : 0);
