// Tiny DOM helpers.

type Attrs = Record<string, unknown> & { style?: string | Partial<CSSStyleDeclaration> };
export type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'class') {
        el.className = String(v);
      } else if (k in el && typeof v !== 'string') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else if (k === 'value' || k === 'checked' || k === 'selected') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: HTMLElement): HTMLElement {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function hexInput(value: number, digits: number, onChange: (v: number) => void, max = (1 << (digits * 4)) - 1): HTMLInputElement {
  const inp = h('input', {
    class: 'hex', value: value.toString(16).toUpperCase().padStart(digits, '0'), size: digits + 1, maxLength: digits,
    spellcheck: false, title: `hex 0–${max.toString(16).toUpperCase()}`,
  });
  const valid = () => { const v = parseInt(inp.value, 16); return /^[0-9a-f]+$/i.test(inp.value.trim()) && v <= max ? v : -1; };
  // invalid input is marked while typing and reset when leaving the field
  inp.addEventListener('input', () => inp.classList.toggle('invalid', valid() < 0));
  inp.addEventListener('change', () => {
    const v = valid();
    inp.classList.remove('invalid');
    if (v >= 0) { value = v; onChange(v); }
    else { inp.value = value.toString(16).toUpperCase().padStart(digits, '0'); toast(`Invalid: expected hex 0–${max.toString(16).toUpperCase()}`, 'error'); }
  });
  return inp;
}

export function select(options: [number, string][], value: number, onChange: (v: number) => void): HTMLSelectElement {
  const s = h('select', null, options.map(([v, l]) => h('option', { value: String(v), selected: v === value }, l)));
  s.addEventListener('change', () => onChange(Number(s.value)));
  return s;
}

// message log: every toast plus events that are worth knowing afterwards (shown in the log bar)
export type LogKind = 'info' | 'error' | 'event';
export interface LogEntry { time: Date; msg: string; kind: LogKind; count: number }
export const logEntries: LogEntry[] = [];
// listener gets the new/updated entry, or null when the log was cleared
const logListeners = new Set<(e: LogEntry | null, repeat: boolean) => void>();
export function onLog(fn: (e: LogEntry | null, repeat: boolean) => void): () => void {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}
export function log(msg: string, kind: LogKind = 'event'): void {
  const last = logEntries[logEntries.length - 1];
  // the same message right again (e.g. repeated undo hint) counts up instead of adding a line
  const repeat = !!last && last.msg === msg && last.kind === kind;
  const e = repeat ? last : { time: new Date(), msg, kind, count: 0 };
  e.count++;
  e.time = new Date();
  if (!repeat) {
    logEntries.push(e);
    if (logEntries.length > 500) logEntries.shift();
  }
  for (const fn of logListeners) fn(e, repeat);
}
export function clearLog(): void {
  logEntries.length = 0;
  for (const fn of logListeners) fn(null, false);
}

export function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  log(msg, kind);
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 2500);
}

// beforeClose: asked on every way of closing (buttons, ✕, Esc, click beside the dialog); false keeps it
// open. close(true) closes without asking.
// open dialogs: background work waits while there are any (see App.later)
let openModals = 0;
const modalWatchers = new Set<() => void>();
export function modalsOpen(): number { return openModals; }
export function onModalsChange(fn: () => void): () => void {
  modalWatchers.add(fn);
  return () => modalWatchers.delete(fn);
}
const modalsChanged = (d: number) => { openModals += d; for (const f of modalWatchers) f(); };

export function modal(title: string, body: HTMLElement, buttons: { label: string; primary?: boolean; danger?: boolean; onClick?: () => boolean | void }[], onClose?: () => void, beforeClose?: () => boolean): { close: (force?: boolean) => void } {
  const back = h('div', { class: 'modal-back' });
  let closed = false;
  // Esc closes the topmost dialog
  const esc = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || [...document.querySelectorAll('.modal-back')].pop() !== back) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const close = (force = false) => {
    if (closed || (!force && beforeClose && !beforeClose())) return;
    closed = true;
    back.remove();
    window.removeEventListener('keydown', esc, true);
    onClose?.();
    modalsChanged(-1);
  };
  window.addEventListener('keydown', esc, true);
  const box = h('div', { class: 'modal' },
    h('div', { class: 'modal-title' }, title, h('button', { class: 'icon-btn', onclick: () => close(), title: 'Close' }, '✕')),
    h('div', { class: 'modal-body' }, body),
    h('div', { class: 'modal-buttons' }, buttons.map((b) => h('button', {
      class: b.danger ? 'danger' : b.primary ? 'primary' : '',
      onclick: () => { if (b.onClick?.() !== false) close(); },
    }, b.label))),
  );
  back.appendChild(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  modalsChanged(1);
  return { close };
}

