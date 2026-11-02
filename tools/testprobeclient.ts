// The editor's probe client (probeclient.ts) against a probe host (probehost.ts) in a stand-in
// worker the test runs by hand: a reply from before a ROM change does not make it ask again and
// again, results come in after it, and one still valid is kept, one whose bytes changed meanwhile not (asked again); after the first copy of the ROM it gets the
// ranges a change wrote; a broken worker hands everything
// wanted to the main thread, and without a worker it all runs there; a failed probe is not asked again until the ROM changes; the
// prefetch follows the tileset; object kinds are kept while the bytes they read are unchanged; a cancelled
// scan is told to the worker; learn jobs (the sprite images) come in as they run, with a worker and without; a lane's
// jobs can be dropped (telling their askers), an urgent one (or any, urged) runs without a worker while a dialog holds the background slices; a failed job
// asked again is FAILED without telling the asker again, the open level's last known tiles hold for their level and ROM
// state only, a progress reply from an older ROM shows nothing. A sprite set is kept as its parts only, the parts sent with a
// request only for their current inputs; the level as edited goes to the worker whole once (#232).
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { BlockProber } from '../src/core/blockprobe.ts';
import { ProbeHost } from '../src/core/probehost.ts';
import { jobKey, EDIT_STATES, type ProbeJob, type ProbeMessage, type ProbeReply } from '../src/core/probeprotocol.ts';
import { ProbeClient, FAILED } from '../src/core/probeclient.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, L2_PTRS } from '../src/core/level.ts';
import { ObjKindProbe, kindsKey, type ObjKinds } from '../src/core/objkinds.ts';
import type { ScanLevel } from '../src/core/levelscan.ts';
import { captureSprites, spriteLoad, spriteSetParts, type SpriteLevel } from '../src/core/spritegfx.ts';
import type { LearnJob } from '../src/core/probeprotocol.ts';
import { inputHash, editState } from '../src/core/inputs.ts';
import { partKey } from '../src/core/jobrunner.ts';
import { serialize } from 'node:v8';
import { levelTilesKey, levelOverride, OpenLevelTiles, type LevelTiles } from '../src/core/levelusage.ts';
import { editorImage } from './fixture.ts';

const EDITOR_IMAGE = await editorImage(); // the fixture as the editor opens it

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
// a new ROM generation that nothing a probe read differs in (the internal name)
const touch = (rom: Rom) => rom.writeAt(0x7fc0, Uint8Array.of(rom.data[0x7fc0] ^ 1));
const file = EDITOR_IMAGE.slice();
const direct = new BlockProber(new Rom(file));
const settle = () => new Promise((r) => setTimeout(r, 0)); // (stored results are awaited first)

const isBlock = (j: ProbeJob, tile: number) => j.kind === 'block' && j.tile === tile;

// a worker the test runs: messages go to a probe host, replies come back when run() is called
class Worker {
  host = new ProbeHost();
  sent: ProbeMessage[] = [];
  reply!: (d: ProbeReply) => void;
  failed!: () => void;
  connect = (reply: (d: ProbeReply) => void, failed: () => void) => {
    this.reply = reply;
    this.failed = failed;
    return (m: ProbeMessage) => { this.sent.push(m); this.host.handle(m); };
  };
  // the next n replies (all by default), each passed through edit
  run(n = Infinity, edit = (d: ProbeReply) => d): ProbeReply[] {
    const out: ProbeReply[] = [];
    while (n > 0 && this.host.pending) { const d = this.host.next(); if (d) { out.push(d); this.reply(edit(d)); n--; } }
    return out;
  }
  // ask messages with block tile's job
  asks(tile: number) { return this.sent.filter((m) => m.type === 'ask' && m.jobs.some((j) => isBlock(j, tile))).length; }
}

function editor(worker: Worker | null) {
  const rom = new Rom(file.slice()), emu = new LevelEmulator(rom);
  const steps: [string, () => void][] = [];
  const e = {
    rom, emu, ts: 0, ready: 0, progress: 0, kindsReady: 0, busy: new Map<string, string>(), steps, soon: [] as (() => void)[],
    results: new ResultCache(new RomFingerprint(rom)),
    client: null as unknown as ProbeClient,
    // background slices on the main thread (the prefetch after a ROM change only when asked)
    drain(prefetch = false) {
      for (let i = 0; i < steps.length;) {
        if (!prefetch && steps[i][0] === 'probe-prefetch') { i++; continue; }
        steps.splice(i, 1)[0][1]();
      }
    },
  };
  e.client = new ProbeClient({
    results: e.results, cacheReady: Promise.resolve(),
    rom: () => rom, tileset: () => e.ts,
    connect: worker ? worker.connect : undefined,
    later: (key, step) => steps.push([key, step]),
    soon: (step) => e.soon.push(step),
    setBusy: (key, label) => { if (label === null) e.busy.delete(key); else e.busy.set(key, label); },
    ready: () => e.ready++,
    progress: () => e.progress++,
    kindLevel: () => {
      const lv = loadLevel(rom, 0x105);
      return { level: { number: lv.number, header: lv.header }, layer2Pointer: rom.r24(L2_PTRS + 0x105 * 3) };
    },
    kindsReady: () => e.kindsReady++,
  });
  return e;
}

