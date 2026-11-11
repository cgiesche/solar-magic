// Colors of the marks canvases draw over game content: selections, warnings, refusals, highlights (#473). They are
// the same in every theme – they sit on the game's pictures, which never change with the theme – and are kept here
// instead of as literals in each view. What a canvas draws as part of the UI (the backdrop around a level, a map)
// reads the UI's CSS tokens (style.css :root) with uiToken.

export const MARK = {
  select: '#4cc2ff', // the selection, the picked item, a target
  warn: '#ffb000', // to be noticed: a pending change, a destination, an over-budget part
  error: '#ff5050', // refused, broken
  ok: '#5cff7a', // allowed (a drop that works)
  highlight: '#ffd34c', // what an event, a history entry or a clause points at
  missing: '#ff4fd8', // nothing to draw (no graphics loaded)
};

/** A mark's color (#rrggbb) with an alpha, as rgba(). */
export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const tokens = new Map<string, string>();

/** A UI token's value (style.css :root, e.g. '--canvas-bg'), read once per theme; the fallback outside a page (tests). */
export function uiToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  let v = tokens.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    tokens.set(name, v);
  }
  return v;
}

const listeners = new Set<() => void>();

/** The tokens' values changed (another theme): uiToken reads them anew, the canvases that draw with them repaint. */
export function tokensChanged(): void {
  tokens.clear();
  for (const fn of [...listeners]) fn();
}

/** fn: called when the tokens change (a canvas drawing with uiToken repaints). */
export function onTokensChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