export function downloadBytes(name: string, data: Uint8Array, mime = 'application/octet-stream'): void {
  const blob = new Blob([data as BlobPart], { type: mime });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: 'display:none' });
    inp.addEventListener('change', () => { resolve(inp.files?.[0] ?? null); inp.remove(); });
    document.body.appendChild(inp);
    inp.click();
  });
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4];

// Middle-button drag pans a scroll container; Ctrl+wheel zooms in steps around the cursor.
export function attachPanZoom(scroller: HTMLElement, zoom: () => number, setZoom: (z: number, anchorX: number, anchorY: number) => void, min = 0.5, max = 4, zoomSteps = ZOOM_STEPS): void {
  let pan: { x: number; y: number; sl: number; st: number } | null = null;
  scroller.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault(); // no autoscroll / primary-selection paste
    pan = { x: e.clientX, y: e.clientY, sl: scroller.scrollLeft, st: scroller.scrollTop };
    scroller.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', (e) => {
    if (!pan) return;
    scroller.scrollLeft = pan.sl - (e.clientX - pan.x);
    scroller.scrollTop = pan.st - (e.clientY - pan.y);
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 1 || !pan) return;
    pan = null;
    scroller.style.cursor = '';
  });
  scroller.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  // touchpads send many small deltas: accumulate to one step per ~mouse-wheel notch
  let acc = 0;
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    acc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    if (Math.abs(acc) < 50) return;
    const dir = acc < 0 ? 1 : -1;
    acc = 0;
    const steps = zoomSteps.filter((s) => s >= min && s <= max);
    const cur = zoom();
    const next = dir > 0 ? steps.find((s) => s > cur + 1e-6) : [...steps].reverse().find((s) => s < cur - 1e-6);
    if (next === undefined) return;
    const rc = scroller.getBoundingClientRect();
    setZoom(next, e.clientX - rc.left, e.clientY - rc.top);
  }, { passive: false });
}

export type CellRect = { x: number; y: number; w: number; h: number };
// palette sheets: a click picks a cell, dragging a rectangle of cells; show() previews the rectangle while dragging
export function attachRectPick(c: HTMLElement, cols: number, rows: number, show: (r: CellRect) => void, done: (r: CellRect) => void): void {
  const cellAt = (e: MouseEvent) => {
    const rc = c.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(cols - 1, Math.floor((e.clientX - rc.left) / (rc.width / cols)))),
      y: Math.max(0, Math.min(rows - 1, Math.floor((e.clientY - rc.top) / (rc.height / rows)))),
    };
  };
  c.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const a = cellAt(e);
    let b = a;
    const rect = (): CellRect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 });
    const move = (ev: MouseEvent) => {
      const n = cellAt(ev);
      if (n.x === b.x && n.y === b.y) return;
      b = n;
      show(rect());
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      done(rect());
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    show(rect());
  });
}

// asks with a few buttons; resolves with the chosen index, null when closed
export function choose(title: string, body: HTMLElement | string, options: { label: string; primary?: boolean; danger?: boolean }[]): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    const b = typeof body === 'string' ? h('p', { style: 'max-width:460px' }, body) : body;
    modal(title, b, options.map((o, i) => ({ label: o.label, primary: o.primary, danger: o.danger, onClick: () => { done = true; resolve(i); } })), () => { if (!done) resolve(null); });
  });
}

// true while a native color picker inside `el` is in use (its input has focus)
export function pickerOpen(el: HTMLElement): boolean {
  const a = document.activeElement;
  return a instanceof HTMLInputElement && a.type === 'color' && el.contains(a);
}

// placeholder for an empty list or panel
export function emptyState(text: string): HTMLElement {
  return h('div', { class: 'empty' }, text);
}