// a reply from before a ROM change: the job is asked once more, not again and again, and its
// result comes in
{
  const w = new Worker(), e = editor(w);
  check(e.client.block(0x11f) === undefined, 'unknown block: asked for');
  await settle();
  const genBefore = e.rom.gen;
  touch(e.rom); // the ROM changed (nothing the probe reads)
  check(e.client.block(0x11f) === undefined, 'asked again after the ROM change');
  await settle();
  w.run(1, (d) => ({ ...d, gen: genBefore })); // a reply as from the generation before
  for (let i = 0; i < 5; i++) { e.client.block(0x11f); await settle(); }
  check(w.asks(0x11f) <= 3, `old reply: asked ${w.asks(0x11f)} times, not again and again`);
  w.run();
  check(JSON.stringify(e.client.block(0x11f)) === JSON.stringify(direct.probe(0x11f)), 'block 11F as probed directly');
  check(e.ready > 0 && !e.busy.has('probe'), "'ready' told, nothing busy");
}

// a reply from before a ROM change that did not touch what the probe read: kept, the job is done
{
  const w = new Worker(), e = editor(w);
  e.client.block(0x130);
  await settle();
  const old = w.host.next(); // (computed on the ROM before, not handed over yet)
  touch(e.rom);
  e.client.block(0x130); // (the client sees the change: sends the new ROM and the job again)
  await settle();
  check(old?.type === 'probe' && old.gen !== e.rom.gen && w.sent.some((m) => m.type === 'edit' && m.gen === e.rom.gen), 'reply from the generation before');
  w.reply(old!);
  check(JSON.stringify(e.client.block(0x130)) === JSON.stringify(direct.probe(0x130)), 'its result is kept: still valid');
  check(e.ready === 1 && !e.busy.has('probe'), "job done: 'ready' told, nothing busy");
  check(e.progress === 1, "job done: 'progress' told once");
}

// a reply from before a ROM change that changed what the probe read: not taken (though the cache is already synced
// to the new ROM when it comes), the job is asked once more; a reply from the current ROM is taken without a check
{
  const w = new Worker(), e = editor(w);
  e.client.block(0x130);
  await settle();
  const old = w.host.next(); // (computed on the ROM before, not handed over yet)
  const deps = old?.type === 'probe' ? old.put.find(([k]) => k === jobKey(old.job))?.[1].deps : undefined;
  const read = deps ? (deps.pages.length ? (deps.pages[0] << 8) | 0xff : deps.bytes[0]) : 0;
  check(!!deps && (deps.pages.length > 0 || deps.bytes.length > 0), '(the probe read ROM bytes)');
  e.rom.writeAt(read, Uint8Array.of(e.rom.data[read] ^ 1));
  e.client.block(0x130); // (the worker gets the edit)
  await settle();
  e.results.fp.sync(); // (the cache has seen the new ROM, as any result used meanwhile makes it)
  const asks = w.asks(0x130);
  w.reply(old!);
  check(e.client.block(0x130) === undefined, 'a byte it read changed meanwhile: its result is not taken');
  await settle();
  check(w.asks(0x130) > asks, '… and the job is asked once more');
  let checks = 0;
  const valid = e.results.fp.valid.bind(e.results.fp);
  e.results.fp.valid = (d) => { checks++; return valid(d); };
  w.run();
  check(e.client.block(0x130) !== undefined && checks === 0, `a reply from the current ROM: taken without a check (${checks} checks)`);
}

