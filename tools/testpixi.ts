// Custom sprites (PIXI format): sprite entries with extra bytes (size table at $0EF30C) are parsed and
// written back, and level files carry the size table they were written with.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadLevel, parseSprites, serializeSprites, spriteSizes, SPR_SIZE_PTR, newUid, type LevelSprite } from '../src/core/level.ts';
import { exportLevelFile, importLevelFile } from '../src/core/levelfile.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { captureSprites } from '../src/core/spritegfx.ts';
import { loadAsar } from '../src/core/asar.ts';
import { ROUTINES } from '../src/core/pixiroutines.ts';
import { existsSync } from 'node:fs';
import { packageFiles, packageFromFiles } from '../src/core/patchpkg.ts';
import { planPixiPackage, applyPixiPackage } from '../src/core/pixipkg.ts';
import { savePixiProject, removePixi, loadPixiProject, parsePixiList, parseCfg, parseJsonCfg, type PixiProject } from '../src/core/pixi.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

const rom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));

// ---- level format with extra bytes
check(spriteSizes(rom) === null, 'vanilla ROM: no size table');
const sizes = new Uint8Array(0x400).fill(3);
sizes[0x200 + 0x10] = 4; // custom 10, extra bit clear: 1 byte
sizes[0x300 + 0x10] = 6; // custom 10, extra bit set: 3 bytes
const sprites: LevelSprite[] = [
  { uid: newUid(), num: 0x0f, x: 3, y: 5, extra: 0 },
  { uid: newUid(), num: 0x10, x: 7, y: 9, extra: 2, bytes: [0xaa] },
  { uid: newUid(), num: 0x10, x: 20, y: 18, extra: 3, bytes: [1, 2] }, // one byte short: padded with 0
  { uid: newUid(), num: 0x10, x: 33, y: 4, extra: 0, bytes: [9] }, // vanilla entry: bytes dropped
];
const data = serializeSprites(sprites, 0x00, false, sizes);
check(data.length === 1 + 3 + 4 + 6 + 3 + 1, `entry sizes from the table (${data.length} bytes)`);
const back = parseSprites(data, 0, false, sizes);
check(back.size === data.length, 'parsed size = data length');
check(back.sprites.length === 4 && same(back.sprites[1].bytes ?? [], [0xaa]) && same(back.sprites[2].bytes ?? [], [1, 2, 0]) && !back.sprites[3].bytes,
  'extra bytes read back (padded, none for vanilla)');
check(same(serializeSprites(back.sprites, 0x00, false, sizes), data), 'roundtrip identical');
check(parseSprites(data, 0, false, null).sprites.length !== 4, 'without the table the data reads differently (sanity)');

// ---- size table in the ROM and level files
const tbl = rom.allocWrite(sizes);
rom.w24(SPR_SIZE_PTR, tbl); rom.w8(SPR_SIZE_PTR + 3, 0x42);
check(same(spriteSizes(rom) ?? [], sizes), 'size table found via $0EF30C/$42');
const lv = loadLevel(rom, 0x105);
lv.sprites.push(...sprites.slice(1, 3).map((s) => ({ ...s, uid: newUid() })));
const file = exportLevelFile(rom, lv);
check(JSON.parse(file).spriteSizes?.length === 0x800, 'level file carries the size table');
const plain = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
const imp = importLevelFile(plain, file, loadLevel(plain, 0x105)).level;
const custom = imp.sprites.filter((s) => s.extra >= 2);
check(imp.sprites.length === lv.sprites.length && custom.length === 2 && same(custom[0].bytes ?? [], [0xaa]),
  'level file imported into a ROM without the table keeps sprites and bytes');

// ---- cfg / json
const cfg = parseCfg('01\n36\n00 00 3B 80 00 00\n12 34\nmarker.asm\n01:03\n', 'sprites/marker.cfg');
check(cfg.type === 1 && cfg.actlike === 0x36 && cfg.tweak[2] === 0x3b && cfg.tweak[3] === 0x80 && cfg.prop[0] === 0x12 && cfg.asm === 'sprites/marker.asm' && cfg.bytes === 1 && cfg.bytesExtra === 3, 'cfg parsed');
const old = parseCfg('01\n36\n00 00 3B 80 00 00\n00 00\nmarker.asm\n2\n', 'sprites/old.cfg');
check(old.bytes === 0 && old.bytesExtra === 0, 'old cfg (assembler byte): no extra bytes');
const js = parseJsonCfg(JSON.stringify({ $1656: { 'Object Clipping': 3, 'Can be jumped on': true }, $166E: { Palette: 4, 'Use second graphics page': true }, AsmFile: 'x.asm', ActLike: 28, Type: 1,
  'Extra Property Byte 1': 5, 'Extra Property Byte 2': 0, 'Additional Byte Count (extra bit clear)': 1, 'Additional Byte Count (extra bit set)': 2,
  Collection: [{ Name: 'Brutal Bill', ExtraBit: false }], Displays: [{ Description: 'A Brutal Bill.\\n\nhoming' }] }), 'sprites/b.json');
