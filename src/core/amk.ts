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

// files: paths relative to AddmusicK's folder ("music/…", "Addmusic_list.txt") → contents, written
// over AddmusicK's own; args: its command line without the ROM name
export async function runAmk(rom: Uint8Array | null, files: Map<string, Uint8Array | string>, args: string[] = []): Promise<AmkResult> {
  await loadAmk();
  const out: string[] = [], err: string[] = [];
  const m = await factory!({ print: (s: string) => out.push(s), printErr: (s: string) => { out.push(s); err.push(s); } });
  const fs = m.FS;
  fs.chdir('/amk');
  for (const [p, c] of files) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (dir) fs.mkdirTree('/amk/' + dir);
    fs.writeFile('/amk/' + p, c);
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