// after the first copy of the ROM the worker gets the ranges a change wrote; the whole ROM again (with what is
// still wanted) only when the ROM's log of changes doesn't reach back that far
{
  const w = new Worker(), e = editor(w);
  e.client.block(0x130);
  await settle();
  e.rom.writeAt(0x7fc0, Uint8Array.of(0x41, 0x42));
  e.client.block(0x131);
  await settle();
  const roms = w.sent.filter((m) => m.type === 'rom'), edits = w.sent.filter((m) => m.type === 'edit');
  check(roms.length === 1 && edits.length === 1, 'one copy of the ROM, then an edit');
  const ed = edits[0];
  check(ed?.type === 'edit' && ed.size === e.rom.size && ed.edits.length === 1 && ed.edits[0][0] === 0x7fc0 && ed.edits[0][1].join() === '65,66', 'the edit: the changed bytes at their offset');
  check(w.sent.filter((m) => m.type === 'ask' && m.jobs.some((j) => isBlock(j, 0x130))).length === 1, 'jobs asked before the edit: not sent again');
  for (let i = 0; i < 9000; i++) e.rom.w8(0x00ffc0, i);
  e.client.block(0x132);
  await settle();
  check(w.sent.filter((m) => m.type === 'rom').length === 2 && w.asks(0x130) === 2, 'the log does not reach back: the whole ROM, the asked jobs again');
  w.run();
  check(JSON.stringify(e.client.block(0x130)) === JSON.stringify(direct.probe(0x130)), 'block 130 as probed directly');
  // a new size: the whole ROM (the worker starts anew), with what is still wanted
  e.client.block(0x133);
  await settle();
  e.rom.expand(e.rom.size * 2);
  e.client.block(0x134);
  await settle();
  check(w.sent.filter((m) => m.type === 'rom').length === 3 && w.asks(0x133) === 2, 'a new size: the whole ROM, the asked jobs again');
  w.run();
  check(e.client.block(0x133) !== undefined && !e.busy.has('probe'), '… and answered');
}

// the worker breaks down: asked probes and object kinds go to the main thread
{
  const w = new Worker(), e = editor(w);
  e.client.block(0x130);
  e.client.kinds(1);
  await settle();
  w.failed();
  await settle();
  e.drain();
  check(JSON.stringify(e.client.block(0x130)) === JSON.stringify(direct.probe(0x130)), 'worker failed: block 130 probed on the main thread');
  const kinds = e.client.kinds(1);
  check(kinds !== undefined && kinds !== null && e.kindsReady === 1, 'worker failed: object kinds found on the main thread');
  check(!e.busy.has('probe') && !e.busy.has('kinds'), 'nothing busy after');
}

// no worker: probes and object kinds run on the main thread, in background slices to the end
{
  const e = editor(null);
  e.client.block(0x130);
  e.client.sprite(0x0d);
  e.client.kinds(1);
  await settle();
  e.drain();
  check(JSON.stringify(e.client.block(0x130)) === JSON.stringify(direct.probe(0x130)), 'no worker: block 130 probed on the main thread');
  check(JSON.stringify(e.client.sprite(0x0d)) === JSON.stringify(direct.probeSprite(0x0d)), 'no worker: sprite 0D probed on the main thread');
  const kinds = e.client.kinds(1);
  check(kinds !== undefined && kinds !== null && e.kindsReady === 1, 'no worker: object kinds found on the main thread');
  check(e.ready === 1 && !e.busy.has('probe') && !e.busy.has('kinds') && !e.steps.some(([k]) => k === 'probe'), 'no worker: done, nothing busy, no slice left');
}

// a failed probe is not asked again until the ROM changes
{
  const w = new Worker(), e = editor(w);
  e.client.block(0x2b);
  await settle();
  w.run(Infinity, (d) => d.type === 'probe' ? { ...d, put: [], failed: true } : d);
  const n = w.asks(0x2b);
  e.client.block(0x2b);
  await settle();
  check(w.asks(0x2b) === n, 'failed probe: not asked again');
  touch(e.rom);
  e.client.block(0x2b);
  await settle();
  check(w.asks(0x2b) > n, 'after a ROM change: asked again');
}

// the prefetch follows the tileset: another tileset's queue is dropped
{
  const w = new Worker(), e = editor(w);
  e.client.prefetch([0x300]);
  await settle();
  e.ts = 2;
  e.client.prefetch();
  await settle();
  const pf = w.sent.filter((m) => m.type === 'prefetch');
  check(pf.length === 2 && pf[0].type === 'prefetch' && pf[0].jobs.some((j) => isBlock(j, 0x300)), 'prefetch of tileset 0 with the extra tile');
  check(pf[1]?.type === 'prefetch' && pf[1].jobs.length > 0 && pf[1].jobs.every((j) => j.ts === 2), 'tileset 2: only its jobs');
}

