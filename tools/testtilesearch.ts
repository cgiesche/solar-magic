// The tile search on the Map16 sheets (tilesearch.ts): by number, and by part of a tile's texts (custom
// block file, the user's tile name), case-insensitive.
import { tileMatches } from '../src/ui/tilesearch.ts';

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
const both = tileMatches('b', 0x400, [names]);
check(both!.includes(0xb) && both!.includes(0x210), 'a hex digit matches numbers and names');

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
