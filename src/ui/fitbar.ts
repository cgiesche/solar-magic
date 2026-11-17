// A bar that gives up room in steps instead of letting its parts run into each other: it is laid out at level 0
// (everything in full) and, while its content is wider than itself, at the next level – the classes fit-1 … fit-N
// on the bar, all up to the level reached, say what the style sheet shortens. Measured from the content at hand
// (labels, fonts, the window), not by widths written down: whenever the bar's width or its content changes.

import { onCloseMenus } from './menu.ts';

/** Keeps `bar` at the lowest of the levels 0 … max its content fits in. The bar's columns must not shrink below
 *  their content (it overflows instead: that is what is measured). apply: what a level changes besides the
 *  classes, also called while trying levels; changed: the level it settled on is another one. */
export function fitBar(bar: HTMLElement, max: number, apply: (level: number) => void, changed: (level: number) => void): () => void {
  let level = -1, queued = false;
  const set = (l: number) => {
    for (let i = 1; i <= max; i++) bar.classList.toggle(`fit-${i}`, i <= l);
    apply(l);
  };
  const fits = () => {
    const last = bar.lastElementChild;
    if (!last) return true;
    const end = bar.getBoundingClientRect().right - parseFloat(getComputedStyle(bar).paddingRight);
    return last.getBoundingClientRect().right <= end + 0.5;
  };
  const fit = () => {
    queued = false;
    if (!bar.isConnected || !bar.clientWidth) return;
    let l = 0;
    for (set(l); l < max && !fits(); set(++l));
    if (l !== level) { level = l; changed(l); }
  };
  // (once per frame: a change of the content comes as several mutations)
  const ask = () => { if (!queued) { queued = true; requestAnimationFrame(fit); } };
  new ResizeObserver(fit).observe(bar);
  new MutationObserver(ask).observe(bar, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  void document.fonts?.ready.then(fit);
  onCloseMenus(ask);
  return fit;
}