// object kinds: asked like probes, kept in the result cache while the bytes the object routines
// read are unchanged, also across sessions; failed ones wait for a ROM change
{
  const lv = loadLevel(new Rom(file), 0x105);
  const direct = new ObjKindProbe(new LevelEmulator(new Rom(file)), { ...lv, header: { ...lv.header, tileset: 1 } }, new Rom(file).r24(L2_PTRS + 0x105 * 3)).result();
  const same = (k: ObjKinds | null | undefined) => !!k && JSON.stringify([...k.kinds]) === JSON.stringify([...direct.kinds]);
  const kindsSent = (w: Worker) => w.sent.filter((m) => m.type === 'kinds').length;

  const w = new Worker(), e = editor(w);
  check(e.client.kinds(1) === undefined && e.busy.has('kinds'), 'kinds: unknown, asked for');
  e.client.kinds(1);
  await settle();
  check(kindsSent(w) === 1, 'kinds: asked once');
  w.run();
  check(same(e.client.kinds(1)) && e.kindsReady === 1 && !e.busy.has('kinds'), 'kinds: as computed directly, told once');

  const entry = e.results.entry(kindsKey(1))!;
  const read = entry.deps.bytes[0], unread = 0x7fc0;
  check(!entry.deps.bytes.includes(unread), '(the internal name is not read by object routines)');
  e.rom.writeAt(unread, Uint8Array.of(e.rom.data[unread] ^ 1));
  check(same(e.client.kinds(1)), 'kinds: a byte they did not read changed: still known');
  await settle();
  check(kindsSent(w) === 1, '… and not asked again');
  e.rom.writeAt(read, Uint8Array.of(e.rom.data[read] ^ 1));
  check(e.client.kinds(1) === undefined, 'kinds: a byte they read changed: unknown again');
  e.client.kinds(1);
  await settle();
  check(kindsSent(w) === 2, '… and asked once more');

  const w2 = new Worker(), e2 = editor(w2);
  e2.results.load([[kindsKey(1), entry]]);
  check(same(e2.client.kinds(1)), 'stored kinds (another session): used at once');
  await settle();
  check(kindsSent(w2) === 0, '… without asking');

  const w3 = new Worker(), e3 = editor(w3);
  e3.client.kinds(1);
  await settle();
  w3.run(Infinity, (d) => d.type === 'kinds' ? { ...d, failed: true, put: [] } : d);
  check(e3.client.kinds(1) === null && e3.kindsReady === 1 && !e3.busy.has('kinds'), 'failed kinds: null');
  await settle();
  check(kindsSent(w3) === 1, '… not asked again');
  touch(e3.rom);
  check(e3.client.kinds(1) === undefined, 'after a ROM change: asked again');
}

// a scan not wanted any more: the worker is told (only when one was asked for), and nothing is busy with it
{
  const w = new Worker(), e = editor(w);
  const cancels = () => w.sent.filter((m) => m.type === 'cancel' && m.task === 'scan').length;
  e.client.cancelScan();
  check(cancels() === 0, 'no scan asked for: no cancel sent');
  const level: ScanLevel = { number: 0x105, ov: {}, vertical: false, width: 256, height: 432 };
  e.client.requestScan(1, 'scan-key', level, () => {});
  await settle();
  e.client.cancelScan();
  check(cancels() === 1 && w.host.pending === 0 && !e.busy.has('scan'), 'scan cancelled: the worker told, it runs nothing');
  e.client.cancelScan();
  check(cancels() === 1, '… once');
}

