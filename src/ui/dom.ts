// Tiny DOM helpers.

import { icon } from './icons.ts';

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

// `ok`: whether a value in range is allowed too (text: not allowed, and why); `expect`: the allowed values,
// for the tooltip and the error
export function hexInput(value: number, digits: number, onChange: (v: number) => void, max = (1 << (digits * 4)) - 1, ok: (v: number) => boolean | string = () => true, expect = `hex 0–${max.toString(16).toUpperCase()}`): HTMLInputElement {
  const inp = h('input', {
    class: 'hex', value: value.toString(16).toUpperCase().padStart(digits, '0'), size: digits + 1, maxLength: digits,
    spellcheck: false, title: expect,
  });
  let why = '';
  const valid = () => {
    const v = parseInt(inp.value, 16);
    const r = /^[0-9a-f]+$/i.test(inp.value.trim()) && v <= max ? ok(v) : false;
    why = typeof r === 'string' ? r : '';
    return r === true ? v : -1;
  };
  // invalid input is marked while typing and reset when leaving the field
  inp.addEventListener('input', () => { inp.classList.toggle('invalid', valid() < 0); inp.title = why || expect; });
  inp.addEventListener('change', () => {
    const v = valid();
    inp.classList.remove('invalid');
    inp.title = expect;
    if (v >= 0) { value = v; onChange(v); }
    else { inp.value = value.toString(16).toUpperCase().padStart(digits, '0'); toast(why || `Invalid: expected ${expect}`, 'error'); }
  });
  return inp;
}

// a checkbox with its label (title: the tooltip)
export function checkbox(label: string, title: string, checked: boolean, onChange: (on: boolean) => void): HTMLLabelElement {
  const c = h('input', { type: 'checkbox', checked });
  c.addEventListener('change', () => onChange(c.checked));
  return h('label', { class: 'row', title }, c, label);
}

export function select(options: [number, string][], value: number, onChange: (v: number) => void): HTMLSelectElement {
  const s = h('select', null, options.map(([v, l]) => h('option', { value: String(v), selected: v === value }, l)));
  s.addEventListener('change', () => onChange(Number(s.value)));
  return s;
}

const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
// whether a key goes to the focused field instead of to the editor's shortcuts: a text field takes every key, a
// dropdown and a slider only the keys they move with (a dropdown also letters: it picks by the first letter), so
// Ctrl+Z, Ctrl+S, "o" etc. work while one keeps the focus
export function fieldTakesKey(e: KeyboardEvent): boolean {
  const t = e.target;
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLSelectElement) return MOVE_KEYS.has(e.key) || e.key === 'Enter' || (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey);
  if (t instanceof HTMLInputElement) return t.type !== 'range' || MOVE_KEYS.has(e.key);
  return false;
}

const isStepField = (t: EventTarget | null): t is HTMLSelectElement | HTMLInputElement =>
  t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && t.type === 'range');

