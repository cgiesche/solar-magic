// An ExGFX number field (patches.ts): a number that may hold the file (gfxNumberProblem: 32–FFF, not FF,
// no 3bpp graphics in E00–FFF), next to it the next free number of the file's range (gfxRangeFor: ExGFX
// 80–DFF, or E00–FFF for files kept "as is"), one click takes it.
import type { Rom } from '../core/rom.ts';
import { h, hexInput } from './dom.ts';
import { freeGfx, gfxEntry, gfxHex, gfxRangeFor, gfxNumberProblem, VANILLA_GFX, AS_IS_FIRST, MAX_GFX, type GfxFileKind } from '../core/patches.ts';

// `file`: what is known of the file (asked when the suggestion is made); `taken`: numbers other files of
// the same upload go to; `author`: the number the file has where it comes from (`by`: e.g. "Lunar Magic"),
// shown with the reason while the field has another one
export interface GfxNumberOptions { file: () => GfxFileKind; taken: () => Set<number>; onChange: (v: number) => void; author?: number | null; by?: string }

// the fields on screen: one's change can change the others' hints ("another file of this upload")
const fields = new Map<HTMLElement, () => void>();

export function gfxNumberField(rom: Rom, value: number, o: GfxNumberOptions): HTMLElement {
  const changed = () => { for (const [el, up] of fields) if (el.isConnected) up(); else fields.delete(el); };
  const inp = hexInput(value, 3, (v) => { value = v; o.onChange(v); update(); changed(); }, MAX_GFX, (v) => gfxNumberProblem(v, o.file()) ?? true,
    `hex ${gfxHex(VANILLA_GFX)}–${gfxHex(MAX_GFX)}, not FF (a graphics slot's “none”), no 3bpp graphics in ${gfxHex(AS_IS_FIRST)}–${gfxHex(MAX_GFX)}`);
  const next = h('button', { class: 'gfxnum-next', type: 'button' });
  const hint = h('span', { class: 'hint' });
  let free = -1;
  const update = () => {
    const f = o.file(), r = gfxRangeFor(f), others = o.taken();
    free = freeGfx(rom, others, r);
    next.textContent = free < 0 ? '' : `Next free: ${gfxHex(free)}`;
    next.title = r === 'asIs' ? `The first free number in ${gfxHex(AS_IS_FIRST)}–${gfxHex(MAX_GFX)}, where files are kept as they are (layer 3 graphics and tilemaps)` : `The first free ExGFX number (from ${gfxHex(0x80)})`;
    next.hidden = free < 0 || free === value;
    const a = o.author ?? null;
    const misfit = a !== null && a !== value ? gfxNumberProblem(a, f) : null;
    const from = a === null || a === value ? '' : ` (${o.by ?? 'author'}: ${gfxHex(a)}${misfit ? ', not possible for this file' : others.has(a) || gfxEntry(rom, a) ? ', already in use here' : ''})`;
    hint.textContent = (others.has(value) ? ' – another file of this upload has this number' : gfxEntry(rom, value) ? ' – replaces the file there' : '') + from;
    hint.title = misfit ?? '';
  };
  next.addEventListener('click', () => {
    if (free < 0) return;
    inp.value = free.toString(16).toUpperCase().padStart(3, '0');
    inp.dispatchEvent(new Event('change'));
  });
  update();
  const el = h('span', { class: 'gfxnum' }, inp, ' ', next, hint);
  fields.set(el, update);
  return el;
}