// learn jobs (sprite images, #175): with a worker the main thread captures nothing, it gets the images as they come and
// the result with its entry (key and input); asked again, the stored result; replace drops the lane's other jobs, also
// when the result is known; a failed one waits for a ROM change; without a worker they run on the main thread
{
  const lv = loadLevel(new Rom(file), 0x105);
  const level: SpriteLevel = { number: 0x105, header: lv.header, spriteHeader: lv.spriteHeader, bgPointer: 0xffd900 };
  const nums = [0x0d, 0x0f, 0x11, 0x1d, 0x21, 0x3e, 0x04], input = { set: 'test' };
  const capEmu = new LevelEmulator(new Rom(file));
  // (a test level load per sprites of one spriteLoad, in the order of their first sprite)
  const loads = [[0x0d, 0x0f, 0x11], [0x1d], [0x21], [0x3e], [0x04]];
  check(loads.every((l) => l.every((n) => spriteLoad(n) === spriteLoad(l[0]))), '(the test level loads as grouped)');
  const direct = JSON.stringify(loads.flatMap((l) => [...captureSprites(capEmu, 0x105, lv.header, lv.spriteHeader, 0xffd900, l)]));
  const job: LearnJob = { kind: 'sprites', level, nums };
  const learns = (w: Worker) => w.sent.filter((m) => m.type === 'learn').length;

  const w = new Worker(), e = editor(w);
  const shown: (unknown[] | null)[] = [], done: unknown[] = [];
  const opts = { input, lane: 'sprites' as const, replace: true, label: 'Sprite graphics', done: (r: unknown) => done.push(r), shown: (i: unknown[] | null) => shown.push(i) };
  check(e.client.learn('spr', job, opts) === undefined && e.busy.get('sprites') === 'Sprite graphics', 'learn: unknown, asked for, busy');
  e.client.learn('spr', job, opts);
  await settle();
  check(learns(w) === 1, 'learn: asked once');
  const replies = w.run(1);
  check(replies[0]?.type === 'learning' && shown.length === 2 && shown[0] === null && (shown[1]?.length ?? 0) > 0 && e.busy.get('sprites') === 'Sprite graphics 20 %', `learn: the first images as they come, the progress label (${e.busy.get('sprites')})`);
  w.run();
  check(done.length === 1 && JSON.stringify(done[0]) === direct && JSON.stringify(shown.slice(1).flat()) === direct, 'learn: the result and the images shown as captured directly');
  // (#232: the images stored once, as the set's parts: not again as the whole set)
  const partsOf = (c: ResultCache) => spriteSetParts(nums).map((p) => c.get(partKey('spr', p.sub), p.input));
  check(e.results.get('spr', inputHash(input)) === undefined && JSON.stringify(partsOf(e.results).flat()) === direct && !e.busy.has('sprites'),
    'learn: in the result cache as its parts only (under its key and their inputs), nothing busy');
  check(e.steps.every(([k]) => k === 'probe-prefetch'), 'learn: the main thread ran nothing for it');
  const again = e.client.learn('spr', job, opts);
  check(JSON.stringify(again) === direct, 'learn: asked again, the stored result (put together from its parts)');
  check(again === done[0] && e.client.learn('spr', job, opts) === again, '… the same result as told to the asker, and on every request');
  await settle();
  check(learns(w) === 1, '… not asked again');

  // the stored test level loads go with the request (#176): a worker without them captures none
  const w3 = new Worker(), e3 = editor(w3), done3: unknown[] = [];
  // (all loads but one; #232: that one stored for another input – of a set before a change – stays here)
  const [[k0, e0], ...others] = e.results.under('spr/');
  e3.results.setAll(others, true);
  e3.results.set(k0.split('#')[0], e0.data, e0.deps, 'stale');
  e3.results.set('spr', e0.data, e0.deps, inputHash(input)); // (the whole set as kept before #232)
  e3.client.learn('spr', job, { ...opts, done: (r) => done3.push(r) });
  await settle();
  const sent3 = w3.sent.find((m) => m.type === 'learn');
  const got3 = w3.run();
  check(sent3?.type === 'learn' && sent3.parts?.length === loads.length - 1 && sent3.parts.every(([, p]) => p.input !== 'stale'),
    `learn: the stored loads for their current inputs sent with it (${sent3?.type === 'learn' && sent3.parts?.length}), not another input's`);
  check(got3.filter((d) => d.type === 'learning').length === 1 && done3.length === 1 && JSON.stringify(done3[0]) === direct, '… only the other load captured, the same images');
  check(e3.results.get('spr', inputHash(input)) === undefined, '… the whole set as kept before dropped');

  // replace: another set drops the variants asked before it (the worker told), also when it is known
  const at = (x: number): LearnJob => ({ kind: 'spriteAt', level, id: 0x0d, x, y: 0 });
  e.client.learn('v1', at(1), { input, lane: 'variants' });
  e.client.learn('v2', at(2), { input, lane: 'variants', label: (n) => `Sprite variants (${n})` });
  check(e.busy.get('variants') === undefined, '(the first job of a lane gives the label: none)');
  e.client.learn('spr', job, { ...opts, lane: 'variants' }); // (known)
  check(w.sent.some((m) => m.type === 'unlearn' && m.lane === 'variants') && !e.busy.has('variants'), 'replace by a known result: the lane dropped in the worker, nothing busy');

  // a failed job: told to the asker (failed); not asked again until the ROM changes (told at once then)
  let fails = 0;
  e.client.learn('v3', at(3), { input, lane: 'variants', failed: () => fails++ });
  await settle();
  w.run(Infinity, (d) => d.type === 'learned' ? { ...d, failed: true, result: null, put: [] } : d);
  check(fails === 1, 'failed learn job: told to the asker');
  const n = learns(w);
  check(e.client.learn('v3', at(3), { input, lane: 'variants', failed: () => fails++ }) === undefined && learns(w) === n && fails === 2, 'failed learn job: not asked again, told at once');
  touch(e.rom);
  e.client.learn('v3', at(3), { input, lane: 'variants' });
  await settle();
  check(learns(w) === n + 1, '… after a ROM change: asked again');

  // no worker: on the main thread, in background slices
  const e2 = editor(null), done2: unknown[] = [];
  e2.client.learn('spr', job, { ...opts, done: (r) => done2.push(r) });
  await settle();
  e2.drain();
  check(done2.length === 1 && JSON.stringify(done2[0]) === direct && JSON.stringify(partsOf(e2.results).flat()) === direct, 'no worker: captured on the main thread');
}

