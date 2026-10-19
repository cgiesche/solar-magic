// An ExGFX number field (patches.ts): 000–FFF, not the game's files nor FF (a slot's "none"); next to it
// the next free number of the file's range (ExGFX 80–DFF, or E00–FFF for files kept "as is"), one click
// takes it.
import type { Rom } from '../core/rom.ts';
import { h, hexInput } from './dom.ts';
import { freeGfx, gfxEntry, gfxHex, VANILLA_GFX, AS_IS_FIRST, MAX_GFX, GFX_NONE, type GfxRange } from '../core/patches.ts';

// `range`: the file's range (asked when the suggestion is made); `taken`: numbers other files of the same
// upload go to
export function gfxNumberField(rom: Rom, value: number, range: () => GfxRange, taken: () => Set<number>, onChange: (v: number) => void): HTMLElement {
  const inp = hexInput(value, 3, (v) => { value = v; onChange(v); update(); }, MAX_GFX, (v) => v >= VANILLA_GFX && v !== GFX_NONE,
    `hex ${gfxHex(VANILLA_GFX)}–${gfxHex(MAX_GFX)}, not FF (a graphics slot's “none”)`);
  const next = h('button', { class: 'gfxnum-next' });
  const hint = h('span', { class: 'hint' });
  let free = -1;
  const update = () => {
    const r = range(), others = taken();
    free = freeGfx(rom, others, r);
    next.textContent = free < 0 ? '' : `Next free: ${gfxHex(free)}`;
    next.title = r === 'asIs' ? `The first free number in ${gfxHex(AS_IS_FIRST)}–${gfxHex(MAX_GFX)}, where files are kept as they are (layer 3 graphics and tilemaps)` : `The first free ExGFX number (from ${gfxHex(0x80)})`;
    next.hidden = free < 0 || free === value;
    hint.textContent = others.has(value) ? ' – another file of this upload has this number' : gfxEntry(rom, value) ? ' – replaces the file there' : '';
  };
  next.addEventListener('click', () => {
    if (free < 0) return;
    inp.value = free.toString(16).toUpperCase().padStart(3, '0');
    inp.dispatchEvent(new Event('change'));
  });
  update();
  return h('span', { class: 'gfxnum' }, inp, ' ', next, hint);
}
