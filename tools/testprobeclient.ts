// The editor's probe client (probeclient.ts) against a probe host (probehost.ts) in a stand-in
// worker the test runs by hand: a reply from before a ROM change does not make it ask again and
// again, results come in after it, and one still valid is kept; a broken worker hands everything
// wanted to the main thread; a failed probe is not asked again until the ROM changes; the
// prefetch follows the tileset.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { BlockProber } from '../src/core/blockprobe.ts';
import { ProbeHost, type ProbeMessage, type ProbeReply } from '../src/core/probehost.ts';
import { ProbeClient } from '../src/core/probeclient.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, L2_PTRS } from '../src/core/level.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const file = new Uint8Array(readFileSync('test/fixtures/smw.smc'));
const direct = new BlockProber(new Rom(file));
const settle = () => new Promise((r) => setTimeout(r, 0)); // (stored results are awaited first)

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
  asks(k: number) { return this.sent.filter((m) => m.type === 'ask' && m.jobs.some((j) => j.k === k)).length; }
}

function editor(worker: Worker | null) {
  const rom = new Rom(file.slice()), emu = new LevelEmulator(rom);
  const steps: [string, () => void][] = [];
  const e = {
    rom, emu, ts: 0, ready: 0, busy: new Map<string, string>(), steps,
    results: new ResultCache(new RomFingerprint(emu)),
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
    rom: () => ({ gen: emu.romGen, data: rom.data }), tileset: () => e.ts,
    connect: worker ? worker.connect : undefined,
    later: (key, step) => steps.push([key, step]),
    setBusy: (key, label) => { if (label === null) e.busy.delete(key); else e.busy.set(key, label); },
    ready: () => e.ready++,
  });
  return e;
}

// a reply from before a ROM change: the job is asked once more, not again and again, and its
// result comes in
{
  const w = new Worker(), e = editor(w);
  check(e.client.block(0x11f) === undefined, 'unknown block: asked for');
  await settle();
  e.emu.syncRom(); // the ROM changed (nothing the probe reads)
  check(e.client.block(0x11f) === undefined, 'asked again after the ROM change');
  await settle();
  w.run(1, (d) => ({ ...d, gen: 1 })); // a reply as from the generation before
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
  e.emu.syncRom();
  e.client.block(0x130); // (the client sees the change: sends the new ROM and the job again)
  await settle();
  check(old?.type === 'probe' && old.gen !== e.emu.romGen && w.sent.some((m) => m.type === 'rom' && m.gen === e.emu.romGen), 'reply from the generation before');
  w.reply(old!);
  check(JSON.stringify(e.client.block(0x130)) === JSON.stringify(direct.probe(0x130)), 'its result is kept: still valid');
  check(e.ready === 1 && !e.busy.has('probe'), "job done: 'ready' told, nothing busy");
}

// the worker breaks down: asked probes and object kinds go to the main thread
{
  const w = new Worker(), e = editor(w);
  const lv = loadLevel(e.rom, 0x105);
  let kinds: unknown = undefined;
  e.client.block(0x130);
  e.client.requestKinds(1, { number: lv.number, header: lv.header }, e.rom.r24(L2_PTRS + 0x105 * 3), (k) => { kinds = k; });
  await settle();
  w.failed();
  await settle();
  e.drain();
  check(JSON.stringify(e.client.block(0x130)) === JSON.stringify(direct.probe(0x130)), 'worker failed: block 130 probed on the main thread');
  check(kinds !== undefined && kinds !== null, 'worker failed: object kinds found on the main thread');
  check(!e.busy.has('probe') && !e.busy.has('kinds'), 'nothing busy after');
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
  e.emu.syncRom();
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
  check(pf.length === 2 && pf[0].type === 'prefetch' && pf[0].jobs.some((j) => j.k === 0x300), 'prefetch of tileset 0 with the extra tile');
  check(pf[1]?.type === 'prefetch' && pf[1].jobs.length > 0 && pf[1].jobs.every((j) => j.ts === 2), 'tileset 2: only its jobs');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