// the levels' uses and the animated tiles and colors (#177): the uses come in the levels' entries as each level is
// learned (shown), the job keeps nothing of its own; the animated ones are kept in memory only, asked again the result at
// once (also after a ROM change of nothing they read)
{
  const w = new Worker(), e = editor(w);
  const shown: unknown[] = [];
  let usesDone = 0;
  e.client.learn('uses', { kind: 'uses', levels: [0x105, 0x106] }, { lane: 'uses', label: 'Uses in levels', shown: (l) => { if (l) shown.push(...l); }, done: () => usesDone++ });
  await settle();
  w.run();
  check(shown.join() === [0x105, 0x106].join() && usesDone === 1 && [0x105, 0x106].every((n) => e.results.under(levelTilesKey(n)).length === 1) && !e.busy.has('uses'),
    'uses: shown a level at a time, in the levels\' entries, done');
  check(e.steps.every(([k]) => k === 'probe-prefetch'), 'uses: the main thread loaded no level');

  // asked again with another list while it runs (#230): the request reaches the worker, the running job takes up the
  // latest list; an edit during the scan asks once more for the reply of the generation before, not for every reply
  const usesSent = () => w.sent.filter((m) => m.type === 'learn' && m.key === 'uses');
  shown.length = 0;
  const usesOpts = { lane: 'uses' as const, label: 'Uses in levels', shown: (l: unknown[] | null) => { if (l) shown.push(...l); }, done: () => usesDone++ };
  e.client.learn('uses', { kind: 'uses', levels: [0x107, 0x108, 0x109] }, usesOpts);
  await settle();
  for (let i = 0; i < 1000 && !shown.length && w.host.pending; i++) w.run(1);
  const before = usesSent().length;
  e.client.learn('uses', { kind: 'uses', levels: [0x10a] }, usesOpts);
  await settle();
  const last = usesSent().at(-1);
  check(usesSent().length === before + 1 && last?.type === 'learn' && last.job.kind === 'uses' && last.job.levels.join() === [0x10a].join(), 'uses asked with another list: the request reaches the worker');
  w.run();
  check(shown.join() === [0x107, 0x10a].join() && usesDone === 2, `… the running job takes up the latest list (${shown.map((n) => (n as number).toString(16)).join()})`);

  e.client.learn('uses', { kind: 'uses', levels: [0x10b] }, usesOpts);
  await settle();
  const genBefore = e.rom.gen;
  touch(e.rom);
  e.client.learn('uses', { kind: 'uses', levels: [0x10b] }, usesOpts); // (sends the edit)
  const sent0 = usesSent().length;
  // (the job's replies as from the generation before, until it is done: the worker then runs it again)
  for (let i = 0; i < 1000 && w.host.pending; i++) if (w.run(1, (d) => ({ ...d, gen: genBefore }))[0]?.type === 'learned') break;
  const old: ProbeReply = { type: 'learned', gen: genBefore, lane: 'uses', key: 'uses', input: undefined, result: undefined, failed: false, put: [] };
  w.reply(old);
  w.reply(old);
  check(usesSent().length === sent0 + 1, `replies from the generation before: asked once more (${usesSent().length - sent0})`);
  w.run();
  check(usesDone === 3 && !e.busy.has('uses'), '… its reply done');

  const job: LearnJob = { kind: 'animated', level: 0x105, ov: {} }, opts = { input: { an: 1 }, lane: 'animated' as const, replace: true };
  let anDone = 0;
  check(e.client.learn('anim:105', job, { ...opts, done: () => anDone++ }) === undefined, 'animated: unknown, asked for');
  await settle();
  w.run();
  const learns = () => w.sent.filter((m) => m.type === 'learn').length, n = learns();
  const got = e.client.learn<{ tiles: Set<number> }>('anim:105', job, opts);
  check(anDone === 1 && (got?.tiles.size ?? 0) > 0 && e.results.get('anim:105', inputHash({ an: 1 })) === undefined, 'animated: kept in memory, not in the result cache');
  touch(e.rom);
  check(e.client.learn('anim:105', job, opts) === got, '… after a ROM change of nothing it read: the same');
  await settle();
  check(learns() === n, '… not asked again');
}

// a lane's jobs not wanted any more (#179): dropped in the worker, nothing busy. Without a worker an urgent job (one a
// dialog shows) runs while the background slices wait for the dialog, another one doesn't
{
  const w = new Worker(), e = editor(w), lv = loadLevel(e.rom, 0x105);
  const sizes = (size: number): LearnJob => ({ kind: 'sizes', level: { number: 0x105, header: lv.header }, layer2Pointer: lv.layer2Pointer, specs: [{ num: 0x21, ext: 0, size }] });
  e.client.learn('sizes', sizes(3), { lane: 'sizes', input: 3, label: 'Sizes' });
  await settle();
  e.client.unlearn('sizes');
  check(w.sent.some((m) => m.type === 'unlearn' && m.lane === 'sizes') && !e.busy.has('sizes') && w.run().length === 0, 'unlearn: the lane dropped in the worker, nothing busy');

  const e2 = editor(null);
  let done = 0;
  e2.client.learn('sizes', sizes(3), { lane: 'sizes', input: 3, urgent: true, done: () => done++ });
  await settle();
  for (let i = 0; i < 100 && e2.soon.length; i++) e2.soon.shift()!();
  check(done === 1, 'no worker: an urgent job runs while the background slices wait');
  e2.client.learn('sizes', sizes(4), { lane: 'sizes', input: 4, done: () => done++ });
  await settle();
  for (let i = 0; i < 100 && e2.soon.length; i++) e2.soon.shift()!();
  check(done === 1 && e2.steps.some(([k]) => k === 'probe'), '… another one waits for them');
  e2.drain();
  check(done === 2, '… and runs then');
}

