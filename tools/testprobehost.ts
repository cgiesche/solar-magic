// Probe jobs (probehost.ts, run by the editor's probe worker): results as the prober's own, asked
// jobs before prefetched ones, a changed ROM drops the queue; object kinds and level scan as
// computed directly, in slices that let asked jobs go first.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { BlockProber, blockKey, spriteKey } from '../src/core/blockprobe.ts';
import { ProbeHost, PROBE_SPRITE, PROBE_RUNS, jobKey, type ProbeDone, type ProbeReply } from '../src/core/probehost.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { ObjKindProbe } from '../src/core/objkinds.ts';
import { levelScanJob, type ScanLevel } from '../src/core/levelscan.ts';
import { loadLevel, serializeLayer1, serializeSprites, L2_PTRS } from '../src/core/level.ts';

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
while (host.pending) { const d = host.next(); if (d?.type === 'probe') done.push(d); }
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

// object kinds and a level scan: as computed directly; an asked job between their slices goes first
const lv = loadLevel(rom, 0x105), l2 = rom.r24(L2_PTRS + 0x105 * 3);
const scanLevel: ScanLevel = {
  number: lv.number, vertical: false, width: lv.header.screens * 256, height: 27 * 16,
  ov: { layer1: serializeLayer1(rom, lv), sprites: serializeSprites(lv.sprites, lv.spriteHeader, false) },
};
const emu = new LevelEmulator(new Rom(file));
const kinds = new ObjKindProbe(emu, { ...lv, header: { ...lv.header, tileset: 1 } }, l2).result();
const job = levelScanJob(emu, scanLevel);
let scanned; for (;;) { const r = job.next(); if (r.done) { scanned = r.value; break; } }
host.handle({ type: 'kinds', ts: 1, level: { number: lv.number, header: lv.header }, layer2Pointer: l2 });
host.handle({ type: 'scan', id: 7, key: 'scan-key', level: scanLevel });
const replies: ProbeReply[] = [];
for (let i = 0; host.pending; i++) {
  if (i === 3) host.ask([{ ts: 1, k: 0x130 }]);
  const d = host.next();
  if (d) replies.push(d);
}
check(replies[0]?.type === 'probe', 'asked job before the rest of the tasks');
const k = replies.find((d) => d.type === 'kinds'), sc = replies.find((d) => d.type === 'scan');
check(k?.type === 'kinds' && k.ts === 1 && JSON.stringify([...k.kinds!.kinds]) === JSON.stringify([...kinds.kinds]) && k.kinds!.deps.size === kinds.deps.size, 'object kinds as computed directly');
check(sc?.type === 'scan' && sc.id === 7 && JSON.stringify(sc.result) === JSON.stringify(scanned) && sc.put.some(([key]) => key === 'scan-key'), 'level scan as played directly, with its cache entry');
host.handle({ type: 'scan', id: 8, key: 'scan-key', level: scanLevel });
host.next();
host.setRom(3, rom.data.slice());
check(host.pending === 0, 'changed ROM: tasks dropped');

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
