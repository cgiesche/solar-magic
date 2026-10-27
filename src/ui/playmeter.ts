// Test play's meters beside the game: live slots of the sprite tables (a bar each, red after a failed
// spawn), a graph of the last frames, and the failed spawns with where Mario was, to show in the level.

import { h } from './dom.ts';
import { hex } from '../core/names.ts';
import { SLOT_KINDS, SLOT_TABLES, type SlotKind } from '../core/slotwatch.ts';
import type { PlayLog, PlayEvent } from '../core/playlog.ts';

export const GRAPH_FRAMES = 256;
const WARN_FRAMES = 60; // a meter stays red this long after a failed spawn

const KIND_NAME: Record<SlotKind, string> = { sprite: 'Sprites', extended: 'Extended', cluster: 'Cluster' };
const KIND_HELP: Record<SlotKind, string> = {
  sprite: 'Normal sprites: enemies, items, platforms …',
  extended: 'Extended sprites: fireballs, hammers, bones, smoke of some sprites …',
  cluster: 'Cluster sprites: Boo ceiling and rings, falling spikes, bonus game 1-Ups …',
};
const SPAWN_NAME: Record<SlotKind, string> = { sprite: 'A sprite', extended: 'An extended sprite', cluster: 'A cluster sprite' };

export function eventText(e: PlayEvent): string {
  return `${SPAWN_NAME[e.kind]} did not spawn${e.count > 1 ? ` (×${e.count})` : ''}`;
}

export function eventHelp(e: PlayEvent): string {
  const t = e.kind === 'sprite' ? 'sprite' : `${e.kind} sprite`;
  return e.free === 0
    ? `All ${SLOT_TABLES[e.kind].slots} ${t} slots were taken.`
    : `The ${e.searched} ${t} slots it may use were taken, ${e.free} others were free: the level's sprite memory or the code that spawns it limits its slots.`;
}

// show: closes test play and shows a tile of the level
export function playMeter(log: PlayLog, show: (tx: number, ty: number) => void): { el: HTMLElement; update: () => void } {
  const rows = SLOT_KINDS.map((k) => {
    const fill = h('div', { class: 'meter-fill' });
    const val = h('span', { class: 'meter-val' });
    const row = h('div', { class: 'meter-row', title: KIND_HELP[k] }, h('span', { class: 'meter-label' }, KIND_NAME[k]), h('div', { class: 'meter-bar' }, fill), val);
    return { k, row, fill, val };
  });
  const graph = h('canvas', { width: GRAPH_FRAMES, height: 48, class: 'meter-graph', title: `Sprite slots in use over the last ${GRAPH_FRAMES} frames; red: a sprite did not spawn` });
  const gctx = graph.getContext('2d')!;
  const list = h('div', { class: 'meter-events' });
  const empty = h('div', { class: 'hint' }, 'No sprite failed to spawn.');
  list.append(empty);
  let shown = ''; // the events in the list (number, failures)

  const update = () => {
    const recent = log.history.slice(-WARN_FRAMES), last = recent[recent.length - 1];
    for (const { k, row, fill, val } of rows) {
      const n = last?.used[k] ?? 0, max = SLOT_TABLES[k].slots;
      fill.style.width = `${(100 * n) / max}%`;
      val.textContent = `${n}/${max}`;
      row.classList.toggle('warn', recent.some((f) => f.failed.some((x) => x.kind === k)));
    }
    drawGraph(gctx, log);
    const now = `${log.events.length}:${log.events.reduce((a, e) => a + e.count, 0)}`;
    if (now !== shown) { shown = now; renderList(); }
  };

  const renderList = () => {
    if (!log.events.length) { list.replaceChildren(empty); return; }
    // newest first
    list.replaceChildren(...log.events.slice().reverse().map((e) => h('div', { class: 'meter-event', title: eventHelp(e) },
      h('span', null, `Frame ${e.frame} · ${eventText(e)} · Mario at ${hex(e.tx, 2)}/${hex(e.ty, 2)}`),
      h('button', { title: 'Quit the test and show this place in the level', onclick: () => show(e.tx, e.ty) }, 'Show'),
    )));
  };

  const el = h('div', { class: 'play-meter' }, ...rows.map((r) => r.row), graph, h('div', { class: 'hint' }, 'Failed spawns'), list);
  return { el, update };
}

// sprite slots (filled), extended and cluster slots (lines) of the last frames, failed spawns as red ticks
function drawGraph(g: CanvasRenderingContext2D, log: PlayLog): void {
  const { width: W, height: H } = g.canvas;
  g.clearRect(0, 0, W, H);
  const hist = log.history.slice(-W), x0 = W - hist.length;
  const y = (n: number, k: SlotKind) => H - 1 - Math.round(((H - 2) * n) / SLOT_TABLES[k].slots);
  g.fillStyle = '#e05252';
  hist.forEach((f, i) => { if (f.failed.length) g.fillRect(x0 + i, 0, 1, H); });
  g.fillStyle = 'rgba(76, 194, 255, 0.45)';
  hist.forEach((f, i) => { const t = y(f.used.sprite, 'sprite'); g.fillRect(x0 + i, t, 1, H - t); });
  for (const [k, c] of [['extended', '#e0c252'], ['cluster', '#b07fe0']] as [SlotKind, string][]) {
    g.strokeStyle = c;
    g.beginPath();
    hist.forEach((f, i) => { const t = y(f.used[k], k) + 0.5; if (i) g.lineTo(x0 + i, t); else g.moveTo(x0, t); });
    g.stroke();
  }
}
