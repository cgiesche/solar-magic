// The tool rail (#477): a vertical bar at the canvas's left edge with the view's edit modes and tools – an icon each,
// its key in the corner and in the tooltip. The keys pick its entries (numbers the modes from the top, letters the
// tools). Used by the level (its six modes), the overworld (its three modes, then its brushes) and the pixel editor
// (its tools). The active entry is marked by the class 'active' (aria-pressed kept by dom.ts keepAriaStates).

import { h } from './dom.ts';
import { icon, type IconName } from './icons.ts';

export type RailEntry = {
  label: string;
  key: string; // shown in the corner and the tooltip
  icon: IconName;
  title?: string; // the tooltip's text after "label (key)"
  active?: boolean;
  disabled?: boolean;
  data?: Record<string, string>; // data-* attributes (e.g. the mode it selects)
  className?: string;
  onClick: () => void;
};

export function toolRail(label: string): HTMLElement {
  return h('div', { class: 'rail', role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': label });
}

/** One entry of a rail. */
export function railButton(e: RailEntry): HTMLButtonElement {
  const b = h('button', {
    class: `rail-btn${e.active ? ' active' : ''}${e.className ? ` ${e.className}` : ''}`, disabled: e.disabled ?? false,
    title: `${e.label} (${e.key})${e.title ? ` – ${e.title}` : ''}`, 'aria-label': e.label, 'aria-keyshortcuts': e.key,
    onclick: e.onClick,
  }, icon(e.icon), h('span', { class: 'rail-key', 'aria-hidden': 'true' }, e.key));
  for (const [k, v] of Object.entries(e.data ?? {})) b.dataset[k] = v;
  return b;
}

/** A rail's entries replaced; 'sep' a divider. */
export function fillRail(rail: HTMLElement, entries: (RailEntry | 'sep')[]): void {
  rail.replaceChildren(...entries.map((e) => (e === 'sep' ? h('div', { class: 'rail-sep', role: 'separator' }) : railButton(e))));
}
