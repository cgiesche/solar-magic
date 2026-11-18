// The probe client (probeclient.ts) with two probe workers (ADR 0016, #513), each a probe host in a stand-in worker the
// test runs by hand: the ROM and the ranges a change wrote reach both, every other message only the worker its lane or
// task belongs to (probeprotocol.ts probeWorker), a result from either lands in the same cache; a worker breaking down
// hands its side to the main thread, the other worker goes on as it is; one worker (the default, or the second one not
// starting): everything goes to it.
import { Rom } from '../src/core/rom.ts';
import { BlockProber } from '../src/core/blockprobe.ts';
import { ProbeHost } from '../src/core/probehost.ts';
import { probeWorker, jobKey, type ProbeMessage, type ProbeReply, type LearnJob } from '../src/core/probeprotocol.ts';
import { ProbeClient } from '../src/core/probeclient.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { loadLevel, L2_PTRS } from '../src/core/level.ts';
import { kindsKey } from '../src/core/objkinds.ts';
import type { ScanLevel } from '../src/core/levelscan.ts';
import type { SpriteLevel } from '../src/core/spritegfx.ts';
import { editorImage } from './fixture.ts';

const file = await editorImage();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const touch = (rom: Rom) => rom.writeAt(0x7fc0, Uint8Array.of(rom.data[0x7fc0] ^ 1)); // (nothing a probe reads)
const settle = () => new Promise((r) => setTimeout(r, 0)); // (stored results are awaited first)
const direct = new BlockProber(new Rom(file.slice()));

// a worker the test runs: messages go to a probe host, replies come back when run() is called
class Worker {
  host = new ProbeHost();
  sent: ProbeMessage[] = [];
  reply!: (d: ProbeReply) => void;
  failed!: () => void;
  run(): ProbeReply[] {
    const out: ProbeReply[] = [];
    while (this.host.pending) { const d = this.host.next(); if (d) { out.push(d); this.reply(d); } }
    return out;
  }
  count(type: ProbeMessage['type']) { return this.sent.filter((m) => m.type === type).length; }
  // what it was sent besides the ROM and its changes: the messages' types, a learn job's or dropped lane's with the lane
  others() { return [...new Set(this.sent.flatMap((m) => (m.type === 'rom' || m.type === 'edit' ? [] : [m.type === 'learn' || m.type === 'unlearn' ? `${m.type}:${m.lane}` : m.type])))].sort().join(); }
}

// an editor with n workers wanted, of which only the first `starting` start
function editor(n: number | undefined, starting = Infinity) {
  const rom = new Rom(file.slice());
  const steps: [string, () => void][] = [];
  const e = {
    rom, workers: [] as Worker[], kindsReady: 0, busy: new Map<string, string>(),
    results: new ResultCache(new RomFingerprint(rom)),
    client: null as unknown as ProbeClient,
    drain() { for (let i = 0; i < steps.length;) { if (steps[i][0] === 'probe-prefetch') i++; else steps.splice(i, 1)[0][1](); } },
  };
  e.client = new ProbeClient({
    results: e.results, cacheReady: Promise.resolve(),
    rom: () => rom, tileset: () => 0,
    ...(n !== undefined && { workers: n }),
    connect: (reply, failed) => {
      if (e.workers.length >= starting) return null;
      const w = new Worker();
      w.reply = reply; w.failed = failed;
      e.workers.push(w);
      return (m) => { w.sent.push(m); w.host.handle(m); };
    },
    later: (key, step) => steps.push([key, step]),
    setBusy: (key, label) => { if (label === null) e.busy.delete(key); else e.busy.set(key, label); },
    ready: () => {},
    kindLevel: () => { const lv = loadLevel(rom, 0x105); return { level: { number: lv.number, header: lv.header }, layer2Pointer: rom.r24(L2_PTRS + 0x105 * 3) }; },
    kindsReady: () => e.kindsReady++,
  });
  return e;
}

const lv = loadLevel(new Rom(file), 0x105);
const spriteLevel: SpriteLevel = { number: 0x105, header: lv.header, spriteHeader: lv.spriteHeader, bgPointer: 0xffd900 };
const sprites: LearnJob = { kind: 'sprites', level: spriteLevel, nums: [0x0d] };
const sizes: LearnJob = { kind: 'sizes', level: { number: 0x105, header: lv.header }, layer2Pointer: lv.layer2Pointer, specs: [{ num: 0x21, ext: 0, size: 3 }] };
const scanLevel: ScanLevel = { number: 0x105, ov: {}, vertical: false, width: 256, height: 432 };
const sameBlock = (e: ReturnType<typeof editor>, tile: number) => JSON.stringify(e.client.block(tile)) === JSON.stringify(direct.probe(tile));

