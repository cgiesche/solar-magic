// The title screen picture as a graphics part (see CONTEXT.md: Graphics part): Lunar Magic's title screen as
// Callisto exports it – a BPS from the clean game to a whole Lunar Magic ROM (the Romhack Races baserom's
// export/global/titlescreen.bps). A package that redraws layer 3's graphics (global GFX files) has the picture
// drawn from them there: without it the game's picture shows 8x8 tiles that hold other pictures (#548: "Ni89ndo").
// The picture is read from the patch's target where its stripe image pointer says it is, in Lunar Magic's layout
// (titlescreen.ts: one stripe of 32 × 29 tiles at VRAM $5000); the bytes the patch takes from the clean game come
// from this ROM where it still has them (cleangame.ts). Nothing else of the patch is taken over (a title screen
// movement or colours of its own).

import { snesToPc } from './rom.ts';
import { cleanGameBps, known } from './cleangame.ts';
import { TITLE_COLS, TITLE_ROWS, TITLE_STRIPE_PTR, titleStripe } from './titlescreen.ts';

type Source = (o: number) => number | null;
const WORDS = TITLE_COLS * TITLE_ROWS;
const HEADER = titleStripe(new Uint16Array(WORDS)).subarray(0, 4);

// whether a file is such a patch with a title screen picture of its own, told from the patch alone: a byte of the
// stripe image pointer that it brings itself or takes from another place of the clean game
export function isTitleBps(data: Uint8Array): boolean {
  let asked = -1; // the clean game's byte the patch's reader asked for
  const patch = cleanGameBps(data, (o) => { asked = o; return null; });
  if (!patch) return false;
  for (let i = 0; i < 3; i++) {
    const pc = snesToPc(TITLE_STRIPE_PTR) + i;
    if (patch.byte(pc) !== null || asked !== pc) return true;
  }
  return false;
}

// the patch's title screen picture (32 × 29 words, row by row); null when it is no such patch or its stripe image
// is not in Lunar Magic's layout, 'not known' when it needs bytes of the clean game this ROM no longer has
// (`clean`: cleangame.ts cleanGameBytes)
export function titleMapOfBps(data: Uint8Array, clean: Source | null): Uint16Array | null | 'not known' {
  return known(() => {
    const rom = cleanGameBps(data, (o) => clean?.(o) ?? null);
    if (!rom) return null;
    const at = rom.r24(TITLE_STRIPE_PTR);
    if ((at & 0xffff) + 4 + WORDS * 2 > 0x10000 || HEADER.some((b, i) => rom.r8(at + i) !== b)) return null;
    return Uint16Array.from({ length: WORDS }, (_, i) => rom.r16(at + 4 + i * 2));
  });
}