check(js.tweak[0] === 0x13 && js.tweak[2] === 0x09 && js.actlike === 28 && js.bytes === 1 && js.bytesExtra === 2 && js.names[0].name === 'Brutal Bill' && js.asm === 'sprites/x.asm', 'json parsed (tweaker bits, collection)');

// ---- a custom sprite running in the game
// INIT: marker $7FB000 = $11, MAIN: counts $7FB001, copies extra byte 1 to $7FB002 and draws one tile
const marker = `print "INIT ",pc
  LDA #$11 : STA $7FB000
  RTL
print "MAIN ",pc
  PHB : PHK : PLB
  LDA $7FB001 : INC : STA $7FB001
  LDA !extra_byte_1,x : STA $7FB002
  LDA !new_sprite_num,x : STA $7FB003
  LDA !9E,x : STA $7FB004
  JSR Gfx
  PLB
  RTL
Gfx:
  %GetDrawInfo()
  LDA $00 : STA $0300|!addr,y
  LDA $01 : STA $0301|!addr,y
  LDA #$8C : STA $0302|!addr,y
  LDA #$21 : STA $0303|!addr,y
  TYA : LSR #2 : TAY
  LDA #$02 : STA $0460|!addr,y
  RTS
`;
const project: PixiProject = {
  files: new Map(Object.entries({
    'sprites/marker.cfg': '01\n36\n00 00 3B 80 00 00\n12 34\nmarker.asm\n01:03\n',
    'sprites/marker.asm': marker,
    'sprites/kill.cfg': '01\n36\n00 00 3B 80 00 00\n00 00\nkill.asm\n03:03\n', // erases itself in INIT
    'sprites/kill.asm': 'print "INIT ",pc\n  STZ !14C8,x\n  RTL\nprint "MAIN ",pc\n  RTL\n',
  }).map(([k, v]) => [k, new TextEncoder().encode(v)])),
  list: parsePixiList('10 marker.cfg\n11 kill.cfg\n'),
};
const prom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
const res = savePixiProject(prom, project);
if (!res.ok) console.log(res.errors.join('\n'));
check(res.ok, 'project assembled and applied');
const psz = spriteSizes(prom);
check(!!psz && psz[0x210] === 4 && psz[0x310] === 6 && psz[0x010] === 3, 'size table installed at $0EF30C');
check(loadPixiProject(prom)?.list.length === 2, 'project stored in the ROM');
const pemu = new LevelEmulator(prom); pemu.boot();
const plv = loadLevel(prom, 0x105);
const W = (a: number) => pemu.snes.wram[a - 0x7e0000];
const runWith = (spr: LevelSprite[]) => {
  plv.sprites = spr;
  const r = pemu.load(0x105, { sprites: serializeSprites(plv.sprites, plv.spriteHeader, false, spriteSizes(prom)) });
  for (let i = 0; i < 40; i++) pemu.snes.runFrame(); // past the fade-in
  return r;
};
const ld = runWith([{ uid: newUid(), num: 0x10, x: 6, y: 0x16, extra: 2, bytes: [0x5a] }]);
check(ld.ok, 'level with the custom sprite loads');
check(W(0x7fb000) === 0x11, 'INIT ran');
check(W(0x7fb001) > 10, `MAIN runs (${W(0x7fb001)} frames)`);
check(W(0x7fb002) === 0x5a && W(0x7fb003) === 0x10 && W(0x7fb004) === 0x36, 'extra byte, custom number and acts like seen by MAIN');

