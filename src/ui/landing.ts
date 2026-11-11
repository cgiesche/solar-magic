// The start page's behavior (its content is static HTML in index.html): screenshots open large in a lightbox
// (Esc, a click or ✕ closes it, the arrow keys step through them) and the desktop app's download for the
// visitor's system stands out.

import { h } from './dom.ts';

export function initLanding(landing: HTMLElement): void {
  lightbox([...landing.querySelectorAll<HTMLAnchorElement>('a.landing-shot')]);
  const os = visitorOs();
  if (os) landing.querySelector(`.landing-downloads [data-os="${os}"]`)?.classList.add('mine');
}

function lightbox(shots: HTMLAnchorElement[]): void {
  if (!shots.length) return;
  let at = 0;
  const img = h('img', { alt: '' });
  const caption = h('figcaption');
  const step = (d: number) => show((at + d + shots.length) % shots.length);
  const dlg = h('dialog', { class: 'lightbox', 'aria-label': 'Screenshot' },
    h('figure', null, img, caption),
    h('button', { class: 'lb-close', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕'),
    h('button', { class: 'lb-prev', title: 'Previous (←)', 'aria-label': 'Previous screenshot', onclick: () => step(-1) }, '‹'),
    h('button', { class: 'lb-next', title: 'Next (→)', 'aria-label': 'Next screenshot', onclick: () => step(1) }, '›'));
  // a click anywhere but the arrows closes it (the backdrop, the screenshot, the caption)
  dlg.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.lb-prev, .lb-next')) dlg.close(); });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });
  document.body.appendChild(dlg);

  function show(i: number): void {
    at = i;
    const a = shots[i], thumb = a.querySelector('img');
    img.src = a.href;
    img.alt = thumb?.alt ?? '';
    caption.textContent = a.dataset.caption ?? '';
  }
  shots.forEach((a, i) => a.addEventListener('click', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; // a new tab stays possible
    e.preventDefault();
    show(i);
    dlg.showModal();
  }));
}

function visitorOs(): 'windows' | 'mac' | 'linux' | null {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad/i.test(ua)) return null;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return null;
}