// waits that a dialog shows (#252): without a worker, urge() runs the probes and learn jobs while the dialog holds
// the background slices, until released; a job dropped (unlearn, or replaced by another) tells its asker
{
  const e = editor(null);
  e.client.block(0x130);
  await settle();
  for (let i = 0; i < 100 && e.soon.length; i++) e.soon.shift()!();
  check(e.client.block(0x130) === undefined && e.steps.some(([k]) => k === 'probe'), 'no worker: a probe waits for the background slices');
  const release = e.client.urge();
  for (let i = 0; i < 1000 && e.soon.length && e.client.block(0x130) === undefined; i++) e.soon.shift()!();
  check(e.client.block(0x130) !== undefined, '… urged: it runs while they wait');
  release();
  e.client.block(0x131);
  await settle();
  for (let i = 0; i < 100 && e.soon.length; i++) e.soon.shift()!();
  check(e.client.block(0x131) === undefined, '… released: the next one waits again');

  const w = new Worker(), e2 = editor(w), lv = loadLevel(e2.rom, 0x105);
  const sizes = (size: number): LearnJob => ({ kind: 'sizes', level: { number: 0x105, header: lv.header }, layer2Pointer: lv.layer2Pointer, specs: [{ num: 0x21, ext: 0, size }] });
  let dropped = 0, done = 0;
  e2.client.learn('sz3', sizes(3), { lane: 'sizes', input: 3, done: () => done++, dropped: () => dropped++ });
  e2.client.unlearn('sizes');
  check(dropped === 1 && done === 0, 'unlearn: the dropped job tells its asker');
  e2.client.learn('sz3', sizes(3), { lane: 'sizes', input: 3, done: () => done++, dropped: () => dropped++ });
  e2.client.learn('sz4', sizes(4), { lane: 'sizes', input: 4, replace: true, done: () => done++ });
  check(dropped === 2, '… replaced by another: too');
  await settle();
  w.run();
  check(done === 1 && dropped === 2, '… the replacing one is done, the dropped one not told again');
}

// the open level's tiles (#226, #229): a failed job is told once as it fails, asked again it is FAILED without telling
// the asker again (who redraws on it); the last known ones only for the level and ROM state they were learned at
{
  const w = new Worker(), e = editor(w), lv = loadLevel(e.rom, 0x105);
  const job: LearnJob = { kind: 'levelTiles', state: editState(lv, levelOverride(e.rom, lv)) }, input = { lt: 1 };
  let fails = 0;
  const opts = { input, lane: 'lt' as const, replace: true, failed: () => fails++ };
  check(e.client.learnOrFailed('lt:105', job, opts) === undefined, 'open level tiles: unknown, asked for');
  await settle();
  w.run(Infinity, (d) => d.type === 'learned' ? { ...d, failed: true, result: null, put: [], memory: undefined } : d);
  check(fails === 1 && !e.busy.has('lt'), 'failed: told once, nothing busy');
  check(e.client.learnOrFailed('lt:105', job, opts) === FAILED && fails === 1, '… asked again: FAILED, not told again');
  touch(e.rom);
  check(e.client.learnOrFailed('lt:105', job, opts) === undefined, '… after a ROM change: asked again');
  await settle();
  w.run();
  const got = e.client.learnOrFailed<LevelTiles>('lt:105', job, opts);
  check(got !== FAILED && got?.level === 0x105 && got.fg.length > 0, '… and learned');

  const tiles = (level: number): LevelTiles => ({ level, tileset: 0, ok: true, fg: [], bg: [] });
  const open = new OpenLevelTiles(), a = tiles(0x105), b = tiles(0x106);
  check(open.shown(0x105, 1, a).tiles === a && open.shown(0x105, 1, a).state === 'known', 'open tiles: known');
  const p = open.shown(0x105, 1, undefined);
  check(p.tiles === a && p.state === 'pending', '… learned again: the last known meanwhile');
  const f = open.shown(0x105, 1, undefined, true);
  check(f.tiles === a && f.state === 'failed', '… failed: the last known, failed');
  check(open.shown(0x105, 2, undefined).tiles === null, '… after a ROM change: none');
  open.shown(0x105, 2, a);
  check(open.shown(0x106, 2, undefined).tiles === null && open.shown(0x105, 2, undefined).tiles === null, '… another level\'s: none, also back at the first');
  check(open.shown(0x106, 2, b).tiles === b, '… known for the other level');
}

