// The test ROM: the clean game (test/fixtures/smw.smc, provided by hand), and the same as the editor
// opens it – with its own patches installed (editorpatches.ts)
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { installEditorPatches } from '../src/core/editorpatches.ts';

export const cleanImage = (): Uint8Array => new Uint8Array(readFileSync('test/fixtures/smw.smc'));

let patched: Uint8Array | null = null;
// a copy of the image with the editor patches
export async function editorImage(): Promise<Uint8Array> {
  if (!patched) {
    const rom = new Rom(cleanImage());
    await installEditorPatches(rom);
    patched = rom.data;
  }
  return patched.slice();
}

// bytes that differ between two ROM images (missing bytes count as 0), not counting `skip` and the patch
// registry (SMWA): it is rewritten into the first free space after every change, so it moves around
export function romDiff(a: Uint8Array, b: Uint8Array, skip: (i: number) => boolean = () => false): number {
  const reg = (d: Uint8Array) => new Rom(d.slice()).scanRats().filter((r) => [0x53, 0x4d, 0x57, 0x41].every((m, k) => d[r.start + 8 + k] === m)).map((r) => [r.start, r.start + 8 + r.size]);
  const regs = [...reg(a), ...reg(b)];
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0) && !skip(i) && !regs.some(([s, e]) => i >= s && i < e)) n++;
  return n;
}
