// A small AddmusicK song with its own BRR sample, laid out like a download (for tests; also
// `node tools/testsong.ts out.zip` writes it as a file to try in the editor).
import { writeFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';

// a looping square wave as BRR: 2-byte loop header (offset 0), then 9-byte blocks of 16 samples
function squareBrr(blocks = 4): Uint8Array {
  const out = new Uint8Array(2 + blocks * 9);
  for (let b = 0; b < blocks; b++) {
    const o = 2 + b * 9;
    out[o] = (11 << 4) | (b === blocks - 1 ? 3 : 0); // shift 11, filter 0, loop+end on the last
    for (let i = 0; i < 8; i++) out[o + 1 + i] = b % 2 ? 0x99 : 0x77; // -7 / +7 per nibble
  }
  return out;
}

export function testSongZip(): Uint8Array {
  const song = `#amk 2
#path "testsong"
#samples
{
	#optimized
	"square.brr"
}
#instruments
{
	"square.brr" $8F $E0 $00 $04 $00
}
#spc
{
	#title "Square Test"
	#author "Solar Magic test"
}
t40 w200
#0 @30 v220 o4 l8 c d e f g a b > c < /
c e g > c < g e c4
`;
  return zipSync({
    'Square Test/Square Test.txt': strToU8(song),
    'Square Test/readme.txt': strToU8('Insert with AddmusicK. Put the samples folder into AddmusicK\'s samples folder.'),
    'Square Test/samples/testsong/square.brr': squareBrr(),
  });
}


if (process.argv[1]?.endsWith('testsong.ts') && process.argv[2]) writeFileSync(process.argv[2], testSongZip());
