// The keyboard scheme's table (ui/shortcuts.ts): the keys the menus and tooltips show come from it by id; what the
// save keys do – Ctrl+S never reaches the browser, saves only what there is to save; Ctrl+Shift+S saves the project.
// node tools/testshortcuts.ts
import { SHORTCUTS, shortcutKeys, shortcutSections, saveKeyAction } from '../src/ui/shortcuts.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const throws = (fn: () => void) => { try { fn(); return false; } catch { return true; } };

{
  const ids = SHORTCUTS.filter((s) => s.id).map((s) => s.id!);
  check(new Set(ids).size === ids.length, 'every id names one entry');
  check(shortcutKeys('save') === 'Ctrl+S', 'Save level: Ctrl+S');
  check(shortcutKeys('save-project') === 'Ctrl+Shift+S', 'Save project: Ctrl+Shift+S');
  check(throws(() => shortcutKeys('no-such-entry')), 'an unknown id throws (a typo is found at the start)');
  const general = shortcutSections().find(([scope]) => scope === 'General')?.[1] ?? [];
  check(general.some((s) => s.id === 'save') && general.some((s) => s.id === 'save-project'), 'both are listed under General');
}
{
  const key = (key: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = { ctrl: true }) =>
    ({ key, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt });
  const open = { dialog: false, dirty: false };
  check(saveKeyAction(key('s', {}), open) === null && saveKeyAction(key('z'), open) === null, 'S alone and other keys: not a save key');
  check(saveKeyAction(key('s', { ctrl: true, alt: true }), open) === null, 'Ctrl+Alt+S (AltGr) is not a save key');
  check(saveKeyAction(key('s'), { dialog: false, dirty: true }) === 'level', 'Ctrl+S with unsaved changes in the level: the level is saved');
  check(saveKeyAction(key('S', { meta: true }), { dialog: false, dirty: true }) === 'level', 'also Cmd+S, also with Caps Lock');
  check(saveKeyAction(key('s'), open) === 'stored', 'Ctrl+S with nothing to save: told, no level saved');
  check(saveKeyAction(key('S', { ctrl: true, shift: true }), open) === 'project', 'Ctrl+Shift+S: the project');
  check(saveKeyAction(key('S', { ctrl: true, shift: true }), { dialog: false, dirty: true }) === 'project', 'also with unsaved changes in the level (Save project saves them)');
  check(saveKeyAction(key('s'), { dialog: true, dirty: true }) === 'none' && saveKeyAction(key('S', { ctrl: true, shift: true }), { dialog: true, dirty: false }) === 'none',
    'in a dialog: taken from the browser, nothing saved behind it');
}

if (bad) { console.error(`${bad} failed`); process.exit(1); }
console.log('all ok');
