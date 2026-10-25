// Custom sound effects of AddmusicK (see CONTEXT.md: Sound effect): text files in its folders 1DF9 and
// 1DFC, numbered in its "Addmusic_sound effects.txt" and played by writing the number to $1DF9 or $1DFC.
// They live in the music project (music.ts) and are inserted with the songs. Here: finding them in an
// upload with the author's numbers, choosing free numbers, the defines of code playing one (a link), and
// the list lines AddmusicK gets.

import { scanDefines, parseNum } from './patchpkg.ts';
import { AMK_SFX } from '../vendor/amk/originals.ts';

export type SfxBank = '1DF9' | '1DFC';
export const SFX_BANKS: SfxBank[] = ['1DF9', '1DFC'];
export const SFX_LIST = 'Addmusic_sound effects.txt';
const LAST_SFX = 0xff;

// a sound effect of the music project
export interface SoundEffect {
  bank: SfxBank;
  num: number;
  file: string; // relative to the bank's folder ("<folder>/<name>.txt")
  name: string;
}

// a sound effect of an upload
export interface FoundSfx {
  file: string; // its path in the upload
  bank: SfxBank;
  rel: string; // its path below the bank's folder (as the author's list names it)
  author: number | null; // its number in the author's list, if the upload has one
}

const dec = new TextDecoder();
const BANK_FILE = /(?:^|\/)(1DF9|1DFC)\/(.+\.txt)$/i;
export const isSfxList = (path: string) => path.slice(path.lastIndexOf('/') + 1).toLowerCase() === SFX_LIST.toLowerCase();
export const sfxName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1).replace(/\.txt$/i, '');
const key = (bank: string, name: string) => `${bank.toUpperCase()}/${name.replace(/\\/g, '/').toLowerCase()}`;

// the lines of AddmusicK's list: bank/name (lower case) → number; pointers to another one ("*") left out
export function parseSfxList(text: string): Map<string, number> {
  const out = new Map<string, number>();
  let bank: SfxBank | null = null;
  for (const l of text.split(/\r?\n/)) {
    const head = /^\s*SFX(1DF9|1DFC):/i.exec(l);
    if (head) { bank = head[1].toUpperCase() as SfxBank; continue; }
    const m = /^\s*([0-9a-f]{1,2})\s+(\*)?\??\s*(\S.*?)\s*$/i.exec(l);
    if (bank && m && !m[2]) out.set(key(bank, m[3]), parseInt(m[1], 16));
  }
  return out;
}

// the sound effects of an upload: the .txt files in a folder 1DF9 or 1DFC, numbered by a list in it
export function findSfx(files: Map<string, Uint8Array>): FoundSfx[] {
  const listed = new Map<string, number>();
  for (const [p, c] of files) if (isSfxList(p)) for (const [k, n] of parseSfxList(dec.decode(c))) listed.set(k, n);
  return [...files.keys()].flatMap((file): FoundSfx[] => {
    const m = BANK_FILE.exec(file);
    if (!m) return [];
    const bank = m[1].toUpperCase() as SfxBank;
    return [{ file, bank, rel: m[2], author: listed.get(key(bank, m[2])) ?? null }];
  });
}

// numbers for sound effects of an upload: the author's when free, else the lowest free one of the bank
// (AddmusicK's own and those of the project are taken); -1 when the bank is full
export function sfxNumbers(project: SoundEffect[], found: FoundSfx[]): number[] {
  const taken = new Map(SFX_BANKS.map((b) => [b, new Set([...AMK_SFX[b], ...project.filter((s) => s.bank === b).map((s) => s.num)])]));
  const free = (b: SfxBank, n: number | null) => n !== null && n > 0 && n <= LAST_SFX && !taken.get(b)!.has(n);
  return found.map((f) => {
    let n = free(f.bank, f.author) ? f.author! : 1;
    while (n <= LAST_SFX && !free(f.bank, n)) n++;
    if (n > LAST_SFX) return -1;
    taken.get(f.bank)!.add(n);
    return n;
  });
}

// a define in a file of the upload playing sfx[sfx] (by its author's number)
export interface SfxLink { file: string; define: string; sfx: number }

// a define's value as a number ("#$38" too)
const num = (v: string) => parseNum(v.trim().replace(/^#/, ''));

// The defines of the upload's code that play one of its sound effects: one whose comment names the
// sound effect's file (set to its author's number, or named like a sound effect: sfx, sound), or one
// named like a sound effect set to the author's number – of the bank a define next to it names (e.g.
// !death_sfx = $38 with !death_sfx_addr = $1DFC), or with no such define, of the only sound effect with
// that number.
export function sfxLinks(files: Map<string, Uint8Array>, found: FoundSfx[]): SfxLink[] {
  const links: SfxLink[] = [];
  if (!found.length) return links;
  for (const [f, c] of files) {
    if (!/\.(asm|asar)$/i.test(f)) continue;
    const defs = scanDefines(dec.decode(c));
    for (const d of defs) {
      const n = num(d.value);
      const named = /sfx|sound/i.test(d.name);
      let i = found.findIndex((s) => (named || (n !== null && s.author === n)) && d.comment.toLowerCase().includes(sfxName(s.rel).toLowerCase()));
      if (i < 0 && n !== null && named) {
        const bankDef = defs.find((o) => o !== d && o.name.toLowerCase().startsWith(d.name.toLowerCase()) && (num(o.value) === 0x1df9 || num(o.value) === 0x1dfc));
        const cands = found.map((s, j) => [s, j] as const).filter(([s]) => s.author === n && (!bankDef || num(bankDef.value) === parseInt(s.bank, 16)));
        if (cands.length === 1) i = cands[0][1];
      }
      if (i >= 0) links.push({ file: f, define: d.name, sfx: i });
    }
  }
  return links;
}

// the lines of the project's sound effects for AddmusicK's list
export function sfxListText(sfx: SoundEffect[]): string {
  return SFX_BANKS.map((b) => `SFX${b}:\n${sfx.filter((s) => s.bank === b).map((s) => `${s.num.toString(16).toUpperCase().padStart(2, '0')}  ${s.file}\n`).join('')}`).join('\n');
}
