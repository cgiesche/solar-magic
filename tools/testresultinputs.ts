// Inputs of emulated results (inputs.ts): what a result learned from the level as edited depends on outside
// the ROM bytes it read changes it, so it is part of the result's input (or key) – an unsaved edit or a view
// setting learns it again instead of reusing what another state of the level gave.
import { LevelEmulator, type LevelOverride } from '../src/core/levelemu.ts';
import { loadLevel, serializeLayer1, serializeSprites, encodeSecondaryHeader, isL1Vertical, SPRITE_MEMORY, type Level } from '../src/core/level.ts';
import { layer2MotionsJob } from '../src/core/l2scroll.ts';
import { layer3Kinds } from '../src/core/layer3.ts';
import { levelScanJob, scanKey } from '../src/core/levelscan.ts';
import { cameraAtKey } from '../src/core/camerareach.ts';
import { emptyTriggerView } from '../src/core/extrigger.ts';
import { assignSlot, levelSlots, layerSlots } from '../src/core/gfxslots.ts';
import { gfxSkipMask } from '../src/core/gfxpages.ts';
import { gfxEntry, GFX_FILES } from '../src/core/patches.ts';
import { lz2Decompress } from '../src/core/lz2.ts';
import { readGfx, writeGfx } from '../src/core/gfxfiles.ts';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { ResultCache, RomFingerprint, RomReads, INPUTS_PER_KEY, oldStoreKeys, type CacheEntry } from '../src/core/romdeps.ts';
import { ResultLearner } from '../src/core/learner.ts';
import { inputHash, levelInput } from '../src/core/inputs.ts';
import { captureSprites } from '../src/core/spritegfx.ts';
import { renderObjectThumbs, thumbsKey, thumbsInput, previewInput, objKey, type ObjSpec } from '../src/ui/thumbs.ts';
import { layerGeom, renderLayerTiles } from '../src/core/render.ts';
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
const ovOf = (lv: Level, r = rom): LevelOverride => ({ layer1: serializeLayer1(r, lv), secondaryHeader: encodeSecondaryHeader(lv.secondary), layer2Pointer: lv.layer2Pointer });
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

