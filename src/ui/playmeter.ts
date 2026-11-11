// Test play's meters beside the game: the CPU's load (red after a lag frame) and live slots of the sprite
// tables (red after a failed spawn), a bar each, graphs of the last frames, and the lag frames and failed
// spawns with where Mario was, and where he died and what killed him, to show in the level.

import { h } from './dom.ts';
import { hex } from '../core/names.ts';
import { LINES_PER_FRAME } from '../core/snes.ts';
import { SLOT_KINDS, SLOT_TABLES, type SlotKind } from '../core/slotwatch.ts';
import { LAG, type PlayLog, type PlayEvent, type LagEvent } from '../core/playlog.ts';
import { killerText } from './deathmarks.ts';

export const GRAPH_FRAMES = 256;
const WARN_FRAMES = 60; // a meter stays red this long after a failed spawn or a lag frame

// per table: the meter's label, its tooltip, what a slot holds (a / an …), the graph's color (a CSS variable)
const KINDS: Record<SlotKind, { label: string; help: string; what: string; a: string; color: string }> = {
  sprite: { label: 'Sprites', help: 'Normal sprites: enemies, items, platforms …', what: 'sprite', a: 'A', color: '--chart-1' },
  extended: { label: 'Extended', help: 'Extended sprites: fireballs, hammers, bones, smoke of some sprites …', what: 'extended sprite', a: 'An', color: '--chart-2' },
  cluster: { label: 'Cluster', help: 'Cluster sprites: Boo ceiling and rings, falling spikes, bonus game 1-Ups …', what: 'cluster sprite', a: 'A', color: '--chart-3' },
};

export function eventText(e: PlayEvent): string {
  const k = KINDS[e.kind];
  return `${k.a} ${k.what} ${e.replaced ? 'replaced another' : 'did not spawn'}${e.count > 1 ? ` (×${e.count})` : ''}`;
}

export function eventHelp(e: PlayEvent): string {
  const t = KINDS[e.kind].what;
  if (e.replaced) return `No ${t} slot it may use was free: it took the slot of another one, which vanished.`;
  return e.free === 0
    ? `All ${SLOT_TABLES[e.kind].slots} ${t} slots were taken.`
    : `The ${e.searched} ${t} slots it may use were taken, ${e.free} others were free: the level's sprite memory or the code that spawns it limits its slots.`;
}

export function lagText(e: LagEvent, worst: boolean): string {
  return `${e.count} lag frame${e.count > 1 ? 's' : ''}${e.last > e.frame ? ` in ${e.last - e.frame + 1} frames` : ''}${worst ? ' (worst)' : ''}`;
}

const percent = (busy: number) => Math.round((100 * busy) / LINES_PER_FRAME);

function meterRow(label: string, help: string) {
  const fill = h('div', { class: 'meter-fill' });
  const val = h('span', { class: 'meter-val' });
  const row = h('div', { class: 'meter-row', title: help }, h('span', { class: 'meter-label' }, label), h('div', { class: 'meter-bar' }, fill), val);
  return { row, fill, val };
}

// a moment in a list: its text, what it means, a button showing Mario's tile then in the level (in e.level when
// it has one: a death names the level it happened in)
function momentRow(e: { frame: number; tx: number; ty: number; level?: number }, text: string, help: string, show: Show): HTMLElement {
  return h('div', { class: 'meter-event', title: help },
    h('span', null, `Frame ${e.frame} · ${text} · Mario at ${e.level === undefined ? '' : `${hex(e.level, 3)}: `}${hex(e.tx, 2)}/${hex(e.ty, 2)}`),
    h('button', { title: 'Quit the test and show this place in the level', onclick: () => show(e.tx, e.ty, e.level) }, 'Show'),
  );
}

type Show = (tx: number, ty: number, level?: number) => void;

