// The overworld emulated off the main thread (#183): the map at an event progress, the submaps' views and the sprites'
// images are learn jobs of the probe worker (probeprotocol.ts owMap, owViews, owSprites), asked for by the editor's
// probe client as the overworld view does (App.overworldMap, submapViews, overworldSprites). Checked: the results are
// those of the overworld loaded directly; the editor's thread loads no overworld (with a worker); a result asked again
// is known at once (memory), also after a ROM edit it didn't read, a layer 1 edit asks again; requests for the slider's
// event progresses replace each other (only the latest is loaded); without a worker it all runs on the main thread.
// The save at an event progress (#255, owprogress.ts progressSaveJob, the switches pressed too; owSave, App.progressSave) too: as learned
// directly, another progress known without emulating again, without a worker on the main thread.
// Layer 1 as after an event without its layer 1 changes (#236, owevents.ts layer1Without; owL1Without,
// App.layer1Without), what an event's layer 1 stroke is compared with: as found directly, not on the main thread,
// asked again after the event's layer 1 was painted (its silent steps written), again as found directly.
import { Rom } from '../src/core/rom.ts';
import { ProbeHost } from '../src/core/probehost.ts';
import type { LearnJob, ProbeMessage, ProbeReply } from '../src/core/probeprotocol.ts';
import { ProbeClient } from '../src/core/probeclient.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { loadLevel, L2_PTRS } from '../src/core/level.ts';
import { OverworldEmulator, OverworldLoads, readL1, writeL1, l1Index, type OwRender } from '../src/core/overworld.ts';
import { submapViews, layer1Without, readEvents, writeEvents, paintEventL1, eventL1Tiles, type Rect } from '../src/core/owevents.ts';
import { owSpriteImages, type OwSpriteView } from '../src/core/owsprites.ts';
import { progressSaveJob, type ProgressSave } from '../src/core/owprogress.ts';
import { runJob } from '../src/core/jobrunner.ts';
import { BlockProber } from '../src/core/blockprobe.ts';
import { LevelUses } from '../src/core/levelusage.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { editorImage } from './fixture.ts';

const same = (a: Uint16Array, b: Uint16Array) => a.length === b.length && a.every((v, i) => v === b[i]);

const file = await editorImage();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const settle = () => new Promise((r) => setTimeout(r, 0)); // (stored results are awaited first)

// overworld loads, counted by where they run (the stand-in worker sets inWorker while it runs the host)
let inWorker = false, loadsHere = 0, loadsThere = 0;
const load = OverworldEmulator.prototype.load;
OverworldEmulator.prototype.load = function (this: OverworldEmulator, map: number, progress: number) {
  if (inWorker) loadsThere++; else loadsHere++;
  return load.call(this, map, progress);
};

class Worker {
  host = new ProbeHost();
  sent: ProbeMessage[] = [];
  reply!: (d: ProbeReply) => void;
  connect = (reply: (d: ProbeReply) => void) => {
    this.reply = reply;
    return (m: ProbeMessage) => { this.sent.push(m); this.host.handle(m); };
  };
  run(): void {
    while (this.host.pending) {
      inWorker = true;
      let d: ProbeReply | null;
      try { d = this.host.next(); } finally { inWorker = false; }
      if (d) this.reply(d);
    }
  }
}