// the routing: fixed, everything to the one worker when there is only one
check(['probe', 'scan', 'camera', 'thumbs', 'uses', 'sizes', 'lt', 'owps', 'level-png'].every((k) => probeWorker(k as 'probe', 2) === 0)
  && ['kinds', 'sprites', 'variants', 'bytes', 'spritemem'].every((k) => probeWorker(k as 'kinds', 2) === 1), 'two workers: the object kinds and the sprite lanes on the second, the rest on the first');
check(['probe', 'kinds', 'sprites', 'thumbs'].every((k) => probeWorker(k as 'probe', 1) === 0), 'one worker: everything on it');

// two workers: the ROM and its changes to both, each lane's and task's messages to its worker only, the results of
// both in the same cache
{
  const e = editor(2);
  let spritesDone = 0, sizesDone = 0;
  e.client.block(0x130);
  e.client.kinds(1);
  e.client.learn('spr', sprites, { input: 1, lane: 'sprites', label: 'Sprite graphics', done: () => spritesDone++ });
  e.client.learn('sizes', sizes, { input: 3, lane: 'sizes', label: 'Sizes', done: () => sizesDone++ });
  e.client.requestScan(1, 'scan-key', scanLevel, () => {});
  e.client.wantPrefetch('map16tab', { tiles: [0x131] });
  await settle();
  const [a, b] = e.workers;
  check(e.workers.length === 2, 'two workers started');
  check(a.count('rom') === 1 && b.count('rom') === 1, 'the ROM to both, once');
  check(a.others() === 'ask,learn:sizes,prefetch,scan', `the first worker: the probes, the scan, the sizes (${a.others()})`);
  check(b.others() === 'kinds,learn:sprites', `the second worker: the object kinds, the sprite images (${b.others()})`);
  check(['probe', 'kinds', 'sprites', 'sizes', 'scan'].every((k) => e.busy.has(k)), 'all of them busy');
  e.client.cancelScan();
  check(a.count('cancel') === 1 && b.count('cancel') === 0, 'the scan cancelled: the first worker told');
  touch(e.rom);
  e.client.block(0x130);
  await settle();
  check(a.count('edit') === 1 && b.count('edit') === 1 && a.count('rom') === 1 && b.count('rom') === 1, 'a ROM change: its ranges to both');
  b.run();
  check(e.client.kinds(1) != null && e.kindsReady === 1 && spritesDone === 1 && !e.busy.has('kinds') && !e.busy.has('sprites'), 'the second worker ran: the object kinds and the sprite images known');
  check(e.busy.has('probe') && e.busy.has('sizes') && sizesDone === 0, '… the first one\'s jobs still busy');
  a.run();
  check(sameBlock(e, 0x130) && sizesDone === 1 && !e.busy.has('probe') && !e.busy.has('sizes'), 'the first worker ran: the block and the sizes known, nothing busy');
  check(e.client.learn('spr', sprites, { input: 1, lane: 'sprites' }) !== undefined && e.results.get(kindsKey(1)) !== undefined && e.results.get(jobKey({ kind: 'block', ts: 0, tile: 0x130 })) !== undefined, 'both workers\' results in the one cache');
  e.client.learn('v', { kind: 'spriteAt', level: spriteLevel, id: 0x0d, x: 1, y: 1 }, { input: 1, lane: 'variants' });
  e.client.learn('sizes', { ...sizes, specs: [{ num: 0x21, ext: 0, size: 4 }] }, { input: 4, lane: 'sizes' });
  await settle();
  e.client.unlearn('variants');
  e.client.unlearn('sizes');
  check(b.others() === 'kinds,learn:sprites,learn:variants,unlearn:variants' && a.others() === 'ask,cancel,learn:sizes,prefetch,scan,unlearn:sizes', 'a lane dropped: its worker told');
}

