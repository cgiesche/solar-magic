// The editor's probe client (probeclient.ts) against a probe host (probehost.ts) in a stand-in
// worker the test runs by hand: a reply from before a ROM change does not make it ask again and
// again, results come in after it, and one still valid is kept, one whose bytes changed meanwhile not (asked again); after the first copy of the ROM it gets the
// ranges a change wrote; a broken worker hands everything
// wanted to the main thread, and without a worker it all runs there; a failed probe is not asked again until the ROM changes; the
// prefetch follows the tileset; object kinds are kept while the bytes they read are unchanged; a cancelled
// scan is told to the worker.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { BlockProber } from '../src/core/blockprobe.ts';
import { ProbeHost } from '../src/core/probehost.ts';
import { jobKey, type ProbeJob, type ProbeMessage, type ProbeReply } from '../src/core/probeprotocol.ts';
import { ProbeClient } from '../src/core/probeclient.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, L2_PTRS } from '../src/core/level.ts';
import { ObjKindProbe, kindsKey, type ObjKinds } from '../src/core/objkinds.ts';
import type { ScanLevel } from '../src/core/levelscan.ts';
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
    rom, emu, ts: 0, ready: 0, kindsReady: 0, busy: new Map<string, string>(), steps,
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
    setBusy: (key, label) => { if (label === null) e.busy.delete(key); else e.busy.set(key, label); },
    ready: () => e.ready++,
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

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
