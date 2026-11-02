// What Map16 tiles do for the tile searches (tilesearch.ts), from the emulation's block probes: the probes asked
// for, and when to search again as more of them are done.

import { probeText } from '../core/blockprobe.ts';
import type { ProbeClient } from '../core/probeclient.ts';
import type { Rom } from '../core/rom.ts';
import { behaviorTexts, behaviorTile, NO_BEHAVIORS, type Behaviors } from './tilesearch.ts';
import type { AppEvent } from './app.ts';

// what FG tiles 0..count-1 do, as the tooltips say it (the block probes, behaviorTile's), for a typed search (none for
// an empty one); the probes not done yet are asked for (ahead of the prefetched ones), onBehaviorProgress says when
// more are done
export function tileBehaviors(app: { rom: Rom; probes: Pick<ProbeClient, 'block'> }, input: string, count: number): Behaviors {
  if (!input.trim()) return NO_BEHAVIORS;
  return behaviorTexts(count, (t) => behaviorTile(app.rom, t), (b) => { const p = app.probes.block(b); return p && probeText(p); });
}

// fn whenever more tiles' behavior may be known: when the probes are done, and as they go on (a probe done) at most
// once a second; returns what stops it (the global setTimeout, not window's: testtilesearch.ts runs it in Node)
export function onBehaviorProgress(app: { on(ev: AppEvent, fn: () => void): () => void }, fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const now = () => { clearTimeout(timer); timer = undefined; fn(); };
  const offDone = app.on('probes', now);
  const offProgress = app.on('probe-progress', () => { timer ??= setTimeout(now, 1000); });
  return () => { clearTimeout(timer); offDone(); offProgress(); };
}
