// A ROM limit's gauge next to the action it can stop (#347, core/owbudget.ts): a small bar of how much is used and
// what is left; neutral below 80 %, amber from 80 %, red when full. Hovering says what it counts, the numbers after.

import { h } from './dom.ts';
import { budgetLevel, budgetText, type Budget } from '../core/owbudget.ts';

// (label: shown before the bar where nothing beside it names the limit)
export function budgetGauge(b: Budget | undefined, label?: string): HTMLElement | null {
  if (!b) return null;
  const left = Math.max(0, b.max - b.used), pct = b.max ? Math.min(100, (b.used / b.max) * 100) : 100;
  return h('span', { class: `budget budget-${budgetLevel(b)}`, title: `${b.name}: ${b.help}\n${budgetText(b)}` },
    label ? h('span', null, label) : null,
    h('span', { class: 'budget-bar' }, h('span', { class: 'budget-fill', style: `width: ${pct}%` })),
    h('span', { class: 'budget-left' }, left ? `${left} left` : 'full'));
}

// a limit that stops the action outright (not a count): the gauge's full look, the reason on hover
export const budgetBlocked = (label: string, why: string): HTMLElement =>
  h('span', { class: 'budget budget-full', title: why }, h('span', { class: 'budget-left' }, label));

// a gauge on a row of its own, what it stops named before it
export const budgetRow = (text: string, b: Budget | undefined): HTMLElement =>
  h('div', { class: 'row budget-row' }, h('span', { class: 'hint' }, text), budgetGauge(b));