function editor(worker: Worker | null) {
  const rom = new Rom(file.slice()), steps: (() => void)[] = [];
  const client = new ProbeClient({
    results: new ResultCache(new RomFingerprint(rom)), cacheReady: Promise.resolve(),
    rom: () => rom, tileset: () => 0,
    connect: worker ? worker.connect : undefined,
    later: (key, step) => { if (key !== 'probe-prefetch') steps.push(step); },
    setBusy: () => {}, ready: () => {}, kindsReady: () => {},
    kindLevel: () => { const lv = loadLevel(rom, 0x105); return { level: { number: lv.number, header: lv.header }, layer2Pointer: rom.r24(L2_PTRS + 0x105 * 3) }; },
  });
  // as the overworld view asks (App)
  const map = (m: number, progress: number, done: (r: OwRender) => void = () => {}) =>
    client.learn<OwRender>(`owm1:${m}`, { kind: 'owMap', map: m, progress } satisfies LearnJob, { lane: 'ow', input: { progress }, replace: true, done });
  const views = (done: (v: Rect[]) => void = () => {}) => client.learn<Rect[]>('owv1', { kind: 'owViews' }, { lane: 'owv', done });
  const sprites = (m: number, progress: number, done: (v: OwSpriteView[]) => void = () => {}) =>
    client.learn<OwSpriteView[]>(`ows1:${m}`, { kind: 'owSprites', map: m, progress }, { lane: 'ows', input: { progress }, replace: true, done });
  const save = (progress: number, done: (v: ProgressSave) => void = () => {}) =>
    client.learn<ProgressSave>('owps1', { kind: 'owSave', progress }, { lane: 'owps', input: { progress }, done });
  const without = (event: number, done: (v: Uint16Array) => void = () => {}) =>
    client.learn<Uint16Array>(`owlw1:${event}`, { kind: 'owL1Without', event }, { lane: 'owlw', replace: true, done });
  const drain = () => { while (steps.length) steps.shift()!(); };
  return { rom, client, map, views, sprites, save, without, drain };
}

const sameRender = (a: OwRender | undefined, b: OwRender) =>
  !!a && a.ok === b.ok && [['vram', a.vram, b.vram], ['cgram', a.cgram, b.cgram], ['wram', a.wram, b.wram], ['ppu', a.ppuRegs, b.ppuRegs]].every(([, x, y]) => Buffer.compare(x as Uint8Array, y as Uint8Array) === 0);
const text = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array || x instanceof Uint32Array ? Array.from(x) : x));

const directRom = new Rom(file.slice()), directLoads = new OverworldLoads(new OverworldEmulator(directRom), 16);
const directProber = new BlockProber(directRom);
const directSave = (progress: number) => runJob(progressSaveJob(directLoads, progress, { prober: directProber, uses: new LevelUses(directRom, directProber.results), emu: new LevelEmulator(directRom) }) as Generator<string | void, ProgressSave>);
const direct = { main: directLoads.get(0, 0x10), yi: directLoads.get(1, 0), views: submapViews(directLoads), sprites: owSpriteImages(directLoads, 0, 0x10), saves: { [0x20]: directSave(0x20), [0x30]: directSave(0x30) } };
loadsHere = 0;

