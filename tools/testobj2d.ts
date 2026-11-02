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
import { effectLoad, ramEffect } from '../src/core/objeffects.ts';
import { renderObjectThumbs } from '../src/core/objthumbs.ts';
import { ObjKindProbe, UNSIZED, sizedByte, withSizedByte, resizeObjectSize, type ObjKind } from '../src/core/objkinds.ts';
import { SizeProbe, drivers } from '../src/core/objresize.ts';
import { EditSession } from '../src/core/editsession.ts';
import { LevelModel } from '../src/core/levelmodel.ts';
import { L2_PTRS } from '../src/core/level.ts';
import { record, holds, RomFingerprint } from '../src/core/romdeps.ts';
import { uninstallPackage } from '../src/core/pkgreg.ts';
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
+ LDA $5A : CMP #$05 : BEQ .block
  LDA $5A : CMP #$06 : BEQ .row
  LDA $5A : CMP #$07 : BNE +
  LDA $58 : BEQ +               ; custom 07: tile 125, only with a 5th byte other than 00
  LDY $57 : LDA #$25 : STA [$6B],y : LDA #$01 : STA [$6E],y
+ JML $0DA53C
.tiles: db $25,$26,$27        ; custom 06's types (what follows is code: no type 3)
.block                        ; custom 05: a block of tile 125, 5th byte: low nibble width - 1, high height - 1
  LDA $6C : PHA : LDA $6F : PHA
  LDA $58 : LSR #4 : STA $01
  LDY $57
.r
  PHY : LDA $58 : AND #$0F : TAX
- LDA #$25 : STA [$6B],y : LDA #$01 : STA [$6E],y : INY : DEX : BPL -
  PLY : TYA : CLC : ADC #$10 : TAY : BCC +
  INC $6C : INC $6F
+ DEC $01 : BPL .r
  PLA : STA $6F : PLA : STA $6C
  JML $0DA53C
.row                          ; custom 06: a row of tile 125 + type (5th byte: high nibble), low nibble width - 1
  LDA $58 : LSR #4 : TAX : LDA.l .tiles,x : STA $02
  LDA $58 : AND #$0F : TAX
  LDY $57
- LDA $02 : STA [$6B],y : LDA #$01 : STA [$6E],y : INY : DEX : BPL -
  JML $0DA53C
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
  check(fxOnly.map((t) => t.key).join() === 'c1' && fxOnly[0].w === 0, `listed without a thumbnail: custom 01, which changes RAM (${fxOnly.map((t) => t.key)})`);
  const quiet = [0, 1, 3].map((n) => obj(0x2d, 0, 0, 0, [n, 0]));
  const base = effectLoad(emu, lv, []).wram;
  const fx = quiet.map((o) => ramEffect(base, effectLoad(emu, lv, [o]).wram));
  check(fx.join() === ',sets $7FA400 bit 0,', `effects: custom 01 sets a flag, 00 and 03 nothing (${fx})`);
}