// images of custom sprites, captured like the original ones (sprite ids $2xx/$3xx)
{
  const img = captureSprites(pemu, 0x105, plv.header, plv.spriteHeader, plv.layer2Pointer >> 16 === 0xff ? plv.layer2Pointer : 0xffd900, [0x00, 0x210, 0x310]);
  check(img.has(0x00) && img.has(0x210) && img.has(0x310), `images of custom sprites captured (${[...img.keys()].map((k) => k.toString(16)).join(' ')})`);
  const one = img.get(0x210);
  check(!!one && one.w === 16 && one.h === 16 && one.ox === 0 && one.oy === 0, 'custom sprite image: its 16x16 tile at the sprite');
}

// many sprites with extra bytes: each frame the loader scans the sprite data from the start for the
// column entering the screen; once Mario has run right, the sprite behind 30 entries of 6 bytes
// (which erase themselves) is found past byte $80, the loader having moved its pointer
const many: LevelSprite[] = [];
for (let i = 0; i < 30; i++) many.push({ uid: newUid(), num: 0x11, x: 1 + (i >> 1), y: 0x10 + (i & 1), extra: 2, bytes: [i, 0, 0] });
many.push({ uid: newUid(), num: 0x10, x: 40, y: 0x16, extra: 2, bytes: [0x77] });
pemu.snes.wram.fill(0, 0x1b000, 0x1b010);
runWith(many);
check(W(0x7fb000) === 0, 'sprite behind the screen not loaded yet');
for (let i = 0; i < 300 && !W(0x7fb000); i++) { pemu.snes.joy1 = 0x4100; pemu.snes.runFrame(); } // run right
pemu.snes.joy1 = 0;
for (let i = 0; i < 4; i++) pemu.snes.runFrame();
check(W(0x7fb000) === 0x11 && W(0x7fb002) === 0x77, 'a sprite past byte $80 of the sprite data loads with its extra byte');
// vanilla sprites still work next to custom ones
const vrom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
const vemu = new LevelEmulator(vrom); vemu.boot();
const vlv = loadLevel(vrom, 0x105);
const a = vemu.load(0x105, { sprites: serializeSprites(vlv.sprites, vlv.spriteHeader, false) });
for (let i = 0; i < 60; i++) vemu.snes.runFrame();
plv.sprites = vlv.sprites;
const b2 = pemu.load(0x105, { sprites: serializeSprites(plv.sprites, plv.spriteHeader, false, spriteSizes(prom)) });
for (let i = 0; i < 60; i++) pemu.snes.runFrame();
const live = (w: Uint8Array) => Array.from({ length: 12 }, (_, i) => [0x14c8, 0x9e, 0xe4, 0xd8, 0x14e0, 0x14d4, 0x161a].map((t) => w[t + i]).join(':')).join(' ') + ' ' + Array.from(w.subarray(0x1938, 0x1938 + 0x40)).join('');
check(a.ok && b2.ok && live(vemu.snes.wram) === live(pemu.snes.wram), 'vanilla level 105 runs the same with the runtime installed');

