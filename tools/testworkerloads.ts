// The editor's level loads that ran on the main thread, learned in the probe worker as learn jobs (#233), asked as App
// asks for them through the probe client: a level's game BG (the remap preview, tilemove.ts gameBgJob), where a prefab's
// arrangement already is ("replace all", prefabplaces.ts prefabPlacesJob), whether a broken up prefab's sources draw
// the level as it did (prefabsources.ts sameTilesJob), the entrance actions that make a level slippery (slippery.ts
// slipperyJob) and a tileset's object table (objectnames.ts objectTableJob). Each as computed directly on the main
// thread, with no level load there (all of them in the stand-in worker); the stored ones under their result cache keys
// as before (slip1, otab1:<tileset>, no input), answered from the cache when asked again. Without a worker the client's
// own probe host learns them.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator, type LevelOverride } from '../src/core/levelemu.ts';
import { loadLevel, newUid, isL1Vertical, levelRows, L2_PTRS, type Level, type LevelObject } from '../src/core/level.ts';
import { layerGeom } from '../src/core/render.ts';
import { MAP_BASE, map16Tile } from '../src/core/ram.ts';
import { saveLevel } from '../src/core/save.ts';
import { bgFromWram } from '../src/core/bg.ts';
import { usedLevels, levelOverride } from '../src/core/levelusage.ts';
import { DM16_EXT } from '../src/core/patches.ts';
import { installPrefabPatch, writePrefab, PREFAB_EXT, PREFAB_MAX, TRANSPARENT, type Prefab } from '../src/core/prefabs.ts';
import { prefabDm16Objects } from '../src/core/prefabcost.ts';
import { planPrefabPlaces, type LevelPlaces, type PrefabSkip } from '../src/core/prefabplaces.ts';
import { setPrefabSources, breakUpPrefab, breakUpParts, replaced } from '../src/core/prefabsources.ts';
import { slipperyActions, slipperyKey } from '../src/core/slippery.ts';
import { objectTable, objectTableKey } from '../src/core/objectnames.ts';
import { gameBgKey } from '../src/core/tilemove.ts';
import { levelInput } from '../src/core/inputs.ts';
import { ProbeHost } from '../src/core/probehost.ts';
import type { LearnJob, LearnLane, ProbeMessage, ProbeReply } from '../src/core/probeprotocol.ts';
import { ProbeClient } from '../src/core/probeclient.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const settle = () => new Promise((r) => setTimeout(r, 0)); // (stored results are awaited first)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// level loads, counted by where they run (the stand-in worker sets inWorker while it runs the host)
let inWorker = false, loadsHere = 0, loadsThere = 0;
const load = LevelEmulator.prototype.load;
LevelEmulator.prototype.load = function (this: LevelEmulator, ...a: Parameters<typeof load>) {
  if (inWorker) loadsThere++; else loadsHere++;
  return load.apply(this, a);
};