// the kinds of its custom numbers (#149): 05 sized by the nibbles of its 5th byte, 06 with types in its high nibble; 02
// (a single tile) has no size, 01 (draws nothing) no kind
{
  const emu = new LevelEmulator(hooked); emu.boot();
  const lv = loadLevel(hooked, 0x105), l2 = hooked.r24(L2_PTRS + 0x105 * 3);
  const { kinds, custom, drawsWith } = new ObjKindProbe(emu, lv, l2).result();
  const k5 = custom.get(5), k6 = custom.get(6);
  const txt = (k?: ObjKind) => JSON.stringify(k);
  check(k5?.byte === 'ext' && k5.lo === 'w' && k5.hi === 'h' && !k5.type, `custom 05: 5th byte low nibble width, high height (${txt(k5)})`);
  check(k6?.byte === 'ext' && k6.type === 'hi' && k6.count === 3 && k6.lo === 'w', `custom 06: 3 types in the 5th byte's high nibble, low nibble width (${txt(k6)})`);
  check(txt(custom.get(2)) === txt(UNSIZED) && !custom.has(1) && !custom.has(3), `custom 02 no size, 01 and 03 no kind (${txt(custom.get(2))})`);
  check(txt(custom.get(7)) === txt(UNSIZED) && drawsWith.get(7)?.join() === '34,34' && drawsWith.get(2)?.join() === '0,0',
    `custom 07 (draws only with a 5th byte other than 00): no size, listed with the bytes it drew with (${drawsWith.get(7)})`);
  check(kinds.get(0x05) === undefined && kinds.get(0x2d)?.byte === undefined, 'the standard objects as before');

  // its boxes: as the 5th byte says
  const probe = new SizeProbe(emu, lv, l2);
  const spec = (ext5: number) => ({ num: 0x2d, ext: 0, size: 0, extension: [5, ext5] });
  const box = (v: number) => probe.box(withSizedByte(k5, spec(0x11), v));
  probe.probe(Array.from({ length: 0x100 }, (_, v) => withSizedByte(k5, spec(0x11), v)));
  const b = box(0x21);
  check(!!b && b.x1 - b.x0 === 1 && b.y1 - b.y0 === 2, `custom 05 at 21: 2×3 tiles (${JSON.stringify(b)})`);
  const d = drivers(k5, 0x11, box);
  check(d.x === 'lo' && d.y === 'hi', `its edges: low nibble x, high y (${d.x}/${d.y})`);

  // resized in the level: by keys and by a drag, its 5th byte changes, its 3rd not
  const rom = new Rom(hooked.data.slice()), es = new EditSession(rom);
  es.open(0x105);
  const m = new LevelModel({
    rom: () => rom, level: () => es.level, edit: (f, rerender) => es.editLevel(f, rerender), geometry: () => ({ l1: { width: 512, height: 27 }, l2: null, vertical: false }),
    beginEdit: () => es.beginLevelEdit(), selectionChanged: () => {}, switchMode: () => {},
  });
  m.insertAt(0x20, 4, { kind: 'obj', num: 0x2d, ext: 0, size: 0, extension: [5, 0x11] });
  const o = es.level.objects.at(-1)!, kindOf = (q: LevelObject) => (q.num === 0x2d && q.extension?.[0] === 5 ? k5! : null);
  m.resizeObjects([o], [resizeObjectSize(k5, sizedByte(k5, o), 1, 2)], () => box, false, kindOf);
  const now = () => m.currentObjects().find((q) => q.uid === o.uid)!;
  check(now().extension?.join() === '5,50' && now().size === 0 && now().x === 0x20, `keys: width +1, height +2: 5th byte 32 (${now().extension}, ${now().size})`);
  const drag = m.beginResize([now()], now(), { hx: 1, hy: 1 }, () => d, () => box, kindOf)!;
  drag.aim(0x20 + 4, 4 + 1); drag.end();
  check(now().extension?.join() === '5,20' && now().size === 0 && now().x === 0x20, `drag the corner to 5×2: 5th byte 14 (${now().extension}, ${now().size})`);
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

// ---------- what reads a level depends on object 2D's length (#213) ----------
// Reading a level (the open level's follow-up, views drawing levels, results with a level as saved as their input)
// takes object 2D's length from emulating the dispatcher: what that read counts as read by the level's reading, so a
// package adding or removing the hook drops what read a level, a change elsewhere doesn't
{
  const rom = new Rom(await editorImage()), fp = new RomFingerprint(rom);
  const emu = new LevelEmulator(rom); emu.boot();
  const src = map16Source(rom, emu.load(0x105));
  const blank = src.fg(0x025);
  installEditorPatch(rom); enableBlocks(rom, blank);
  const readLevel = () => { const rec = record(rom, () => loadLevel(rom, 0x105)); return { rec, deps: fp.deps(rec.reads) }; };
  // the object kinds (they probe 2D's custom numbers only with a hook): no level read, but object 2D's length
  const kindsDeps = () => {
    const lv = loadLevel(rom, 0x105), probe = new ObjKindProbe(emu, lv, rom.r24(L2_PTRS + 0x105 * 3));
    probe.result();
    return fp.deps(probe.reads());
  };
  const a = readLevel(), ka = kindsDeps();
  const other = loadLevel(rom, 0x106);
  other.objects.push(obj(0x14, 3, 0x14, 0));
  saveLevel(rom, other);
  check(holds(rom, a.rec) && fp.valid(a.deps) && fp.valid(ka), 'another level saved: level 105 as read and the object kinds still hold');
  const pkg = inspectUpload('obj2d.asm', new TextEncoder().encode(HOOK.replace('|!addr', ''))) as ReadyPreview;
  const r = await installPackage(rom, pkg, { level: 0x105, blank, tileWords: (t) => src.fg(t), setup: false });
  check(r.ok && objectLength2D(rom) === 5, `package with the hook installed: 5 bytes (${objectLength2D(rom)})`);
  check(!holds(rom, a.rec) && !fp.valid(a.deps), 'level 105 as read before no longer holds');
  check(!fp.valid(ka), 'the object kinds learned before no longer hold');
  const b = readLevel(), kb = kindsDeps();
  await uninstallPackage(rom, r.pkg!.id, blank);
  check(objectLength2D(rom) === 3, `package removed: 3 bytes (${objectLength2D(rom)})`);
  check(!holds(rom, b.rec) && !fp.valid(b.deps), 'level 105 as read with the hook no longer holds');
  check(!fp.valid(kb), 'the object kinds learned with the hook no longer hold');
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

  // the bars' kinds (#149): no size (the 5th byte is entrance info), so listed as before (with both bytes 00)
  const t0 = performance.now();
  const { custom, drawsWith } = new ObjKindProbe(emu, lv, rom.r24(L2_PTRS + 0x105 * 3)).result();
  const sized = [...custom].filter(([, k]) => JSON.stringify(k) !== JSON.stringify(UNSIZED)).map(([c]) => c.toString(16));
  check(custom.size > 0 && !sized.length && [...drawsWith.values()].every((b) => b.join() === '0,0'), `the custom numbers' kinds: none sized (${custom.size} kinds, sized: ${sized.join(' ')}; ${Math.round(performance.now() - t0)} ms)`);

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