// math routines computed in the game: CircleX/Y/XY, Aiming, Random
{
  const math = `print "INIT ",pc
  RTL
print "MAIN ",pc
  LDA $7FB0FF : BEQ + : RTL
+ LDA #$01 : STA $7FB0FF
  ; CircleX/CircleY: angle $040 (45°), radius $40 → $7FB010/$7FB012
  REP #$20 : LDA #$0040 : STA $04 : SEP #$20 : LDA #$40 : STA $06
  %CircleX() : REP #$20 : LDA $07 : STA $7FB010 : SEP #$20
  %CircleY() : REP #$20 : LDA $09 : STA $7FB012 : SEP #$20
  ; CircleXY: angle $180 (270°), radius $30 → $7FB014/$7FB016
  LDA #$80 : SEC : LDY #$30 : %CircleXY()
  REP #$20 : LDA $07 : STA $7FB014 : LDA $09 : STA $7FB016 : SEP #$20
  ; Aiming: shooter 30 px right of and 40 px below the target, speed $20 → $7FB018/$7FB019
  REP #$20 : LDA #$001E : STA $00 : LDA #$0028 : STA $02 : SEP #$20
  LDA #$20 : %Aiming()
  LDA $00 : STA $7FB018 : LDA $02 : STA $7FB019
  ; Random: 64 numbers 0-5, largest → $7FB01A
  LDA #$00 : STA $7FB01A
  LDY #$40
- LDA #$05 : %Random() : CMP $7FB01A : BCC + : STA $7FB01A
+ DEY : BNE -
  RTL
`;
  const r3 = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
  const res3 = savePixiProject(r3, { files: new Map([
    ['sprites/math.cfg', new TextEncoder().encode('01\n36\n00 00 3B 80 00 00\n00 00\nmath.asm\n00:00\n')],
    ['sprites/math.asm', new TextEncoder().encode(math)],
  ]), list: parsePixiList('00 math.cfg\n') });
  if (!res3.ok) console.log(res3.errors.join('\n'));
  const e3 = new LevelEmulator(r3); e3.boot();
  const l3 = loadLevel(r3, 0x105);
  l3.sprites = [{ uid: newUid(), num: 0x00, x: 6, y: 0x16, extra: 2 }];
  e3.load(0x105, { sprites: serializeSprites(l3.sprites, l3.spriteHeader, false, spriteSizes(r3)) });
  for (let i = 0; i < 40; i++) e3.snes.runFrame();
  const w3 = (a: number) => e3.snes.wram[a - 0x7e0000];
  const s16 = (a: number) => { const v = w3(a) | (w3(a + 1) << 8); return v >= 0x8000 ? v - 0x10000 : v; };
  const s8 = (a: number) => (w3(a) >= 0x80 ? w3(a) - 0x100 : w3(a));
  check(res3.ok && w3(0x7fb0ff) === 1, 'math sprite ran');
  check(Math.abs(s16(0x7fb010) - 45) <= 1 && Math.abs(s16(0x7fb012) - 45) <= 1, `CircleX/Y at 45°, radius 64: ${s16(0x7fb010)}, ${s16(0x7fb012)} (≈45)`);
  check(s16(0x7fb014) === 0 && s16(0x7fb016) === -48, `CircleXY at 270°, radius 48: ${s16(0x7fb014)}, ${s16(0x7fb016)} (0, -48)`);
  check(Math.abs(s8(0x7fb018) + 19) <= 1 && Math.abs(s8(0x7fb019) + 26) <= 1, `Aiming towards the target: ${s8(0x7fb018)}, ${s8(0x7fb019)} (≈-19, -26)`);
  check(w3(0x7fb01a) === 5, `Random 0-5 reaches 5 and no more (${w3(0x7fb01a)})`);
}

// every built-in routine assembles (called from code that never runs)
{
  const all = Object.keys(ROUTINES).filter((n) => !n.startsWith('Pixi'));
  const r2 = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
  const res2 = savePixiProject(r2, { files: new Map([
    ['sprites/all.cfg', new TextEncoder().encode('01\n36\n00 00 3B 80 00 00\n00 00\nall.asm\n00:00\n')],
    ['sprites/all.asm', new TextEncoder().encode('print "INIT ",pc\nprint "MAIN ",pc\n  RTL\n' + all.map((n) => `  %${n}()`).join('\n') + '\n')],
  ]), list: parsePixiList('00 all.cfg\n') });
  if (!res2.ok) console.log(res2.errors.slice(0, 20).join('\n'));
  check(res2.ok, `all ${all.length} shared routines assemble`);
}

// a downloaded package (resources_local, not in the repository): numbers, linked defines, applied
if (existsSync('resources_local/BrutalBill.zip')) {
  const r4 = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
  const pkg = packageFromFiles('BrutalBill.zip', packageFiles('BrutalBill.zip', new Uint8Array(readFileSync('resources_local/BrutalBill.zip'))));
  const plan = planPixiPackage(r4, pkg);
  const desc = plan.sprites.map((q) => `${q.kind}:${q.num.toString(16)}`).sort().join(' ');
  check(desc === 'shooters:c0 sprites:0', `BrutalBill: sprite 00 and shooter C0 (${desc})`);
  const link = plan.links.find((l) => l.define === 'Sprite');
  check(!!link && plan.sprites[link.sprite].kind === 'sprites', 'BrutalBill: the shooter\'s !Sprite names the sprite');
  const res4 = applyPixiPackage(r4, pkg, plan, [0, 0, 0, 0], () => [0, 0, 0, 0]);
  if (!res4.ok) console.log(res4.errors.join('\n'));
  check(res4.ok, 'BrutalBill applied');
  const shooter = new TextDecoder().decode(loadPixiProject(r4)?.files.get('shooters/BrutalBillShooter.asm'));
  check(/^!Sprite\s*=\s*\$00/m.test(shooter), 'BrutalBill: the shooter spawns sprite $00');
}