// dropdowns and sliders, everywhere: one changed with the keys keeps the focus when its panel is built anew on the
// change (the field at the same place in the new panel, of the same kind and label, gets it), so the keys step on;
// the mouse wheel over a slider steps it (input and change, as a key would)
export function installStepFields(): void {
  const label = (t: Element) => t.previousElementSibling?.textContent ?? '';
  const remember = (e: Event) => {
    const t = e.target;
    if (!isStepField(t) || document.activeElement !== t) return;
    // the way from the field up to the body: each parent with the index of the child on the way
    const path: [Element, number][] = [];
    for (let c: Element = t; c.parentElement && c !== document.body; c = c.parentElement) path.push([c.parentElement, [...c.parentElement.children].indexOf(c)]);
    const kind = t instanceof HTMLInputElement ? `input:${t.type}` : 'select';
    const name = label(t);
    // the panel may be built anew right on the change or a little later (after an asynchronous ROM edit), even
    // more than once: watched for a second, as long as the focus does not go elsewhere
    let cur = t;
    const done = (): boolean => {
      if (cur.isConnected) return document.activeElement !== cur;
      const a = document.activeElement;
      if (a && a !== document.body) return true;
      const from = path.findIndex(([p]) => p.isConnected);
      if (from < 0) return false;
      let el: Element | undefined = path[from][0];
      for (let i = from; i >= 0 && el; i--) el = el.children[path[i][1]];
      if (!isStepField(el ?? null)) return false;
      const f = el as HTMLSelectElement | HTMLInputElement;
      if ((f instanceof HTMLInputElement ? `input:${f.type}` : 'select') !== kind || label(f) !== name || f.disabled) return false;
      f.focus({ preventScroll: true });
      cur = f;
      return false;
    };
    const until = performance.now() + 1000;
    queueMicrotask(() => {
      if (done()) return;
      const tick = () => { if (!done() && performance.now() < until) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  };
  document.addEventListener('change', remember, true);
  document.addEventListener('input', remember, true);
  // exactly one step per mouse-wheel notch, however many pixels the browser makes of it (100, 120, more with a
  // display scale): a wheel event of a notch's size is one step. Touchpads and high-resolution wheels send many small
  // deltas: accumulated to one step per notch (forgotten after a pause or on a turn). Each step is an input, the
  // change (the edit, one undo step) comes once the wheel rests, as at the end of a drag
  let acc = 0;
  let accAt = 0;
  let over: HTMLInputElement | null = null;
  let changed = false;
  let rest = 0;
  const settle = () => {
    clearTimeout(rest);
    if (over && changed) over.dispatchEvent(new Event('change', { bubbles: true }));
    changed = false;
  };
  document.addEventListener('wheel', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== 'range' || t.disabled || e.ctrlKey) return;
    e.preventDefault();
    if (over !== t) { settle(); over = t; acc = 0; }
    const d = e.deltaMode === 0 ? e.deltaY : e.deltaY * 100;
    if (!d) return;
    let up: boolean;
    if (Math.abs(d) >= 50) { up = d < 0; acc = 0; }
    else {
      if (e.timeStamp - accAt > 200 || (acc < 0) !== (d < 0)) acc = 0;
      accAt = e.timeStamp;
      acc += d;
      if (Math.abs(acc) < 100) return;
      up = acc < 0;
      acc = 0;
    }
    const was = t.value;
    if (up) t.stepUp(); else t.stepDown();
    if (t.value === was) return;
    changed = true;
    t.dispatchEvent(new Event('input', { bubbles: true }));
    clearTimeout(rest);
    rest = window.setTimeout(settle, 400);
  }, { passive: false, capture: true });
}

// message log: every toast plus events that are worth knowing afterwards (shown in the log bar)
export type LogKind = 'info' | 'error' | 'warn' | 'output' | 'event';
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
// what a tool (Asar, UberASM, AddmusicK, PIXI …) reported: errors, warnings and its prints, each a line
// of the log with the tool's name in front; `output`: everything the tool printed, as one entry
export function logTool(tool: string, r: { errors: string[]; warnings: string[]; prints?: string[] }, output = ''): void {
  for (const p of r.prints ?? []) log(`${tool}: ${p}`, 'output');
  if (output.trim()) log(`${tool} output:\n${output.trimEnd()}`, 'output');
  for (const w of r.warnings) log(`${tool}: ${w}`, 'warn');
  for (const e of r.errors) log(`${tool}: ${e}`, 'error');
}
export function clearLog(): void {
  logEntries.length = 0;
  for (const fn of logListeners) fn(null, false);
}

let toastStack: HTMLElement | null = null;
// extra: a button in the toast (e.g. Show), which closes it; or a body shown instead of msg (which the log gets),
// e.g. with buttons and folded-out details. A toast with either stays while the pointer is on it. Returns a function
// closing it.
export function toast(msg: string, kind: 'info' | 'error' = 'info', extra?: { label: string; run: () => void } | HTMLElement): () => void {
  log(msg, kind);
  // one column for all toasts: a toast shown while others are visible goes below them instead of on top
  if (!toastStack?.isConnected) toastStack = document.body.appendChild(h('div', { class: 'toast-stack' }));
  const body = extra instanceof HTMLElement ? extra : null, action = extra instanceof HTMLElement ? null : extra;
  const t = h('div', { class: `toast ${kind}` }, body ?? msg,
    action ? h('button', { class: 'toast-action', onclick: () => { action.run(); t.remove(); } }, action.label) : null);
  toastStack.appendChild(t);
  // a burst (Ctrl+Z held, many errors) keeps only the newest few on screen; the log has them all
  while (toastStack.childElementCount > 5) toastStack.firstElementChild!.remove();
  setTimeout(() => t.classList.add('show'), 10);
  const close = () => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); };
  const ms = kind === 'error' || action ? 6000 : 2500;
  let timer = setTimeout(close, body ? ms * 1.5 : ms);
  if (body || action) {
    t.addEventListener('mouseenter', () => clearTimeout(timer));
    t.addEventListener('mouseleave', () => { clearTimeout(timer); timer = setTimeout(close, ms / 2); });
  }
  return () => { clearTimeout(timer); close(); };
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

// Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) in a dialog: the editor's undo and redo while the dialog holding body is the topmost
// one (the editor's own keys wait while a dialog is open). A text field, select or text area keeps its own keys; a
// switch just clicked has the focus and isn't one. Returns what takes the keys off again (on the dialog's close)
export function dialogUndoKeys(body: HTMLElement, undo: () => void, redo: () => void, after?: () => void): () => void {
  const keys = (e: KeyboardEvent) => {
    const t = e.target;
    if ((t instanceof HTMLInputElement && t.type !== 'checkbox' && t.type !== 'radio') || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    if (!(e.ctrlKey || e.metaKey) || ![...document.querySelectorAll('.modal-back')].pop()?.contains(body)) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    e.preventDefault();
    if (k === 'y' || e.shiftKey) redo(); else undo();
    after?.();
  };
  window.addEventListener('keydown', keys);
  return () => window.removeEventListener('keydown', keys);
}

// what an immediate dialog or workspace says about its changes (#481)
export const IMMEDIATE_NOTE = 'Changes apply immediately · Ctrl+Z undoes';

// the editor's undo and redo for dialogs whose changes apply at once (main.ts sets them)
let editorUndo: { undo: () => void; redo: () => void } | null = null;
export function setDialogUndo(undo: () => void, redo: () => void): void { editorUndo = { undo, redo }; }

// One dialog pattern (#481): a title naming the subject, ✕, the body, the buttons at the right with the primary (or
// the dangerous) one last; Enter takes the primary one (not in a text area, nor on a button), Esc and ✕ are Cancel.
// Two kinds besides plain messages:
// - immediate: every change is a ROM edit at once – the footer says so, Ctrl+Z / Ctrl+Y undo and redo inside
//   (after: what draws the dialog again afterwards), one button Close
// - staged: changes wait for the primary button (Apply) – changed fields are marked and counted in the title
// buttons: the elements of the given buttons, in the given order (e.g. to show one only at times)
export type ModalOptions = { immediate?: boolean | { after?: () => void }; staged?: boolean; className?: string };
export function modal(title: string, body: HTMLElement, buttons: { label: string; primary?: boolean; danger?: boolean; onClick?: () => boolean | void }[], onClose?: () => void, beforeClose?: () => boolean, opts: ModalOptions = {}): { close: (force?: boolean) => void; buttons: HTMLButtonElement[] } {
  const back = h('div', { class: 'modal-back' });
  let closed = false;
  const topmost = () => [...document.querySelectorAll('.modal-back')].pop() === back;
  // Esc closes the topmost dialog
  const esc = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !topmost()) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const imm = opts.immediate ? (typeof opts.immediate === 'object' ? opts.immediate : {}) : null;
  const offUndo = imm && editorUndo ? dialogUndoKeys(body, editorUndo.undo, editorUndo.redo, imm.after) : null;
  const close = (force = false) => {
    if (closed || (!force && beforeClose && !beforeClose())) return;
    closed = true;
    back.remove();
    window.removeEventListener('keydown', esc, true);
    offUndo?.();
    onClose?.();
    modalsChanged(-1);
  };
  window.addEventListener('keydown', esc, true);
  const els = buttons.map((b) => h('button', {
    class: b.danger ? 'danger' : b.primary ? 'primary' : '',
    onclick: () => { if (b.onClick?.() !== false) close(); },
  }, b.label));
  // (shown with the primary or dangerous ones last: at the right, where the eye ends)
  const order = els.map((e, i) => ({ e, last: !!(buttons[i].primary || buttons[i].danger), i }))
    .sort((a, b) => Number(a.last) - Number(b.last) || a.i - b.i).map((x) => x.e);
  const primary = els.find((_, i) => buttons[i].primary);
  const count = h('span', { class: 'modal-changes', hidden: true });
  const box = h('div', { class: `modal${opts.className ? ` ${opts.className}` : ''}`, role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-title' }, h('span', { class: 'modal-title-text' }, title, count), h('button', { class: 'icon-btn', onclick: () => close(), title: 'Close (Esc)', 'aria-label': 'Close' }, icon('close'))),
    h('div', { class: 'modal-body' }, body),
    order.length || imm ? h('div', { class: 'modal-buttons' }, imm ? h('span', { class: 'hint modal-note' }, IMMEDIATE_NOTE) : null, order) : null,
  );
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !primary || primary.disabled) return;
    const t = e.target as HTMLElement;
    if (t instanceof HTMLTextAreaElement || t instanceof HTMLButtonElement || t instanceof HTMLSelectElement || t.isContentEditable || t.closest('a')) return;
    e.preventDefault();
    primary.click();
  });
  if (opts.staged) trackChanges(body, count);
  back.appendChild(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  modalsChanged(1);
  return { close, buttons: els };
}

