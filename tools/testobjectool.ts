// ObjecTool's custom extended objects (98–FF, issue #104) and Lunar Magic's side files for objects (objtext.ts):
// names from .mw0t, tooltips from .osc, read from a package's upload and kept with its record. Extended objects
// that draw nothing are listed when their load changes RAM (thumbs.ts, objeffects.ts), with what it changed.
// With the Romhack Races baserom: 98–DF listed and named, E0–FF not; its sample level 13B's six such objects
// drawn as boxes; removing it takes the names; a newer package's names win, with a note.
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { loadApu } from '../src/core/apu.ts';
import { loadAsar } from '../src/core/asar.ts';
import { map16Source } from '../src/core/render.ts';
import { installEditorPatch } from '../src/core/patches.ts';
import { enableBlocks } from '../src/core/map16ext.ts';
import { inspectUpload, installPackage, removePackage, type ReadyPreview, type InstallOptions } from '../src/core/packages.ts';
import { listPackages } from '../src/core/pkgreg.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel } from '../src/core/level.ts';
import { objectName } from '../src/core/objectnames.ts';
import { parseMw0t, parseOsc, tipKey, objectTooltip } from '../src/core/objtext.ts';
import { renderObjectThumbs, type ObjThumb } from '../src/ui/thumbs.ts';
import { sampleLevel } from '../src/core/mwl.ts';
import { levelOverride } from '../src/core/levelusage.ts';
import { boxedObjects, boxLabel, boxAt } from '../src/core/objboxes.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };

// ---------- the side files ----------
{
  // .mw0t: an extended object's number, a tab, its name; lines without the number name a group of .mw0 (left out)
  const n = parseMw0t('98\tEnable Free Vertical Scroll\nA3\tDisable Score\r\nSome group\n\nzz\tnot a number\n');
  check([...n].map(([k, v]) => `${k.toString(16)}=${v}`).join('|') === '98=Enable Free Vertical Scroll|a3=Disable Score', `.mw0t: ${[...n].join('|')}`);

  // .osc: object, ExType, type, text (tabs or spaces); escapes; only the default appearance's text (type 0 with
  // X/Y or byte value 0); tileset-specific and the GFX information types left out; comments
  const o = parseOsc([
    ' 0  98  0   UberASM Object 98: Free Vertical Scroll\\n-----\\nMakes the camera follow Mario.',
    '0\tA2\t0\tA \\\\ B\\r\\bFF0000\\fFFFFFF red\\No escape',
    '2D\t41\t0\tA custom Retry midway point tape.',
    '10 0 0 A horizontal pipe object.',
    '0 2F 0000 Blue POW inside.',
    '0 2F 0100 Silver POW inside.',
    '15 0 20000 A midway point.',
    '15 0 20100 A goal point.',
    '17 0 21004 Clouds.',
    '3C 0 21 Here is a mushroom ledge!',
    '6 0 8 7F,7F,7F,15,7F,7F,7F,7F',
    '6 0 A 6 7 8',
    '; a comment',
    '',
  ].join('\n'));
  check(o.get(tipKey(0, 0x98)) === 'UberASM Object 98: Free Vertical Scroll\n-----\nMakes the camera follow Mario.', '.osc: extended object 98, \\n a new line');
  check(o.get(tipKey(0, 0xa2)) === 'A \\ B red\\No escape', `.osc: \\\\, colors dropped, unknown escapes kept (${o.get(tipKey(0, 0xa2))})`);
  check(o.get(tipKey(0x2d, 0x41)) === 'A custom Retry midway point tape.', '.osc: object 2D by its custom number');
  check(o.get(tipKey(0x10, 0)) === 'A horizontal pipe object.', '.osc: a standard object');
  check(o.get(tipKey(0, 0x2f)) === 'Blue POW inside.' && o.get(tipKey(0x15, 0)) === 'A midway point.', '.osc: X/Y and byte value variants: the default one');
  check(o.size === 6 && !o.has(tipKey(0x17, 0)) && !o.has(tipKey(0x3c, 0)) && !o.has(tipKey(6, 0)), `.osc: tileset-specific and GFX information left out (${[...o.keys()]})`);
}

// ---------- the Romhack Races baserom ----------
await loadAsar();
await loadApu();
const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const files = unzipSync(new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip')));
const keep: Record<string, Uint8Array> = {};
for (const [k, v] of Object.entries(files)) if (!/^(export\/|resources\/original_graphics\/|workspace\/Graphics\/)/.test(k)) keep[k] = v;
const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom); emu.boot();
const src = map16Source(rom, emu.load(0x105));
const blank = src.fg(0x025);
installEditorPatch(rom); enableBlocks(rom, blank);
const opt: InstallOptions = { level: 0x105, blank, tileWords: (t) => src.fg(t), setup: false };
const r = await installPackage(rom, inspectUpload('baserom.zip', zipSync(keep)) as ReadyPreview, opt);
check(r.ok && !!r.pkg?.objectText, `installed, with its object names and tooltips (${r.errors.join(' ')})`);
const name = (ext: number) => objectName(rom, 0, ext, null);

