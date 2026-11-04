// The overworld view's lanes (#388), its requests as App makes them (probeprotocol.ts SAVE_LANES, OW_LEFT_LANES) through
// the editor's probe client to a probe host that runs nothing meanwhile (the saves of an edit being learned):
// scrubbing the playthrough strip over 40 progresses leaves one save of the progress shown queued (and the one with
// every event passed), not one per progress; a test play's save isn't replaced. Leaving the overworld unlearns the
// strip's saves, the World check and the exits' arrows: the level editor's next job is the worker's next step, the
// test play's save still queued; the requests dropped are told so (the editor asks them again when the view shows).
import { Rom } from '../src/core/rom.ts';
import { ProbeHost } from '../src/core/probehost.ts';
import { SAVE_LANES, OW_LEFT_LANES, type LearnJob, type LearnLane, type ProbeMessage, type SaveAsker } from '../src/core/probeprotocol.ts';
import { ProbeClient } from '../src/core/probeclient.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { OW_EVENTS } from '../src/core/overworld.ts';
import { editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const json = (x: unknown) => JSON.stringify(x);
const settle = () => new Promise((r) => setTimeout(r, 0)); // (stored results are awaited first)

const file = await editorImage(), kinds = pathKinds(new Rom(file.slice())), shapes = pathShapes(new Rom(file.slice()));
const host = new ProbeHost(), rom = new Rom(file.slice());
const client = new ProbeClient({
  results: new ResultCache(new RomFingerprint(rom)), cacheReady: Promise.resolve(),
  rom: () => rom, tileset: () => 0,
  connect: () => (m: ProbeMessage) => host.handle(m),
  later: () => {}, setBusy: () => {}, ready: () => {}, kindsReady: () => {},
  kindLevel: () => null as never,
});
// the jobs the worker has queued by lane (ProbeHost's lanes)
const queued = (lane: LearnLane): LearnJob[] => ((host as unknown as { lanes: { get(n: string): { jobs: { msg: { job: LearnJob } }[] } | undefined } }).lanes.get(lane)?.jobs ?? []).map((j) => j.msg.job);
const saves = () => (['owps', 'owpn', 'owpa'] as const).flatMap((l) => queued(l).filter((j) => j.kind === 'owSave'));
// as App.progressSave
const dropped: number[] = [];
const save = (progress: number, asker: SaveAsker) =>
  client.learn('owps1', { kind: 'owSave', progress }, { ...SAVE_LANES[asker], input: { progress }, dropped: () => dropped.push(progress) });

// ---- scrubbing the strip ----
save(50, 'test');
for (let p = 0; p < 40; p++) { save(p, 'shown'); save(OW_EVENTS, 'every'); }
await settle();
const q = saves();
check(q.length === 3 && queued('owpn').length === 1 && (queued('owpn')[0] as { progress: number }).progress === 39,
  `scrubbing 40 progresses: ${q.length} saves queued (the progress shown, 39; every event passed; the test play's)`);
check(dropped.length === 39 && !dropped.includes(50), `the 39 progresses scrubbed past told they were dropped, not the test play's (${dropped.length})`);

// ---- leaving the overworld ----
client.learn('owwc1', { kind: 'owWorldCheck', kinds, shapes }, { lane: 'owwc', input: [kinds, shapes] });
client.learn('owxe1', { kind: 'owExitEdges', kinds, shapes }, { lane: 'owxe', input: [kinds, shapes] });
await settle();
dropped.length = 0;
for (const lane of OW_LEFT_LANES) client.unlearn(lane); // (App.overworldLeft)
client.learn('slip1', { kind: 'slippery' }, { lane: 'slippery' });
await settle();
check(OW_LEFT_LANES.every((l) => !queued(l).length) && queued('owps').length === 1, 'left: the strip\'s saves, the World check and the arrows unlearned, the test play\'s save queued');
check(json([...new Set(dropped)]) === json([39, OW_EVENTS]), `the strip's saves told they were dropped (progresses ${[...new Set(dropped)].join(', ')})`);
// the worker's next turns: the lanes left take turns, the test play's save (asked first) and the level's job
const stepped: string[] = [];
for (let i = 0; i < 2; i++) { const d = host.next(); stepped.push(d && 'lane' in d ? d.lane : String(d?.type)); }
check(stepped.includes('slippery') && stepped.every((l) => l === 'slippery' || l === 'owps'), `the level job's first step within the worker's next two (${stepped.join(', ')})`);

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