// a progress reply from an older ROM generation (#229): its images are not shown (the result is checked as before)
{
  const lv = loadLevel(new Rom(file), 0x105);
  const level: SpriteLevel = { number: 0x105, header: lv.header, spriteHeader: lv.spriteHeader, bgPointer: 0xffd900 };
  const job: LearnJob = { kind: 'sprites', level, nums: [0x0d, 0x1d, 0x21] };
  const w = new Worker(), e = editor(w), shown: (unknown[] | null)[] = [], done: unknown[] = [];
  const opts = { input: { set: 'gen' }, lane: 'sprites' as const, done: (r: unknown) => done.push(r), shown: (i: unknown[] | null) => shown.push(i) };
  e.client.learn('spr', job, opts);
  await settle();
  const before = e.rom.gen;
  touch(e.rom);
  e.client.learn('spr', job, opts); // (the worker gets the edit)
  await settle();
  const first = w.run(1, (d) => ({ ...d, gen: before }));
  check(first[0]?.type === 'learning' && first[0].shown.length > 0 && shown.every((i) => i === null), 'progress from an older ROM: its images not shown');
  w.run();
  check(shown.some((i) => i?.length) && done.length === 1, '… those of the current ROM are, and the result');
}

// the level as edited (#232): sent to the worker whole once, later requests name it (the tiles of the level as edited,
// the placement preview under the mouse); whole again once the worker dropped it (EDIT_STATES others since) and to the
// main thread's host once the worker broke down. The size of a placement preview request before and after.
{
  const w = new Worker(), e = editor(w), lv = loadLevel(e.rom, 0x105), state = editState(lv, levelOverride(e.rom, lv));
  const learns = () => w.sent.filter((m): m is ProbeMessage & { type: 'learn' } => m.type === 'learn');
  const whole = (m: ProbeMessage & { type: 'learn' }) => 'state' in m.job && 'level' in m.job.state;
  const obj = (x: number) => ({ uid: 100 + x, num: 0x21, ext: 0, size: 0x13, x, y: 0x14 });
  const preview = (x: number): LearnJob => ({ kind: 'preview', state, layer2: false, objects: [obj(x)] });
  e.client.learnOrFailed('lt:105', { kind: 'levelTiles', state }, { input: state.id, lane: 'lt', replace: true });
  for (let x = 2; x < 6; x++) { e.client.learn(`pp:${x}`, preview(x), { input: x, lane: 'placement', replace: true }); await settle(); }
  const sent = learns();
  check(sent.length === 5 && whole(sent[0]) && sent.slice(1).every((m) => !whole(m)), `level as edited: sent whole with the first request only (${sent.map((m) => whole(m) ? 'whole' : 'id').join()})`);
  const got = w.run().filter((d) => d.type === 'learned');
  check(got.length === 2 && got.every((d) => d.type === 'learned' && !d.failed), '… the worker learns on it (the tiles, the latest preview)');

  // the size of a placement preview request: the level and its load as before, the objects placed in the level named
  const placed = { ...lv, objects: [...lv.objects, obj(6)] }, ovp = levelOverride(e.rom, placed);
  const before = { type: 'learn', lane: 'placement', key: 'pp', input: 'x', replace: true, job: { kind: 'preview', level: placed, ov: ovp, layer2: false, placed: [lv.objects.length] } };
  e.client.learn('pp:6', preview(6), { input: 6, lane: 'placement', replace: true });
  await settle();
  const after = learns().at(-1)!, size = (m: unknown) => serialize(m).length;
  console.log(`  placement preview request: ${size(before)} bytes before, ${size(after)} after (the level as edited sent once: ${size(sent[0])}, with the owners of its bytes ${size({ ...sent[0], job: { ...sent[0].job, state } })})`);
  check(size(after) * 50 < size(before), '… a preview request is a small part of what it was');

  // EDIT_STATES others sent whole: the first whole again
  for (let i = 0; i < EDIT_STATES; i++) {
    const other = editState({ ...lv, number: 0x100 + i }, levelOverride(e.rom, lv));
    e.client.learnOrFailed(`lt:${i}`, { kind: 'levelTiles', state: other }, { input: other.id, lane: 'lt' });
    await settle();
  }
  e.client.learn('pp:7', preview(7), { input: 7, lane: 'placement', replace: true });
  await settle();
  check(whole(learns().at(-1)!), `… whole again after ${EDIT_STATES} others`);
  w.run();

  // the worker breaks down: the main thread's host is sent it whole (it learns on it)
  e.client.learn('pp:8', preview(8), { input: 8, lane: 'placement', replace: true });
  await settle();
  w.failed();
  await settle();
  e.drain();
  const pv = e.client.learn('pp:8', preview(8), { input: 8, lane: 'placement' });
  check(!!pv, '… after the worker broke down: learned on the main thread');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
