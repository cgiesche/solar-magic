// Probe jobs (probehost.ts, run by the editor's probe worker): results as the prober's own, asked
// jobs before prefetched ones, a new ROM drops the queue; object kinds, level scan and camera as
// computed directly, a step at a time that lets asked jobs go first. A ROM change sent as the ranges it wrote keeps
// the queue and the tasks; only a task that read a changed byte starts over, before its next step (overworld edits
// restart nothing).
// A cancelled scan runs no further slice and goes on when asked for again. Results a task's slice found before a ROM
// change go with the next reply only if they hold on the new ROM. Jobs keep their result cache keys; only the scan
// can be cancelled. Learn jobs (the sprite images, the levels' uses, the sprite memory check, the animated tiles) as
// learned directly, with the result learner's entries, in lanes; prefetched probes take turns with the tasks.
import { readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { BlockProber, blockKey, collisionKey, spriteKey, runsKey, cameraKey } from '../src/core/blockprobe.ts';
import { ProbeHost } from '../src/core/probehost.ts';
import { jobId, jobKey, type ProbeJob, type ProbeMessage, type ProbeDone, type ProbeReply } from '../src/core/probeprotocol.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { ObjKindProbe, kindsKey, type ObjKinds } from '../src/core/objkinds.ts';
import { levelScanJob, type ScanLevel } from '../src/core/levelscan.ts';
import { cameraAtJob } from '../src/core/camerareach.ts';
import { runJob } from '../src/core/jobrunner.ts';
import { loadLevel, serializeLayer1, serializeSprites, L2_PTRS } from '../src/core/level.ts';
import { editorImage } from './fixture.ts';
import { checkJobRunner } from './runnercheck.ts';
import { gfxSkipMask, gfxDisplaySkipMask } from '../src/core/gfxpages.ts';
import { tilesetPointers, pointersKey, TILESETS } from '../src/core/tilesets.ts';
import { setActsLike, extTileWords, setExtTileWords } from '../src/core/map16ext.ts';
import { bgTileAddr } from '../src/core/bgmap16.ts';
import { FG_PALS, BACK_AREA } from '../src/core/sharedpal.ts';
import { setCustomPalette } from '../src/core/patches.ts';
import { captureSprites, captureSpriteAt, spriteSetJob, spriteLoad, spriteLoads, type SpriteLevel } from '../src/core/spritegfx.ts';
import { storeKey, type CacheEntry, type RomDeps } from '../src/core/romdeps.ts';
import { LevelUses, levelUsesJob, levelTilesKey } from '../src/core/levelusage.ts';
import { spriteMemCheckJob, usedSpriteMemory, SpriteGroupResults, type SpriteMemLevel, type SpriteMemResult } from '../src/core/spritemem.ts';
import { animatedJob, type Animated } from '../src/core/levelemu.ts';
import { inputHash } from '../src/core/inputs.ts';
import { ResultLearner } from '../src/core/learner.ts';
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
  && jobKey({ kind: 'sprite', ts: 2, num: 0x20d }) === spriteKey(2, 0x20d) && jobKey({ kind: 'runs', ts: 2 }) === runsKey(2)
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

// the entries hold in the editor's cache (same ROM) and equal the prober's results
const cache = new ResultCache(new RomFingerprint(rom));
for (const d of done) for (const [k, e] of d.put) cache.set(k, e.data, e.deps);
check(JSON.stringify(cache.get(blockKey(0, 0x11f))) === JSON.stringify(direct.probe(0x11f)), 'block 11F as probed directly');
check(JSON.stringify(cache.get(spriteKey(0, 0x0d))) === JSON.stringify(direct.probeSprite(0x0d)), 'sprite 0D as probed directly');

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
const kindProbe = new ObjKindProbe(emu, { ...lv, header: { ...lv.header, tileset: 1 } }, l2), kinds = kindProbe.result();
const scanned = runJob(levelScanJob(emu, scanLevel));
host.handle({ type: 'kinds', ts: 1, level: { number: lv.number, header: lv.header }, layer2Pointer: l2 });
host.handle({ type: 'scan', id: 7, key: 'scan-key', level: scanLevel });
host.handle({ type: 'camera', id: 9, key: 'camera-key', level: scanLevel, x: 0xbb8, y: 0x20 });
const replies: ProbeReply[] = [];
for (let i = 0; host.pending; i++) {
  if (i === 3) host.ask([{ kind: 'block', ts: 1, tile: 0x130 }]);
  const d = host.next();
  if (d) replies.push(d);
}
check(replies[0]?.type === 'probe', 'asked job before the rest of the tasks');
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
  const held = [blockKey(0, 0x130), spriteKey(0, 0x0d), kindsKey(1), 'scan-ow'].filter((k) => ed.get(k) !== undefined);
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
  const held2 = [blockKey(0, 0x130), spriteKey(0, 0x0d), kindsKey(1), 'scan-ow', 'scan-paint'].filter((k) => ed.get(k) !== undefined);
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
  const page = emu.bootReads!.pages.indexOf(1), o = page << 8;
  const flip = (gen: number) => { r.writeAt(o, Uint8Array.of(r.data[o] ^ 1)); h.handle({ type: 'edit', gen, size: r.size, edits: [[o, r.data.slice(o, o + 1)]] }); };
  flip(2); flip(3);
  check(h.started === started && h.pending === pending, 'a byte the scan read: nothing restarted at once, the kinds and the queue stay');
  // the same scan asked for again (the same key): the running one answers it
  h.handle({ type: 'scan', id: 5, key: 'scan-re', level: scanLevel });
  check(h.started === started, 'the same scan asked for again while it runs: not restarted');
  // (a prefetched probe first: they take turns with the tasks)
  const replies: ProbeReply[] = [];
  const first = h.next();
  if (first) replies.push(first);
  check(first?.type === 'probe' && h.started === started, 'a prefetched probe takes its turn after the tasks\' steps');
  h.next();
  check(h.started === started + 1, 'the scan started over before its next step');
  while (h.pending) { const d = h.next(); if (d) replies.push(d); }
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
  const o = emu.bootReads!.pages.indexOf(1) << 8, started2 = h.started;
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
// changed acts-like drops the results of that tile
{
  const r = new Rom(file), h = new ProbeHost(), ed = new ResultCache(new RomFingerprint(r));
  h.setRom(1, r.data.slice());
  const keep = (d: ProbeReply | null) => { for (const [k, e] of d?.put ?? []) ed.set(k, e.data, e.deps); return d; };
  const tiles = [0x025, 0x040, 0x0a0, 0x130, 0x200];
  const jobs: ProbeJob[] = [...tiles.flatMap((t): ProbeJob[] => [{ kind: 'block', ts: 0, tile: t }, { kind: 'collision', ts: 0, tile: t }]), { kind: 'sprite', ts: 0, num: 0x0d }, { kind: 'runs', ts: 0 }];
  h.ask(jobs);
  while (h.pending) keep(h.next());
  const keys = [...tiles.flatMap((t) => [blockKey(0, t), collisionKey(0, t)]), spriteKey(0, 0x0d), runsKey(0)];
  const ptrs = tilesetPointers(ptrEmu, 0).result;
  let gen = 1;
  const send = (change: () => void) => {
    const g = r.gen;
    change();
    h.handle({ type: 'edit', gen: ++gen, size: r.size, edits: r.changesSince(g)!.map(([a, e]) => [a, r.data.slice(a, e)]) });
  };
  const prober = (h as unknown as { prober: BlockProber }).prober; // (its boot snapshot: booted again when replaced)
  const edit = (what: string, change: () => void) => {
    const boot = prober.emu.baseState;
    send(change);
    const lost = keys.filter((k) => ed.get(k) === undefined);
    check(lost.length === 0, `${what}: no result dropped${lost.length ? ` (${lost.join(', ')})` : ''}`);
    h.ask([{ kind: 'block', ts: 0, tile: 0x025 }]);
    h.next();
    check(prober.emu.baseState === boot, `${what}: not booted again`);
    h.ask(jobs); // (the dropped ones again)
    while (h.pending) keep(h.next());
  };
  const draw = (snes: number) => r.writeAt(snesToPc(snes), Uint8Array.of(r.r8(snes) ^ 0x41));
  for (const t of [0x025, 0x040, 0x0a0, 0x130]) edit(`FG tile ${t.toString(16)} drawn`, () => draw(0x0d0000 | ptrs[t]));
  edit('extended FG tile 200 drawn', () => setExtTileWords(r, 0x200, extTileWords(r, 0x200)!.map((w) => w ^ 0x4000)));
  edit('BG tile 025 drawn', () => draw(bgTileAddr(r, 0x025)!));
  edit('shared FG palette 0 changed', () => draw(FG_PALS + 2));
  edit('back area color changed', () => draw(BACK_AREA));
  const colors = new Uint8Array(0x200).fill(0x21);
  edit('own palette of level 106 set', () => setCustomPalette(r, 0x106, colors));
  edit('own palette of the probe level set', () => setCustomPalette(r, 0x105, colors));
  edit('own palette of the probe level changed', () => setCustomPalette(r, 0x105, colors.map((c) => c ^ 3)));
  edit('own palette of the probe level removed', () => setCustomPalette(r, 0x105, null));

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
// the result cache entries as the result learner on the main thread makes them (key, input, bytes read: a picture,
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
    return [...spriteLoads(ids).values()].flatMap((l) => [...captureSprites(on, 0x105, lv5.header, lv5.spriteHeader, 0xffd900, l)]);
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
  const entry = done?.type === 'learned' ? done.put.find(([k]) => k === storeKey('spr-set', input))?.[1] : undefined;
  check(entry?.input === input && JSON.stringify(entry.data) === JSON.stringify(direct), 'sprite set: its result cache entry, with its input');

  // the main thread's result learner, as the editor sets it up
  const lr = new Rom(file), main = new LevelEmulator(lr), results = new ResultCache(new RomFingerprint(lr)), later: (() => void)[] = [];
  main.skipMask = () => gfxSkipMask(lr);
  main.boot();
  const learner = new ResultLearner({ rom: lr, results, cacheReady: Promise.resolve(), main, later: (_k, f) => later.push(f), soon: (f) => later.push(f), setBusy: () => {} });
  learner.learn('spr-set', (e, _p, part) => spriteSetJob(e, level, nums, () => {}, part), { input: { set: 'test', nums } });
  for (let i = 0; i < 100 && !results.entry('spr-set', input); i++) { await new Promise((f) => setTimeout(f, 0)); while (later.length) later.shift()!(); }
  const there = results.entry('spr-set', input);
  check(!!there && !!entry && JSON.stringify(there.deps) === JSON.stringify(entry.deps) && JSON.stringify(there.data) === JSON.stringify(entry.data),
    'sprite set: the same entry as the result learner on the main thread (bytes read)');
  check(!!entry && entry.deps.pages.some((p) => gfxDisplaySkipMask(r, Array.from({ length: TILESETS }, (_, ts) => tilesetPointers(ptrEmu, ts).result))[p << 8]),
    'sprite set: a picture, its reads keep the display data');

  // the same set again: the stored result at once
  h.handle({ type: 'learn', lane: 'sprites', key: 'spr-set', input, job: { kind: 'sprites', level, nums }, replace: true });
  const again = h.next();
  check(again?.type === 'learned' && again.put.some(([k]) => k === storeKey('spr-set', input)) && h.pending === 0, 'sprite set asked again: its stored result, with its entry');

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
  check(v0?.type === 'learned' && JSON.stringify(v0.result) === JSON.stringify(captureSpriteAt(capEmu, 0x105, lv5.header, lv5.spriteHeader, 0xffd900, 0x0d, 0, 0)), 'a variant as captured directly');
  const b1 = learned.find((d) => d.type === 'learned' && d.key === 'b:1');
  check(b1?.type === 'learned' && JSON.stringify(b1.result) === JSON.stringify(captureSprites(capEmu, 0x105, lv5.header, lv5.spriteHeader, 0xffd900, [0x0d], undefined, [1]).get(0x0d) ?? null), 'extra bytes as captured directly');

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
    return JSON.stringify([...spriteLoads(ids).values()].flatMap((l) => [...captureSprites(on, 0x105, lv5.header, lv5.spriteHeader, 0xffd900, l)]));
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

// the levels' uses, the sprite memory check and the animated tiles and colors (learn jobs, #177): results and entries
// (keys, inputs, bytes read) as the result learner on the main thread makes them: the uses in the levels' entries (the
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
  // the main thread's result learner, as the editor set it up
  const lr = new Rom(file), main = new LevelEmulator(lr), results = new ResultCache(new RomFingerprint(lr)), later: (() => void)[] = [];
  main.skipMask = () => gfxSkipMask(lr);
  main.boot();
  const learner = new ResultLearner({ rom: lr, results, cacheReady: Promise.resolve(), main, later: (_k, f) => later.push(f), soon: (f) => later.push(f), setBusy: () => {} });
  const drain = async (until: () => boolean) => {
    for (let i = 0; i < 2000 && !until(); i++) { await new Promise((f) => setTimeout(f, 0)); while (later.length) later.shift()!(); }
  };
  const same = (a: CacheEntry | undefined, b: CacheEntry | undefined) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

  // uses
  const levels = [0x105, 0x106, 0x107];
  const uses = run({ type: 'learn', lane: 'uses', key: 'uses', job: { kind: 'uses', levels }, replace: false });
  const shownLevels = uses.out.flatMap((d) => (d.type === 'learning' ? d.shown : []));
  check(shownLevels.join() === levels.join() && uses.done?.type === 'learned' && !uses.done.failed && uses.done.result === undefined, `uses: a level at a time, shown as it comes (${shownLevels.join()})`);
  const idx = new LevelUses(lr, results);
  let usesDone = false;
  learner.learn('uses', (emu) => levelUsesJob(idx, emu, levels, () => {}), { keep: false, picture: false, done: () => (usesDone = true) });
  await drain(() => usesDone);
  const there = levels.map((n) => results.under(levelTilesKey(n))[0]);
  check(there.every((e) => !!e && same(uses.put.get(e[0]), e[1])) && !uses.put.has('uses'), 'uses: the levels\' entries as the result learner\'s on the main thread (keys, inputs, bytes read: no picture), none of the job\'s');
  const again = run({ type: 'learn', lane: 'uses', key: 'uses', job: { kind: 'uses', levels }, replace: false });
  check(!again.out.some((d) => d.type === 'learning') && levels.every((n, i) => same(again.put.get(there[i][0]), there[i][1])),
    'uses asked again: the levels known, none loaded, their entries handed back (the editor asked: it has none)');

  // the sprite memory check of $E0 in level 00C (incomplete with the level's value: a suggestion)
  const lvc = loadLevel(r, 0xc), sprites = [{ uid: 1, num: 0xe0, x: 8, y: 0x14, extra: 0 }];
  const sm: SpriteMemLevel = { number: 0xc, header: lvc.header, bgPointer: 0xffd900, mem: lvc.spriteHeader & 0x3f, candidates: usedSpriteMemory(r), sprites };
  const smInput = inputHash({ sm: 'test' });
  const check1 = run({ type: 'learn', lane: 'spritemem', key: 'sm-test', input: smInput, job: { kind: 'spriteMem', level: sm }, replace: true });
  let smDone: unknown;
  learner.learn('sm-test', (emu) => spriteMemCheckJob(emu, sm, new SpriteGroupResults(results.fp)), { input: { sm: 'test' }, picture: false, done: (x) => (smDone = x) });
  await drain(() => smDone !== undefined);
  check(check1.done?.type === 'learned' && JSON.stringify(check1.done.result) === JSON.stringify(smDone) && (smDone as SpriteMemResult).lost.length === 1 && (smDone as SpriteMemResult).suggestion !== null, `sprite memory: the check as on the main thread (${JSON.stringify(smDone)})`);
  check(same(check1.put.get(storeKey('sm-test', smInput)), results.entry('sm-test', smInput) && { ...results.entry('sm-test', smInput)!, input: smInput }),
    'sprite memory: its entry as the result learner\'s (key, input, bytes read)');

  // the animated tiles and colors of level 105: in memory only
  const anInput = inputHash({ an: 'test' });
  const an = run({ type: 'learn', lane: 'animated', key: 'anim:test', input: anInput, job: { kind: 'animated', level: 0x105, ov: {} }, replace: true });
  let anDone: Animated | undefined;
  learner.learn('anim:test', (emu) => animatedJob(emu, 0x105, {}), { input: { an: 'test' }, keep: 'memory', done: (x) => (anDone = x) });
  await drain(() => anDone !== undefined);
  const res = an.done?.type === 'learned' ? an.done.result as Animated : undefined;
  check(!!res && !!anDone && res.tiles.size > 0 && [...res.tiles].join() === [...anDone.tiles].join() && [...res.colors].join() === [...anDone.colors].join(),
    `animated: the tiles and colors as on the main thread (${res?.tiles.size} tiles, ${res?.colors.size} colors)`);
  const mem = (learner as unknown as { runner: { memory: { entry(k: string, i: string): { data: unknown; deps: RomDeps } | undefined } } }).runner.memory.entry('anim:test', anInput);
  check(an.done?.type === 'learned' && !!mem && !an.put.has(storeKey('anim:test', anInput)) && an.done.memory?.input === anInput
    && JSON.stringify(an.done.memory.deps) === JSON.stringify(mem.deps), 'animated: kept in memory only, its entry handed back as the result learner keeps it (bytes read)');
}

// the job runner under both owners (runnercheck.ts)
await checkJobRunner(check);

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
