// Inputs of emulated results (inputs.ts): what a result learned from the level as edited depends on outside
// the ROM bytes it read changes it, so it is part of the result's input (or key) – an unsaved edit or a view
// setting learns it again instead of reusing what another state of the level gave.
import { LevelEmulator, type LevelOverride } from '../src/core/levelemu.ts';
import { loadLevel, serializeLayer1, serializeSprites, encodeSecondaryHeader, isL1Vertical, SPRITE_MEMORY, type Level } from '../src/core/level.ts';
import { layer2MotionsJob } from '../src/core/l2scroll.ts';
import { layer3Kinds, layer3KindsJob } from '../src/core/layer3.ts';
import { levelScanJob, scanKey } from '../src/core/levelscan.ts';
import { runJob, JobRunner, type Job, type Part } from '../src/core/jobrunner.ts';
import { LEARN_KINDS, type LearnJob } from '../src/core/probeprotocol.ts';
import { learnAtOnce } from './runnercheck.ts';
import { cameraAtKey } from '../src/core/camerareach.ts';
import { emptyTriggerView } from '../src/core/extrigger.ts';
import { assignSlot, levelSlots, layerSlots } from '../src/core/gfxslots.ts';
import { gfxSkipMask } from '../src/core/gfxpages.ts';
import { gfxEntry, GFX_FILES } from '../src/core/patches.ts';
import { lz2Decompress } from '../src/core/lz2.ts';
import { readGfx, writeGfx, createGfx, ANIM_FILE } from '../src/core/gfxfiles.ts';
import { emptyList, writeLevelList, writeGlobalList, setLevelSettings, NO_LEVEL_LIST } from '../src/core/exanim.ts';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { ResultCache, RomFingerprint, RomReads, oldStoreKeys, type CacheEntry } from '../src/core/romdeps.ts';
import { INPUTS_PER_KEY } from '../src/core/keptresults.ts';
import { ResultLearner } from '../src/core/learner.ts';
import { inputHash, levelInput, editState } from '../src/core/inputs.ts';
import { spriteSetJob, spriteAtJob, spriteBytesJob } from '../src/core/spritegfx.ts';
import { spriteJobs, spriteInput, layer3Spec, type LearnSpec } from '../src/core/learnspecs.ts';
import { renderObjectThumbs, thumbsKey, thumbsInput, previewInput, objKey, type ObjSpec } from '../src/core/objthumbs.ts';
import { layerGeom, renderLayerTiles } from '../src/core/render.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom); emu.boot();
const results = new ResultCache(new RomFingerprint(rom));
const learner = new ResultLearner({ rom, results, main: emu });
// a learn job as the probe worker runs it (probehost.ts learnJob), of the kinds asked for here
function jobOf(e: LevelEmulator, j: LearnJob, part: Part): Job<unknown> {
  switch (j.kind) {
    case 'sprites': return spriteSetJob(e, j.level, j.nums, () => {}, part, j.input);
    case 'spriteAt': return spriteAtJob(e, j.level, j.id, j.x, j.y);
    case 'spriteBytes': return spriteBytesJob(e, j.level, j.id, j.bytes);
    case 'layer3': return layer3KindsJob(e, j.level, j.ov);
    case 'layer2Motions': return (function* () { return (yield* layer2MotionsJob(e, j.level, j.ov)).result; })();
    default: throw new Error(`no ${j.kind} here`);
  }
}
// learns spec at once on a job runner of the main thread, kept as its kind says (probeprotocol.ts LEARN_KINDS): its
// stored result, else its job's (started: counted)
const runner = new JobRunner({ rom, results, main: emu });
// (jobs started; of a result kept as its parts only, the parts learned: it starts to put them together)
let started = 0;
const learn = (s: LearnSpec): unknown => {
  const kind = LEARN_KINDS[s.job.kind];
  return learnAtOnce(runner, { key: s.key, input: inputHash(s.input), ...kind, start: (e, _p, part) => {
    if (kind.whole !== false) started++;
    return jobOf(e, s.job, (sub, input, l) => part(sub, input, () => { started++; return l(); }));
  } });
};
const ovOf = (lv: Level, r = rom): LevelOverride => ({ layer1: serializeLayer1(r, lv), secondaryHeader: encodeSecondaryHeader(lv.secondary), layer2Pointer: lv.layer2Pointer });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// layer 2 motions (App.layer2Motions): an unsaved entrance action changes what the scroll settings do
{
  const N = 0x105, lv = loadLevel(rom, N), edited = structuredClone(lv);
  edited.secondary.entranceAction = 1;
  const learned = [lv, edited].map((l) => { const ov = ovOf(l); return learn({ key: `l2m2:${N}`, job: { kind: 'layer2Motions', level: N, ov }, input: levelInput(N, ov) }); });
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
  const lr = new JobRunner({ rom: r, results: new ResultCache(new RomFingerprint(r)), main: e });
  const N = 0x105, saved = loadLevel(r, N);
  const lv = { ...saved, objects: [...saved.objects, { ...saved.objects[0], x: 2, y: 20 }] }, ov = ovOf(lv, r);
  const g = layerGeom(r, 0, lv.header.mode, lv.header.screens), tiles = Array.from({ length: 16 * 27 }, (_, i) => ((i >> 4) << 16) | (i & 15));
  let runs = 0;
  const key = `pp1:${N.toString(16)}:1`;
  // (as the probe worker learns it: kept in memory, a picture)
  const preview = () => learnAtOnce(lr, { key, input: inputHash(previewInput(r, editState(lv, ov), false, [])), ...LEARN_KINDS.preview,
    start: function* (em) { runs++; const res = em.load(N, ov); return res.ok ? renderLayerTiles(r, res, g, false, tiles) : null; } });
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

// placement preview and object thumbnails: what the level's animations copy at its load from an Anim graphic
// (ExAnimation data isn't among the bytes read) is in their input – pixels drawn in the frames its slots read show in
// the next preview, those drawn in tiles of the graphic no frame reads or in an Anim graphic no list of the level
// reads keep it
{
  const r = new Rom(await editorImage()), e = new LevelEmulator(r);
  e.skipMask = () => gfxSkipMask(r);
  e.boot();
  const lr = new JobRunner({ rom: r, results: new ResultCache(new RomFingerprint(r)), main: e });
  const N = 0x105;
  // Anim graphic A: its first 32 tiles over all of the layers' 512 tiles (16 slots of 32 tiles, one frame), the
  // other 96 read by no frame; Anim graphic B: no list reads it
  createGfx(r, ANIM_FILE); createGfx(r, ANIM_FILE + 1);
  const list = emptyList();
  for (let k = 0; k < 16; k++) list.slots.set(k, { type: 0x0e, trigger: 0, framesLess1: 0, dest: 0x8000 | (k * 0x200), frames: [0] });
  list.count = 16;
  writeLevelList(r, N, list);
  const lv = loadLevel(r, N), ov = ovOf(lv, r);
  const g = layerGeom(r, 0, lv.header.mode, lv.header.screens), tiles = Array.from({ length: 16 * 27 }, (_, i) => ((i >> 4) << 16) | (i & 15));
  let runs = 0;
  const key = `pp1:${N.toString(16)}:1`;
  // (as the probe worker learns it: kept in memory, a picture)
  const preview = () => learnAtOnce(lr, { key, input: inputHash(previewInput(r, editState(lv, ov), false, [])), ...LEARN_KINDS.preview,
    start: function* (em) { runs++; const res = em.load(N, ov); return res.ok ? renderLayerTiles(r, res, g, false, tiles) : null; } });
  const pixels = (p: Awaited<ReturnType<typeof preview>>) => p ? inputHash(p.px) : '';
  // pixels drawn in tiles [from, to) of a file, as the graphics tab does
  const draw = (file: number, from: number, to: number) => { const f = readGfx(r, file); for (let i = from * 64; i < to * 64; i++) f.pix[i] = (f.pix[i] + 5) & 15; writeGfx(r, f); };
  const a = await preview(), thumbs = inputHash(thumbsInput(r, lv));
  draw(ANIM_FILE, 0, 32);
  const b = await preview();
  check(a !== null && b !== null && pixels(a) !== pixels(b), 'placement preview: pixels drawn in the frames the level\'s animations show at its load show in the next one');
  check(inputHash(thumbsInput(r, lv)) !== thumbs, 'thumbnails: the frames the level\'s animations copy are in their input');
  const before = runs, thumbsB = inputHash(thumbsInput(r, lv));
  draw(ANIM_FILE, 32, 128);
  draw(ANIM_FILE + 1, 0, 128);
  const c = await preview();
  check(c === b && runs === before, 'placement preview: pixels drawn in Anim graphic tiles no frame of the level reads keep it');
  check(inputHash(thumbsInput(r, lv)) === thumbsB, 'thumbnails: Anim graphic tiles the level\'s animations don\'t read keep them');
  list.slots.get(0)!.frames = [0x400];
  writeLevelList(r, N, list);
  check(inputHash(thumbsInput(r, lv)) !== thumbsB, 'thumbnails: a slot reading other frames is in their input');
  setLevelSettings(r, N, NO_LEVEL_LIST);
  const off = inputHash(thumbsInput(r, lv));
  draw(ANIM_FILE, 0, 128);
  check(inputHash(thumbsInput(r, lv)) === off, 'thumbnails: with the level\'s animations off its Anim graphic keeps them');
  const global = emptyList();
  global.altFile = 1;
  global.slots.set(0, { type: 0x01, trigger: 0, framesLess1: 0, dest: 0x8000, frames: [0x20] });
  writeGlobalList(r, global);
  const g0 = inputHash(thumbsInput(r, lv));
  draw(ANIM_FILE + 1, 0, 1);
  check(inputHash(thumbsInput(r, lv)) === g0, 'thumbnails: a tile of the global list\'s Anim graphic no frame reads keeps them');
  draw(ANIM_FILE + 1, 1, 2);
  check(inputHash(thumbsInput(r, lv)) !== g0, 'thumbnails: the frames the global list copies are in their input');
}

// level scan and the camera at Mario (levelDataKey): an ExAnimation trigger of the view changes the scan
{
  const N = 0x106, lv = loadLevel(rom, N), vertical = isL1Vertical(rom, lv.header.mode);
  const scan = (ov: LevelOverride) => runJob(levelScanJob(emu, { number: N, vertical, ov, width: lv.header.screens * 256, height: 27 * 16 }));
  const ov = { ...ovOf(lv), sprites: serializeSprites(lv.sprites, lv.spriteHeader, vertical), exTriggers: emptyTriggerView() };
  const silver = emptyTriggerView(); silver.game.add(0x02);
  const on = { ...ov, exTriggers: silver };
  check(!same(scan(ov), scan(on)), 'level scan: a silver P-switch trigger in the view changes it');
  check(scanKey(N, ov) !== scanKey(N, on), 'level scan: the view\'s triggers are in its key');
  check(cameraAtKey(N, ov, 0x40, 0x100) !== cameraAtKey(N, on, 0x40, 0x100), 'camera at Mario: the view\'s triggers are in its key');
}

// several inputs per key (inputs and keys from learnspecs.ts, as App asks): sprite images are keyed by sprite set and
// palette, the level's sprite memory is in their input – 001 and 11E share the keys, switching back to 001 doesn't
// capture again; the same for a sprite's variant at a place and a sprite with extra bytes. Layer 3 kinds are keyed by
// tileset, the level as edited is their input: an edit and its undo don't load again.
{
  const a = loadLevel(rom, 0x001), b = loadLevel(rom, 0x11e);
  check(a.header.spriteGfx === b.header.spriteGfx && a.header.spritePalette === b.header.spritePalette && (a.spriteHeader & SPRITE_MEMORY) !== (b.spriteHeader & SPRITE_MEMORY),
    '001 and 11E: the same sprite set, another sprite memory');
  const jobsOf = (lv: Level) => spriteJobs(lv, [0x0d], spriteInput(rom, lv, []));
  check(jobsOf(a).all.key === jobsOf(b).all.key && inputHash(jobsOf(a).all.input) !== inputHash(jobsOf(b).all.input), 'sprite images: one key, two inputs');
  // learns spec (as the probe worker runs its job) for each level in turn: the levels whose result was learned
  const inTurn = (what: string, spec: (lv: Level) => LearnSpec) => {
    const before = started;
    for (const lv of [a, b, a]) learn(spec(lv));
    check(started - before === 2, `${what}: 001, 11E, 001 learns 001's once (${started - before} runs)`);
  };
  inTurn('sprite images', (lv) => jobsOf(lv).all);
  inTurn('sprite variants', (lv) => jobsOf(lv).at(0x0d, 0x20, 0x10));
  inTurn('extra-byte images', (lv) => jobsOf(lv).bytes(0x0d, [1, 2]));
  // layer 3 kinds: level 105 as saved and as edited (an object moved)
  const lv = loadLevel(rom, 0x105), edited = structuredClone(lv);
  edited.objects[0].x++;
  const l3 = (l: Level) => layer3Spec(rom, l, ovOf(l), l.header.tileset);
  check(l3(lv).key === l3(edited).key && inputHash(l3(lv).input) !== inputHash(l3(edited).input), 'layer 3 kinds: one key, two inputs');
  const before = started;
  for (const l of [lv, edited, lv, edited]) learn(l3(l));
  const runs = started - before;
  check(runs === 2, `layer 3 kinds: an edit, its undo and redo load twice (${runs} loads)`);
}

// the result cache keeps the latest used INPUTS_PER_KEY inputs of a key, also as stored; a result is still dropped when
// bytes it read change
{
  const r = new Rom(await editorImage()), fp = new RomFingerprint(r), cache = new ResultCache(fp);
  const reads = new RomReads(r); reads.read(0x100, 1); reads.read(0x200 * 8, 1);
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
  const lt = (i: number) => learner.now('mem', () => { runs++; return { result: i, reads: new RomReads(rom) }; }, { input: i, keep: 'memory' });
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
  const depsAt = (o: number) => { const rd = new RomReads(r); rd.read(o, 1); return fp.deps(rd); };
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
