// #289: does the exit dialog's map picker (owexit.ts pickOverworldTile: the 7 maps at event progress 0, lane 'owpick')
// push the overworld view's kept loads out of the probe worker's OverworldLoads (OW_LOADS_KEPT), and what does the
// view pay for it when shown again? The requests as App makes them (App.overworldMap: key owm1:<map>, input
// { progress }, lane 'ow' replacing / 'owpick' urgent) through the editor's probe client to a probe host run here as
// the worker. The view scrubs its slider over N progresses of a map (each one shown: learned), then the picker is
// opened, shows its maps one at a time as the user picks them (each learned; its lane asks for the map shown only)
// and is cancelled, then the slider goes back over the same progresses; counted: overworld loads emulated in the worker
// and its time, without the picker (A), with the picker showing one map (B1: the one it opens on) and all 7 (B7).
//   docker run --rm -v $PWD:$PWD -w $PWD node:24-slim node perf/r289/hostperf289.ts
import { Rom } from '../../src/core/rom.ts';
import { ProbeHost } from '../../src/core/probehost.ts';
import type { LearnLane, ProbeMessage, ProbeReply } from '../../src/core/probeprotocol.ts';
import { ProbeClient } from '../../src/core/probeclient.ts';
import { ResultCache, RomFingerprint } from '../../src/core/romdeps.ts';
import { OverworldEmulator, OW_LOADS_KEPT, OW_EVENTS } from '../../src/core/overworld.ts';
import { editorImage } from '../../tools/fixture.ts';

const settle = () => new Promise((r) => setTimeout(r, 0));
let loads = 0;
const rec = OverworldEmulator.prototype.loadRecorded;
OverworldEmulator.prototype.loadRecorded = function (this: OverworldEmulator, ...a: Parameters<typeof rec>) { loads++; return rec.apply(this, a); };

const file = await editorImage();
type Cost = { loads: number; ms: number };

async function session(map: number, progresses: number[], picker: number): Promise<{ back: Cost; pick: Cost }> {
  const host = new ProbeHost(), rom = new Rom(file.slice());
  let reply!: (d: ProbeReply) => void;
  const client = new ProbeClient({
    results: new ResultCache(new RomFingerprint(rom)), cacheReady: Promise.resolve(),
    rom: () => rom, tileset: () => 0,
    connect: (r) => { reply = r; return (m: ProbeMessage) => host.handle(m); },
    later: () => {}, setBusy: () => {}, ready: () => {}, kindsReady: () => {},
    kindLevel: () => null as never,
  });
  const run = async (): Promise<Cost> => {
    await settle();
    const l0 = loads, t0 = performance.now();
    while (host.pending) { const d = host.next(); if (d) reply(d); }
    await settle();
    return { loads: loads - l0, ms: performance.now() - t0 };
  };
  const ask = (m: number, progress: number, lane: LearnLane = 'ow') =>
    client.learn(`owm1:${m}`, { kind: 'owMap', map: m, progress }, { lane, urgent: lane !== 'ow', input: { progress }, replace: true, label: 'Overworld', done: () => {} });
  for (const p of progresses) { ask(map, p); await run(); }
  let pick: Cost = { loads: 0, ms: 0 };
  for (let m = 0; m < picker; m++) { ask(m, 0, 'owpick'); const r = await run(); pick.loads += r.loads; pick.ms += r.ms; }
  if (picker) client.unlearn('owpick');
  const back: Cost = { loads: 0, ms: 0 };
  for (const p of [...progresses].reverse()) { ask(map, p); const r = await run(); back.loads += r.loads; back.ms += r.ms; }
  return { back, pick };
}

console.log(`OW_LOADS_KEPT ${OW_LOADS_KEPT}, OW_EVENTS ${OW_EVENTS}`);
const f = (x: Cost) => `${x.loads} loads, ${x.ms.toFixed(0)} ms`;
for (const n of [1, 4, 9, 12, 16]) {
  // the slider's progresses, spread over the events (not 0: the picker's own)
  const ps = Array.from({ length: n }, (_, i) => Math.round(((i + 1) * OW_EVENTS) / n));
  const a = await session(1, ps, 0), b1 = await session(1, ps, 1), b7 = await session(1, ps, 7);
  console.log(`${String(n).padStart(2)} progresses of map 1 shown, then back over them: A ${f(a.back)} | B1 (picker ${f(b1.pick)}) ${f(b1.back)} | B7 (picker ${f(b7.pick)}) ${f(b7.back)}`);
}