class Worker {
  host = new ProbeHost();
  reply!: (d: ProbeReply) => void;
  connect = (reply: (d: ProbeReply) => void) => {
    this.reply = reply;
    return (m: ProbeMessage) => { this.host.handle(m); };
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

const rom = new Rom(await editorImage());
installPrefabPatch(rom);
const direct = new LevelEmulator(rom);
direct.boot();

// a probe client as App's (worker: a stand-in one; none: its own probe host, in background slices run here)
function client(worker: Worker | null): { c: ProbeClient; results: ResultCache; run: () => void } {
  const results = new ResultCache(new RomFingerprint(rom)), slices: (() => void)[] = [];
  const c = new ProbeClient({
    results, cacheReady: Promise.resolve(),
    rom: () => rom, tileset: () => 0, ...(worker ? { connect: worker.connect } : {}),
    later: (_k, step) => slices.push(step), setBusy: () => {}, ready: () => {}, kindsReady: () => {},
    kindLevel: () => { const lv = loadLevel(rom, 0x105); return { level: { number: lv.number, header: lv.header }, layer2Pointer: rom.r24(L2_PTRS + 0x105 * 3) }; },
  });
  const run = () => { if (worker) worker.run(); else while (slices.length) slices.shift()!(); };
  return { c, results, run };
}
const worker = new Worker(), w = client(worker);

// a learn job asked as App asks: { known: at once, from the cache } or learned in the worker
async function asked<T>(on: typeof w, key: string, job: LearnJob, lane: LearnLane, input?: unknown): Promise<{ r: T | undefined; known: boolean; here: number; there: number }> {
  const h0 = loadsHere, t0 = loadsThere;
  let got: T | undefined;
  const now = on.c.learn<T>(key, job, { lane, input, done: (r) => (got = r) });
  if (now !== undefined) return { r: now, known: true, here: loadsHere - h0, there: loadsThere - t0 };
  await settle();
  on.run();
  await settle();
  return { r: got, known: false, here: loadsHere - h0, there: loadsThere - t0 };
}
const where = (a: { here: number; there: number }) => `${a.there} loads in the worker, ${a.here} here`;

// ---- a level's game BG (App.loadedBg) ----
{
  const ns = usedLevels(rom).filter((n) => !loadLevel(rom, n).layer2Objects).slice(0, 3);
  for (const n of ns) {
    const want = bgFromWram(direct.load(n).wram);
    const a = await asked<Uint16Array>(w, gameBgKey(n), { kind: 'gameBg', level: n }, 'gamebg');
    check(!a.known && !!a.r && same([...a.r], [...want]) && a.here === 0 && a.there > 0, `game BG of level ${n.toString(16)}: as loaded directly (${where(a)})`);
  }
  const again = await asked<Uint16Array>(w, gameBgKey(ns[0]), { kind: 'gameBg', level: ns[0] }, 'gamebg');
  check(again.known && again.here === 0 && again.there === 0, 'game BG asked again: from the result cache');
}

// ---- the slippery entrance actions (App.slipperyActions) and the object tables (App.objectTable) ----
{
  const want = slipperyActions(direct).result;
  const a = await asked<number[]>(w, slipperyKey, { kind: 'slippery' }, 'slippery');
  check(slipperyKey === 'slip1' && !a.known && same(a.r, want) && a.here === 0 && a.there > 0, `slippery actions (${want.join()}): as learned directly (${where(a)})`);
  check(w.results.entry('slip1')?.input === undefined && same(w.results.get('slip1'), want), 'slippery actions: under slip1, no input, as before');
  for (const ts of [0, 1, 4]) {
    const t = objectTable(direct, ts).result;
    const b = await asked<number | null>(w, objectTableKey(ts), { kind: 'objectTable', tileset: ts }, 'otab');
    check(objectTableKey(ts) === `otab1:${ts}` && !b.known && b.r === t && b.here === 0 && b.there > 0, `object table of tileset ${ts} (${t?.toString(16)}): as learned directly, under otab1:${ts} (${where(b)})`);
  }
  const c = await asked<number | null>(w, objectTableKey(0), { kind: 'objectTable', tileset: 0 }, 'otab');
  check(c.known && c.here === 0, 'object table asked again: from the result cache');
}

// ---- where a prefab's arrangement already is (App.prefabPlaces) ----
const T = TRANSPARENT;
const s: Prefab = { w: 3, h: 2, tiles: [0x130, 0x131, T, 0x132, 0x132, 0x133], name: '' };
const dm = (x: number, y: number, tile: number): LevelObject => ({ uid: newUid(), num: 0, ext: DM16_EXT, x, y, size: 0, tile });
const singles = (x: number, y: number): LevelObject[] => s.tiles.flatMap((t, i) => (t === T ? [] : [dm(x + (i % s.w), y + Math.floor(i / s.w), t)])).reverse();
const coin = (x: number, y: number): LevelObject => ({ uid: newUid(), num: 5, ext: 0, x, y, size: 0 });
{
  // level 106 as saved: a place split around a coin it draws over (a load is needed to tell); level 105 as edited
  // (open): one place, and one of the selection
  const H1 = 0x105, H2 = 0x106;
  const lv2 = loadLevel(rom, H2), [a, b, c, d, e] = singles(0x30, 7);
  lv2.objects.push(a, b, c, coin(0x30, 7), d, e);
  saveLevel(rom, lv2);
  const open = loadLevel(rom, H1), pre = open.objects.length;
  open.objects.push(...prefabDm16Objects(s, 0x22, 8), ...singles(0x40, 8));
  const skip: PrefabSkip = { level: H1, layer: 1, objects: [pre, pre + 1, pre + 2, pre + 3] };
  const levels = usedLevels(rom), sel = new Set(skip.objects);
  // as App did on the main thread
  const want = planPrefabPlaces(rom, s, {
    levels, level: (n) => (n === H1 ? open : loadLevel(rom, n)), load: (n, ov) => direct.load(n, ov), skip: (n, l, i) => n === H1 && l === 1 && sel.has(i),
  });
  const r = await asked<LevelPlaces[]>(w, 'places', { kind: 'prefabPlaces', prefab: s, levels, open, skip }, 'prefab-places', { s, levels, open, skip });
  check(want.length === 2 && want.some((p) => p.level === H2) && want.find((p) => p.level === H1)?.places.length === 1, `the places found directly: the open level's other one, the one around the coin (${want.map((p) => p.level.toString(16)).join()})`);
  check(!r.known && same(r.r, want) && r.here === 0 && r.there > 0, `places: as found directly (${where(r)})`);
}

// ---- whether a broken up prefab's sources draw the level as it did (App.explodePrefab) ----
{
  // a resizable object of level 105 as prefab 3 of the cells it writes (as "Selection as prefab" takes them), placed
  // instead of it: its sources draw the same; made from it one tile wider: not
  const H = 0x105, N = 3, lv = loadLevel(rom, H), vertical = isL1Vertical(rom, lv.header.mode);
  const ovOf = (l: Level): LevelOverride => levelOverride(rom, l);
  const r = direct.load(H, ovOf(lv)), geom = layerGeom(rom, 0, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
  let pick: { at: number; s: Prefab; x: number; y: number } | null = null;
  for (const [i, o] of lv.objects.entries()) {
    if (o.num === 0 || o.size === 0) continue;
    const cells = new Map<string, number>();
    for (let y = 0; y < levelRows(lv.secondary); y++) for (let x = 0; x < lv.header.screens * 16; x++) {
      const a = geom.addr(x, y);
      if (a >= 0 && r.owner[a - MAP_BASE] === i) cells.set(`${x},${y}`, map16Tile(r.wram, a));
    }
    if (new Set(cells.values()).size < 2) continue;
    const xs = [...cells.keys()].map((k) => +k.split(',')[0]), ys = [...cells.keys()].map((k) => +k.split(',')[1]);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x + 1, h = Math.max(...ys) - y + 1;
    if (w > PREFAB_MAX || h > PREFAB_MAX) continue;
    pick = { at: i, s: { w, h, tiles: Array.from({ length: w * h }, (_, j) => cells.get(`${x + (j % w)},${y + Math.floor(j / w)}`) ?? T), name: '' }, x, y };
    break;
  }
  const { at, s: cut, x, y } = pick!, o = lv.objects[at];
  const prefabObj: LevelObject = { uid: newUid(), num: 0, ext: PREFAB_EXT, x, y, size: 0, prefab: N };
  const placed: Level = { ...lv, objects: lv.objects.map((q, i) => (i === at ? prefabObj : q)) };
  writePrefab(rom, N, cut);
  const found: boolean[] = [];
  for (const [what, src] of [['made from it', o], ['one tile wider', { ...o, size: o.size + 1 }]] as const) {
    setPrefabSources(rom, N, cut, [src], x, y);
    const p = breakUpParts(rom, prefabObj, vertical)!;
    const b = breakUpPrefab(rom, placed, prefabObj, vertical, (l) => direct.load(l.number, ovOf(l)))!;
    const a = ovOf(placed), bb = ovOf(replaced(placed, prefabObj, p.sources!));
    const got = await asked<boolean>(w, 'same', { kind: 'sameTiles', level: H, a, b: bb }, 'breakup', [levelInput(H, a), levelInput(H, bb)]);
    found.push(b.sources);
    check(!got.known && got.r === b.sources && got.here === 0 && got.there === 2, `break up, its sources ${what}: ${b.sources ? 'the same' : 'not the same'} as found directly (${where(got)})`);
  }
  check(same(found, [true, false]), 'break up: the sources made from it draw the same, the wider ones not');
}

// ---- without a worker: the client's own probe host ----
{
  const local = client(null);
  const n = usedLevels(rom).find((k) => !loadLevel(rom, k).layer2Objects)!;
  const a = await asked<Uint16Array>(local, gameBgKey(n), { kind: 'gameBg', level: n }, 'gamebg');
  check(!a.known && !!a.r && same([...a.r], [...bgFromWram(direct.load(n).wram)]), 'without a worker: the game BG learned by the client\'s own probe host');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('worker loads ok');