// a staged dialog's changed fields (#481): marked, and their number beside the title. A field's value when it is first
// touched is its start (fields drawn anew start anew)
function trackChanges(body: HTMLElement, count: HTMLElement): void {
  const start = new WeakMap<Element, string>();
  const valueOf = (el: Element) => el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? String(el.checked) : (el as HTMLInputElement).value;
  const isField = (el: EventTarget | null): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
  const remember = (el: Element) => { if (!start.has(el)) start.set(el, valueOf(el)); };
  for (const el of body.querySelectorAll('input, select, textarea')) remember(el);
  body.addEventListener('focusin', (e) => { if (isField(e.target)) remember(e.target); });
  body.addEventListener('pointerdown', (e) => { if (isField(e.target)) remember(e.target); }, true);
  const update = (e: Event) => {
    if (!isField(e.target)) return;
    const el = e.target;
    if (start.has(el)) el.classList.toggle('changed', valueOf(el) !== start.get(el));
    const n = body.querySelectorAll('.changed').length;
    count.hidden = !n;
    count.textContent = `${n} change${n === 1 ? '' : 's'}`;
  };
  body.addEventListener('input', update);
  body.addEventListener('change', update);
}

// zoom levels of every view (1: one SNES pixel per screen pixel); a view uses a range of them
// (the level, overworld and level preview 50–400%, the pixel editor up to 3200%)
const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
export const ZOOM_MIN = 0.5, ZOOM_MAX = 4;

// zoom levels of whole screen pixels per SNES pixel (half one for an overview), at the screen's scale: every SNES
// pixel equally big. A zoom of 2.5 screen pixels per SNES pixel (200 % at a scale of 125 %) draws them 2 and 3 wide
// alternately, which the browser may draw differently each time the picture changes – the whole picture flickers
export function pixelZoomSteps(min = ZOOM_MIN, max = ZOOM_MAX): number[] {
  const dpr = window.devicePixelRatio || 1, out: number[] = [];
  for (const d of [0.5, ...Array.from({ length: Math.ceil(max * dpr) }, (_, i) => i + 1)]) {
    const z = d / dpr;
    if (z >= min * 0.75 && z <= max + 1e-6) out.push(z);
  }
  return out;
}
// the zoom level of steps nearest to z
export function snapZoom(z: number, steps: number[]): number {
  return steps.reduce((a, b) => (Math.abs(b - z) < Math.abs(a - z) ? b : a));
}

