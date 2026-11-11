// A floating layer – a menu, a context menu, a popover (#465, #480): one way to close them. A mouse press outside
// it or Esc closes it; the keys are seen before the editor's own shortcuts (capture), so Esc closes the layer and
// keeps the selection. onKey handles a layer's own keys first (a menu's arrows): true when it took the key, 'pass'
// to leave the key to the editor (not even Esc closing the layer).

export type LayerOptions = {
  contains: (n: Node) => boolean; // whether a press on this node is inside the layer (its button included)
  close: () => void;
  onKey?: (ev: KeyboardEvent) => boolean | 'pass';
  returnFocus?: () => HTMLElement | null; // focused again when Esc closes the layer
  deferOutside?: boolean; // the press that opened it (a right click) must not close it
};

/** Listens for what closes the layer; the function returned stops listening (call it when the layer closes). */
export function dismissable(o: LayerOptions): () => void {
  const outside = (ev: MouseEvent) => { if (!o.contains(ev.target as Node)) o.close(); };
  const keys = (ev: KeyboardEvent) => {
    const r = o.onKey?.(ev) ?? false;
    if (r === 'pass') return;
    let took = r;
    if (!took && ev.key === 'Escape') {
      o.close();
      o.returnFocus?.()?.focus();
      took = true;
    }
    if (!took) return;
    ev.preventDefault();
    ev.stopPropagation();
  };
  window.addEventListener('keydown', keys, true);
  const timer = o.deferOutside ? setTimeout(() => window.addEventListener('mousedown', outside, true), 0) : 0;
  if (!o.deferOutside) window.addEventListener('mousedown', outside, true);
  return () => {
    clearTimeout(timer);
    window.removeEventListener('keydown', keys, true);
    window.removeEventListener('mousedown', outside, true);
  };
}

/** The first control in a layer focused (else the layer itself), for keyboard users to reach its content. */
export function focusInto(box: HTMLElement): void {
  const first = box.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex="0"], a[href]');
  if (first) { first.focus(); return; }
  if (!box.hasAttribute('tabindex')) box.tabIndex = -1;
  box.focus();
}
