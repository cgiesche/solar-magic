// The system asking for reduced motion, and the switches whose default follows it: View → "Animation" (the level's
// and the overworld's animated tiles and colors, #420) and "Animate selection outlines" (ants.ts).

import { boolPref } from './prefs.ts';

export const reducedMotion = (): boolean => {
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; }
};

// View → "Animation", one switch for the level editor and the overworld (App.setAnimation): on by default, off by
// default when the system asks for reduced motion; kept in the browser
export const animationPref = boolPref('animation', () => !reducedMotion());
