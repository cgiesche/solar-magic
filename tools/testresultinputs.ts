// Inputs of emulated results (inputs.ts): what a result learned from the level as edited depends on outside
// the ROM bytes it read changes it, so it is part of the result's input (or key) – an unsaved edit or a view
// setting learns it again instead of reusing what another state of the level gave.
import { LevelEmulator, type LevelOverride } from '../src/core/levelemu.ts';
import { loadLevel, serializeLayer1, serializeSprites, encodeSecondaryHeader, isL1Vertical, type Level } from '../src/core/level.ts';
import { layer2MotionsJob } from '../src/core/l2scroll.ts';
import { layer3Kinds } from '../src/core/layer3.ts';
import { levelScanJob, scanKey } from '../src/core/levelscan.ts';
import { cameraAtKey } from '../src/core/camerareach.ts';
import { emptyTriggerView } from '../src/core/extrigger.ts';
import { assignSlot, levelSlots, layerSlots } from '../src/core/gfxslots.ts';
import { gfxSkipMask } from '../src/core/gfxpages.ts';
import { gfxEntry } from '../src/core/patches.ts';
import { lz2Decompress } from '../src/core/lz2.ts';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { ResultLearner } from '../src/core/learner.ts';
import { inputHash, levelInput } from '../src/core/inputs.ts';
import { renderObjectThumbs, thumbsKey, thumbsInput, objKey, type ObjSpec } from '../src/ui/thumbs.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom); emu.boot();
const results = new ResultCache(new RomFingerprint(rom));
const steps: (() => void)[] = [];
const learner = new ResultLearner({
  rom, results, cacheReady: Promise.resolve(), main: emu,
  later: (_key, step) => steps.push(step), soon: (step) => steps.push(step), setBusy: () => {},
});
const drain = async () => { for (let i = 0; i < 1000; i++) { await new Promise((r) => setTimeout(r, 0)); while (steps.length) steps.shift()!(); } };
const ovOf = (lv: Level): LevelOverride => ({ layer1: serializeLayer1(rom, lv), secondaryHeader: encodeSecondaryHeader(lv.secondary), layer2Pointer: lv.layer2Pointer });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// layer 2 motions (App.layer2Motions): an unsaved entrance action changes what the scroll settings do
{
  const N = 0x105, lv = loadLevel(rom, N), edited = structuredClone(lv);
  edited.secondary.entranceAction = 1;
  const learned: unknown[] = [];
  for (const l of [lv, edited]) {
    const ov = ovOf(l);
    learner.learn(`l2m2:${N}`, function* (e) { return (yield* layer2MotionsJob(e, N, ov)).result; }, { input: levelInput(N, ov), done: (r) => learned.push(r) });
    await drain();
  }
  check(learned.length === 2 && !same(learned[0], learned[1]), 'layer 2 motions: an unsaved edit changes them, learned again for the edited level');
}

// layer 3 kinds (App.layer3Kinds): an unsaved level mode changes what the layer 3 settings do in a tileset
{
  const N = 0x01f, lv = loadLevel(rom, N), edited = structuredClone(lv);
  edited.header.mode = 1;
  const kinds = [lv, edited].map((l) => { const ov = ovOf(l); return learner.now(`l3k2:${l.header.tileset}`, (e) => e.tracked(() => layer3Kinds(e, N, ov)), { input: levelInput(N, ov) }).join(); });
  check(kinds[0] !== kinds[1], `layer 3 kinds: an unsaved mode changes them (${kinds[0]} / ${kinds[1]})`);
}

// object thumbnails (thumbs.ts): the level number (its graphics slots) and the content of the graphics files
// change them; the BG (layer 2 pointer) doesn't (they are layer 1)
{
  const r = new Rom(await editorImage()), e = new LevelEmulator(r);
  e.skipMask = () => gfxSkipMask(r); // as the editor: graphics data isn't among the bytes read
  e.boot();
  const lv = loadLevel(r, 0x105), other = { ...structuredClone(lv), number: 0x106 };
  const specs: ObjSpec[] = Array.from({ length: 16 }, (_, i) => ({ num: 0, ext: 0x40 + i, size: 0 }));
  const keyOf = (s: ObjSpec) => objKey(s, null);
  const thumbs = (l: Level) => JSON.stringify(renderObjectThumbs(r, e, l, specs, keyOf).map((t) => [t.key, inputHash(t.px)]));
  assignSlot(r, 0x106, 'FG1', 0x17);
  const a = thumbs(lv), b = thumbs(other);
  check(a !== b && thumbsKey(lv, specs, keyOf) === thumbsKey(other, specs, keyOf), 'thumbnails: another level with the same header looks different (its graphics slots)');
  check(inputHash(thumbsInput(r, lv)) !== inputHash(thumbsInput(r, other)), 'thumbnails: the level number is in their input');
  const fg1 = layerSlots(levelSlots(r, lv.number, lv.header))[0].file, before = inputHash(thumbsInput(r, lv));
  const fp = new RomFingerprint(r), deps = fp.deps(e.tracked(() => thumbs(lv)).reads);
  // a pixel drawn in FG1: a literal byte of its (LZ2) data changed, as drawing in place does
  const at = snesToPc(gfxEntry(r, fg1)!.addr), old = lz2Decompress(r.data, at).data;
  const flip = (o: number) => { r.data[o] ^= 0x10; r.gen++; };
  const differs = () => { try { const now = lz2Decompress(r.data, at).data; return now.length === old.length && now.some((v, i) => v !== old[i]); } catch { return false; } };
  for (let o = ((at >> 8) + 2) << 8; ; o++) { // (inside the file: a page shared with other data is read)
    flip(o);
    if (differs() && thumbs(lv) !== a) break;
    flip(o);
  }
  check(fp.valid(deps), 'thumbnails: an edited graphics file changes them, not seen by the bytes read');
  check(inputHash(thumbsInput(r, lv)) !== before, 'thumbnails: the graphics files\' content is in their input');
  const bg = { ...structuredClone(lv), layer2Pointer: loadLevel(r, 0x106).layer2Pointer };
  check(thumbs(bg) === thumbs(lv), 'thumbnails: the BG doesn\'t change them (not a gap)');
}

// level scan and the camera at Mario (levelDataKey): an ExAnimation trigger of the view changes the scan
{
  const N = 0x106, lv = loadLevel(rom, N), vertical = isL1Vertical(rom, lv.header.mode);
  const scan = (ov: LevelOverride) => {
    const job = levelScanJob(emu, { number: N, vertical, ov, width: lv.header.screens * 256, height: 27 * 16 });
    for (;;) { const r = job.next(); if (r.done) return r.value; }
  };
  const ov = { ...ovOf(lv), sprites: serializeSprites(lv.sprites, lv.spriteHeader, vertical), exTriggers: emptyTriggerView() };
  const silver = emptyTriggerView(); silver.game.add(0x02);
  const on = { ...ov, exTriggers: silver };
  check(!same(scan(ov), scan(on)), 'level scan: a silver P-switch trigger in the view changes it');
  check(scanKey(N, ov) !== scanKey(N, on), 'level scan: the view\'s triggers are in its key');
  check(cameraAtKey(N, ov, 0x40, 0x100) !== cameraAtKey(N, on, 0x40, 0x100), 'camera at Mario: the view\'s triggers are in its key');
}

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all ok');
