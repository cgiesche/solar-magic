// The level view's View options kept in the browser (#488): what View → Layers / Overlays shows and the keys that
// switch them (Ctrl+' grid, C collision, V game view frame, J jump arcs) – as the overworld's view options are.
// Animation has its own preference (motion.ts animationPref).

import { jsonPref } from './prefs.ts';
import type { Shown } from '../core/viewsettings.ts';

type Kept = Partial<Record<keyof Shown, boolean>>;
const levelViewPref = jsonPref<Kept>('level-view', {}, (v): v is Kept =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'boolean'));

/** show with the kept options applied; every later change of an option (but Animation) is kept again. */
export function keptShown(show: Shown): Shown {
  const kept = levelViewPref.get();
  for (const k of Object.keys(show) as (keyof Shown)[]) if (k !== 'anim' && typeof kept[k] === 'boolean') show[k] = kept[k]!;
  return new Proxy(show, {
    set(t, k, v) {
      (t as unknown as Record<string | symbol, unknown>)[k] = v;
      if (k !== 'anim' && typeof k === 'string' && k in t && typeof v === 'boolean') levelViewPref.set({ ...levelViewPref.get(), [k]: v });
      return true;
    },
  });
}
