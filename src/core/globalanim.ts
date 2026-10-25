// Global animation slots as a graphics part (see CONTEXT.md: Graphics part): Lunar Magic's global
// ExAnimation list as Callisto exports it – a BPS from the clean game to a whole Lunar Magic ROM (the
// Romhack Races baserom's export/global/exanimation.bps). The list is read from the patch's target in
// Lunar Magic's layout, which the editor's engine follows (exanim.ts); the few bytes the patch takes from
// the clean game come from this ROM where it still has them (cleangame.ts). The slots' frames come from
// the package's ExGFX 60–63 file of the list's Anim graphic and go into the Anim graphic of this ROM's
// global list (levelgfx.ts placeGlobalSlots).

import { snesToPc } from './rom.ts';
import { bpsReader } from './bps.ts';
import { SMW_CLEAN_CRC, CLEAN_SIZE } from './cleangame.ts';
import { exanimLayout, globalListAddr, parseList, listMaxLength, type ExList, type RomRead } from './exanim.ts';

type Source = (o: number) => number | null;
const none: Source = () => null;

// a byte of the target depends on a byte of the clean game this ROM does not have
class NotKnown extends Error {}

// the Lunar Magic ROM a BPS from the clean game makes, read through it (bytes not known throw NotKnown),
// and its global list's address (0: none); null when it is no such patch or has no ExAnimation
function lmRom(data: Uint8Array, clean: Source): { rom: RomRead; byte: (pc: number) => number | null; list: number } | null {
  const r = bpsReader(data);
  if (!r || r.sourceSize !== CLEAN_SIZE || r.sourceCrc !== SMW_CLEAN_CRC) return null;
  const byte = (pc: number) => r.byte(pc, clean);
  const r8 = (a: number) => {
    const v = byte(snesToPc(a));
    if (v === null) throw new NotKnown();
    return v;
  };
  const rom: RomRead = { r8, r16: (a) => r8(a) | (r8(a + 1) << 8), r24: (a) => r8(a) | (r8(a + 1) << 8) | (r8(a + 2) << 16) };
  return exanimLayout(rom) ? { rom, byte, list: globalListAddr(rom) } : null;
}

// runs `read`; 'not known' when it needs a byte that is not known
function known<T>(read: () => T): T | 'not known' {
  try { return read(); } catch (e) {
    if (e instanceof NotKnown) return 'not known';
    throw e;
  }
}

// whether a file is such a patch with global animation slots, told from the patch alone: its list's
// address and the number of slots it uses are bytes the patch brings
export function isGlobalAnimBps(data: Uint8Array): boolean {
  return known(() => {
    const m = lmRom(data, none);
    return !!m?.list && m.rom.r8(m.list) > 0;
  }) === true;
}

// the patch's global list; null when it has none, 'not known' when it needs bytes of the clean game
// this ROM no longer has (`clean`: cleangame.ts cleanGameBytes)
export function globalAnimList(data: Uint8Array, clean: Source | null): ExList | null | 'not known' {
  return known(() => {
    const m = lmRom(data, clean ?? none);
    if (!m?.list) return null;
    // the list's bytes up to the first not known one; a list cut short by it is not known
    const max = listMaxLength(m.list), b: number[] = [];
    for (let i = 0; i < max; i++) {
      const v = m.byte(snesToPc(m.list + i));
      if (v === null) break;
      b.push(v);
    }
    try { return parseList(Uint8Array.from(b)).list; } catch (e) {
      if (b.length < max && /truncated/.test(String(e))) throw new NotKnown();
      return null;
    }
  });
}
