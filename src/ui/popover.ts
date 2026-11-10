// A popover from a button (ADR 0015): settings or reference shown beside where they are chosen, out of the side
// panel. Closes on a click outside it or Esc; one open at a time, and an open menu closes it (and it the menu).
// The button stays the same element while its bar is drawn again, so an open popover survives that; refresh() draws its
// content again (the thing it shows changed).

import { h } from './dom.ts';
import { closeMenus } from './menu.ts';

export type Popover = {
  root: HTMLElement; // the button in its wrapper: put it where the button goes
  refresh: () => void; // the content drawn again when open (closed when the button left the page)
  close: () => void;
  isOpen: () => boolean;
};

let current: Popover | null = null;

export function closePopovers(): void {
  current?.close();
}

// label: the button's text; title: its tooltip; content: made anew whenever it opens or is refreshed
export function popover(label: string, title: string, content: () => HTMLElement, cls = ''): Popover {
  const btn = h('button', { class: `pop-btn${cls ? ` ${cls}` : ''}`, title, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, label);
  const wrap = h('div', { class: 'menu-wrap' }, btn);
  const box = h('div', { class: 'popover', role: 'dialog' });
  const outside = (ev: MouseEvent) => { if (!wrap.contains(ev.target as Node)) self.close(); };
  // (capture: before the editor's own Esc – the selection stays)
  const keys = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    self.close();
    btn.focus();
  };
  const place = () => {
    box.style.left = '0';
    box.style.right = 'auto';
    // kept on screen near the right edge
    if (box.getBoundingClientRect().right > window.innerWidth - 4) { box.style.left = 'auto'; box.style.right = '0'; }
  };
  const self: Popover = {
    root: wrap,
    isOpen: () => current === self,
    close: () => {
      if (current !== self) return;
      current = null;
      box.remove();
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('keydown', keys, true);
    },
    refresh: () => {
      if (current !== self) return;
      if (!wrap.isConnected) { self.close(); return; }
      box.replaceChildren(content());
      place();
    },
  };
  const open = () => {
    closeMenus();
    closePopovers();
    current = self;
    box.replaceChildren(content());
    wrap.append(box);
    place();
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('keydown', keys, true);
  };
  btn.addEventListener('click', () => (current === self ? self.close() : open()));
  return self;
}
