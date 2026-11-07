// Sprite probes are kept once for all tilesets (blockprobe.ts): a sprite probed in one tileset is known in another
// without probing again, also to the editor (probeprotocol.ts jobResult). One whose probe read the tileset ($1931)
// from code that doesn't read it in the probe level without the sprite is kept per tileset: vanilla's unused
// sprite 36 runs into code that reads it, and its variants differ between tileset 0 and the others. The palettes'
// prefetch asks for no sprite already known for all tilesets.
import { Rom } from '../src/core/rom.ts';
import { BlockProber, spriteKey, spriteTsKey, type SpriteProbe } from '../src/core/blockprobe.ts';
import { jobResult, type ProbeMessage } from '../src/core/probeprotocol.ts';
import { ProbeClient } from '../src/core/probeclient.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const p = new BlockProber(new Rom(await editorImage()));
let sets = 0;
const set = p.results.set.bind(p.results);
p.results.set = (...a: Parameters<ResultCache['set']>) => { sets++; set(...a); };

// a sprite that doesn't read the tileset: probed once, found in every tileset
p.use(0);
const koopa = p.probeSprite(0x0d);
check(sets === 1 && !p.results.get<SpriteProbe>(spriteKey(0x0d))?.byTileset, 'sprite 0D probed in tileset 0: kept once for all tilesets');
p.use(4);
check(same(p.cachedSprite(0x0d), koopa), 'known in tileset 4');
sets = 0;
check(same(p.probeSprite(0x0d), koopa) && sets === 0, 'not probed again in tileset 4');
const editor = new ResultCache(new RomFingerprint(p.rom));
for (const [k, e] of p.results.flush().put) editor.set(k, e.data, e.deps);
check(same(jobResult(editor, { kind: 'sprite', ts: 7, num: 0x0d }), koopa), 'the editor finds it for tileset 7 (jobResult)');

// a sprite that reads the tileset: per tileset
p.use(0);
const s0 = p.probeSprite(0x36);
check(!!p.results.get<SpriteProbe>(spriteKey(0x36))?.byTileset && same(p.results.get(spriteTsKey(0, 0x36)), s0), 'sprite 36 read the tileset: kept for tileset 0 only');
p.use(1);
check(p.cachedSprite(0x36) === undefined, 'not known in tileset 1');
const s1 = p.probeSprite(0x36);
check(same(p.results.get(spriteTsKey(1, 0x36)), s1) && !same(s0, s1), `probed in tileset 1, with other variants (${s0.variants.nx} X classes in tileset 0, ${s1.variants.nx} in 1)`);
p.use(0);
check(same(p.cachedSprite(0x36), s0), 'tileset 0 keeps its own');
for (const [k, e] of p.results.flush().put) editor.set(k, e.data, e.deps);
check(same(jobResult(editor, { kind: 'sprite', ts: 1, num: 0x36 }), s1) && jobResult(editor, { kind: 'sprite', ts: 2, num: 0x36 }) === undefined,
  'the editor finds each tileset\'s, none for a tileset not probed');

// the prefetch in another tileset: only the sprites not known there
const prefetched = async (ts: number) => {
  const sent: ProbeMessage[] = [];
  const client = new ProbeClient({
    results: editor, cacheReady: Promise.resolve(), rom: () => p.rom, tileset: () => ts,
    kindLevel: () => { throw new Error('no kinds'); },
    connect: () => (m) => sent.push(m),
    later: () => {}, setBusy: () => {}, ready: () => {}, kindsReady: () => {},
  });
  client.wantPrefetch('picker', { sprites: true });
  await new Promise((r) => setTimeout(r, 0));
  return sent.flatMap((m) => (m.type === 'prefetch' ? m.jobs : [])).filter((j) => j.kind === 'sprite').map((j) => j.num);
};
const in4 = await prefetched(4), in1 = await prefetched(1);
check(!in4.includes(0x0d) && in4.includes(0x36) && in4.length === 200, `prefetch in tileset 4: every sprite but 0D (${in4.length})`);
check(!in1.includes(0x0d) && !in1.includes(0x36) && in1.length === 199, `prefetch in tileset 1: neither 0D nor 36 (${in1.length})`);

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
