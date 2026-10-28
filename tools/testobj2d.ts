// Object 2D (Lunar Magic's "user defined" object, obj2d.ts): its length is found by emulation – 3 bytes in the
// clean game, 5 with a hook at $0DA415 that reads two more (ObjecTool, the Retry System's custom midway bars).
// With 5 bytes its two extra bytes (the extension) are parsed, written, kept by level files and Lunar Magic's
// level files; without, 2D stays a 3-byte object.
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { applyPatch } from '../src/core/patchapply.ts';
import { parseObjects, serializeObjects, newUid, loadLevel, type LevelObject } from '../src/core/level.ts';
import { objectLength2D, fitExtension } from '../src/core/obj2d.ts';
import { saveLevel } from '../src/core/save.ts';
import { parseLmObjects } from '../src/core/mwl.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
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

// an object given the extension the ROM reads: 2D with a hook keeps its bytes (missing ones 0), others have none
{
  const a = obj(0x2d, 0, 0, 0); fitExtension(a, 5);
  const b = obj(0x2d, 0, 0, 0, [9, 8, 7]); fitExtension(b, 5);
  const c = obj(0x2d, 0, 0, 0, [9, 8]); fitExtension(c, 3);
  const d = obj(0x14, 0, 0, 0, [9, 8]); fitExtension(d, 5);
  check(a.extension?.join() === '0,0' && b.extension?.join() === '9,8' && !('extension' in c) && !('extension' in d), 'extension fitted to the object and the ROM');
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

process.exit(fail ? 1 : 0);