// show: closes test play and shows a tile of the level (of another level); name: a sprite's name by its id
export function playMeter(log: PlayLog, show: Show, name: (id: number) => string): { el: HTMLElement; update: () => void } {
  const cpu = meterRow('CPU', 'Share of the frame the CPU was busy (from the NMI until the game waits for the next one); red: a lag frame, the game\'s frame was not done in time and the game slowed down');
  const rows = SLOT_KINDS.map((k) => ({ k, ...meterRow(KINDS[k].label, KINDS[k].help) }));
  const cpuGraph = h('canvas', { width: GRAPH_FRAMES, height: 32, class: 'meter-graph', title: `CPU load over the last ${GRAPH_FRAMES} frames; red: a lag frame` });
  const cctx = cpuGraph.getContext('2d')!;
  const graph = h('canvas', { width: GRAPH_FRAMES, height: 48, class: 'meter-graph', title: `Sprite slots in use over the last ${GRAPH_FRAMES} frames (extended and cluster sprites as lines); red: a sprite did not spawn or replaced another` });
  const gctx = graph.getContext('2d')!;
  const list = h('div', { class: 'meter-events' });
  const empty = h('div', { class: 'hint' }, 'No sprite failed to spawn.');
  list.append(empty);
  const lagHead = h('div', { class: 'hint' });
  const lagList = h('div', { class: 'meter-events' });
  const deathHead = h('div', { class: 'hint' });
  const deathList = h('div', { class: 'meter-events' });
  let shown = '', shownLag = '', shownDeaths = -1; // the events in the lists (number, failures / lag frames)

  const update = () => {
    const recent = log.history.slice(-WARN_FRAMES), last = recent[recent.length - 1];
    const busy = !last ? 0 : last.busy === LAG ? LINES_PER_FRAME : last.busy;
    cpu.fill.style.width = `${percent(busy)}%`;
    cpu.val.textContent = last?.busy === LAG ? 'Lag' : `${percent(busy)}%`;
    cpu.row.classList.toggle('warn', recent.some((f) => f.busy === LAG));
    drawCpu(cctx, log);
    for (const { k, row, fill, val } of rows) {
      const n = last?.used[k] ?? 0, max = SLOT_TABLES[k].slots;
      fill.style.width = `${(100 * n) / max}%`;
      val.textContent = `${n}/${max}`;
      row.classList.toggle('warn', recent.some((f) => f.failed.some((x) => x.kind === k)));
    }
    drawGraph(gctx, log);
    const now = `${log.events.length}:${log.events.reduce((a, e) => a + e.count, 0)}`;
    if (now !== shown) { shown = now; renderList(); }
    const nowLag = `${log.lags.length}:${log.lagFrames}`;
    if (nowLag !== shownLag) { shownLag = nowLag; renderLags(); }
    if (log.deaths.length !== shownDeaths) { shownDeaths = log.deaths.length; renderDeaths(); }
  };

  const renderDeaths = () => {
    deathHead.textContent = `Deaths: ${log.deaths.length}`;
    // newest first
    deathList.replaceChildren(...log.deaths.slice().reverse().map((d) => momentRow(d, `Killed by ${killerText(d.killer, name)}`,
      'Mario died here; the place is kept as a death marker in the level (View → Death markers).', show)));
  };

  const renderLags = () => {
    lagHead.textContent = `Lag frames: ${log.lagFrames}`;
    if (!log.lags.length) { lagList.replaceChildren(); return; }
    const worst = log.lags.length > 1 ? log.worstLag() : null;
    // newest first
    lagList.replaceChildren(...log.lags.slice().reverse().map((e) => momentRow(e, lagText(e, e === worst),
      'The game\'s frame was not done before the next one began: the game slowed down here (many sprites, heavy code).', show)));
  };

  const renderList = () => {
    if (!log.events.length) { list.replaceChildren(empty); return; }
    // newest first
    list.replaceChildren(...log.events.slice().reverse().map((e) => momentRow(e, eventText(e), eventHelp(e), show)));
  };

  renderLags();
  renderDeaths();
  const el = h('div', { class: 'play-meter' }, cpu.row, cpuGraph, ...rows.map((r) => r.row), graph,
    deathHead, deathList, lagHead, lagList, h('div', { class: 'hint' }, 'Failed spawns'), list);
  return { el, update };
}

// sprite slots (filled), extended and cluster slots (lines) of the last frames, failed spawns as red ticks
function drawGraph(g: CanvasRenderingContext2D, log: PlayLog): void {
  const { width: W, height: H } = g.canvas;
  const css = getComputedStyle(g.canvas), color = (v: string) => css.getPropertyValue(v).trim();
  g.clearRect(0, 0, W, H);
  const hist = log.history.slice(-W), x0 = W - hist.length;
  const y = (n: number, k: SlotKind) => H - 1 - Math.round(((H - 2) * n) / SLOT_TABLES[k].slots);
  g.fillStyle = color('--danger');
  hist.forEach((f, i) => { if (f.failed.length) g.fillRect(x0 + i, 0, 1, H); });
  g.fillStyle = color(KINDS.sprite.color);
  g.globalAlpha = 0.45;
  hist.forEach((f, i) => { const t = y(f.used.sprite, 'sprite'); g.fillRect(x0 + i, t, 1, H - t); });
  g.globalAlpha = 1;
  for (const k of ['extended', 'cluster'] as SlotKind[]) {
    g.strokeStyle = color(KINDS[k].color);
    g.beginPath();
    hist.forEach((f, i) => { const t = y(f.used[k], k) + 0.5; if (i) g.lineTo(x0 + i, t); else g.moveTo(x0, t); });
    g.stroke();
  }
}

// the CPU's load of the last frames, lag frames as red bars
function drawCpu(g: CanvasRenderingContext2D, log: PlayLog): void {
  const { width: W, height: H } = g.canvas;
  const css = getComputedStyle(g.canvas);
  g.clearRect(0, 0, W, H);
  const hist = log.history.slice(-W), x0 = W - hist.length;
  g.fillStyle = css.getPropertyValue('--danger').trim();
  hist.forEach((f, i) => { if (f.busy === LAG) g.fillRect(x0 + i, 0, 1, H); });
  g.fillStyle = css.getPropertyValue('--accent-strong').trim();
  hist.forEach((f, i) => {
    if (f.busy === LAG) return;
    const t = H - 1 - Math.round(((H - 2) * f.busy) / LINES_PER_FRAME);
    g.fillRect(x0 + i, t, 1, H - t);
  });
}
