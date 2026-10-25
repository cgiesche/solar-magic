// AddmusicK 1.0.11 (https://github.com/KungFuFurby/AddMusicKFF; by Kipernal, maintained since 1.0.6 by
// Medic, HertzDevil, Vitor Vilela, Lui, KevinM, KungFuFurby and others) compiled to WebAssembly with
// Asar linked in (tools/build-amk.sh). Each run gets a fresh instance (AddmusicK keeps its state in
// globals) whose in-memory file system holds AddmusicK's own folder (asm/, samples/, sound effects,
// the original songs) at /amk, plus the ROM and the files of the run.

import type { AmkModule } from '../vendor/amk/amk.mjs';

export interface AmkResult {
  ok: boolean;
  rom: Uint8Array | null; // the ROM after inserting (null with -norom or on failure)
  log: string; // everything AddmusicK printed
  errors: string[]; // its error output, line by line
  spcs: Map<string, Uint8Array>; // generated SPC files by name (without folder)
}

let factory: ((opts?: Record<string, unknown>) => Promise<AmkModule>) | null = null;

export async function loadAmk(): Promise<void> {
  factory ??= (await import('../vendor/amk/amk.mjs')).default;
}

// The folders a song's sample paths step through before a "..", e.g. "Song" of #path "Song" with
// "../optimized/00 SMW @0.brr": Windows resolves such paths by their text, so AddmusicK finds
// samples/optimized/… whether or not samples/Song exists; the in-memory file system needs the folder.
function dotDotDirs(text: string): string[] {
  const t = text.replace(/;[^\n]*/g, '');
  const base = /#path\s+"([^"]*)"/.exec(t)?.[1] ?? '';
  const dirs = new Set<string>();
  for (const [, q] of t.matchAll(/"([^"\n]*\.\.[^"\n]*)"/g)) {
    const seg = `${base}/${q}`.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] !== '..') continue;
      const d = seg.slice(0, i);
      if (d.length && !d.includes('..')) dirs.add(d.join('/'));
    }
  }
  return [...dirs];
}

// AddmusicK's own list of sound effects with more lines in each bank (`add` in the list's format)
function withSfx(own: string, add: string): string {
  const lines = (t: string, bank: string) => (new RegExp(`SFX${bank}:([^]*?)(?=SFX1DF|$)`).exec(t)?.[1] ?? '').trim();
  return ['1DF9', '1DFC'].map((b) => `SFX${b}:\n${[lines(own, b), lines(add, b)].filter(Boolean).join('\n')}\n`).join('\n');
}

// files: paths relative to AddmusicK's folder ("music/…", "1DFC/…", "Addmusic_list.txt") → contents,
// written over AddmusicK's own – except "Addmusic_sample groups.txt", whose groups are added to
// AddmusicK's own, and "Addmusic_sound effects.txt", whose sound effects are; args: its command line
// without the ROM name
export async function runAmk(rom: Uint8Array | null, files: Map<string, Uint8Array | string>, args: string[] = []): Promise<AmkResult> {
  await loadAmk();
  const out: string[] = [], err: string[] = [];
  const m = await factory!({ print: (s: string) => out.push(s), printErr: (s: string) => { out.push(s); err.push(s); } });
  const fs = m.FS;
  fs.chdir('/amk');
  for (const [p, c] of files) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (dir) fs.mkdirTree('/amk/' + dir);
    if (p === 'Addmusic_sample groups.txt') {
      const own: Uint8Array = fs.readFile('/amk/' + p), add = typeof c === 'string' ? new TextEncoder().encode(c) : c;
      const all = new Uint8Array(own.length + 2 + add.length);
      all.set(own); all.set([10, 10], own.length); all.set(add, own.length + 2);
      fs.writeFile('/amk/' + p, all);
    } else if (p === 'Addmusic_sound effects.txt') {
      const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
      fs.writeFile('/amk/' + p, withSfx(dec(fs.readFile('/amk/' + p)).replace(/\r/g, ''), typeof c === 'string' ? c : dec(c)));
    } else fs.writeFile('/amk/' + p, c);
    if (dir.startsWith('music/') && /\.txt$/i.test(p)) for (const d of dotDotDirs(typeof c === 'string' ? c : new TextDecoder('latin1').decode(c))) {
      fs.mkdirTree(`/amk/${dir}/${d}`);
      fs.mkdirTree(`/amk/samples/${d}`);
    }
  }
  if (rom) fs.writeFile('/amk/rom.sfc', rom);
  let code: number;
  try {
    code = m.callMain(['-noblock', ...args, ...(rom ? ['rom.sfc'] : [])]) ?? 0;
  } catch (e) {
    // exit() of a run that was already returning, or a crash of the tool
    const st = (e as { status?: number }).status;
    if (typeof st !== 'number') { err.push(`AddmusicK crashed: ${e}`); code = 1; } else code = st;
  }
  const spcs = new Map<string, Uint8Array>();
  try {
    for (const f of fs.readdir('/amk/SPCs')) if (f.toLowerCase().endsWith('.spc')) spcs.set(f, fs.readFile('/amk/SPCs/' + f));
  } catch { /* none */ }
  const ok = code === 0 && !err.some((l) => /error/i.test(l));
  return {
    ok,
    rom: ok && rom ? fs.readFile('/amk/rom.sfc') : null,
    log: out.join('\n'),
    errors: err.filter((l) => l.trim()),
    spcs,
  };
}
