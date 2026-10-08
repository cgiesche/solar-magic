// Probe jobs (probehost.ts, run by the editor's probe worker): results as the prober's own, asked
// jobs before prefetched ones, a changed ROM drops the queue.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { BlockProber, blockKey, spriteKey } from '../src/core/blockprobe.ts';
import { ProbeHost, PROBE_SPRITE, PROBE_RUNS, jobKey, type ProbeDone } from '../src/core/probehost.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const file = new Uint8Array(readFileSync('test/fixtures/smw.smc'));
const rom = new Rom(file);
const direct = new BlockProber(new Rom(file));

const host = new ProbeHost();
host.setRom(1, rom.data.slice());
host.setPrefetch([{ ts: 0, k: 0x130 }, { ts: 0, k: PROBE_SPRITE | 0x0d }]);
host.ask([{ ts: 0, k: 0x11f }, { ts: 0, k: PROBE_RUNS }]);
const done: ProbeDone[] = [];
for (let d; (d = host.next());) done.push(d);
check(done.map((d) => d.job.k).join(',') === [0x11f, PROBE_RUNS, 0x130, PROBE_SPRITE | 0x0d].join(','), 'asked jobs first, then prefetched');
check(done.every((d) => d.gen === 1 && !d.failed && d.put.some(([k]) => k === jobKey(d.job))), 'every job gives its result entry');

// the entries hold in the editor's cache (same ROM) and equal the prober's results
const cache = new ResultCache(new RomFingerprint(new LevelEmulator(rom)));
for (const d of done) for (const [k, e] of d.put) cache.set(k, e.data, e.deps);
check(JSON.stringify(cache.get(blockKey(0, 0x11f))) === JSON.stringify(direct.probe(0x11f)), 'block 11F as probed directly');
check(JSON.stringify(cache.get(spriteKey(0, 0x0d))) === JSON.stringify(direct.probeSprite(0x0d)), 'sprite 0D as probed directly');

// a ROM change drops the queue; results carry the new generation
host.ask([{ ts: 0, k: 0x2b }]);
const changed = rom.data.slice();
host.setRom(2, changed);
check(host.pending === 0 && host.next() === null, 'changed ROM: queue dropped');
host.ask([{ ts: 0, k: 0x2b }]);
check(host.next()?.gen === 2, 'results after the change carry its generation');

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
