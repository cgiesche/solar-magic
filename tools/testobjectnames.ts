// Object names (objectnames.ts): built-in names for the game's own objects only – standard 01–21, the
// tileset-specific 2E–3F per object table (learned by emulation: which table the object loader reads for a
// tileset), extended 00, 01, 10–97 –, "Object XX" / "Extended object XX" for the free numbers, and the user's
// names over them per project (editor data, usernames.ts).
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { TILESETS } from '../src/core/tilesets.ts';
import { objectTable, builtinObjectName, objectName, setObjectName, objectNameKey } from '../src/core/objectnames.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hex = (n: number) => n.toString(16).toUpperCase();
const key = (num: number, ext: number, table: number | null) => { const k = objectNameKey(num, ext, table); if (k === null) throw new Error('no key'); return k; };

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom); emu.boot();
const tables = Array.from({ length: TILESETS }, (_, ts) => objectTable(emu, ts).result);

// the five object tables of the clean game ($0DA415's), found by emulation
{
  const groups = new Map<number, number[]>();
  for (let ts = 0; ts < 0xf; ts++) { const t = tables[ts]; if (t !== null) groups.set(t, [...groups.get(t) ?? [], ts]); }
  const got = [...groups].map(([t, ts]) => `${hex(t).padStart(6, '0')}:${ts.map(hex).join(',')}`).sort().join(' ');
  check(got === '0DA455:0,7,C 0DC19A:1 0DCD9A:2,6,8 0DD99A:3,9,A,B,E 0DE89A:4,5,D', `object tables per tileset ${got}`);
}

// built-in names: the game's own numbers only
{
  const t0 = tables[0], t1 = tables[1], t2 = tables[2], t3 = tables[3], t5 = tables[5];
  check(builtinObjectName(0x05, 0, t0) === 'Coins' && builtinObjectName(0x21, 0, t3) === 'Long ground ledge', 'standard 01–21, the same in every tileset');
  check([0x22, 0x26, 0x2a, 0x2d].every((n) => builtinObjectName(n, 0, t0) === null), 'standard 22–2D (free) have none');
  check(objectName(rom, 0x22, 0, t0) === 'Object 22' && objectName(rom, 0x2d, 0, t5) === 'Object 2D', '… they are "Object XX", not tileset objects');
  check(builtinObjectName(0x33, 0, t0) === 'Forest tree top' && builtinObjectName(0x3c, 0, t2) === 'Mushroom ledge top', '2E–3F by the tileset\'s object table');
  check(builtinObjectName(0x3c, 0, t0) !== builtinObjectName(0x3c, 0, t2), '… one number, other objects in other tables');
  check(builtinObjectName(0x2e, 0, t1) === null && objectName(rom, 0x2e, 0, t1) === 'Object 2E', '… none where the table leaves it unused');
  check(builtinObjectName(0x2e, 0, t5) === 'Thin upward spikes', '… the ghost house table uses all of them');
  check(builtinObjectName(0x30, 0, null) === null, '… none without a known table');
  const ext = Array.from({ length: 0x88 }, (_, i) => builtinObjectName(0, 0x10 + i, null));
  check(ext.every((n) => !!n), 'extended 10–97 all have one');
  check(builtinObjectName(0, 0x18, null) === '3-Up moon' && builtinObjectName(0, 0x41, null) === 'Yoshi coin', '… e.g. 18 the moon, 41 the Yoshi coin');
  check(builtinObjectName(0, 0x00, null) === 'Screen exit' && builtinObjectName(0, 0x01, null) === 'Screen jump', 'extended 00 and 01');
  check([0x02, 0x03, 0x06, 0x0f, 0x98, 0xff].every((e) => builtinObjectName(0, e, null) === null), 'extended 02–0F and 98–FF (free) have none');
  check(objectName(rom, 0, 0x98, null) === 'Extended object 98', '… they are "Extended object XX"');
  check(objectName(rom, 0, 0x04, null) === 'Prefab' && objectName(rom, 0, 0x05, null) === 'Direct Map16 (editor patch)', 'the editor\'s own 04 and 05');
}

// the user's names: any object, per project, over the built-in one
{
  const r = new Rom(rom.data.slice());
  const t0 = tables[0], t2 = tables[2];
  setObjectName(r, key(0x05, 0, t0), 'Gold rings');
  check(objectName(r, 0x05, 0, t0) === 'Gold rings' && objectName(r, 0x05, 0, t2) === 'Gold rings', 'a standard object renamed, in every tileset');
  setObjectName(r, key(0x2d, 0, t0), '  My custom thing ');
  check(objectName(r, 0x2d, 0, t0) === 'My custom thing', 'a free number named (trimmed)');
  setObjectName(r, key(0x3c, 0, t2), 'Big mushroom');
  check(objectName(r, 0x3c, 0, t2) === 'Big mushroom' && objectName(r, 0x3c, 0, t0) === 'Arch ledge', '2E–3F per object table');
  setObjectName(r, key(0, 0x18, t0), 'Star moon');
  check(objectName(r, 0, 0x18, t2) === 'Star moon' && objectName(r, 0x18, 0, t0) === 'Water surface (animated)', 'an extended object renamed, apart from the standard one of its number');
  check(objectNameKey(0x3c, 0, null) === null && objectName(r, 0x3c, 0, null) === 'Object 3C', '2E–3F without a known table: no name of the user (it would be shared by all such tilesets)');
  check(objectNameKey(0, 0x18, t0) === objectNameKey(0, 0x18, t2) && objectNameKey(0x13, 0, t0) === objectNameKey(0x13, 0, t2), 'only 2E–3F depend on the table');
  setObjectName(r, key(0x05, 0, t0), '');
  check(objectName(r, 0x05, 0, t0) === 'Coins', 'an empty name resets to the built-in one');
  setObjectName(r, key(0x2d, 0, t0), ' ');
  check(objectName(r, 0x2d, 0, t0) === 'Object 2D', '… or to "Object XX"');

  const back = Rom.fromFile(r.outputProject(false));
  check(objectName(back, 0x3c, 0, t2) === 'Big mushroom' && objectName(back, 0, 0x18, t0) === 'Star moon', 'names survive the project file');
  check(objectName(Rom.fromFile(r.output(false)), 0x3c, 0, t2) === 'Mushroom ledge top', 'a plain ROM has none');

  const s = new RomEditSession(r);
  s.edit('Rename', () => setObjectName(r, key(0, 0x41, null), 'Big coin'));
  check(objectName(r, 0, 0x41, null) === 'Big coin', 'renamed in an edit');
  s.undo();
  check(objectName(r, 0, 0x41, null) === 'Yoshi coin', 'undo restores it');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