// with a worker
{
  const w = new Worker(), e = editor(w);
  let got: OwRender | undefined;
  check(e.map(0, 0x10, (r) => (got = r)) === undefined, 'the main map at event progress 10: asked for');
  await settle();
  w.run();
  check(sameRender(got, direct.main), 'the main map: as loaded directly');
  check(sameRender(e.map(0, 0x10), direct.main) && loadsHere === 0, 'asked again: known at once');

  // the slider moved through event progresses before the worker ran: only the latest is loaded
  const before = loadsThere;
  for (let p = 0x11; p <= 0x15; p++) e.map(0, p);
  await settle();
  w.run();
  check(loadsThere - before === 1 && !!e.map(0, 0x15) && e.map(0, 0x12) === undefined, `the slider: only the latest progress loaded (${loadsThere - before} loads)`);
  w.run();

  // another submap; its views and sprites
  let yi: OwRender | undefined, views: Rect[] | undefined, sprites: OwSpriteView[] | undefined;
  e.map(1, 0, (r) => (yi = r));
  e.views((v) => (views = v));
  e.sprites(0, 0x10, (v) => (sprites = v));
  await settle();
  w.run();
  check(sameRender(yi, direct.yi), "Yoshi's Island: as loaded directly");
  check(text(views) === text(direct.views) && views!.length === 7, `the submaps' views: as found directly (${text(views?.[1])})`);
  check(text(sprites) === text(direct.sprites) && sprites!.some((s) => s.image), 'the sprites on the main map at progress 10: as found directly');

  // the save at an event progress
  let saved: ProgressSave | undefined;
  check(e.save(0x20, (v) => (saved = v)) === undefined, 'the save at event progress 20: asked for');
  await settle();
  w.run();
  check(text(saved) === text(direct.saves[0x20]) && saved!.eventsTriggered === 0x20 && saved!.switchPalaces[1] === 1 && loadsHere === 0,
    `the save: as learned directly (${saved?.eventsTriggered} events triggered, the yellow switch pressed), not on the main thread`);
  const loaded = loadsThere;
  let other: ProgressSave | undefined;
  e.save(0x30, (v) => (other = v));
  await settle();
  w.run();
  check(text(other) === text(direct.saves[0x30]) && loadsThere === loaded && text(e.save(0x20)) === text(direct.saves[0x20]),
    'another progress: without emulating again; the first known at once');

  // a ROM edit the loads didn't read (the internal name) keeps them, painting layer 1 asks again
  e.rom.writeAt(0x7fc0, Uint8Array.of(e.rom.data[0x7fc0] ^ 1));
  check(sameRender(e.map(1, 0), direct.yi) && !!e.views() && !!e.sprites(0, 0x10), 'an edit nothing read: all known at once');
  const l1 = readL1(e.rom);
  l1[l1Index(0, 3, 3)] ^= 1;
  writeL1(e.rom, l1);
  let painted: OwRender | undefined;
  check(e.map(0, 0x10, (r) => (painted = r)) === undefined, 'layer 1 painted: asked again');
  await settle();
  w.run();
  check(!!painted && painted.wram !== got!.wram && loadsHere === 0, 'layer 1 painted: loaded again in the worker; the main thread loaded no overworld');

  // layer 1 without an event's layer 1 changes (the first with some)
  const d0 = readEvents(e.rom), ev = [...d0.silent.keys()].find((k) => eventL1Tiles(d0, k).length)!;
  const withoutHere = (rom: Rom) => { const n = loadsHere, v = layer1Without(new Rom(rom.data.slice()), ev); loadsHere = n; return v; };
  let wo: Uint16Array | undefined;
  check(e.without(ev, (v) => (wo = v)) === undefined, `layer 1 without event ${ev.toString(16)}'s changes: asked for`);
  await settle();
  w.run();
  const directWo = withoutHere(e.rom);
  check(!!wo && same(wo, directWo) && loadsHere === 0,
    'layer 1 without the event: as found directly, not on the main thread');
  check(!!e.without(ev), 'asked again: known at once');
  // the event's layer 1 painted (a tile more, as an event stroke writes it)
  const at = l1Index(0, 5, 5), after = Uint16Array.from(directWo);
  after[at] ^= 1;
  writeEvents(e.rom, paintEventL1(readEvents(e.rom), ev, after, directWo, new Set([at])));
  check(eventL1Tiles(readEvents(e.rom), ev).includes(at), "the event's layer 1 painted");
  let wo2: Uint16Array | undefined;
  check(e.without(ev, (v) => (wo2 = v)) === undefined, "the event's layer 1 painted: asked again");
  await settle();
  w.run();
  check(!!wo2 && same(wo2, withoutHere(e.rom)) && same(wo2, directWo) && loadsHere === 0,
    "again as found directly, the same as before (the event's own layer 1 changes aren't in it), not on the main thread");
}

// without a worker: on the main thread, in background slices
{
  const e = editor(null);
  let got: OwRender | undefined, views: Rect[] | undefined;
  e.map(0, 0x10, (r) => (got = r));
  let saved: ProgressSave | undefined;
  e.views((v) => (views = v));
  e.save(0x20, (v) => (saved = v));
  await settle();
  e.drain();
  check(sameRender(got, direct.main) && text(views) === text(direct.views) && text(saved) === text(direct.saves[0x20]) && loadsHere > 0,
    'without a worker: the map, the views and the save on the main thread, as learned directly');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
