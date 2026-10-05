// The readme or HTML manual of a package, shown inside the editor: pages, images and stylesheets come from
// the package (as blob URLs), links between its pages stay in the viewer, the pages' own scripts don't
// run. Docs of packages added to a tool project are kept in the browser, so they can be read again later.

import { h, clear, modal } from './dom.ts';
import { kvSet, kvEntries, kvDel } from './storage.ts';
import { docFiles } from '../core/pkgmap.ts';

const MIME: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', txt: 'text/plain', md: 'text/plain', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
};
const ext = (p: string) => p.split('.').pop()!.toLowerCase();
const isDocAsset = (p: string) => ext(p) in MIME;
const dec = new TextDecoder();

// all readable docs of a package, most relevant first
export function packageDocs(files: Map<string, Uint8Array>): string[] {
  const main = docFiles(files);
  const rest = [...files.keys()].filter((p) => /\.(html?|txt|md)$/i.test(p) && !/(^|\/)list\.txt$/i.test(p) && !main.includes(p)).sort();
  return [...main, ...rest];
}

function resolve(from: string, rel: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const s of rel.split('/')) {
    if (s === '..') parts.pop();
    else if (s && s !== '.') parts.push(s);
  }
  return parts.join('/');
}

export function openDocs(title: string, files: Map<string, Uint8Array>, start?: string): void {
  const docs = packageDocs(files);
  if (!docs.length) return;
  const urls = new Map<string, string>();
  const blob = (path: string, data: Uint8Array | string = files.get(path)!) => {
    let u = urls.get(path);
    if (!u) { u = URL.createObjectURL(new Blob([data as BlobPart], { type: MIME[ext(path)] ?? 'application/octet-stream' })); urls.set(path, u); }
    return u;
  };
  // a stylesheet with its url(...) pointing at the package's files
  const css = (path: string) => blob(path, dec.decode(files.get(path)!).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, _q, u: string) => {
    const p = resolve(path, u.split(/[?#]/)[0]);
    return files.has(p) ? `url("${blob(p)}")` : all;
  }));

  const frame = h('iframe', { class: 'doc-frame', sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox' });
  const pick = h('select', { onchange: () => show(pick.value) }, docs.map((d) => h('option', { value: d }, d)));
  const history: string[] = [];
  const back = h('button', { disabled: true, onclick: () => { history.pop(); const p = history.pop(); if (p) show(p); } }, '← Back');

  function page(path: string): string {
    const text = dec.decode(files.get(path)!);
    if (!/\.html?$/i.test(path)) return `<!doctype html><meta charset="utf-8"><pre style="white-space: pre-wrap; font: 13px/1.45 ui-monospace, monospace; margin: 12px">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
    const doc = new DOMParser().parseFromString(text, 'text/html');
    doc.querySelectorAll('script, meta[http-equiv]').forEach((e) => {
      // a redirecting page (Readme.html → docs/index.html) becomes a link
      const m = /url=(.+)$/i.exec(e.getAttribute('content') ?? '');
      if (m) doc.body.append(Object.assign(doc.createElement('a'), { href: m[1].trim(), textContent: m[1].trim() }));
      e.remove();
    });
    for (const el of doc.querySelectorAll<HTMLElement>('[src], [href]')) {
      const attr = el.hasAttribute('src') ? 'src' : 'href';
      const v = el.getAttribute(attr)!;
      if (/^(#|[a-z]+:)/i.test(v)) { if (el.tagName === 'A' && /^https?:/i.test(v)) el.setAttribute('target', '_blank'); continue; }
      const [rel, hash] = v.split('#');
      const p = resolve(path, rel.split('?')[0]);
      if (!files.has(p)) continue;
      if (el.tagName === 'A' && /\.(html?|txt|md)$/i.test(p)) { el.setAttribute('href', '#' + (hash ?? '')); el.dataset.doc = p; }
      else el.setAttribute(attr, ext(p) === 'css' ? css(p) : blob(p));
    }
    return '<!doctype html>' + doc.documentElement.outerHTML;
  }

  function show(path: string, hash = ''): void {
    // a page only redirecting (Readme.html → docs/index.html): its target
    const m = /\.html?$/i.test(path) && /<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]+url=([^"'>\s]+)/i.exec(dec.decode(files.get(path)!));
    const to = m ? resolve(path, m[1].split('#')[0]) : '';
    if (to && to !== path && files.has(to)) { show(to, hash); return; }
    history.push(path);
    back.disabled = history.length < 2;
    if ([...pick.options].some((o) => o.value === path)) pick.value = path;
    frame.onload = () => {
      const d = frame.contentDocument;
      if (!d) return;
      d.addEventListener('click', (e) => {
        const a = (e.target as Element).closest?.('a[data-doc]') as HTMLAnchorElement | null;
        if (!a) return;
        e.preventDefault();
        show(a.dataset.doc!, a.getAttribute('href')!.slice(1));
      });
      if (hash) d.getElementById(hash)?.scrollIntoView();
    };
    frame.srcdoc = page(path);
  }

  const body = h('div', { class: 'doc-view' }, h('div', { class: 'row' }, back, pick), frame);
  show(start && files.has(start) ? start : docs[0]);
  modal(`Manual: ${title}`, body, [{ label: 'Close', primary: true }], () => { for (const u of urls.values()) URL.revokeObjectURL(u); });
}

// a button opening the package's docs, null without any
export function docsButton(title: string, files: Map<string, Uint8Array>): HTMLElement | null {
  return packageDocs(files).length ? h('button', { onclick: () => openDocs(title, files) }, 'Manual …') : null;
}

// docs of packages added to a tool project, kept in the browser by tool and package name
interface StoredDocs { title: string; files: [string, Uint8Array][] }
const key = (tool: string, title: string) => `docs:${tool}:${title}`;

export async function keepDocs(tool: string, title: string, files: Map<string, Uint8Array>): Promise<void> {
  const keep = [...files].filter(([p]) => isDocAsset(p) && !/(^|\/)list\.txt$/i.test(p));
  if (keep.some(([p]) => /\.(html?|txt|md)$/i.test(p))) await kvSet(key(tool, title), { title, files: keep } satisfies StoredDocs);
}

// the kept docs of a tool as buttons (filled in once loaded), each with one to forget them
export function keptDocsRow(tool: string): HTMLElement {
  const el = h('div', { class: 'row doc-row' });
  void kvEntries<StoredDocs>(`docs:${tool}:`).then((all) => {
    if (!all.length) return;
    clear(el).append(h('span', { class: 'hint' }, 'Manuals:'), ...all.map(([k, d]) => {
      const chip = h('span', { class: 'row doc-chip' },
        h('button', { onclick: () => openDocs(d.title, new Map(d.files)) }, d.title),
        h('button', { class: 'icon-btn', title: 'Forget manual (only stored in the browser)', onclick: () => { void kvDel(k); chip.remove(); } }, '✕'));
      return chip;
    }));
  }).catch(() => {});
  return el;
}

// forgets the kept docs of a package (removed)
export function forgetDocs(title: string): void {
  for (const tool of ['uber', 'blocks', 'sprites']) kvDel(key(tool, title)).catch(() => {});
}
