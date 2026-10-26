// The hint to save a prefab after pasting the same Direct Map16 objects repeatedly (App.pasteHint, #115): a
// small box beside the level that never blocks editing; its button opens "Selection as prefab" for the pasted
// objects, ✕ hides it for that arrangement. Opening another level hides it.
import type { App } from './app.ts';
import { h, toast } from './dom.ts';
import { openSavePrefab } from './panels.ts';

export function pasteHintBox(app: App): HTMLElement {
  const text = h('span');
  const save = h('button', {
    class: 'primary', title: 'Open “Selection as prefab” with the pasted objects selected',
    onclick: () => {
      if (!app.selectPasteHint()) { toast('The pasted objects are no longer in the level.', 'error'); app.setPasteHint(null); return; }
      app.setPasteHint(null);
      openSavePrefab(app);
    },
  }, 'Save as prefab …');
  const dismiss = h('button', { class: 'icon-btn', title: 'Don’t suggest this again for these objects', 'aria-label': 'Dismiss', onclick: () => app.dismissPasteHint() }, '✕');
  const el = h('div', { class: 'paste-hint', role: 'status' }, text, save, dismiss);
  app.on('paste-hint', () => {
    const p = app.pasteHint;
    el.classList.toggle('show', !!p);
    if (p) text.textContent = `Placed ${p.count} times – save as prefab? Saves ${p.saved} byte${p.saved === 1 ? '' : 's'}, edits apply everywhere.`;
  });
  app.on('level', () => { if (app.pasteHint && app.pasteHint.level !== app.level.number) app.setPasteHint(null); });
  return el;
}
