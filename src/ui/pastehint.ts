// The hint to save a prefab after pasting the same Direct Map16 objects repeatedly (App.pasteHint, #115): a
// small box beside the level that never blocks editing; its button opens "Selection as prefab" for the pasted
// objects (and the arrangement is not suggested again), ✕ hides it for that arrangement. Opening another level
// or the pasted objects going (undo) hides it.
import type { App } from './app.ts';
import { h, toast } from './dom.ts';
import { openSavePrefab } from './panels.ts';

export function pasteHintBox(app: App): HTMLElement {
  const text = h('span');
  const save = h('button', {
    class: 'primary', title: 'Open “Selection as prefab” with the pasted objects selected',
    onclick: () => {
      const ok = app.selectPasteHint();
      app.dismissPasteHint();
      if (ok) openSavePrefab(app); else toast('The pasted objects are no longer in the level.', 'error');
    },
  }, 'Save as prefab …');
  const dismiss = h('button', { class: 'icon-btn', title: 'Don’t suggest this again for these objects', 'aria-label': 'Dismiss', onclick: () => app.dismissPasteHint() }, '✕');
  const el = h('div', { class: 'paste-hint', role: 'status' }, text, save, dismiss);
  app.on('paste-hint', () => {
    const p = app.pasteHint;
    el.classList.toggle('show', !!p);
    if (p) text.textContent = `Placed ${p.count} times – save as prefab? Saves ${p.saved} byte${p.saved === 1 ? '' : 's'}, edits apply everywhere.`;
  });
  const gone = () => { if (app.pasteHint && !app.pasteHintObjects()) app.setPasteHint(null); };
  app.on('level', gone);
  app.on('change', gone);
  return el;
}
