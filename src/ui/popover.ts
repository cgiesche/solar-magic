// a popover from a button (ADR 0015): settings or reference shown beside where they are chosen, out of the side
// panel. Closes on a click outside it or Esc; one open at a time, closed with the menus (menu.ts closeMenus: a menu
// opening, by mouse or key) and closing them. The button stays the same element while its bar is drawn again, so an
// open popover survives that; refresh() draws its content again (what it shows changed)

import { h } from './dom.ts';
import { closeMenus, onCloseMenus } from './menu.ts';
import { dismissable, focusInto } from './layer.ts';

export type Popover = {
  root: HTMLElement; // the button in its wrapper: put where the button goes
  refresh: () => void; // the content drawn again while open (closed once the button is no longer shown)
  close: () => void;
};

let current: Popover | null = null;
onCloseMenus(() => current?.close());

// label: the button's text; title: its tooltip; content: made anew whenever it opens or is refreshed
export function popover(label: string | Node, title: string, content: () => HTMLElement): Popover {
  const btn = h('button', { class: 'pop-btn', title, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, label);
  const wrap = h('div', { class: 'pop-wrap' }, btn);
  const box = h('div', { class: 'popover', role: 'dialog', 'aria-label': title });
  // (its workspace left by a key or the address: closed, not in the way there)
  const shown = () => wrap.isConnected && wrap.checkVisibility();
  const fill = () => {
    // (the control with the focus keeps it: a song just chosen)
    const fields = () => [...box.querySelectorAll<HTMLElement>('button, select, input')];
    const at = fields().indexOf(document.activeElement as HTMLElement);
    box.replaceChildren(content());
    if (at >= 0) fields()[at]?.focus();
    // kept on screen near the right edge
    box.style.left = '0';
    box.style.right = 'auto';
    if (box.getBoundingClientRect().right > window.innerWidth - 4) { box.style.left = 'auto'; box.style.right = '0'; }
  };
  let stop: (() => void) | null = null;
  const self: Popover = {
    root: wrap,
    close: () => {
      if (current !== self) return;
      current = null;
      box.remove();
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      stop?.();
      stop = null;
    },
    refresh: () => {
      if (current !== self) return;
      if (shown()) fill(); else self.close();
    },
  };
  const open = () => {
    closeMenus(); // (this one's predecessor too)
    current = self;
    wrap.append(box);
    fill();
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    stop = dismissable({
      contains: (n) => wrap.contains(n),
      close: () => self.close(),
      returnFocus: () => btn,
      // (its workspace left meanwhile: closed, the Esc left to the editor)
      onKey: (ev) => { if (ev.key !== 'Escape' || shown()) return false; self.close(); return 'pass'; },
    });
    focusInto(box); // (keyboard users reach its controls, #465)
  };
  btn.addEventListener('click', () => (current === self ? self.close() : open()));
  return self;
}
