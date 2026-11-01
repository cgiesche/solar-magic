// A package that replaces the whole overworld (Overworld Revolution, signature `YFOR` at $048000) locks the overworld
// workspace (ADR 0005); without it the overworld is the editor's.
import { Rom } from '../src/core/rom.ts';
import { overworldReplacement } from '../src/core/overworld.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const image = await editorImage();

{
  const rom = new Rom(image.slice());
  check(overworldReplacement(rom) === null, 'the editor\'s ROM: no overworld replacement');
  rom.writeBytes(0x048000, new TextEncoder().encode('YFOR'));
  const r = overworldReplacement(rom);
  check(r !== null && /Overworld Revolution/.test(r), `signature YFOR at $048000: replaced by ${r}`);
  rom.writeBytes(0x048000, new TextEncoder().encode('YFO_'));
  check(overworldReplacement(rom) === null, 'another signature: no overworld replacement');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