// the next zoom level in or out (dir > 0: in) from z within [min, max] (or of the view's own levels), undefined at
// the end
export function zoomStep(z: number, dir: number, min = ZOOM_MIN, max = ZOOM_MAX, own?: number[]): number | undefined {
  const steps = own ?? ZOOM_STEPS.filter((s) => s >= min && s <= max);
  return dir > 0 ? steps.find((s) => s > z + 1e-6) : [...steps].reverse().find((s) => s < z - 1e-6);
}

// “− 100% +” of every view; update() shows the current zoom. steps: the view's own zoom levels (pixelZoomSteps)
export function zoomControl(zoom: () => number, setZoom: (z: number) => void, min = ZOOM_MIN, max = ZOOM_MAX, steps?: () => number[]): { root: HTMLElement; update: () => void } {
  const label = h('span', { class: 'zoom' });
  const step = (dir: number) => { const z = zoomStep(zoom(), dir, min, max, steps?.()); if (z !== undefined) setZoom(z); };
  const update = () => { label.textContent = `${Math.round(zoom() * 100)}%`; };
  update();
  return {
    root: h('div', { class: 'row zoom-ctl' },
      h('button', { onclick: () => step(-1), title: 'Zoom out (Ctrl+mouse wheel)' }, '−'), label,
      h('button', { onclick: () => step(1), title: 'Zoom in (Ctrl+mouse wheel)' }, '+')),
    update,
  };
}

// Middle-button drag pans a scroll container; Ctrl+wheel zooms in steps around the cursor.
export function attachPanZoom(scroller: HTMLElement, zoom: () => number, setZoom: (z: number, anchorX: number, anchorY: number) => void, min = ZOOM_MIN, max = ZOOM_MAX, steps?: () => number[]): void {
  let pan: { x: number; y: number; sl: number; st: number } | null = null;
  scroller.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault(); // no autoscroll / primary-selection paste
    pan = { x: e.clientX, y: e.clientY, sl: scroller.scrollLeft, st: scroller.scrollTop };
    scroller.classList.add('panning'); // (the grabbing hand over whatever cursor its contents have)
  });
  window.addEventListener('mousemove', (e) => {
    if (!pan) return;
    scroller.scrollLeft = pan.sl - (e.clientX - pan.x);
    scroller.scrollTop = pan.st - (e.clientY - pan.y);
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 1 || !pan) return;
    pan = null;
    scroller.classList.remove('panning');
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
    const next = zoomStep(zoom(), dir, min, max, steps?.());
    if (next === undefined) return;
    const rc = scroller.getBoundingClientRect();
    setZoom(next, e.clientX - rc.left, e.clientY - rc.top);
  }, { passive: false });
}

export type CellRect = { x: number; y: number; w: number; h: number };
// palette sheets: a click picks a cell, dragging a rectangle of cells; show() previews the rectangle while dragging;
// Go to definition (F12, isGoto) goes to the cell's definition instead, if there is one (jump)
export function attachRectPick(c: HTMLElement, cols: number, rows: number, show: (r: CellRect) => void, done: (r: CellRect) => void, jump?: (x: number, y: number) => void): void {
  const cellAt = (e: MouseEvent) => {
    const rc = c.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(cols - 1, Math.floor((e.clientX - rc.left) / (rc.width / cols)))),
      y: Math.max(0, Math.min(rows - 1, Math.floor((e.clientY - rc.top) / (rc.height / rows)))),
    };
  };
  if (jump) c.dataset.goto = ''; // (F12 goes to a cell's definition, gotoAt)
  c.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const a = cellAt(e);
    if (jump && isGoto(e)) { jump(a.x, a.y); return; }
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

