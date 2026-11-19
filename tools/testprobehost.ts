// Probe jobs (probehost.ts, run by the editor's probe worker): results as the prober's own, asked
// jobs before prefetched ones, a new ROM drops the queue; object kinds, level scan and camera as
// computed directly, a step at a time that lets asked jobs go first (the kinds of the open level's objects before them, #393). A ROM change sent as the ranges it wrote keeps
// the queue and the tasks; only a task that read a changed byte starts over, before its next step (overworld edits
// restart nothing).
// A cancelled scan runs no further slice and goes on when asked for again. Results a task's slice found before a ROM
// change go with the next reply only if they hold on the new ROM. Jobs keep their result cache keys; only the scan
// can be cancelled. Learn jobs (the sprite images, the levels' uses, the sprite memory check, the animated tiles, the layer 3
// kinds, the tiles of the level as edited, the object thumbnails, the placement preview, the jump arcs, the layer 2
// motions, the path kinds, the prefab suggestions, the object boxes) as learned directly, with the entries the job runner on
// the main thread makes (its jobs learned there at once), in lanes; prefetched probes only when nothing else is pending. The open level's work
// (the object boxes, the loads of the sprite set with its sprites) goes before asked probes, the prefetch and the other lanes.
import { readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { BlockProber, blockKey, collisionKey, spriteKey, runsKey, cameraKey } from '../src/core/blockprobe.ts';
import { ProbeHost } from '../src/core/probehost.ts';
import { jobId, jobKey, LEARN_KINDS, EDIT_STATES, type ProbeJob, type ProbeMessage, type ProbeDone, type ProbeReply } from '../src/core/probeprotocol.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { ObjKindProbe, kindsKey, type ObjKinds } from '../src/core/objkinds.ts';
import { levelScanJob, type ScanLevel } from '../src/core/levelscan.ts';
import { cameraAtJob } from '../src/core/camerareach.ts';
import { runJob, JobRunner, partKey, type JobSpec } from '../src/core/jobrunner.ts';
import { loadLevel, serializeLayer1, serializeSprites, encodeSecondaryHeader, newUid, L2_PTRS } from '../src/core/level.ts';
import { levelObjects } from '../src/core/learnspecs.ts';
import { editorImage } from './fixture.ts';
import { checkJobRunner, learnAtOnce } from './runnercheck.ts';
import { gfxSkipMask, gfxDisplaySkipMask } from '../src/core/gfxpages.ts';
import { tilesetPointers, pointersKey, TILESETS } from '../src/core/tilesets.ts';
import { setActsLike, extTileWords, setExtTileWords } from '../src/core/map16ext.ts';
import { bgTileAddr } from '../src/core/bgmap16.ts';
import { FG_PALS, BACK_AREA, SHARED_PALETTES, SHARED_PAL_SIZE } from '../src/core/sharedpal.ts';
import { setCustomPalette } from '../src/core/patches.ts';
import { captureSprites, captureSpriteAt, spriteSetJob, spriteSetParts, spriteLoad, spriteLoads, type SpriteLevel } from '../src/core/spritegfx.ts';
import { storeKey, bytePages, type CacheEntry } from '../src/core/romdeps.ts';
import { loadAsar } from '../src/core/asar.ts';
import { savePixiProject, parsePixiList, type PixiProject } from '../src/core/pixi.ts';
import { LevelUses, levelUsesJob, levelTilesKey, levelTilesAll, levelOverride } from '../src/core/levelusage.ts';
import { layer3Kinds } from '../src/core/layer3.ts';
import { spriteMemCheckJob, usedSpriteMemory, SpriteGroupResults, type SpriteMemLevel, type SpriteMemResult } from '../src/core/spritemem.ts';
import { animatedJob, type Animated } from '../src/core/levelemu.ts';
import { inputHash, editState } from '../src/core/inputs.ts';
import { objectThumbsJob, placementPreviewJob, withPlaced, objKey, type ObjSpec, type ObjThumb, type PlacementPreview } from '../src/core/objthumbs.ts';
import { jumpArcsJob, type JumpArc } from '../src/core/jumparcs.ts';
import { layer2MotionsJob, type Layer2Motions } from '../src/core/l2scroll.ts';
import { pathKindsJob, type PathKind } from '../src/core/owpaths.ts';
import { suggestPrefabs, KeptSuggestions, type SuggestRun } from '../src/core/prefabsuggest.ts';
import { SizeProbe, type SizeSpec } from '../src/core/objresize.ts';
import { DM16_EXT } from '../src/core/patches.ts';
import { installPrefabPatch } from '../src/core/prefabs.ts';
import { saveLevel } from '../src/core/save.ts';
import { readL1, writeL1, readL2, writeL2, l1Index, l2Index, l2Pointers } from '../src/core/overworld.ts';

// sprites by their test level load (spriteLoad), the loads in the order of their first sprite
const byLoad = (ids: number[]) => { const m = new Map<number, number[]>(); for (const n of ids) m.set(spriteLoad(n), [...(m.get(spriteLoad(n)) ?? []), n]); return m; };

const EDITOR_IMAGE = await editorImage(); // the fixture as the editor opens it

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const file = EDITOR_IMAGE.slice();
const rom = new Rom(file);
const direct = new BlockProber(new Rom(file));

// each job's result under the prober's key
check(jobKey({ kind: 'block', ts: 2, tile: 0x130 }) === blockKey(2, 0x130) && jobKey({ kind: 'collision', ts: 2, tile: 0x130 }) === collisionKey(2, 0x130)
  && jobKey({ kind: 'sprite', ts: 2, num: 0x20d }) === spriteKey(0x20d) && jobKey({ kind: 'runs', ts: 2 }) === runsKey(2)
  && jobKey({ kind: 'bands', ts: 2, mode: 0x0a, vscroll: 2 }) === cameraKey(2, 0x0a, 2), 'job keys: the prober\'s result cache keys');
// @ts-expect-error only the scan can be cancelled
const cancelKinds: ProbeMessage = { type: 'cancel', task: 'kinds' };
void cancelKinds;

const host = new ProbeHost();
host.setRom(1, rom.data.slice());
const prefetched: ProbeJob[] = [{ kind: 'block', ts: 0, tile: 0x130 }, { kind: 'sprite', ts: 0, num: 0x0d }];
const asked: ProbeJob[] = [{ kind: 'block', ts: 0, tile: 0x11f }, { kind: 'runs', ts: 0 }];
host.setPrefetch(prefetched);
host.ask(asked);
const done: ProbeDone[] = [];
while (host.pending) { const d = host.next(); if (d?.type === 'probe') done.push(d); }
check(done.map((d) => jobId(d.job)).join(',') === [...asked, ...prefetched].map(jobId).join(','), 'asked jobs first, then prefetched');
check(done.every((d) => d.gen === 1 && !d.failed && d.put.some(([k]) => k === jobKey(d.job))), 'every job gives its result entry');

// the prefetch last: the asked probes, then the lanes and tasks (taking turns among them), the prefetched probes only
// when nothing else is pending; an asked probe coming while they run goes first again
{
  const h = new ProbeHost();
  h.setRom(1, rom.data.slice());
  h.setPrefetch([{ kind: 'block', ts: 0, tile: 0x131 }, { kind: 'sprite', ts: 0, num: 0x0d }]);
  h.ask([{ kind: 'block', ts: 0, tile: 0x130 }]);
  h.handle({ type: 'learn', lane: 'uses', key: 'uses', job: { kind: 'uses', levels: [0x106, 0x107] }, replace: false });
  h.handle({ type: 'learn', lane: 'slippery', key: 'slip', job: { kind: 'slippery' }, replace: false });
  const what = (d: ProbeReply) => (d.type === 'probe' ? `probe ${jobId(d.job)}` : d.type === 'learning' || d.type === 'learned' ? `${d.type} ${d.lane}` : d.type);
  const order: string[] = [];
  let askedLate = false;
  while (h.pending) {
    const d = h.next();
    if (d) order.push(what(d));
    // (while the lanes run: an asked probe goes before their next step)
    if (!askedLate && order.length === 3) { askedLate = true; h.ask([{ kind: 'block', ts: 0, tile: 0x132 }]); }
  }
  const at = (s: string) => order.findIndex((x) => x.startsWith(s)), lastLane = Math.max(order.lastIndexOf('learned uses'), order.lastIndexOf('learned slippery'));
  check(at('probe') === 0 && order[0] === `probe ${jobId({ kind: 'block', ts: 0, tile: 0x130 })}` && order[3] === `probe ${jobId({ kind: 'block', ts: 0, tile: 0x132 })}`,
    `prefetch last: the asked probes first, also one asked while the lanes run (${order.join(', ')})`);
  check(lastLane > 0 && at(`probe ${jobId({ kind: 'block', ts: 0, tile: 0x131 })}`) > lastLane && at(`probe ${jobId({ kind: 'sprite', ts: 0, num: 0x0d })}`) > lastLane,
    `prefetch last: the prefetched probes only after the lanes are done (${order.join(', ')})`);
}

// the entries hold in the editor's cache (same ROM) and equal the prober's results
const cache = new ResultCache(new RomFingerprint(rom));
for (const d of done) for (const [k, e] of d.put) cache.set(k, e.data, e.deps);
check(JSON.stringify(cache.get(blockKey(0, 0x11f))) === JSON.stringify(direct.probe(0x11f)), 'block 11F as probed directly');
check(JSON.stringify(cache.get(spriteKey(0x0d))) === JSON.stringify(direct.probeSprite(0x0d)), 'sprite 0D as probed directly');

// a ROM change drops the queue; results carry the new generation
host.ask([{ kind: 'block', ts: 0, tile: 0x2b }]);
const changed = rom.data.slice();
host.setRom(2, changed);
check(host.pending === 0 && host.next() === null, 'changed ROM: queue dropped');
host.ask([{ kind: 'block', ts: 0, tile: 0x2b }]);
check(host.next()?.gen === 2, 'results after the change carry its generation');

// a result the editor dropped (it came from an older generation) still reaches it when asked again:
// the host's own cache knows it, its reply must hand the entry back all the same
host.ask([{ kind: 'block', ts: 0, tile: 0x2c }]);
host.next(); // (dropped by the editor)
host.setRom(3, changed);
host.ask([{ kind: 'block', ts: 0, tile: 0x2c }]);
const again = host.next();
check(again?.type === 'probe' && again.put.some(([k]) => k === blockKey(0, 0x2c)), 'a result already known to the host is handed back again');

// object kinds and a level scan: as computed directly; an asked job between their slices goes first
const lv = loadLevel(rom, 0x105), l2 = rom.r24(L2_PTRS + 0x105 * 3);
const scanLevel: ScanLevel = {
  number: lv.number, vertical: false, width: lv.header.screens * 256, height: 27 * 16,
  ov: { layer1: serializeLayer1(rom, lv), sprites: serializeSprites(lv.sprites, lv.spriteHeader, false) },
};
const emu = new LevelEmulator(new Rom(file));
const emuRom = new Rom(file), ptrEmu = new LevelEmulator(new Rom(file));
ptrEmu.skipMask = () => gfxDisplaySkipMask(ptrEmu.rom, []);
const emuMask = gfxDisplaySkipMask(emuRom, Array.from({ length: TILESETS }, (_, ts) => tilesetPointers(ptrEmu, ts).result));
emu.skipMask = () => emuMask; // as the host: GFX and ExAnimation data and the display data are no dependency

// the main thread's job runner, as the editor's result learner sets it up: the learn jobs learned there at once
// (learnAtOnce) give the entries the probe host's are compared with (keys, inputs, bytes read)
const lr = new Rom(file), main = new LevelEmulator(lr), results = new ResultCache(new RomFingerprint(lr)), mainRunner = new JobRunner({ rom: lr, results, main });
main.skipMask = () => gfxSkipMask(lr);
main.boot();
const atOnce = <T>(spec: JobSpec<T>): T => learnAtOnce(mainRunner, spec);
const same = (a: CacheEntry | undefined, b: CacheEntry | undefined) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
const kindProbe = new ObjKindProbe(emu, { ...lv, header: { ...lv.header, tileset: 1 } }, l2), kinds = kindProbe.result();
const scanned = runJob(levelScanJob(emu, scanLevel));
// (the kinds of the level's objects first, #393)
const lvObjects = levelObjects(lv);
host.handle({ type: 'kinds', ts: 1, level: { number: lv.number, header: lv.header }, layer2Pointer: l2, first: lvObjects });
host.handle({ type: 'scan', id: 7, key: 'scan-key', level: scanLevel });
host.handle({ type: 'camera', id: 9, key: 'camera-key', level: scanLevel, x: 0xbb8, y: 0x20 });
const replies: ProbeReply[] = [];
let kindsSteps = 0; // (next() calls until the level's objects' kinds were shown)
for (let i = 0; host.pending; i++) {
  if (i === 3) host.ask([{ kind: 'block', ts: 1, tile: 0x130 }]);
  const d = host.next();
  if (d) replies.push(d);
  if (d?.type === 'kindsShown') kindsSteps = i + 1;
}
const shownAt = replies.findIndex((d) => d.type === 'kindsShown'), shownKinds = replies[shownAt];
check(shownAt === 0 && replies[1]?.type === 'probe' && replies.findIndex((d) => d.type === 'kinds') > 1 && kindsSteps > 3,
  `the kinds of the level's objects first (${kindsSteps} steps, an asked job waiting), then the asked job, then the rest of the tasks`);
check(shownKinds?.type === 'kindsShown' && shownKinds.ts === 1 && JSON.stringify(shownKinds.kinds) === JSON.stringify(lvObjects.flatMap((n) => (kinds.kinds.has(n) ? [[n, kinds.kinds.get(n)]] : []))),
  `the level's objects' kinds as in the tileset's (${lvObjects.length} objects, ${shownKinds?.type === 'kindsShown' ? shownKinds.kinds.length : 0} not plain)`);
const k = replies.find((d) => d.type === 'kinds'), sc = replies.find((d) => d.type === 'scan');
const kEntry = k?.type === 'kinds' ? k.put.find(([key]) => key === kindsKey(1))?.[1] : undefined;
check(k?.type === 'kinds' && k.ts === 1 && !k.failed && JSON.stringify([...(kEntry?.data as ObjKinds).kinds]) === JSON.stringify([...kinds.kinds]), 'object kinds as computed directly, in a result cache entry');
check(!!kEntry && kEntry.deps.pages.length === 0 && kEntry.deps.bytes.length === kindProbe.reads().bytes.size && kEntry.deps.bytes.length > 0, 'object kinds depend on the single bytes the object routines read, no pages');
check(sc?.type === 'scan' && sc.id === 7 && JSON.stringify(sc.result) === JSON.stringify(scanned) && sc.put.some(([key]) => key === 'scan-key'), 'level scan as played directly, with its cache entry');
const cam = replies.find((d) => d.type === 'camera'), camera = runJob(cameraAtJob(emu, scanLevel, 0xbb8, 0x20));
check(cam?.type === 'camera' && cam.id === 9 && JSON.stringify(cam.result) === JSON.stringify(camera) && cam.put.some(([key]) => key === 'camera-key'), 'camera at a place as played directly, with its cache entry');
host.handle({ type: 'scan', id: 8, key: 'scan-key', level: scanLevel });
host.next();
host.setRom(4, rom.data.slice());
check(host.pending === 0, 'new ROM: tasks dropped');

// a ROM change by ranges while a level scan runs: overworld data (layer 1, layer 2 tiles and attributes, bank 04
// event tables) restarts nothing and drops no result; the scan still gives what it gives on the ROM
{
  const r = new Rom(file), h = new ProbeHost(), ed = new ResultCache(new RomFingerprint(r));
  h.setRom(1, r.data.slice());
  const keep = (d: ProbeReply | null) => { for (const [k, e] of d?.put ?? []) ed.set(k, e.data, e.deps); return d; };
  h.ask([{ kind: 'block', ts: 0, tile: 0x130 }, { kind: 'sprite', ts: 0, num: 0x0d }]);
  h.handle({ type: 'kinds', ts: 1, level: { number: lv.number, header: lv.header }, layer2Pointer: l2 });
  while (h.pending) keep(h.next());
  h.handle({ type: 'scan', id: 1, key: 'scan-ow', level: scanLevel });
  for (let i = 0; i < 4; i++) keep(h.next());
  const started = h.started, g = r.gen;
  for (const [snes, n] of [[0x0cf7df, 0x800], [0x04a533, 0x40], [0x04c02b, 0x40], [0x04d85d, 0x10], [0x04d93d, 0x10], [0x04dd8d, 0x10]]) {
    r.writeAt(snesToPc(snes), r.data.slice(snesToPc(snes), snesToPc(snes) + n).map((b) => b ^ 0x5a));
  }
  h.handle({ type: 'edit', gen: 2, size: r.size, edits: r.changesSince(g)!.map(([a, e]) => [a, r.data.slice(a, e)]) });
  check(h.pending === 1, 'overworld edit: the scan still runs');
  let sc: ProbeReply | null = null;
  while (h.pending) { const d = keep(h.next()); if (d?.type === 'scan') sc = d; }
  check(h.started === started, 'overworld edit: the scan was not restarted');
  check(sc?.type === 'scan' && sc.gen === 2 && JSON.stringify(sc.result) === JSON.stringify(scanned), 'overworld edit: the scan as played directly');
  const held = [blockKey(0, 0x130), spriteKey(0x0d), kindsKey(1), 'scan-ow'].filter((k) => ed.get(k) !== undefined);
  check(held.length === 4, `overworld edit: block, sprite, kinds and scan results still hold (${held.join(', ')})`);

  // painting on the overworld as the editor writes it: layer 1, layer 2 in place, layer 2 moved to free space
  h.handle({ type: 'scan', id: 3, key: 'scan-paint', level: scanLevel });
  for (let i = 0; i < 4; i++) keep(h.next());
  const started2 = h.started, g2 = r.gen;
  const ow1 = readL1(r), ow2 = readL2(r);
  ow1[l1Index(0, 5, 5)] ^= 1;
  writeL1(r, ow1);
  ow2[l2Index(0, 5, 5)] ^= 1;
  writeL2(r, ow2);
  for (let k = 0; k < 0x1000; k++) ow2[k] = (k * 7919) & 0x3fff;
  const at = l2Pointers(r).tiles;
  writeL2(r, ow2);
  check(l2Pointers(r).tiles !== at, 'painting: layer 2 moved');
  h.handle({ type: 'edit', gen: 3, size: r.size, edits: r.changesSince(g2)!.map(([a, e]) => [a, r.data.slice(a, e)]) });
  check(h.pending === 1, 'painting: the scan still runs');
  while (h.pending) keep(h.next());
  check(h.started === started2, 'painting: the scan was not restarted');
  const held2 = [blockKey(0, 0x130), spriteKey(0x0d), kindsKey(1), 'scan-ow', 'scan-paint'].filter((k) => ed.get(k) !== undefined);
  check(held2.length === 5, `painting: block, sprite, kinds and scan results still hold (${held2.join(', ')})`);

  // the same scan asked for again: its stored result at once
  h.handle({ type: 'scan', id: 2, key: 'scan-ow', level: scanLevel });
  const again = h.next();
  check(again?.type === 'scan' && again.id === 2 && again.put.some(([k]) => k === 'scan-ow'), 'a scan asked for again: the stored result, with its entry');
}

// a change of a byte a running task read restarts that task only: the queue and the other tasks go on
{
  const r = new Rom(file), h = new ProbeHost();
  h.setRom(1, r.data.slice());
  h.handle({ type: 'scan', id: 1, key: 'scan-re', level: scanLevel });
  h.handle({ type: 'kinds', ts: 2, level: { number: lv.number, header: lv.header }, layer2Pointer: l2 });
  h.next(); h.next();
  h.setPrefetch([{ kind: 'block', ts: 0, tile: 0x131 }, { kind: 'block', ts: 0, tile: 0x132 }]);
  const started = h.started, pending = h.pending;
  // a byte the boot read (the scan counts it from its first slice; object kinds don't depend on it): changed, and
  // changed back before the restarted scan read anything (no second restart)
  const page = emu.snapshot!.reads.pages.indexOf(1), o = page << 8;
  const flip = (gen: number) => { r.writeAt(o, Uint8Array.of(r.data[o] ^ 1)); h.handle({ type: 'edit', gen, size: r.size, edits: [[o, r.data.slice(o, o + 1)]] }); };
  flip(2); flip(3);
  check(h.started === started && h.pending === pending, 'a byte the scan read: nothing restarted at once, the kinds and the queue stay');
  // the same scan asked for again (the same key): the running one answers it
  h.handle({ type: 'scan', id: 5, key: 'scan-re', level: scanLevel });
  check(h.started === started, 'the same scan asked for again while it runs: not restarted');
  // (the scan's turn next: the prefetched probes wait until the tasks are done)
  const replies: ProbeReply[] = [];
  const first = h.next();
  if (first) replies.push(first);
  check(first?.type !== 'probe' && h.started === started + 1, 'the scan started over before its next step (the prefetch waits for the tasks)');
  while (h.pending) { const d = h.next(); if (d) replies.push(d); }
  const firstProbe = replies.findIndex((d) => d.type === 'probe');
  check(firstProbe > replies.findIndex((d) => d.type === 'scan') && firstProbe > replies.findIndex((d) => d.type === 'kinds'), 'the prefetched probes after the tasks are done');
  const sc = replies.find((d) => d.type === 'scan');
  check(sc?.type === 'scan' && sc.id === 5 && JSON.stringify(sc.result) === JSON.stringify(scanned), 'restarted scan as played directly, answering the latest request');
  check(replies.some((d) => d.type === 'kinds' && !d.failed) && replies.filter((d) => d.type === 'probe').length === 2, 'the kinds and the queued probes done');
  check(h.started === started + 1, 'the scan started over once, the kinds not');
}

// a cancelled scan runs no further slice; asked for again with the same key it goes on where it stood (also after a
// change of a byte it read: started over then), another key starts anew
{
  const r = new Rom(file), h = new ProbeHost();
  h.setRom(1, r.data.slice());
  h.handle({ type: 'scan', id: 1, key: 'scan-c', level: scanLevel });
  for (let i = 0; i < 4; i++) h.next();
  const started = h.started;
  h.handle({ type: 'cancel', task: 'scan' });
  check(h.pending === 0 && h.next() === null, 'cancelled scan: no further slice');
  h.ask([{ kind: 'block', ts: 0, tile: 0x130 }]);
  check(h.next()?.type === 'probe' && h.pending === 0, 'cancelled scan: an asked job runs, the scan not after it');
  h.handle({ type: 'scan', id: 2, key: 'scan-c', level: scanLevel });
  check(h.started === started && h.pending === 1, 'the same scan asked for again: goes on, not restarted');
  let sc: ProbeReply | null = null;
  while (h.pending) { const d = h.next(); if (d?.type === 'scan') sc = d; }
  check(sc?.type === 'scan' && sc.id === 2 && JSON.stringify(sc.result) === JSON.stringify(scanned), 'cancelled and asked again: as played directly, answering the latest request');

  h.handle({ type: 'scan', id: 3, key: 'scan-d', level: scanLevel });
  for (let i = 0; i < 4; i++) h.next();
  h.handle({ type: 'cancel', task: 'scan' });
  const o = emu.snapshot!.reads.pages.indexOf(1) << 8, started2 = h.started;
  r.writeAt(o, Uint8Array.of(r.data[o] ^ 1));
  h.handle({ type: 'edit', gen: 2, size: r.size, edits: [[o, r.data.slice(o, o + 1)]] });
  check(h.started === started2 && h.pending === 0, 'a byte the cancelled scan read: not run, not started over yet');
  r.writeAt(o, Uint8Array.of(r.data[o] ^ 1)); // (changed back: the scan has read nothing since it started over)
  h.handle({ type: 'edit', gen: 3, size: r.size, edits: [[o, r.data.slice(o, o + 1)]] });
  h.handle({ type: 'scan', id: 4, key: 'scan-d', level: scanLevel });
  h.next();
  check(h.started === started2 + 1, '… asked for again: started over before its next step, once');
  sc = null;
  while (h.pending) { const d = h.next(); if (d?.type === 'scan') sc = d; }
  check(sc?.type === 'scan' && sc.id === 4 && JSON.stringify(sc.result) === JSON.stringify(scanned), '… as played directly');

  h.handle({ type: 'scan', id: 5, key: 'scan-e', level: scanLevel });
  for (let i = 0; i < 4; i++) h.next();
  h.handle({ type: 'cancel', task: 'scan' });
  h.handle({ type: 'scan', id: 6, key: 'scan-f', level: scanLevel });
  h.next();
  check(h.started === started2 + 3, 'another scan asked for after a cancel: started anew');
  h.handle({ type: 'scan', id: 7, key: 'scan-e', level: scanLevel });
  h.next();
  check(h.started === started2 + 4, '… and the cancelled one asked for after it: started anew too');
  sc = null;
  while (h.pending) { const d = h.next(); if (d?.type === 'scan') sc = d; }
  check(sc?.type === 'scan' && sc.id === 7 && JSON.stringify(sc.result) === JSON.stringify(scanned), '… as played directly');
}

// what blocks look like is no input of what they do: drawing a Map16 tile (FG of the tilesets' shared and own pages,
// extended FG, BG) or changing colors (shared palettes, a level's own) drops no block, collision or sprite result; a
// changed acts-like drops the results of that tile. The shared palettes' first and last page hold code too (the goal
// tape's and the goal sphere's palette fade at $00:B000, the boot's from $00:B888): a color there drops nothing, that
// code changed drops what ran it (#190)
{
  const r = new Rom(file), h = new ProbeHost(), ed = new ResultCache(new RomFingerprint(r));
  h.setRom(1, r.data.slice());
  const keep = (d: ProbeReply | null) => { for (const [k, e] of d?.put ?? []) ed.set(k, e.data, e.deps); return d; };
  const tiles = [0x025, 0x040, 0x0a0, 0x130, 0x200];
  const sprites = [0x0d, 0x4a, 0x7b]; // (the goal sphere and tape run the palette fade's code at $00:B000)
  const jobs: ProbeJob[] = [...tiles.flatMap((t): ProbeJob[] => [{ kind: 'block', ts: 0, tile: t }, { kind: 'collision', ts: 0, tile: t }]), ...sprites.map((num): ProbeJob => ({ kind: 'sprite', ts: 0, num })), { kind: 'runs', ts: 0 }];
  h.ask(jobs);
  while (h.pending) keep(h.next());
  const keys = [...tiles.flatMap((t) => [blockKey(0, t), collisionKey(0, t)]), ...sprites.map((n) => spriteKey(n)), runsKey(0)];
  const ptrs = tilesetPointers(ptrEmu, 0).result;
  let gen = 1;
  const send = (change: () => void) => {
    const g = r.gen;
    change();
    h.handle({ type: 'edit', gen: ++gen, size: r.size, edits: r.changesSince(g)!.map(([a, e]) => [a, r.data.slice(a, e)]) });
  };
  const prober = (h as unknown as { prober: BlockProber }).prober; // (its boot snapshot: booted again when replaced)
  const edit = (what: string, change: () => void) => {
    const boot = prober.emu.snapshot;
    send(change);
    const lost = keys.filter((k) => ed.get(k) === undefined);
    check(lost.length === 0, `${what}: no result dropped${lost.length ? ` (${lost.join(', ')})` : ''}`);
    h.ask([{ kind: 'block', ts: 0, tile: 0x025 }]);
    h.next();
    check(prober.emu.snapshot === boot, `${what}: not booted again`);
    h.ask(jobs); // (the dropped ones again)
    while (h.pending) keep(h.next());
  };
  const draw = (snes: number) => r.writeAt(snesToPc(snes), Uint8Array.of(r.r8(snes) ^ 0x41));
  for (const t of [0x025, 0x040, 0x0a0, 0x130]) edit(`FG tile ${t.toString(16)} drawn`, () => draw(0x0d0000 | ptrs[t]));
  edit('extended FG tile 200 drawn', () => setExtTileWords(r, 0x200, extTileWords(r, 0x200)!.map((w) => w ^ 0x4000)));
  edit('BG tile 025 drawn', () => draw(bgTileAddr(r, 0x025)!));
  edit('shared FG palette 0 changed', () => draw(FG_PALS + 2));
  edit('back area color changed', () => draw(BACK_AREA));
  edit('last shared color changed', () => draw(SHARED_PALETTES + SHARED_PAL_SIZE - 2));
  const colors = new Uint8Array(0x200).fill(0x21);
  edit('own palette of level 106 set', () => setCustomPalette(r, 0x106, colors));
  edit('own palette of the probe level set', () => setCustomPalette(r, 0x105, colors));
  edit('own palette of the probe level changed', () => setCustomPalette(r, 0x105, colors.map((c) => c ^ 3)));
  edit('own palette of the probe level removed', () => setCustomPalette(r, 0x105, null));

  send(() => draw(0x00b000));
  const faded = keys.filter((k) => ed.get(k) === undefined);
  check(faded.join() === [spriteKey(0x4a), spriteKey(0x7b)].join(), `the palette fade's code changed: the goal sphere and tape dropped only (${faded.join(', ')})`);
  send(() => setActsLike(r, 0x025, 0x130));
  check(ed.get(blockKey(0, 0x025)) === undefined && ed.get(collisionKey(0, 0x025)) === undefined, 'acts-like of 025 changed: its results dropped');
}

// result cache entries a task's slice set (the tilesets' pointers) and not handed back yet: after a ROM change only
// those that hold on it go with the next reply (the editor takes a reply of the current ROM unchecked)
for (const changeRead of [false, true]) {
  const r = new Rom(file), h = new ProbeHost();
  h.setRom(1, r.data.slice());
  const prober = (h as unknown as { prober: BlockProber }).prober;
  h.handle({ type: 'kinds', ts: 1, level: { number: lv.number, header: lv.header }, layer2Pointer: l2 });
  h.next();
  const read = prober.results.entry(pointersKey(1))?.deps, o = !read ? -1 : changeRead ? read.bytes[0] : 0x7fc0; // (the internal name)
  check(!!read && (changeRead || (!read.bytes.includes(o) && !read.pages.includes(o >> 8))), "(the kinds' first slice learned the pointers)");
  r.writeAt(o, Uint8Array.of(r.data[o] ^ 1));
  h.handle({ type: 'edit', gen: 2, size: r.size, edits: [[o, r.data.slice(o, o + 1)]] });
  const put = prober.results.flush().put, fp = new RomFingerprint(r);
  const kept = put.filter(([k]) => Array.from({ length: TILESETS }, (_, ts) => pointersKey(ts)).includes(k)).length;
  check(put.every(([, e]) => fp.valid(e.deps)), `a ROM change ${changeRead ? '' : 'not '}of a byte they read: the entries not handed back yet all hold on it`);
  check(kept === (changeRead ? 0 : TILESETS), `… the pointers ${changeRead ? 'left out' : 'kept'} (${kept})`);
}

// a new size: a new ROM (queue dropped)
{
  const r = new Rom(file), h = new ProbeHost();
  h.setRom(1, r.data.slice());
  h.handle({ type: 'scan', id: 1, key: 'scan-sz', level: scanLevel });
  h.edit(2, r.size * 2, []);
  check(h.pending === 0, 'a new size: tasks dropped');
}

// sprite images (learn jobs, #175): as captured directly, a test level load (six sprites grouped by number, #176) per
// step with the images as they come;
// the result cache entries as the job runner on the main thread makes them (key, input, bytes read: a picture,
// from the main boot snapshot); a lane's jobs one after another, a request for the same result joins it, replace
// drops the lane's others, unlearn all of them
{
  const r = new Rom(file), h = new ProbeHost();
  h.setRom(1, r.data.slice());
  const lv5 = loadLevel(r, 0x105), level: SpriteLevel = { number: 0x105, header: lv5.header, spriteHeader: lv5.spriteHeader, bgPointer: 0xffd900 };
  const nums = [0x00, 0x04, 0x0d, 0x0f, 0x11, 0x1d, 0x21, 0x3e], input = inputHash({ set: 'test', nums });
  const capEmu = new LevelEmulator(new Rom(file));
  capEmu.skipMask = () => gfxSkipMask(capEmu.rom);
  // a capture of the whole set: each load's sprites at once
  const capture = (on: LevelEmulator, ids: number[]) => {
    return [...spriteLoads(ids).values()].flatMap((l) => [...captureSprites(on, level, l)]);
  };
  const direct = capture(capEmu, nums);
  h.handle({ type: 'learn', lane: 'sprites', key: 'spr-set', input, job: { kind: 'sprites', level, nums }, replace: true });
  const replies: ProbeReply[] = [];
  while (h.pending) { const d = h.next(); if (d) replies.push(d); }
  const steps = replies.filter((d) => d.type === 'learning'), done = replies.find((d) => d.type === 'learned');
  check(steps.length === 5 && steps[0].type === 'learning' && steps[0].fresh && steps[0].label === 'Sprite graphics 20 %' && steps.every((d) => d.type === 'learning' && d.lane === 'sprites' && d.key === 'spr-set' && d.input === input),
    `sprite set: a reply per test level load, labelled, the first fresh (${steps.length} steps)`);
  const shown = steps.flatMap((d) => (d.type === 'learning' ? d.shown : []));
  check(JSON.stringify(shown) === JSON.stringify(direct), 'sprite set: the images as they come, as captured directly');
  check(done?.type === 'learned' && !done.failed && JSON.stringify(done.result) === JSON.stringify(direct), 'sprite set: the result as captured directly');
  // (#232: the images once, as the entries of the set's parts; not again as the whole set)
  const put = replies.flatMap((d) => ('put' in d ? d.put : []));
  const partEntries = spriteSetParts(nums).map((p) => put.find(([k]) => k === storeKey(partKey('spr-set', p.sub), p.input))?.[1]);
  check(!put.some(([k]) => k === storeKey('spr-set', input)) && partEntries.every((e) => !!e) && JSON.stringify(partEntries.flatMap((e) => e!.data as unknown[])) === JSON.stringify(direct),
    'sprite set: kept as its parts only, the images in their entries');

  atOnce({ key: 'spr-set', input, ...LEARN_KINDS.sprites, start: (e, _p, part) => spriteSetJob(e, level, nums, () => {}, part) });
  const there = spriteSetParts(nums).map((p) => results.entry(partKey('spr-set', p.sub), p.input));
  check(results.entry('spr-set', input) === undefined && there.every((t, i) => !!t && !!partEntries[i] && JSON.stringify(t.deps) === JSON.stringify(partEntries[i]!.deps) && JSON.stringify(t.data) === JSON.stringify(partEntries[i]!.data)),
    'sprite set: the same entries as on the main thread (bytes read)');
  check(partEntries.some((e) => !!e && e.deps.pages.some((p) => emuMask[p << 8])), 'sprite set: a picture, its reads keep the display data');

  // the same set again: the parts as stored, no load captured
  h.handle({ type: 'learn', lane: 'sprites', key: 'spr-set', input, job: { kind: 'sprites', level, nums }, replace: true });
  const again = h.next();
  check(again?.type === 'learned' && JSON.stringify(again.result) === JSON.stringify(direct) && h.pending === 0, 'sprite set asked again: put together from its stored parts at once');

  // variants and extra bytes in lanes of their own: one after another, the same result asked twice runs once
  const at = (x: number): ProbeMessage => ({ type: 'learn', lane: 'variants', key: `v:${x}`, input, job: { kind: 'spriteAt', level, id: 0x0d, x, y: 0 }, replace: false });
  const started = h.started;
  h.handle(at(0)); h.handle(at(1)); h.handle(at(0));
  h.handle({ type: 'learn', lane: 'bytes', key: 'b:1', input, job: { kind: 'spriteBytes', level, id: 0x0d, bytes: [1] }, replace: false });
  const got: ProbeReply[] = [];
  while (h.pending) { const d = h.next(); if (d) got.push(d); }
  const learned = got.filter((d) => d.type === 'learned');
  check(learned.map((d) => d.type === 'learned' && d.key).join() === 'v:0,b:1,v:1' && h.started === started + 3, `variants and bytes: lanes taking turns, a job asked twice runs once (${learned.map((d) => d.type === 'learned' && d.key).join()})`);
  const v0 = learned.find((d) => d.type === 'learned' && d.key === 'v:0');
  check(v0?.type === 'learned' && JSON.stringify(v0.result) === JSON.stringify(captureSpriteAt(capEmu, level, 0x0d, 0, 0)), 'a variant as captured directly');
  const b1 = learned.find((d) => d.type === 'learned' && d.key === 'b:1');
  check(b1?.type === 'learned' && JSON.stringify(b1.result) === JSON.stringify(captureSprites(capEmu, level, [0x0d], undefined, [1]).get(0x0d) ?? null), 'extra bytes as captured directly');

  // replace drops the lane's other jobs, unlearn the lane
  h.handle(at(2)); h.handle(at(3));
  h.handle({ ...at(4), replace: true } as ProbeMessage);
  const rep: ProbeReply[] = [];
  while (h.pending) { const d = h.next(); if (d) rep.push(d); }
  check(rep.map((d) => d.type === 'learned' && d.key).join() === 'v:4', 'replace: only the latest job of the lane');
  h.handle(at(5)); h.handle(at(6));
  h.handle({ type: 'unlearn', lane: 'variants' });
  check(h.pending === 0, 'unlearn: the lane\'s jobs dropped');
}

// a changed sprite recaptures only its own images (#176): each test level load of a set is kept on its own with the bytes
// it read; a change one load read captures only that load again, a sprite added to the list only the load it is in,
// the result the same as a capture of the whole set; a host given the editor's stored loads captures none
{
  const r = new Rom(file), h = new ProbeHost();
  h.setRom(1, r.data.slice());
  const lv5 = loadLevel(r, 0x105), level: SpriteLevel = { number: 0x105, header: lv5.header, spriteHeader: lv5.spriteHeader, bgPointer: 0xffd900 };
  const capture = (ids: number[]) => {
    const on = new LevelEmulator(new Rom(r.data.slice()));
    on.skipMask = () => gfxSkipMask(on.rom);
    return JSON.stringify([...spriteLoads(ids).values()].flatMap((l) => [...captureSprites(on, level, l)]));
  };
  const loadInput = inputHash({ set: 'test' });
  const learn = (nums: number[]): ProbeMessage => ({ type: 'learn', lane: 'sprites', key: 'spr', input: inputHash({ set: 'test', nums }), job: { kind: 'sprites', level, nums, input: loadInput }, replace: true });
  const run = (m: ProbeMessage) => {
    h.handle(m);
    const out: ProbeReply[] = [];
    while (h.pending) { const d = h.next(); if (d) out.push(d); }
    const done = out.find((d) => d.type === 'learned');
    return { loads: out.filter((d) => d.type === 'learning').length, result: done?.type === 'learned' ? JSON.stringify(done.result) : '', put: out.flatMap((d) => ('put' in d ? d.put : [])) };
  };
  const nums = [0x00, 0x04, 0x0d, 0x0f, 0x11, 0x1d, 0x21, 0x3e];
  const first = run(learn(nums));
  const parts = first.put.filter(([k]) => k.startsWith('spr/'));
  check(first.loads === 5 && parts.length === 5 && first.result === capture(nums), `set: a part per test level load (${parts.length}), the images as a capture of the whole set`);

  // a page only one load read (its sprite's code or tables)
  const own = parts.map(([k, e]) => ({ k, pages: new Set(e.deps.pages) }));
  const only = own.flatMap((o) => [...o.pages].filter((p) => own.every((x) => x === o || !x.pages.has(p))).map((p) => ({ k: o.k, p })));
  check(only.length > 0, `set: pages only one load read (${only.length})`);
  const o = (only[0]?.p ?? 0) << 8;
  r.writeAt(o, Uint8Array.of(r.data[o] ^ 0x01));
  h.handle({ type: 'edit', gen: 2, size: r.size, edits: [[o, r.data.slice(o, o + 1)]] });
  const changed = run(learn(nums));
  const redone = changed.put.filter(([k]) => k.startsWith('spr/')).map(([k]) => k);
  check(changed.loads === 1 && redone.length === 1 && redone[0] === only[0]?.k, `a change one load read: only that load captured again (${changed.loads} loads, ${redone.join()})`);
  check(changed.result === capture(nums), '… the images as a capture of the whole set');

  // a sprite added to the list (a new custom sprite): only the load it is in
  const more = [...nums, 0x05];
  const added = run(learn(more));
  const addedParts = added.put.filter(([k]) => k.startsWith('spr/')).map(([k]) => k.split('#')[0]);
  check(added.loads === 1 && addedParts.join() === `spr/${spriteLoad(0x05).toString(16)}`, `a sprite added: only its load captured (${addedParts.join()})`);
  check(added.result === capture(more), '… the images as a capture of the whole set');

  // another host (the worker after the editor reopened the ROM) given the editor's stored loads: captures none
  const h2 = new ProbeHost();
  h2.setRom(1, r.data.slice());
  const all = new Map([...parts, ...changed.put, ...added.put].filter(([k]) => k.startsWith('spr/')));
  h2.handle({ ...(learn(more) as ProbeMessage & { type: 'learn' }), parts: [...all] });
  const out: ProbeReply[] = [];
  while (h2.pending) { const d = h2.next(); if (d) out.push(d); }
  const got = out.find((d) => d.type === 'learned');
  check(out.filter((d) => d.type === 'learning').length === 0 && got?.type === 'learned' && JSON.stringify(got.result) === capture(more) && !got.put.some(([k]) => k.startsWith('spr/')),
    'the editor\'s stored loads: none captured, the same images, not handed back');
}

// one sprite's entry in a per-sprite table (#231): the tables are found by emulation when the ROM boots
// (spritetables.ts) and their pages recorded by byte, so a change of one sprite's entry captures only its load again –
// the game's tweakers, and PIXI's sprite table (16 bytes per number); a PIXI insert again that moves the custom sprites'
// code captures only their loads again, not those of the game's sprites
{
  await loadAsar();
  // the parts captured again after change (spr/<load>, sent as the bytes it changed), the images as a capture of the whole set
  const recaptured = (r: Rom, nums: number[], change: (r: Rom) => void) => {
    const h = new ProbeHost();
    h.setRom(1, r.data.slice());
    const lv5 = loadLevel(r, 0x105), level: SpriteLevel = { number: 0x105, header: lv5.header, spriteHeader: lv5.spriteHeader, bgPointer: 0xffd900 };
    const learn: ProbeMessage = { type: 'learn', lane: 'sprites', key: 'spr', input: inputHash({ set: 'test', nums }), job: { kind: 'sprites', level, nums, input: inputHash({ set: 'test' }) }, replace: true };
    const run = () => {
      h.handle(learn);
      const out: ProbeReply[] = [];
      while (h.pending) { const d = h.next(); if (d) out.push(d); }
      const done = out.find((d) => d.type === 'learned');
      return { result: done?.type === 'learned' ? JSON.stringify(done.result) : '', parts: out.flatMap((d) => ('put' in d ? d.put : [])).map(([k]) => k.split('#')[0]).filter((k) => k.startsWith('spr/')) };
    };
    const first = run(), before = r.data.slice();
    change(r);
    const edits: [number, Uint8Array][] = [];
    for (let i = 0; i < r.size; i++) {
      if (r.data[i] === before[i]) continue;
      let j = i;
      while (j < r.size && r.data[j] !== before[j]) j++;
      edits.push([i, r.data.slice(i, j)]);
      i = j;
    }
    h.handle({ type: 'edit', gen: 2, size: r.size, edits });
    const again = run();
    const on = new LevelEmulator(new Rom(r.data.slice()));
    on.skipMask = () => gfxSkipMask(on.rom);
    const whole = JSON.stringify([...spriteLoads(nums).values()].flatMap((l) => [...captureSprites(on, level, l)]));
    return { first: first.parts, again: again.parts, same: again.result === whole };
  };
  const flip = (o: number) => (r: Rom) => r.writeAt(o, Uint8Array.of(r.data[o] ^ 0x01));
  const tablePages = (r: Rom) => { const e = new LevelEmulator(r); e.boot(); return bytePages(r); };

  const vr = new Rom(EDITOR_IMAGE.slice()), tweaker = snesToPc(0x07f26c); // the game's first tweaker table ($1656)
  const vp = tablePages(vr);
  check([0, 0x21, 0xc8].every((n) => vp[(tweaker + n) >> 8] === 1), 'the game\'s tweaker table: byte pages, found by emulation');
  const v = recaptured(new Rom(EDITOR_IMAGE.slice()), [0x00, 0x04, 0x0d, 0x0f, 0x11, 0x1d, 0x21, 0x3e], flip(tweaker + 0x21));
  check(v.first.length === 5 && v.again.join() === `spr/${spriteLoad(0x21).toString(16)}` && v.same,
    `a tweaker of sprite 21 changed: only its load captured again (${v.again.join()}), the images as a capture of the whole set`);

  // two custom sprites in loads of their own, told apart in PIXI's table by their extra property bytes
  const draw = (more: string) => 'print "INIT ",pc\n  RTL\nprint "MAIN ",pc\n  PHB : PHK : PLB\n' + more + '  JSR Gfx\n  PLB\n  RTL\nGfx:\n  %GetDrawInfo()\n'
    + '  LDA $00 : STA $0300|!addr,y\n  LDA $01 : STA $0301|!addr,y\n  LDA #$8C : STA $0302|!addr,y\n  LDA #$21 : STA $0303|!addr,y\n'
    + '  TYA : LSR #2 : TAY\n  LDA #$02 : STA $0460|!addr,y\n  RTS\n';
  const project = (more: string): PixiProject => ({
    files: new Map(Object.entries({
      'sprites/a.cfg': '01\n36\n00 00 3B 80 00 00\n12 34\na.asm\n', 'sprites/b.cfg': '01\n36\n00 00 3B 80 00 00\n56 78\nb.asm\n',
      'sprites/a.asm': draw(''), 'sprites/b.asm': draw(more),
    }).map(([k, f]) => [k, new TextEncoder().encode(f)])),
    list: parsePixiList('10 a.cfg\n20 b.cfg\n'),
  });
  const pr = new Rom(EDITOR_IMAGE.slice());
  check(savePixiProject(pr, project('')).ok, 'PIXI: two custom sprites inserted');
  // their rows in PIXI's sprite table: type, acts like, tweakers, INIT, MAIN, extra property bytes
  const row = (prop: number[]) => pr.data.findIndex((_, i) => [1, 0x36, 0, 0, 0x3b, 0x80, 0, 0].every((b, j) => pr.data[i + j] === b) && pr.data[i + 14] === prop[0] && pr.data[i + 15] === prop[1]);
  const rowB = row([0x56, 0x78]);
  check(rowB > 0 && row([0x12, 0x34]) === rowB - 0x10 * 16, 'PIXI: the sprites\' rows in its table');
  const pp = tablePages(new Rom(pr.data.slice()));
  check(pp[(rowB - 0x20 * 16) >> 8] === 1 && pp[rowB >> 8] === 1 && pp[(rowB - 0x20 * 16 + 0xff * 16) >> 8] === 1, 'PIXI\'s sprite table: byte pages, found by emulation');
  const pnums = [0x00, 0x0d, 0x210, 0x220];
  const p = recaptured(new Rom(pr.data.slice()), pnums, flip(rowB + 2));
  check(p.first.length === 4 && p.again.join() === `spr/${spriteLoad(0x220).toString(16)}` && p.same,
    `PIXI: a tweaker of custom sprite 20 changed: only its load captured again (${p.again.join()}), the images as a capture of the whole set`);

  // inserted again with more code in sprite 20: its code changed (where the editor places it – today in its old place,
  // its INIT/MAIN pointers as they were), a sprite whose pointers changed counts as changed too; the runtime and the
  // game's sprites stay
  const moved = (r: Rom) => [0x10, 0x20].filter((n) => { const o = rowB - (0x20 - n) * 16 + 8; return r.data.subarray(o, o + 6).some((b, i) => b !== pr.data[o + i]); });
  let movedNow: number[] = [];
  const re = recaptured(new Rom(pr.data.slice()), pnums, (r) => { savePixiProject(r, project('  NOP #8\n')); movedNow = moved(r); });
  const changedNow = [...new Set([...movedNow, 0x20])].sort((x, y) => x - y);
  check(re.again.join() === changedNow.map((n) => `spr/${spriteLoad(0x200 | n).toString(16)}`).join() && re.same,
    `PIXI inserted again, sprite 20's code changed${movedNow.length ? `, sprites ${movedNow.map((n) => n.toString(16)).join()} moved` : ''}: only their loads captured again (${re.again.join()}), the images as a capture of the whole set`);
}

// the levels' uses, the sprite memory check and the animated tiles and colors (learn jobs, #177): results and entries
// (keys, inputs, bytes read) as the job runner on the main thread makes them: the uses in the levels' entries (the
// job keeps none), shown a level at a time; the check in the result cache; the animated ones in memory only, handed
// back with the result
{
  const r = new Rom(file), h = new ProbeHost();
  h.setRom(1, r.data.slice());
  const run = (m: ProbeMessage) => {
    h.handle(m);
    const out: ProbeReply[] = [];
    while (h.pending) { const d = h.next(); if (d) out.push(d); }
    return { out, done: out.find((d) => d.type === 'learned'), put: new Map(out.flatMap((d) => ('put' in d ? d.put : []))) };
  };

  // uses
  const levels = [0x105, 0x106, 0x107];
  const uses = run({ type: 'learn', lane: 'uses', key: 'uses', job: { kind: 'uses', levels }, replace: false });
  const shownLevels = uses.out.flatMap((d) => (d.type === 'learning' ? d.shown : []));
  check(shownLevels.join() === levels.join() && uses.done?.type === 'learned' && !uses.done.failed && uses.done.result === undefined, `uses: a level at a time, shown as it comes (${shownLevels.join()})`);
  const idx = new LevelUses(lr, results);
  atOnce({ key: 'uses', keep: false, picture: false, start: (emu) => levelUsesJob(idx, emu, () => levels, () => {}) });
  const there = levels.map((n) => results.under(levelTilesKey(n))[0]);
  check(there.every((e) => !!e && same(uses.put.get(e[0]), e[1])) && !uses.put.has('uses'), 'uses: the levels\' entries as on the main thread (keys, inputs, bytes read: no picture), none of the job\'s');
  const again = run({ type: 'learn', lane: 'uses', key: 'uses', job: { kind: 'uses', levels }, replace: false });
  check(!again.out.some((d) => d.type === 'learning') && levels.every((n, i) => same(again.put.get(there[i][0]), there[i][1])),
    'uses asked again: the levels known, none loaded, their entries handed back (the editor asked: it has none)');
  // asked again with another list while it runs (#230): the running job takes up the latest list, the levels no
  // longer asked for are left
  h.handle({ type: 'learn', lane: 'uses', key: 'uses', job: { kind: 'uses', levels: [0x108, 0x109, 0x10a] }, replace: false });
  const firstShown: unknown[] = [];
  for (let i = 0; i < 1000 && !firstShown.length && h.pending; i++) { const d = h.next(); if (d?.type === 'learning') firstShown.push(...d.shown); }
  const moved = run({ type: 'learn', lane: 'uses', key: 'uses', job: { kind: 'uses', levels: [0x10b] }, replace: false });
  const movedShown = [...firstShown, ...moved.out.flatMap((d) => (d.type === 'learning' ? d.shown : []))];
  check(movedShown.join() === [0x108, 0x10b].join() && moved.done?.type === 'learned' && [...moved.put.keys()].some((k) => k.startsWith(levelTilesKey(0x10b))) && ![0x109, 0x10a].some((n) => [...moved.put.keys()].some((k) => k.startsWith(levelTilesKey(n)))),
    `uses asked with another list while running: the latest list scanned, the others not (${movedShown.map((n) => (n as number).toString(16)).join()})`);

  // the sprite memory check of $E0 in level 00C (incomplete with the level's value: a suggestion)
  const lvc = loadLevel(r, 0xc), sprites = [{ uid: 1, num: 0xe0, x: 8, y: 0x14, extra: 0 }];
  const sm: SpriteMemLevel = { number: 0xc, header: lvc.header, bgPointer: 0xffd900, mem: lvc.spriteHeader & 0x3f, candidates: usedSpriteMemory(r), sprites };
  const smInput = inputHash({ sm: 'test' });
  const check1 = run({ type: 'learn', lane: 'spritemem', key: 'sm-test', input: smInput, job: { kind: 'spriteMem', level: sm }, replace: true });
  const smDone = atOnce({ key: 'sm-test', input: smInput, keep: true, picture: false, start: (emu) => spriteMemCheckJob(emu, sm, new SpriteGroupResults(results.fp)) });
  check(check1.done?.type === 'learned' && JSON.stringify(check1.done.result) === JSON.stringify(smDone) && (smDone as SpriteMemResult).lost.length === 1 && (smDone as SpriteMemResult).suggestion !== null, `sprite memory: the check as on the main thread (${JSON.stringify(smDone)})`);
  check(same(check1.put.get(storeKey('sm-test', smInput)), results.entry('sm-test', smInput) && { ...results.entry('sm-test', smInput)!, input: smInput }),
    'sprite memory: its entry as on the main thread (key, input, bytes read)');

  // a level's scan as a learn job (#258: a level's image): as played directly, its entry as on the main thread, under
  // its key without an input as a scan task keeps it (no picture)
  const scl = run({ type: 'learn', lane: 'level-images', key: 'scan-learn', job: { kind: 'scan', level: scanLevel }, replace: true });
  const sclDone = atOnce({ key: 'scan-learn', ...LEARN_KINDS.scan, start: (emu) => levelScanJob(emu, scanLevel) });
  check(scl.done?.type === 'learned' && JSON.stringify(scl.done.result) === JSON.stringify(scanned) && JSON.stringify(sclDone) === JSON.stringify(scanned), 'level scan learned: as played directly');
  check(same(scl.put.get(storeKey('scan-learn', undefined)), results.entry('scan-learn')), 'level scan learned: its entry as on the main thread (key, no input, bytes read)');

  // the animated tiles and colors of level 105: in memory only
  const anInput = inputHash({ an: 'test' });
  const an = run({ type: 'learn', lane: 'animated', key: 'anim:test', input: anInput, job: { kind: 'animated', level: 0x105, ov: {} }, replace: true });
  const anDone = atOnce({ key: 'anim:test', input: anInput, keep: 'memory', picture: true, start: (emu) => animatedJob(emu, 0x105, {}) });
  const res = an.done?.type === 'learned' ? an.done.result as Animated : undefined;
  check(!!res && !!anDone && res.tiles.size > 0 && [...res.tiles].join() === [...anDone.tiles].join() && [...res.colors].join() === [...anDone.colors].join(),
    `animated: the tiles and colors as on the main thread (${res?.tiles.size} tiles, ${res?.colors.size} colors)`);
  const mem = mainRunner.memory.entry('anim:test', anInput);
  check(an.done?.type === 'learned' && !!mem && !an.put.has(storeKey('anim:test', anInput)) && an.done.memory?.input === anInput
    && JSON.stringify(an.done.memory.deps) === JSON.stringify(mem.deps), 'animated: kept in memory only, its entry handed back as the main thread keeps it (bytes read)');

  // the layer 3 kinds of level 105 in the castle tileset and the tiles of the level as edited (learn jobs, #178): results and
  // entries as on the main thread (no pictures; the kinds in the result cache, the tiles in memory only)
  const lv5 = loadLevel(r, 0x105), ov5 = levelOverride(r, lv5), l3ov = { layer1: serializeLayer1(r, { ...lv5, header: { ...lv5.header, tileset: 1 } }), secondaryHeader: encodeSecondaryHeader(lv5.secondary) };
  const l3Input = inputHash({ l3: 'test' });
  const l3 = run({ type: 'learn', lane: 'layer3', key: 'l3k-test', input: l3Input, job: { kind: 'layer3', level: 0x105, ov: l3ov }, replace: true });
  const l3Now = atOnce({ key: 'l3k-test', input: l3Input, keep: true, picture: false, start: function* (emu) { return layer3Kinds(emu, 0x105, l3ov); } });
  check(l3.done?.type === 'learned' && !l3.done.failed && (l3.done.result as string[]).join() === l3Now.join() && l3Now.join() === 'none,tide-moving,image,image',
    `layer 3 kinds: as on the main thread (${l3Now.join()})`);
  check(same(l3.put.get(storeKey('l3k-test', l3Input)), results.entry('l3k-test', l3Input) && { ...results.entry('l3k-test', l3Input)!, input: l3Input }),
    'layer 3 kinds: their entry as on the main thread (key, input, bytes read: no picture)');
  const ltInput = inputHash({ lt: 'test' });
  const lt = run({ type: 'learn', lane: 'lt', key: 'lt-test', input: ltInput, job: { kind: 'levelTiles', state: editState(lv5, ov5) }, replace: true });
  const ltNow = atOnce({ key: 'lt-test', input: ltInput, keep: 'memory', picture: false, start: function* (emu) { return levelTilesAll(lr, lv5, (o) => emu.load(0x105, o), ov5); } });
  check(lt.done?.type === 'learned' && !lt.done.failed && JSON.stringify(lt.done.result) === JSON.stringify(ltNow) && ltNow.fg.length > 0,
    `open level's tiles: as on the main thread (${ltNow.fg.length} FG, ${ltNow.bg.length} BG uses)`);
  const ltMem = mainRunner.memory.entry('lt-test', ltInput);
  check(lt.done?.type === 'learned' && !!ltMem && !lt.put.has(storeKey('lt-test', ltInput)) && lt.done.memory?.input === ltInput
    && JSON.stringify(lt.done.memory.deps) === JSON.stringify(ltMem.deps), 'open level\'s tiles: kept in memory only, their entry handed back as the main thread keeps it (bytes read)');
}

// the object thumbnails, the placement preview, the jump arcs, the layer 2 motions, the overworld path kinds, the prefab
// suggestions and the object boxes (learn jobs, #179): results and entries (keys, inputs, bytes read) as the job
// runner on the main thread made them; the placement preview and the arcs in memory only, a request replacing the
// lane's others drops them; the suggestions and the boxes to the editor only (the boxes probed again after a ROM change)
{
  const r = new Rom(file), h = new ProbeHost();
  h.setRom(1, r.data.slice());
  const run = (...ms: ProbeMessage[]) => {
    for (const m of ms) h.handle(m);
    const out: ProbeReply[] = [];
    while (h.pending) { const d = h.next(); if (d) out.push(d); }
    const learned = out.filter((d) => d.type === 'learned');
    return { out, learned, done: learned[learned.length - 1], put: new Map(out.flatMap((d) => ('put' in d ? d.put : []))) };
  };
  const json = (x: unknown) => JSON.stringify(x, (_k, v) => (v instanceof Uint32Array ? [...v] : v));
  const lv5 = loadLevel(r, 0x105), ov5 = levelOverride(r, lv5);

  // object thumbnails (a picture, in the result cache)
  const specs: ObjSpec[] = [{ num: 0x21, ext: 0, size: 0x13 }, { num: 0, ext: 0x10, size: 0 }, { num: 0x0e, ext: 0, size: 0x02 }];
  const keys = specs.map((q) => objKey(q, null)), thInput = inputHash({ th: 'test' }), thLoad = inputHash({ th: 'load' });
  const th = run({ type: 'learn', lane: 'thumbs', key: 'th-test', input: thInput, job: { kind: 'thumbs', level: lv5, specs, keys, input: thLoad }, replace: true });
  const thNow = atOnce<ObjThumb[]>({ key: 'th-test', input: thInput, keep: true, picture: true, start: (emu) => objectThumbsJob(lr, emu, lv5, specs, (q) => keys[specs.indexOf(q)]) });
  check(th.done?.type === 'learned' && !th.done.failed && json(th.done.result) === json(thNow) && thNow.length === 3, `thumbnails: as on the main thread (${thNow.length})`);
  check(same(th.put.get(storeKey('th-test', thInput)), results.entry('th-test', thInput) && { ...results.entry('th-test', thInput)!, input: thInput }),
    'thumbnails: their entry as on the main thread (key, input, bytes read: a picture)');
  // asked again with another list (an object's types found meanwhile, #511): the loads of the sections left as they
  // were are taken as stored – only the changed section's batch is learned, the result as learned from scratch
  {
    const partPuts = (x: { put: Map<string, unknown> }) => [...x.put.keys()].filter((k) => k.includes('th-test/')).length;
    const specs2: ObjSpec[] = [{ num: 0x21, ext: 0, size: 0x23 }, specs[1], specs[2]], keys2 = specs2.map((q) => objKey(q, null)), in2 = inputHash({ th: 'test2' });
    const th2 = run({ type: 'learn', lane: 'thumbs', key: 'th-test', input: in2, job: { kind: 'thumbs', level: lv5, specs: specs2, keys: keys2, input: thLoad }, replace: true });
    const scratch = atOnce<ObjThumb[]>({ key: 'th-scratch', input: in2, keep: true, picture: true, start: (emu) => objectThumbsJob(lr, emu, lv5, specs2, (q) => keys2[specs2.indexOf(q)]) });
    check(partPuts(th) >= 2 && partPuts(th2) === 1, `thumbnails: another list of objects learns only the changed section's batch (parts learned: ${partPuts(th)}, then ${partPuts(th2)})`);
    check(th2.done?.type === 'learned' && !th2.done.failed && json(th2.done.result) === json(scratch) && json(scratch) !== json(thNow), 'thumbnails: the result as learned from scratch');
    const th3 = run({ type: 'learn', lane: 'thumbs', key: 'th-test', input: in2, job: { kind: 'thumbs', level: lv5, specs: specs2, keys: keys2, input: inputHash({ th: 'load2' }) }, replace: true });
    check(th3.done?.type === 'learned' && json(th3.done.result) === json(scratch), 'thumbnails: the list as kept');
  }

  // the placement preview: an object placed in level 105 (in memory only); a request replacing it drops it
  // (#232: the level as pvState sent whole once, then named by its id)
  const obj = { uid: 1, num: 0x21, ext: 0, size: 0x13, x: 4, y: 0x14 }, placed = { ...lv5, objects: [...lv5.objects, obj] }, ovp = levelOverride(r, placed);
  const pvState = editState(lv5, ov5);
  const pvJob = (i: number, whole: boolean): ProbeMessage => ({ type: 'learn', lane: 'placement', key: `pp-test${i}`, input: thInput, job: { kind: 'preview', state: whole ? pvState : { id: pvState.id }, layer2: false, objects: [obj] }, replace: true });
  const started = h.started;
  const pv = run(pvJob(1, true), pvJob(2, false));
  const pvNow = atOnce<PlacementPreview | null>({ key: 'pp-now', input: 'pp', keep: 'memory', picture: true, start: (emu) => placementPreviewJob(lr, emu, placed, ovp, false, [placed.objects.length - 1]) });
  check(pv.learned.length === 1 && pv.done?.type === 'learned' && pv.done.key === 'pp-test2' && h.started === started + 1, 'placement preview: the replaced request dropped, only the latest learned');
  check(pv.done?.type === 'learned' && !!pvNow && pvNow.w > 0 && json(pv.done.result) === json(pvNow) && !pv.put.has(storeKey('pp-test2', thInput)) && !!pv.done.memory,
    `placement preview: as on the main thread (${pvNow?.w}x${pvNow?.h}), in memory only`);
  const placedAt = withPlaced(r, pvState, false, [obj]);
  check(json(placedAt.ov) === json({ ...ov5, ...ovp }) && placedAt.placed.join() === `${lv5.objects.length}`, 'placement preview: the level as pvState with the object placed loads as it would with the object in it');
  const unsent = run({ ...(pvJob(3, false) as ProbeMessage & { type: 'learn' }), job: { kind: 'preview', state: { id: 'unsent' }, layer2: false, objects: [obj] } });
  check(unsent.done?.type === 'learned' && unsent.done.failed, 'placement preview: a level as pvState never sent whole: failed');
  // the host keeps the latest EDIT_STATES sent whole, also over a new ROM
  h.setRom(2, r.data.slice());
  for (let i = 0; i < EDIT_STATES - 1; i++) run({ ...(pvJob(4, false) as ProbeMessage & { type: 'learn' }), job: { kind: 'levelTiles', state: editState({ ...lv5, number: 0x100 + i }, ov5) }, lane: 'lt' });
  const pvKept = run(pvJob(5, false));
  run({ ...(pvJob(6, false) as ProbeMessage & { type: 'learn' }), job: { kind: 'levelTiles', state: editState({ ...lv5, number: 0x1ff }, ov5) }, lane: 'lt' });
  const gone = run(pvJob(7, false));
  check(pvKept.done?.type === 'learned' && !pvKept.done.failed && json(pvKept.done.result) === json(pvNow) && gone.done?.type === 'learned' && gone.done.failed,
    `placement preview: the level as pvState kept over a new ROM, until ${EDIT_STATES} others came`);

  // jump arcs from two tiles: the first replaced
  const runs = direct.runStates(), lvHash = inputHash({ lv: 'test' });
  const arcs = (tx: number): ProbeMessage => ({ type: 'learn', lane: 'arcs', key: `arcs:${tx}`, input: thInput, job: { kind: 'arcs', level: lvHash, load: { level: 0x105, ov: ov5, spriteHeader: lv5.spriteHeader, height: 432 }, tx, ty: 0x16, runs }, replace: true });
  const ar = run(arcs(3), arcs(5));
  const arNow = atOnce<JumpArc[]>({ key: 'arcs:now', input: 'arcs', keep: 'memory', picture: false, start: (emu, prepare) => jumpArcsJob(emu, prepare, lvHash, { level: 0x105, ov: ov5, spriteHeader: lv5.spriteHeader, height: 432 }, 5, 0x16, runs) });
  check(ar.learned.length === 1 && ar.done?.type === 'learned' && ar.done.key === 'arcs:5' && !!ar.done.memory, 'jump arcs: the replaced request dropped, the latest in memory only');
  check(ar.done?.type === 'learned' && arNow.length === 8 && JSON.stringify(ar.done.result) === JSON.stringify(arNow), 'jump arcs: as on the main thread');

  // the layer 2 motions of level 105 and the overworld path kinds (no pictures, in the result cache)
  const l2Input = inputHash({ l2: 'test' });
  const l2 = run({ type: 'learn', lane: 'l2', key: 'l2m-test', input: l2Input, job: { kind: 'layer2Motions', level: 0x105, ov: ov5 }, replace: true });
  const l2Now = atOnce<Layer2Motions>({ key: 'l2m-test', input: l2Input, keep: true, picture: false, start: function* (emu) { return (yield* layer2MotionsJob(emu, 0x105, ov5)).result; } });
  check(l2.done?.type === 'learned' && !l2.done.failed && l2Now.paired.length === 16 && JSON.stringify(l2.done.result) === JSON.stringify(l2Now), 'layer 2 motions: as on the main thread');
  check(same(l2.put.get(storeKey('l2m-test', l2Input)), results.entry('l2m-test', l2Input) && { ...results.entry('l2m-test', l2Input)!, input: l2Input }),
    'layer 2 motions: their entry as on the main thread (key, input, bytes read: no picture)');
  const pk = run({ type: 'learn', lane: 'owpk3', key: 'owpk-test', job: { kind: 'pathKinds' }, replace: true });
  const pkNow = atOnce<PathKind[]>({ key: 'owpk-test', keep: true, picture: false, start: pathKindsJob });
  check(pk.done?.type === 'learned' && pkNow.length === 0x200 && JSON.stringify(pk.done.result) === JSON.stringify(pkNow), 'path kinds: as on the main thread');
  check(same(pk.put.get('owpk-test'), results.entry('owpk-test', undefined)), 'path kinds: their entry as on the main thread (bytes read: no picture)');

  // the prefab suggestions of some levels, the open one as edited (a 3×3 block of Direct Map16 tiles twice, once in
  // another level): as found directly; the run handed to the editor holds there (KeptSuggestions.held)
  const pr = new Rom(file.slice());
  installPrefabPatch(pr);
  const dm = (x: number, y: number, tile: number) => ({ uid: newUid(), num: 0, ext: DM16_EXT, x, y, size: 0, tile });
  const block = (x: number, y: number) => Array.from({ length: 9 }, (_, i) => dm(x + (i % 3), y + Math.floor(i / 3), 0x100 + i));
  const l6 = loadLevel(pr, 0x106);
  l6.objects.push(...block(0x24, 6));
  saveLevel(pr, l6);
  const edited = loadLevel(pr, 0x105), levels = [0x105, 0x106, 0x107];
  edited.objects.push(...block(0x20, 5), ...block(0x30, 8));
  const hp = new ProbeHost();
  hp.setRom(1, pr.data.slice());
  hp.handle({ type: 'learn', lane: 'prefab-suggest', key: 'suggest', input: '1', job: { kind: 'suggest', levels, open: edited }, replace: true });
  const sgOut: ProbeReply[] = [];
  while (hp.pending) { const d = hp.next(); if (d) sgOut.push(d); }
  const sgDone = sgOut.find((d) => d.type === 'learned');
  const sgEmu = new LevelEmulator(pr);
  sgEmu.boot();
  const sgNow = suggestPrefabs(pr, { levels, open: edited, emu: () => sgEmu });
  const sgRun = sgDone?.type === 'learned' ? sgDone.result as SuggestRun : undefined;
  check(!!sgRun && sgNow.length > 0 && JSON.stringify(sgRun.list) === JSON.stringify(sgNow) && sgOut.every((d) => !('put' in d) || !d.put.some(([k]) => k.startsWith('suggest'))),
    `prefab suggestions: as found directly (${sgNow.length}), nothing kept but the run`);
  const kept = new KeptSuggestions(new RomFingerprint(pr));
  if (sgRun) kept.adopt(sgRun);
  check(JSON.stringify(kept.held(pr, { levels, open: edited })) === JSON.stringify(sgNow), 'prefab suggestions: the run holds in the editor');

  // object boxes at sizes in level 105: as probed directly, to the editor only; probed again after a ROM change
  const sizes: SizeSpec[] = Array.from({ length: 32 }, (_, size) => ({ num: 0x21, ext: 0, size })); // (in three loads)
  const kl = { number: 0x105, header: lv5.header }, l2p = lv5.layer2Pointer;
  const sz = run({ type: 'learn', lane: 'sizes', key: 'sizes', input: '1', job: { kind: 'sizes', level: kl, layer2Pointer: l2p, specs: sizes }, replace: false });
  const sp = new SizeProbe(lr, kl, l2p);
  sp.probe(new LevelEmulator(lr), sizes);
  check(sz.done?.type === 'learned' && JSON.stringify(sz.done.result) === JSON.stringify(sizes.map((q) => sp.box(q))) && sz.put.size === 0 && (sz.done.result as unknown[]).some((b) => b !== null),
    'object boxes: as probed directly, nothing kept');
  const sz2 = run({ type: 'learn', lane: 'sizes', key: 'sizes', input: '2', job: { kind: 'sizes', level: kl, layer2Pointer: l2p, specs: sizes }, replace: false });
  h.handle({ type: 'edit', gen: 2, size: r.size, edits: [[0x7ff0, Uint8Array.of(r.data[0x7ff0])]] });
  const sz3 = run({ type: 'learn', lane: 'sizes', key: 'sizes', input: '3', job: { kind: 'sizes', level: kl, layer2Pointer: l2p, specs: sizes }, replace: false });
  check(!sz2.out.some((d) => d.type === 'learning') && sz2.done?.type === 'learned' && sz3.out.filter((d) => d.type === 'learning').length > 0 && JSON.stringify(sz3.done?.type === 'learned' && sz3.done.result) === JSON.stringify(sz.done?.type === 'learned' && sz.done.result),
    'object boxes: asked again, known without a load; after a ROM change probed again');
}

// The open level's work first (#393): the object boxes and the loads of a sprite set with the open level's sprites run
// before asked probes, the prefetch and the other lanes; the rest of the set then takes turns as before (an asked probe
// before it); a request with other sprites first while the set runs captures theirs next; the result and the parts'
// entries as without
{
  const r = new Rom(file), lv5 = loadLevel(r, 0x105);
  const level: SpriteLevel = { number: 0x105, header: lv5.header, spriteHeader: lv5.spriteHeader, bgPointer: 0xffd900 };
  const nums = [0x00, 0x04, 0x0d, 0x0f, 0x11, 0x1d, 0x21, 0x3e], input = inputHash({ set: 'test', nums }); // (loads 00 04 / 0d 0f 11 / 1d / 21 / 3e)
  const asked: ProbeJob = { kind: 'block', ts: 0, tile: 0x130 }, prefetched: ProbeJob = { kind: 'block', ts: 0, tile: 0x131 };
  const host = (first?: number[]) => {
    const h = new ProbeHost();
    h.setRom(1, r.data.slice());
    h.ask([asked]);
    h.setPrefetch([prefetched]);
    h.handle({ type: 'learn', lane: 'sprites', key: 'spr-set', input, job: { kind: 'sprites', level, nums, ...(first && { first }) }, replace: true });
    return h;
  };
  const drain = (h: ProbeHost, out: ProbeReply[] = []) => { while (h.pending) { const d = h.next(); if (d) out.push(d); } return out; };
  // what each reply is: a load of the set (its sprites shown), the set's end, a probe
  const what = (d: ProbeReply) => (d.type === 'probe' ? `probe ${d.job.kind === 'block' ? d.job.tile.toString(16) : ''}` : d.type === 'learning' ? (d.shown as [number][]).map(([n]) => n).sort((a, b) => a - b).map((n) => n.toString(16)).join(' ') : d.type);
  const parts = (out: ProbeReply[]) => JSON.stringify(out.flatMap((d) => ('put' in d ? d.put : [])).filter(([k]) => k.startsWith('spr-set/')).sort(([a], [b]) => (a < b ? -1 : 1)));
  const result = (out: ProbeReply[]) => { const d = out.find((x) => x.type === 'learned'); return d?.type === 'learned' ? JSON.stringify(d.result) : ''; };

  const plain = drain(host());
  const withFirst = drain(host([0x3e, 0x0d]));
  const order = withFirst.map(what);
  check(order[0] === 'd f 11' && order[1] === '3e' && order[2] === 'probe 130' && order.indexOf('probe 131') === order.length - 1,
    `sprite set: the loads of the level's sprites (0d, 3e) before the asked probe, the rest after it, the prefetch last (${order.join(', ')})`);
  check(result(withFirst) === result(plain) && result(plain) !== '' && parts(withFirst) === parts(plain), 'sprite set with the level\'s sprites first: the result and the parts\' entries as without');
  check(plain.map(what)[0] === 'probe 130', `sprite set without the level's sprites: after the asked probe, as before (${plain.map(what).join(', ')})`);

  // another level's sprites asked first while the set runs: their load next, before the asked probe
  const h = host([0x0d]), out: ProbeReply[] = [];
  for (let d = h.next(); ; d = h.next()) if (d) { out.push(d); break; }
  h.handle({ type: 'learn', lane: 'sprites', key: 'spr-set', input, job: { kind: 'sprites', level, nums, first: [0x21] }, replace: true });
  const retargeted = drain(h, out).map(what);
  check(retargeted[0] === 'd f 11' && retargeted[1] === '21' && retargeted[2] === 'probe 130', `sprite set asked with other sprites first: theirs next, before the asked probe (${retargeted.join(', ')})`);

  // a ROM change to a page the load of the level's sprites read (one the fewest other loads read), after it was
  // captured: the set starts over, that load again before the asked probe (the open level's work again)
  const putOf = (out: ProbeReply[]) => out.flatMap((d) => ('put' in d ? d.put : [])).filter(([k]) => k.startsWith('spr-set/'));
  const own = putOf(plain).map(([k, e]) => ({ k, pages: new Set(e.deps.pages) })), d0 = own.find((o) => o.k.startsWith(`spr-set/${spriteLoad(0x0d).toString(16)}`));
  const readers = (p: number) => own.filter((o) => o.pages.has(p)).length;
  const page = d0 && [...d0.pages].sort((a, b) => readers(a) - readers(b))[0];
  check(page !== undefined && readers(page) < own.length, `(a page the load of 0d read, not every load: ${page?.toString(16)}, ${own.map((o) => o.k.split('#')[0]).join(' ')})`);
  const he = host([0x0d]), heOut: ProbeReply[] = [];
  for (let d = he.next(); ; d = he.next()) if (d) { heOut.push(d); break; }
  const o = (page ?? 0) << 8, changed = r.data.slice();
  changed[o] ^= 1;
  he.handle({ type: 'edit', gen: 2, size: changed.length, edits: [[o, changed.slice(o, o + 1)]] });
  const afterEdit = drain(he, heOut);
  const restarted = afterEdit.findIndex((d, i) => i > 0 && d.type === 'learning' && d.fresh);
  check(what(afterEdit[0]) === 'd f 11' && restarted === 1 && what(afterEdit[1]) === 'd f 11' && what(afterEdit[2]) === 'probe 130',
    `sprite set started over by a ROM change: the level's load again before the asked probe (${afterEdit.map(what).join(', ')})`);

  // the object boxes before the asked probe, the prefetch and a lane taking turns (the levels' uses)
  const hs = new ProbeHost();
  hs.setRom(1, r.data.slice());
  hs.ask([asked]);
  hs.setPrefetch([prefetched]);
  hs.handle({ type: 'learn', lane: 'uses', key: 'uses', job: { kind: 'uses', levels: [0x106] }, replace: false });
  const sizes: SizeSpec[] = Array.from({ length: 32 }, (_, size) => ({ num: 0x21, ext: 0, size })); // (in three loads)
  hs.handle({ type: 'learn', lane: 'sizes', key: 'sizes', input: '1', job: { kind: 'sizes', level: { number: 0x105, header: lv5.header }, layer2Pointer: lv5.layer2Pointer, specs: sizes }, replace: false });
  const so = drain(hs), sizesAt = so.findIndex((d) => d.type === 'learned' && d.lane === 'sizes');
  check(sizesAt >= 0 && so.slice(0, sizesAt).every((d) => d.type !== 'probe' && !(d.type === 'learned' && d.lane === 'uses')),
    `object boxes: before the asked probe, the prefetch and the levels' uses (${so.map((d) => ('lane' in d ? `${d.type} ${d.lane}` : what(d))).join(', ')})`);
}

// the job runner under both owners (runnercheck.ts)
await checkJobRunner(check);

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