// the Extended list's objects (thumbs.ts): those that draw nothing are listed for what their load changes
const extended = (): ObjThumb[] => renderObjectThumbs(rom, emu, loadLevel(rom, 0x105), range(0x10, 0xff).map((e) => ({ num: 0, ext: e, size: 0 })), (s) => hx(s.ext));
{
  const t0 = Date.now();
  const thumbs = extended();
  const byKey = new Map(thumbs.map((t) => [t.key, t]));
  const listed = (ns: number[]) => ns.filter((n) => byKey.has(hx(n)));
  check(listed(range(0x98, 0xdf)).length === 72 && range(0x98, 0xdf).every((n) => byKey.get(hx(n))?.effect), `98–DF listed for what they do (${listed(range(0x98, 0xdf)).length}, ${Date.now() - t0} ms)`);
  check(!listed(range(0xe0, 0xff)).length, `E0–FF not listed (${listed(range(0xe0, 0xff)).map(hx)})`);
  // each sets its bit of ObjecTool's flags ($7FA400 on), some do more at once (UberASM's init)
  const flag = (n: number) => `$${(0x7fa400 + ((n - 0x98) >> 3)).toString(16).toUpperCase()} bit ${(n - 0x98) & 7}`;
  check(byKey.get('98')?.effect === `sets ${flag(0x98)}` && byKey.get('A4')?.effect === `sets ${flag(0xa4)}` && byKey.get('DF')?.effect === `sets ${flag(0xdf)}`,
    `what they change: 98 ${byKey.get('98')?.effect}; A4 ${byKey.get('A4')?.effect}; DF ${byKey.get('DF')?.effect}`);
  console.log(`     99: ${byKey.get('99')?.effect}; D0: ${byKey.get('D0')?.effect}`);
  check(byKey.size > 0x88 && thumbs.filter((t) => !t.effect).every((t) => t.w > 0), `the game's own extended objects drawn (${thumbs.filter((t) => !t.effect).length})`);
}

// names from RHRv5.mw0t, tooltips from RHRv5.osc
{
  const named = range(0x98, 0xdf).filter((n) => name(n) !== `Extended object ${hx(n)}`);
  check(named.length === 42 && name(0x98) === 'Enable Free Vertical Scroll' && name(0xb1) === 'Retry: Set Type to Prompt', `42 named from the .mw0t (98: ${name(0x98)}; B1: ${name(0xb1)})`);
  check(name(0xe0) === 'Extended object E0' && name(0x10) === 'Small door', 'the others keep their names');
  const tipped = named.filter((n) => objectTooltip(rom, 0, n));
  check(tipped.length === 42 && objectTooltip(rom, 0, 0x98)!.startsWith('UberASM Object 98: Free Vertical Scroll\n-----\n'), `each named one has its .osc tooltip (${tipped.length})`);
  check(!!objectTooltip(rom, 0x2d, 0x41)?.includes('Retry midway point tape'), 'object 2D 41: its .osc tooltip');
}

// the sample level 13B: its six objects that draw nothing are boxes, found and moved by their tile
{
  const lv = sampleLevel(rom, files['export/levels/level 13B.mwl'], loadLevel(rom, 0x13b), { tile: (t) => t, sprite: () => null }, true).level;
  const boxes = () => boxedObjects(lv.objects, emu.load(0x13b, levelOverride(rom, lv)).touched, (i) => i);
  const b = boxes();
  check(b.map(boxLabel).sort().join() === 'B1,B3,BA,BB,BC,D0', `13B: six boxes (${b.map((o) => `${boxLabel(o)}@${o.x},${o.y}`).join(' ')})`);
  const b1 = boxAt(b, 1, 1);
  check(b1?.ext === 0xb1 && boxAt(b, 3, 1) === null, 'B1 found at its tile');
  b1!.x = 3;
  const moved = boxes();
  check(boxAt(moved, 3, 1)?.ext === 0xb1 && !boxAt(moved, 1, 1) && moved.length === 6, 'moved: its box at its new tile');
}

// a newer package naming some of them: its names win, with a note; removed, the older one's are back
{
  const enc = new TextEncoder();
  const small = zipSync({
    'mine.asm': enc.encode('lorom\nfreedata\ndb $01\n'),
    'mine.mw0t': enc.encode('98\tMy scroll object\nB1\tRetry: Set Type to Prompt\nE0\tMy new object\n'),
    'mine.osc': enc.encode('0\t98\t0\tMy tooltip\n'),
  });
  const p = inspectUpload('mine.zip', small) as ReadyPreview;
  check(p.status === 'ready' && !p.unclaimed.length, `the small package: a patch and its side files (${p.status}, ${p.status === 'ready' ? p.unclaimed : ''})`);
  const r2 = await installPackage(rom, p, opt);
  const note = r2.warnings.find((w) => w.includes('replace'));
  check(r2.ok && note === 'Object names and tooltips of “mine” replace those of “baserom” for extended 98.', `installed with a note: ${note}`);
  check(name(0x98) === 'My scroll object' && objectTooltip(rom, 0, 0x98) === 'My tooltip' && name(0xe0) === 'My new object' && name(0xa0) === 'Press L & R To Die',
    `the newer names (98: ${name(0x98)}, E0: ${name(0xe0)}), the older ones elsewhere (A0: ${name(0xa0)})`);
  await removePackage(rom, r2.pkg!.id, blank);
  check(name(0x98) === 'Enable Free Vertical Scroll' && objectTooltip(rom, 0, 0x98)?.startsWith('UberASM Object 98') === true && name(0xe0) === 'Extended object E0', 'removed: the baserom\'s names again');
}

// the baserom removed: its names are gone; 98–DF stay listed, now as what the game's own code draws for them
// (door parts from $0DA6D1's table; #110 may hide those, then this check changes)
{
  const pkg = listPackages(rom).find((x) => x.name === 'baserom')!;
  await removePackage(rom, pkg.id, blank);
  check(!listPackages(rom).length && name(0x98) === 'Extended object 98' && !objectTooltip(rom, 0, 0x98), `removed: no names (98: ${name(0x98)})`);
  const byKey = new Map(extended().map((t) => [t.key, t]));
  check(range(0x98, 0xdf).every((n) => byKey.get(hx(n))?.w), 'listed by emulation: 98–DF draw tiles');
}

process.exit(fail ? 1 : 0);