// eyedropper: the swatch of the hovered color next to the mouse (RGBA as packed by snesColorToRGBA,
// null: transparent); hideColorLoupe() removes it. The pipette cursor is the CSS class 'pipette'.
let loupe: { root: HTMLElement; sw: HTMLElement; text: HTMLElement } | null = null;
export function showColorLoupe(e: MouseEvent, rgba: number | null, label = ''): void {
  if (!loupe) {
    const sw = h('span', { class: 'loupe-sw' }), text = h('span', { class: 'loupe-text' });
    loupe = { root: h('div', { class: 'loupe' }, sw, text), sw, text };
  }
  if (!loupe.root.isConnected) document.body.append(loupe.root);
  const r = rgba === null ? 0 : rgba & 0xff, g = rgba === null ? 0 : (rgba >> 8) & 0xff, b = rgba === null ? 0 : (rgba >> 16) & 0xff;
  loupe.sw.classList.toggle('transp', rgba === null);
  loupe.sw.style.background = rgba === null ? '' : `rgb(${r},${g},${b})`;
  loupe.text.textContent = (label ? `${label} · ` : '') + (rgba === null ? 'transparent' : `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase()}`);
  // below right of the cursor; flipped at the window edges
  const w = loupe.root.offsetWidth, hh = loupe.root.offsetHeight;
  const x = e.clientX + 18 + w > innerWidth ? e.clientX - 10 - w : e.clientX + 18;
  const y = e.clientY + 18 + hh > innerHeight ? e.clientY - 10 - hh : e.clientY + 18;
  loupe.root.style.transform = `translate(${x}px, ${y}px)`;
}
export function hideColorLoupe(): void {
  loupe?.root.remove();
}

// placeholder for an empty list or panel
export function emptyState(text: string): HTMLElement {
  return h('div', { class: 'empty' }, text);
}

// an image W pixels wide (RGBA words) drawn into a canvas of its size, its transparent pixels black (back: the word
// they get instead, 0 keeps them transparent)
export function putImage(canvas: HTMLCanvasElement, img: Uint32Array, W = 512, back = 0xff000000): void {
  canvas.width = W; canvas.height = img.length / W;
  const ctx = canvas.getContext('2d')!;
  const id = ctx.createImageData(W, img.length / W);
  const px = new Uint32Array(id.data.buffer);
  for (let i = 0; i < px.length; i++) px[i] = img[i] || back;
  ctx.putImageData(id, 0, 0);
}

// the state of tabs and segmented controls for assistive technology (#480): a tab bar's buttons are tabs, the active
// one selected; a segmented control's active button is pressed – kept from the class 'active' the views set
const GROUP = '.tabbar, .seg, .btn-group, .tabs.seg, .rail';
function ariaOf(b: Element): void {
  const bar = b.parentElement;
  if (!(b instanceof HTMLButtonElement) || !bar?.matches(GROUP)) return;
  const on = b.classList.contains('active');
  if (bar.classList.contains('tabbar')) {
    if (b.getAttribute('role') !== 'tab') b.setAttribute('role', 'tab');
    if (b.getAttribute('aria-selected') !== String(on)) b.setAttribute('aria-selected', String(on));
  } else if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
}
export function keepAriaStates(root: HTMLElement): void {
  for (const b of root.querySelectorAll(`:is(${GROUP}) > button`)) ariaOf(b);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') ariaOf(r.target as Element);
      else for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        ariaOf(n);
        for (const b of n.querySelectorAll(`:is(${GROUP}) > button`)) ariaOf(b);
      }
    }
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
}

// Go to definition (#482): F12 over something with a definition – an animated tile or color, a Map16 tile, a palette
// button – opens it. Sent as a click marked so (gotoAt) to the element under the mouse; its handler asks isGoto. (A
// Ctrl+click is no longer one: Ctrl+click adds to the selection wherever there is one.)
export function isGoto(e: MouseEvent): boolean { return (e as MouseEvent & { gotoDefinition?: boolean }).gotoDefinition === true; }
export function gotoAt(x: number, y: number): boolean {
  // (only where a definition can be gone to – marked data-goto –: elsewhere the click would be a real one)
  const el = document.elementFromPoint(x, y);
  if (!el?.closest('[data-goto]')) return false;
  for (const type of ['mousedown', 'mouseup', 'click']) {
    // (ctrlKey too: handlers that leave a Ctrl+click alone leave it alone)
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ctrlKey: true });
    Object.defineProperty(ev, 'gotoDefinition', { value: true });
    el.dispatchEvent(ev);
  }
  return true;
}
