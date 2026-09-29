// Tiny DOM helpers.

type Attrs = Record<string, unknown> & { style?: string | Partial<CSSStyleDeclaration> };
type Child = Node | string | number | null | undefined | false | Child[];

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
    spellcheck: false,
  });
  inp.addEventListener('change', () => {
    const v = parseInt(inp.value, 16);
    if (!Number.isNaN(v) && v >= 0 && v <= max) onChange(v);
    else inp.value = value.toString(16).toUpperCase().padStart(digits, '0');
  });
  return inp;
}

export function select(options: [number, string][], value: number, onChange: (v: number) => void): HTMLSelectElement {
  const s = h('select', null, options.map(([v, l]) => h('option', { value: String(v), selected: v === value }, l)));
  s.addEventListener('change', () => onChange(Number(s.value)));
  return s;
}

export function toast(msg: string, kind: 'info' | 'error' = 'info'): void {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 2500);
}

export function modal(title: string, body: HTMLElement, buttons: { label: string; primary?: boolean; onClick?: () => boolean | void }[]): { close: () => void } {
  const back = h('div', { class: 'modal-back' });
  const close = () => back.remove();
  const box = h('div', { class: 'modal' },
    h('div', { class: 'modal-title' }, title, h('button', { class: 'icon-btn', onclick: close, title: 'Schließen' }, '✕')),
    h('div', { class: 'modal-body' }, body),
    h('div', { class: 'modal-buttons' }, buttons.map((b) => h('button', {
      class: b.primary ? 'primary' : '',
      onclick: () => { if (b.onClick?.() !== false) close(); },
    }, b.label))),
  );
  back.appendChild(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
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
