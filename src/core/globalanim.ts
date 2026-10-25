// Global animation slots as a graphics part (see CONTEXT.md: Graphics part): Lunar Magic's global
// ExAnimation list as Callisto exports it – a BPS from the clean game to a whole Lunar Magic ROM (the
// Romhack Races baserom's export/global/exanimation.bps). The list is read from the patch's target in
// Lunar Magic's layout, which the editor's engine follows (exanim.ts); the few bytes the patch takes from
// the clean game come from this ROM where it still has them (cleangame.ts). The slots' frames come from
// the package's ExGFX 60–63 file of the list's alternative file and go into the Anim graphic of this ROM's
// global list (levelgfx.ts placeGlobalSlots).

import { snesToPc } from './rom.ts';
import { bpsReader } from './bps.ts';
import { SMW_CLEAN_CRC, CLEAN_SIZE } from './cleangame.ts';
import { exanimLayout, globalListAddr, parseList, type ExList, type RomRead } from './exanim.ts';

type Source = (o: number) => number | null;
const none: Source = () => null;

// a byte of the target depends on a byte of the clean game this ROM does not have
class NotKnown extends Error {}

// the global list of the Lunar Magic ROM a BPS from the clean game makes: null when it has none (or is
// no such patch), 'not known' when it depends on bytes of the clean game `clean` does not give; `slots`:
// only whether the list says it uses slots
function readList(data: Uint8Array, clean: Source, slots = false): ExList | boolean | null | 'not known' {
  const r = bpsReader(data);
  if (!r || r.sourceSize !== CLEAN_SIZE || r.sourceCrc !== SMW_CLEAN_CRC) return null;
  const r8 = (a: number) => {
    const v = r.byte(snesToPc(a), clean);
    if (v === null) throw new NotKnown();
    return v;
  };
  const rom: RomRead = { r8, r16: (a) => r8(a) | (r8(a + 1) << 8), r24: (a) => r8(a) | (r8(a + 1) << 8) | (r8(a + 2) << 16) };
  try {
    if (!exanimLayout(rom)) return null;
    const at = globalListAddr(rom);
    if (!at) return null;
    if (slots) return r8(at) > 0;
    // the list's bytes up to the first not known one; a list cut short by it is not known
    const max = Math.min(0x8000 - (at & 0x7fff), 0x4000), b: number[] = [];
    for (let i = 0; i < max; i++) {
      const v = r.byte(snesToPc(at + i), clean);
      if (v === null) break;
      b.push(v);
    }
    try { return parseList(Uint8Array.from(b)).list; } catch (e) {
      if (b.length < max && /truncated/.test(String(e))) return 'not known';
      return null;
    }
  } catch (e) {
    if (e instanceof NotKnown) return 'not known';
    throw e;
  }
}

// whether a file is such a patch with global animation slots, told from the patch alone: its list's
// address and the number of slots it uses are bytes the patch brings
export function isGlobalAnimBps(data: Uint8Array): boolean {
  return readList(data, none, true) === true;
}

// the patch's global list; null when it has none, 'not known' when it needs bytes of the clean game
// this ROM no longer has (`clean`: cleangame.ts cleanGameBytes)
export function globalAnimList(data: Uint8Array, clean: Source | null): ExList | null | 'not known' {
  return readList(data, clean ?? none) as ExList | null | 'not known';
}