// custom shooters and generators: MAIN runs every frame, the shooter with its extra byte
{
  const enc2 = new TextEncoder();
  const r5 = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
  const res5 = savePixiProject(r5, { files: new Map([
    ['shooters/s.cfg', enc2.encode('01\n00\n00 00 00 00 00 00\n00 00\ns.asm\n01:01\n')],
    ['shooters/s.asm', enc2.encode('print "MAIN ",pc\n  LDA $7FB020 : INC : STA $7FB020\n  LDA !shooter_extra_byte_1,x : STA $7FB021\n  LDA !shoot_num,x : STA $7FB023\n  RTL\n')],
    ['generators/g.cfg', enc2.encode('01\n00\n00 00 00 00 00 00\n00 00\ng.asm\n00:00\n')],
    ['generators/g.asm', enc2.encode('print "MAIN ",pc\n  LDA $7FB022 : INC : STA $7FB022\n  RTL\n')],
  ]), list: parsePixiList('C0 s.cfg\nD0 g.cfg\n') });
  if (!res5.ok) console.log(res5.errors.join('\n'));
  check(res5.ok, 'shooter and generator assembled');
  const e5 = new LevelEmulator(r5); e5.boot();
  const l5 = loadLevel(r5, 0x105);
  l5.sprites = [{ uid: newUid(), num: 0xc0, x: 8, y: 0x16, extra: 3, bytes: [0x42] }, { uid: newUid(), num: 0xd0, x: 9, y: 0x16, extra: 2 }];
  e5.load(0x105, { sprites: serializeSprites(l5.sprites, l5.spriteHeader, false, spriteSizes(r5)) });
  for (let i = 0; i < 40; i++) e5.snes.runFrame();
  const w5 = (a: number) => e5.snes.wram[a - 0x7e0000];
  check(w5(0x7fb020) > 10 && w5(0x7fb021) === 0x42 && w5(0x7fb023) === 0xc1, `custom shooter runs with its extra byte and extra bit (${w5(0x7fb020)} frames, byte ${w5(0x7fb021).toString(16)}, num ${w5(0x7fb023).toString(16)})`);
  check(w5(0x7fb022) > 10, `custom generator runs (${w5(0x7fb022)} frames)`);
}
if (existsSync('resources_local/BrutalBill.zip')) {
  const r6 = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
  const pkg = packageFromFiles('BrutalBill.zip', packageFiles('BrutalBill.zip', new Uint8Array(readFileSync('resources_local/BrutalBill.zip'))));
  const res6 = applyPixiPackage(r6, pkg, planPixiPackage(r6, pkg), [0, 0, 0, 0], () => [0, 0, 0, 0]);
  const e6 = new LevelEmulator(r6); e6.boot();
  const l6 = loadLevel(r6, 0x105);
  l6.sprites = [{ uid: newUid(), num: 0xc0, x: 12, y: 0x17, extra: 2, bytes: [0x02] }];
  e6.load(0x105, { sprites: serializeSprites(l6.sprites, l6.spriteHeader, false, spriteSizes(r6)) });
  let bill = -1;
  for (let i = 0; i < 400 && bill < 0; i++) {
    e6.snes.runFrame();
    const w = e6.snes.wram;
    for (let k = 0; k < 12; k++) if (w[0x14c8 + k] >= 8 && (w[0x1ab10 + k] & 8) && w[0x1ab9e + k] === 0) bill = k;
  }
  check(res6.ok && bill >= 0, 'BrutalBill: the shooter fires a Brutal Bill (custom sprite 00)');
  if (bill >= 0) {
    const w = e6.snes.wram, x0 = w[0xe4 + bill] | (w[0x14e0 + bill] << 8);
    for (let i = 0; i < 30; i++) e6.snes.runFrame();
    const x1 = w[0xe4 + bill] | (w[0x14e0 + bill] << 8);
    check(w[0x14c8 + bill] === 8 && x1 !== x0, `BrutalBill: the bill flies (x ${x0.toString(16)} → ${x1.toString(16)})`);
  }
}

// removing restores the ROM
const w = removePixi(prom);
check(w.length === 0 && spriteSizes(prom) === null, 'removed: no size table');
const orig = new Uint8Array(readFileSync('Super Mario World (U) [!].smc'));
let diff = 0;
for (let i = 0; i < Math.min(orig.length - 512, prom.data.length); i++) if (prom.data[i] !== orig[i + 512] && i !== 0x7fd7) diff++; // ROM size: stays expanded
check(diff === 0, `removed: ROM as before (${diff} bytes differ)`);

console.log(bad ? `${bad} FAILED` : 'all ok');
if (bad) process.exit(1);
