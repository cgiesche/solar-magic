// The tile search on the Map16 sheets (tilesearch.ts): by number, and by part of a tile's texts (custom
// block file, the user's tile name, its emulated behavior), case-insensitive; the tiles still being determined
// are counted. An extended tile without a custom block is told by the tile it acts like: checked by emulation
// (its probe says the same as that tile's).
import { Rom } from '../src/core/rom.ts';
import { BlockProber, probeText } from '../src/core/blockprobe.ts';
import { installEditorPatch } from '../src/core/patches.ts';
import { setActsLike, setExtTileWords, enableBlocks, setBlock, DEFAULT_ACTS } from '../src/core/map16ext.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { tileMatches, behaviorTexts, behaviorTile, pendingHint } from '../src/ui/tilesearch.ts';
import { editorImage, cleanImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const eq = (a: number[] | null, b: number[] | null) => JSON.stringify(a) === JSON.stringify(b);

const files = new Map([[0x130, 'blocks/coin_door.asm']]);
const names = new Map([[0x200, 'Castle window'], [0x201, 'Window ledge'], [0x210, 'Bush']]);

check(tileMatches('  ', 0x400, [files, names]) === null, 'an empty input matches nothing and dims nothing');
check(eq(tileMatches('025', 0x400), [0x25]), 'a padded number is the tile');
check(eq(tileMatches('21', 0x400)?.slice(0, 2) ?? null, [0x21, 0x210]), 'a short number is the start');
check(eq(tileMatches('window', 0x400, [files, names]), [0x200, 0x201]), 'part of a name matches the named tiles');
check(eq(tileMatches('WINDOW', 0x400, [files, names]), [0x200, 0x201]), 'any case');
check(eq(tileMatches('castle win', 0x400, [files, names]), [0x200]), 'a single match');
check(eq(tileMatches('coin', 0x400, [files, names]), [0x130]), 'block files still match');
check(eq(tileMatches('bush', 0x200, [files, names]), []), 'only tiles below the count');
const hexWord = tileMatches('b', 0x400, [names]);
check(!!hexWord?.includes(0xb) && !!hexWord?.includes(0x210), 'a hex digit matches numbers and names');

// behavior texts: of the tiles determined (by the probe of the tile that tells them), undefined still being
// determined; tile 7 has none, tile 1F0 is told by 2B
const probed = new Map<number, string>([[0x2b, '+1 coin'], [0x130, 'from below: solid, no effect']]);
const how = behaviorTexts(0x200, (t) => t === 7 ? -1 : t === 0x1f0 ? 0x2b : t, (b) => probed.get(b) ?? (b < 0x10 ? undefined : ''));
check(how.pending === 0x10 - 1, 'the probes still being determined are counted (not tiles without behavior)');
check(how.texts.get(0x1f0) === '+1 coin' && !how.texts.has(7) && !how.texts.has(3), 'a tile has the text of the probe that tells it');
check(eq(tileMatches('coin', 0x200, [names, how.texts]), [0x2b, 0x1f0]), 'part of the behavior text matches the tiles');
check(eq(tileMatches('SOLID', 0x200, [how.texts]), [0x130]), 'behavior in any case');
check(eq(tileMatches('solid', 0x200, [files, names]), []), 'without behavior texts no tile matches by behavior');
check(pendingHint(0) === '' && pendingHint(1) === '1 tile still being determined …' && pendingHint(12) === '12 tiles still being determined …', 'the hint while not final');

// by emulation: an extended tile without a custom block does what the tile it acts like does
const rom = new Rom((await editorImage()).slice());
installEditorPatch(rom);
const emu = new LevelEmulator(rom); emu.boot();
const src = map16Source(rom, emu.load(0x105));
enableBlocks(rom, src.fg(DEFAULT_ACTS));
const prober = new BlockProber(rom);
const refs = [0x2b, 0x11f, 0x114, 0x11e, 0x130, 0x124];
refs.forEach((ref, i) => { setExtTileWords(rom, 0x2a0 + i, src.fg(ref)); setActsLike(rom, 0x2a0 + i, ref); });
for (const [i, ref] of refs.entries()) {
  const t = 0x2a0 + i, a = probeText(prober.probe(t)), b = probeText(prober.probe(ref));
  check(behaviorTile(rom, t) === ref && a === b, `${t.toString(16)} acting like ${ref.toString(16)}: "${a}" as "${b}"`);
}
check(behaviorTile(rom, 0x130) === 0x130 && behaviorTile(rom, 0x1ff) === 0x1ff, 'a tile below 200 is told by itself');
setBlock(rom, 0x2b0, 0x108000, false);
check(behaviorTile(rom, 0x2b0) === 0x2b0, 'a tile with a custom block is told by itself');
check(behaviorTile(new Rom(cleanImage()), 0x2a0) === -1 && behaviorTile(new Rom(cleanImage()), 0x2b) === 0x2b, 'without the extension an extended tile has no behavior');

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