// placement preview (App.objectsPreview): drawn by the level's load with the placed objects added; pixels drawn
// in the graphics files the level uses show in the next preview (the files' data isn't among the bytes read, their
// content is in its input), those drawn in a file it doesn't use keep the preview
{
  const r = new Rom(await editorImage()), e = new LevelEmulator(r);
  e.skipMask = () => gfxSkipMask(r);
  e.boot();
  const queue: (() => void)[] = [];
  const lr = new ResultLearner({
    rom: r, results: new ResultCache(new RomFingerprint(r)), cacheReady: Promise.resolve(), main: e,
    later: (_key, step) => queue.push(step), soon: (step) => queue.push(step), setBusy: () => {},
  });
  const run = async () => { for (let i = 0; i < 1000; i++) { await new Promise((res) => setTimeout(res, 0)); while (queue.length) queue.shift()!(); } };
  const N = 0x105, saved = loadLevel(r, N);
  const lv = { ...saved, objects: [...saved.objects, { ...saved.objects[0], x: 2, y: 20 }] }, ov = ovOf(lv, r);
  const g = layerGeom(r, 0, lv.header.mode, lv.header.screens), tiles = Array.from({ length: 16 * 27 }, (_, i) => ((i >> 4) << 16) | (i & 15));
  let runs = 0;
  const key = `pp1:${N.toString(16)}:1`;
  const preview = async () => {
    const opts = { input: previewInput(r, lv, ov), lane: 'placement', replace: true, keep: 'memory' as const };
    const job = function* (em: LevelEmulator) { runs++; const res = em.load(N, ov); return res.ok ? renderLayerTiles(r, res, g, false, tiles) : null; };
    const pic = lr.learn(key, job, opts);
    if (pic !== undefined) return pic;
    await run();
    return lr.learn(key, job, opts);
  };
  const a = await preview(), pixels = (p: typeof a) => p ? inputHash(p.px) : '';
  const files = layerSlots(levelSlots(r, N, lv.header)).map((s) => s.file);
  // pixels drawn in a file, as the graphics tab does (all of them: those of the tiles in the preview among them)
  const draw = (file: number) => { const f = readGfx(r, file); f.pix = f.pix.map((p) => p ^ 1); writeGfx(r, f); };
  for (const f of files) draw(f);
  const b = await preview();
  check(a !== null && b !== null && pixels(a) !== pixels(b), 'placement preview: pixels drawn in the graphics files the level uses show in the next one');
  const before = runs, all = levelSlots(r, N, lv.header).map((s) => s.file);
  const unused = Array.from({ length: GFX_FILES }, (_, i) => i).find((f) => !all.includes(f) && gfxEntry(r, f))!;
  draw(unused);
  const c = await preview();
  check(c === b && runs === before, `placement preview: pixels drawn in GFX${unused.toString(16).padStart(2, '0')} (not the level's) keep it`);
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

// several inputs per key: sprite images (App.ensureSpriteImages) are keyed by sprite set and palette, the level's
// sprite memory is in their input – 001 and 11E share the key, switching back to 001 doesn't capture again
{
  const a = loadLevel(rom, 0x001), b = loadLevel(rom, 0x11e);
  check(a.header.spriteGfx === b.header.spriteGfx && a.header.spritePalette === b.header.spritePalette && (a.spriteHeader & SPRITE_MEMORY) !== (b.spriteHeader & SPRITE_MEMORY),
    '001 and 11E: the same sprite set, another sprite memory');
  let captured = 0;
  const learned: number[] = [];
  for (const lv of [a, b, a]) {
    const hd = lv.header, sh = lv.spriteHeader;
    const stored = learner.learn(`i6${hd.spriteGfx}-${hd.spritePalette}`, function* (e) {
      captured++;
      return [...captureSprites(e, lv.number, hd, sh, 0xffd900, [0x0d])];
    }, { input: { gfx: hd.spriteGfx, palette: hd.spritePalette, memory: sh & SPRITE_MEMORY }, lane: 'sprites', replace: true, done: () => learned.push(lv.number) });
    await drain();
    if (stored) learned.push(lv.number);
  }
  check(captured === 2 && learned.join() === '1,286,1', `sprite images: 001, 11E, 001 captures 001's once (${captured} captures)`);
}

// the result cache keeps the latest used INPUTS_PER_KEY inputs of a key, also as stored; a result is still dropped when
// bytes it read change
{
  const r = new Rom(await editorImage()), fp = new RomFingerprint(r), cache = new ResultCache(fp);
  const reads = new RomReads(r.data.length); reads.read(0x100, 1); reads.read(0x200 * 8, 1);
  const deps = fp.deps(reads), inputs = Array.from({ length: INPUTS_PER_KEY + 2 }, (_, i) => `in${i}`);
  const has = (c: ResultCache, i: number) => c.get('k', inputs[i]) === i;
  for (let i = 0; i < INPUTS_PER_KEY; i++) cache.set('k', i, deps, inputs[i]);
  check(inputs.slice(0, INPUTS_PER_KEY).every((_, i) => has(cache, i)), `a key holds ${INPUTS_PER_KEY} inputs`);
  // (used last: 0 .. INPUTS_PER_KEY-1 in order; 0 used again, so 1 is the least recently used)
  has(cache, 0);
  cache.set('k', INPUTS_PER_KEY, deps, inputs[INPUTS_PER_KEY]);
  check(!has(cache, 1) && [0, 2, INPUTS_PER_KEY].every((i) => has(cache, i)), 'another input drops the least recently used one');
  // stored as App does (IndexedDB: put the entries and orders, delete the dropped)
  const db = new Map<string, CacheEntry | string[]>();
  const store = (c: ResultCache) => { const { put, order, del } = c.flush(); for (const [k, v] of [...put, ...order]) db.set(k, v); for (const k of del) db.delete(k); };
  store(cache);
  check([...db.keys()].filter((k) => !k.endsWith('#')).length === INPUTS_PER_KEY, `stored: ${INPUTS_PER_KEY} entries of the key`);
  has(cache, 3); has(cache, 2); store(cache); // (used last: 2, 3, INPUTS_PER_KEY, 0)
  const again = new ResultCache(fp);
  again.load([...db]);
  again.set('k', INPUTS_PER_KEY + 1, deps, inputs[INPUTS_PER_KEY + 1]);
  store(again);
  check(!has(again, 0) && [2, 3, INPUTS_PER_KEY, INPUTS_PER_KEY + 1].every((i) => has(again, i)) && !db.has(`k#${inputs[0]}`) && db.size === INPUTS_PER_KEY + 1,
    'loaded from storage: the least recently used goes first, also from storage');
  r.writeAt(0x100, Uint8Array.of(r.data[0x100] ^ 1));
  check([2, 3, INPUTS_PER_KEY, INPUTS_PER_KEY + 1].every((i) => !has(again, i)), 'a changed byte read drops the results of all inputs');
  store(again);
  check(db.size === 0, 'and from storage');
}

// results kept in memory only keep the latest used INPUTS_PER_KEY inputs of a key too
{
  let runs = 0;
  const lt = (i: number) => learner.now('mem', () => { runs++; return { result: i, reads: new RomReads(rom.data.length) }; }, { input: i, keep: 'memory' });
  for (let i = 0; i < INPUTS_PER_KEY; i++) lt(i);
  lt(0); lt(INPUTS_PER_KEY);
  const before = runs;
  lt(0); lt(2);
  check(runs === before, `memory: ${INPUTS_PER_KEY} inputs of a key kept`);
  lt(1);
  check(runs === before + 1, 'memory: the least recently used one dropped');
}

// stored results nobody asks for (App.sweepResults): the rows of earlier cache versions go at start, the background
// sweep drops the results whose bytes read changed, of inputs not in use too, a few at a time
{
  const keys = ['rc2:a', 'rc3:k#x', 'rc3:k#', 'rc4:k#in0', 'rc4:k#', 'rc5:n', 'rc:z', 'rcx:y', 'rom'];
  check(oldStoreKeys(keys, 'rc', 4).join() === 'rc2:a,rc3:k#x,rc3:k#,rc:z', 'old cache rows: those of earlier prefixes, not the current or a later one or other stores');
  const r = new Rom(await editorImage()), fp = new RomFingerprint(r), cache = new ResultCache(fp);
  const db = new Map<string, CacheEntry | string[]>();
  const store = (c: ResultCache) => { const { put, order, del } = c.flush(); for (const [k, v] of [...put, ...order]) db.set(k, v); for (const k of del) db.delete(k); };
  const depsAt = (o: number) => { const rd = new RomReads(r.data.length); rd.read(o, 1); return fp.deps(rd); };
  // two keys, all of their inputs stored; key 'k' read 0x100, key 'j' 0x400
  for (let i = 0; i < INPUTS_PER_KEY; i++) { cache.set('k', i, depsAt(0x100), `in${i}`); cache.set('j', i, depsAt(0x400), `in${i}`); }
  store(cache);
  const loaded = new ResultCache(fp);
  let changes = 0;
  loaded.onChange = () => changes++;
  loaded.load([...db]);
  const sweep = (c: ResultCache, n: number) => { let slices = 1; while (c.sweep(n)) slices++; return slices; };
  check(sweep(loaded, 3) === Math.ceil(2 * INPUTS_PER_KEY / 3) && changes === 0, 'sweep: the loaded results checked a few per slice, all still hold');
  r.writeAt(0x100, Uint8Array.of(r.data[0x100] ^ 1));
  loaded.get('k', 'in0'); // (one in use: dropped when asked for, the others by the sweep)
  sweep(loaded, 3);
  store(loaded);
  check(changes > 0 && [...db.keys()].every((k) => !k.startsWith('k#')) && [...db.keys()].filter((k) => k.startsWith('j#') && k !== 'j#').length === INPUTS_PER_KEY,
    'sweep: a changed byte read drops the results of all inputs of the key from storage without them being asked for, keeps the others');
  // a ROM change while the sweep runs: it starts again with what isn't checked for the new ROM
  for (let i = 0; i < INPUTS_PER_KEY; i++) loaded.set('k', i, depsAt(0x100), `in${i}`);
  r.writeAt(0x400, Uint8Array.of(r.data[0x400] ^ 1));
  loaded.sweep(1);
  r.writeAt(0x100, Uint8Array.of(r.data[0x100] ^ 1));
  sweep(loaded, 1);
  store(loaded);
  check(db.size === 0, 'sweep: a ROM change during it is checked too');
}

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all ok');
