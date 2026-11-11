// Light and dark theme (#474): View → Theme chooses System, Light or Dark, kept as a preference. "System" follows the
// operating system (prefers-color-scheme, in the stylesheet: it needs no code, so the start page has it before the
// editor's code is loaded); Light and Dark set data-theme on the root. The game's pictures never change with it –
// only the UI's tokens (style.css) do; canvases that draw a token repaint (marks.ts onTokensChanged). The desktop
// app's window frame follows.

import { jsonPref } from './prefs.ts';
import { tokensChanged } from './marks.ts';
import { desktop } from './platform.ts';

export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEMES: { id: ThemeChoice; label: string; title: string }[] = [
  { id: 'system', label: 'System', title: 'Light or dark as the operating system is set' },
  { id: 'light', label: 'Light', title: 'Always light' },
  { id: 'dark', label: 'Dark', title: 'Always dark' },
];

export const themePref = jsonPref<ThemeChoice>('theme', 'system', (v): v is ThemeChoice => v === 'system' || v === 'light' || v === 'dark');

function apply(): void {
  const choice = themePref.get(), root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  tokensChanged();
  if (desktop) {
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
      getCurrentWindow().setTheme(choice === 'system' ? null : choice)).catch(() => { /* the frame stays as it is */ });
  }
}

let started = false;

/** The chosen theme applied, and again whenever it or (for System) the operating system's changes. */
export function initTheme(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  apply();
  themePref.onChange(apply);
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (themePref.get() === 'system') tokensChanged(); });
}
