// Dropdown menus (menu bar and single dropdown buttons).
// disabled/checked are callbacks evaluated whenever a menu opens, so items never go stale.

import { h } from './dom.ts';

export type MenuItem =
  | { label: string; shortcut?: string; title?: string; onClick: () => void; disabled?: () => boolean }
  | { label: string; shortcut?: string; title?: string; checked: () => boolean; onToggle: (v: boolean) => void | Promise<void>; disabled?: () => boolean }
  | { heading: string }
  | 'sep';

// items: a function for a menu whose items change (made anew whenever it opens)
export type Menu = { label: string; items: MenuItem[] | (() => MenuItem[]); disabled?: () => boolean; title?: string };

let current: { close: () => void; owner: HTMLElement } | null = null;

export function closeMenus(): void {
  current?.close();
}

// one dropdown button; `bar` groups buttons so hovering switches between open menus
function dropdown(menu: Menu, bar?: HTMLElement): HTMLElement {
  const btn = h('button', { class: 'menu-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: menu.title, role: bar ? 'menuitem' : undefined }, menu.label, h('span', { class: 'caret' }, '▾'));
  const wrap = h('div', { class: 'menu-wrap' }, btn);
  const open = () => {
    if (current?.owner === wrap) return;
    closeMenus();
    const list = h('div', { class: 'menu', role: 'menu' });
    const entries: HTMLButtonElement[] = [];
    for (const it of typeof menu.items === 'function' ? menu.items() : menu.items) {
      if (it === 'sep') { list.append(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
      if ('heading' in it) { list.append(h('div', { class: 'menu-heading' }, it.heading)); continue; }
      const disabled = it.disabled?.() ?? false;
      const isCheck = 'checked' in it;
      const on = isCheck && it.checked();
      const e = h('button', {
        class: 'menu-item', role: isCheck ? 'menuitemcheckbox' : 'menuitem', disabled, title: it.title, tabindex: '-1',
        'aria-checked': isCheck ? String(on) : undefined,
      },
        h('span', { class: 'menu-check' }, isCheck ? (on ? '✓' : '') : ''),
        h('span', { class: 'menu-label' }, it.label),
        it.shortcut ? h('kbd', null, it.shortcut) : null);
      e.addEventListener('click', () => {
        if (isCheck) {
          // checkbox items keep the menu open
          const show = () => {
            const now = it.checked();
            e.setAttribute('aria-checked', String(now));
            (e.firstChild as HTMLElement).textContent = now ? '✓' : '';
          };
          // onToggle may ask first (async): show the state once it is settled
          void Promise.resolve(it.onToggle(!it.checked())).then(show);
          show();
        } else {
          closeMenus();
          it.onClick();
        }
      });
      e.addEventListener('mouseenter', () => e.focus());
      entries.push(e);
      list.append(e);
    }
    wrap.append(list);
    // keep it on screen near the right edge
    if (list.getBoundingClientRect().right > window.innerWidth - 4) { list.style.left = 'auto'; list.style.right = '0'; }
    // and near the bottom (a button at the foot of a panel): open upwards when it does not fit below but above
    const r = list.getBoundingClientRect(), b = btn.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 4 && b.top - r.height - 3 >= 4) { list.style.top = 'auto'; list.style.bottom = 'calc(100% + 3px)'; }
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    const outside = (ev: MouseEvent) => { if (!wrap.contains(ev.target as Node)) closeMenus(); };
    const keys = (ev: KeyboardEvent) => {
      const enabled = entries.filter((x) => !x.disabled);
      const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
      if (ev.key === 'Escape') { closeMenus(); btn.focus(); }
      else if (ev.key === 'ArrowDown') enabled[(i + 1) % enabled.length]?.focus();
      else if (ev.key === 'ArrowUp') enabled[(i - 1 + enabled.length) % enabled.length]?.focus();
      else if ((ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && bar) {
        const btns = [...bar.querySelectorAll<HTMLButtonElement>(':scope > .menu-wrap > .menu-btn:not(:disabled)')];
        const j = btns.indexOf(btn);
        const next = btns[(j + (ev.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
        if (next && next !== btn) { next.click(); next.parentElement?.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus(); }
      } else if (ev.key === 'Enter' || ev.key === ' ') { if (i >= 0) enabled[i].click(); }
      else if (ev.key !== 'Tab') return; // let other keys through
      ev.preventDefault();
      ev.stopPropagation();
    };
    // capture: runs before the editor's global shortcuts
    window.addEventListener('keydown', keys, true);
    window.addEventListener('mousedown', outside, true);
    current = {
      owner: wrap,
      close: () => {
        list.remove();
        btn.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        window.removeEventListener('keydown', keys, true);
        window.removeEventListener('mousedown', outside, true);
        current = null;
      },
    };
  };
  btn.addEventListener('click', () => {
    if (current?.owner === wrap) closeMenus();
    else open();
  });
  btn.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' || current?.owner === wrap) return;
    ev.preventDefault();
    open();
    wrap.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus();
  });
  // menu bar: once one menu is open, hovering another opens that one
  if (bar) btn.addEventListener('mouseenter', () => { if (current && current.owner !== wrap && bar.contains(current.owner) && !btn.disabled) open(); });
  if (menu.disabled) (wrap as HTMLElement & { refresh?: () => void }).refresh = () => (btn.disabled = menu.disabled!());
  return wrap;
}

export function menuBar(menus: Menu[]): HTMLElement & { refresh: () => void } {
  const bar = h('nav', { class: 'menubar', role: 'menubar' }) as HTMLElement & { refresh: () => void };
  const wraps = menus.map((m) => dropdown(m, bar));
  bar.append(...wraps);
  bar.refresh = () => { for (const w of wraps) (w as HTMLElement & { refresh?: () => void }).refresh?.(); };
  bar.refresh();
  return bar;
}

export function menuButton(menu: Menu): HTMLElement {
  return dropdown(menu);
}

// a context menu at a viewport position (right click); closes on a choice, Esc or a click elsewhere
export function contextMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenus();
  const list = h('div', { class: 'menu context-menu', role: 'menu', style: `position: fixed; left: ${x}px; top: ${y}px` });
  const entries: HTMLButtonElement[] = [];
  for (const it of items) {
    if (it === 'sep') { list.append(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if ('heading' in it) { list.append(h('div', { class: 'menu-heading' }, it.heading)); continue; }
    if (!('onClick' in it)) continue;
    const e = h('button', { class: 'menu-item', role: 'menuitem', disabled: it.disabled?.() ?? false, title: it.title, tabindex: '-1' },
      h('span', { class: 'menu-check' }), h('span', { class: 'menu-label' }, it.label), it.shortcut ? h('kbd', null, it.shortcut) : null);
    e.addEventListener('click', () => { closeMenus(); it.onClick(); });
    e.addEventListener('mouseenter', () => e.focus());
    entries.push(e);
    list.append(e);
  }
  document.body.append(list);
  // keep it on screen
  const r = list.getBoundingClientRect();
  if (r.right > window.innerWidth - 4) list.style.left = `${Math.max(4, x - r.width)}px`;
  if (r.bottom > window.innerHeight - 4) list.style.top = `${Math.max(4, y - r.height)}px`;
  const outside = (ev: MouseEvent) => { if (!list.contains(ev.target as Node)) closeMenus(); };
  const keys = (ev: KeyboardEvent) => {
    const enabled = entries.filter((b) => !b.disabled);
    const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === 'Escape') closeMenus();
    else if (ev.key === 'ArrowDown') enabled[(i + 1) % enabled.length]?.focus();
    else if (ev.key === 'ArrowUp') enabled[(i - 1 + enabled.length) % enabled.length]?.focus();
    else if (ev.key === 'Enter' || ev.key === ' ') { if (i >= 0) enabled[i].click(); }
    else if (ev.key !== 'Tab') return;
    ev.preventDefault();
    ev.stopPropagation();
  };
  window.addEventListener('keydown', keys, true);
  // the right click that opened the menu must not close it
  setTimeout(() => window.addEventListener('mousedown', outside, true), 0);
  current = {
    owner: list,
    close: () => {
      list.remove();
      window.removeEventListener('keydown', keys, true);
      window.removeEventListener('mousedown', outside, true);
      current = null;
    },
  };
}