// the second worker breaks down: its side goes to the main thread, the first worker keeps its ROM and queue
{
  const e = editor(2);
  e.client.block(0x130);
  e.client.kinds(1);
  await settle();
  const [a, b] = e.workers;
  b.failed();
  await settle();
  check(a.count('rom') === 1 && a.count('ask') === 1 && a.count('kinds') === 0, 'second worker failed: nothing sent to the first again');
  e.drain();
  check(e.client.kinds(1) != null && e.kindsReady === 1 && !e.busy.has('kinds'), '… the object kinds found on the main thread');
  check(e.busy.has('probe'), '… the block still the first worker\'s');
  a.run();
  check(sameBlock(e, 0x130) && !e.busy.has('probe'), '… and answered by it');
  // the first one too: both sides on the main thread
  e.client.block(0x132);
  e.client.kinds(2);
  await settle();
  a.failed();
  await settle();
  e.drain();
  check(sameBlock(e, 0x132) && e.client.kinds(2) != null && !e.busy.has('probe') && !e.busy.has('kinds'), 'both failed: everything on the main thread');
  check(b.count('rom') === 1 && b.count('kinds') === 1, '… the broken ones sent nothing more');
}

// a learn job of the worker that breaks down: learned on the main thread; one that failed on the other worker is not
// asked again by it
{
  const e = editor(2);
  let done = 0, fails = 0;
  const bad: LearnJob = { kind: 'levelTiles', state: { id: 'not-sent' } };
  e.client.learnOrFailed('lt:x', bad, { lane: 'lt', input: 'not-sent', failed: () => fails++ });
  await settle();
  const [a, b] = e.workers;
  const error = console.error;
  console.error = () => {}; // (the job's error)
  a.run();
  console.error = error;
  e.client.learn('spr', sprites, { input: 1, lane: 'sprites', label: 'Sprite graphics', done: () => done++ });
  await settle();
  check(fails === 1 && b.count('learn') === 1, '(a job failed on the first worker, the sprite images asked of the second)');
  b.failed();
  await settle();
  e.drain();
  check(done === 1 && !e.busy.has('sprites') && e.client.learn('spr', sprites, { input: 1, lane: 'sprites' }) !== undefined, 'second worker failed: its sprite images learned on the main thread');
  e.client.learnOrFailed('lt:x', bad, { lane: 'lt', input: 'not-sent', failed: () => fails++ });
  await settle();
  check(a.count('learn') === 1 && a.count('rom') === 1 && fails === 1, '… the job that failed on the first worker is not asked again');
}

// a new size: the whole ROM to both, each with what is wanted of it
{
  const e = editor(2);
  e.client.block(0x130);
  e.client.kinds(1);
  await settle();
  const [a, b] = e.workers;
  const data = new Uint8Array(e.rom.data.length + 0x8000);
  data.set(e.rom.data);
  e.rom.data = data;
  touch(e.rom);
  e.client.block(0x130);
  await settle();
  check(a.count('rom') === 2 && b.count('rom') === 2 && a.count('edit') === 0 && b.count('edit') === 0, 'a new size: the whole ROM to both');
  check(a.others() === 'ask' && a.count('ask') === 2 && b.others() === 'kinds' && b.count('kinds') === 2, '… each asked again for what is wanted of it only');
  a.run(); b.run();
  check(sameBlock(e, 0x130) && e.client.kinds(1) != null && !e.busy.size, '… and answered');
}

// the first worker breaks down: the probes go to the main thread, the object kinds stay with the second
{
  const e = editor(2);
  e.client.block(0x130);
  e.client.kinds(1);
  await settle();
  const [a, b] = e.workers;
  a.failed();
  await settle();
  e.drain();
  check(sameBlock(e, 0x130) && !e.busy.has('probe'), 'first worker failed: the block probed on the main thread');
  check(b.count('rom') === 1 && b.count('kinds') === 1 && e.busy.has('kinds'), '… the object kinds still the second worker\'s');
  b.run();
  check(e.client.kinds(1) != null && !e.busy.has('kinds'), '… and answered by it');
}

// one worker: by default, and when the second doesn't start
for (const [what, e] of [['one worker (the default)', editor(undefined)], ['the second worker not starting', editor(2, 1)]] as const) {
  e.client.block(0x130);
  e.client.kinds(1);
  await settle();
  check(e.workers.length === 1 && e.workers[0].others() === 'ask,kinds', `${what}: everything to the one`);
  e.workers[0].run();
  check(sameBlock(e, 0x130) && e.client.kinds(1) != null && !e.busy.size, '… and answered by it');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
