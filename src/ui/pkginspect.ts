// The Packages workspace's inspector (#517): the side panel shows the part chosen in the main area – a block, a
// sprite, a patch, a file – with its settings (the define assignments at the top of its file, applied to the ROM at
// once), its source to edit and the ways on to where it is used. A view marks its rows with PartSelection.row
// between begin() and end(); end() draws the chosen one again, so the panel follows every change of the ROM.

import { h, type Child } from './dom.ts';
import { definesForm, hasDefines, openTextEdit, isTextFile } from './defineedit.ts';
import { rewriteDefines } from '../core/patchpkg.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();

export interface Inspected {
  kind: string; // what it is ("Block", "Sprite", "Patch" …)
  title: Child;
  from?: { name: string; go(): void }; // its package, when the view is not the package's own
  facts?: [string, Child][];
  body?: Child[]; // settings of its own, in place of the defines of `file`
  files?: Map<string, Uint8Array>; // the project its file is in
  file?: string; // the file with its settings and source
  onChange?: () => void; // after `file` was rewritten: applies the project to the ROM
  hint?: string;
  links?: { label: string; title?: string; run(): void }[];
}

// the defines of `file` as a form with Apply (the file rewritten in place, then onChange), null without any
function settingsOf(files: Map<string, Uint8Array>, file: string, onChange: () => void): HTMLElement[] | null {
  if (!hasDefines(files, file)) return null;
  const text = dec.decode(files.get(file)!);
  const form = definesForm(text);
  return [...form.rows, h('div', { class: 'row' }, h('button', { class: 'primary', title: 'Write the settings into the file and apply it to the ROM (Ctrl+Z undoes)', onclick: () => {
    const changed = form.read();
    if (!Object.keys(changed).length) return;
    files.set(file, enc.encode(rewriteDefines(text, changed).text));
    onChange();
  } }, 'Apply'))];
}

function inspector(x: Inspected): HTMLElement {
  const { files, file, onChange } = x;
  const own = files && file && onChange && files.has(file) ? { files, file, onChange } : null;
  const settings = x.body ?? (own ? settingsOf(own.files, own.file, own.onChange) : null);
  return h('div', { class: 'pkg-insp' },
    h('div', null,
      h('div', { class: 'pkg-insp-kind' }, x.kind),
      h('div', { class: 'pkg-insp-title' }, x.title),
      x.from ? h('div', { class: 'hint' }, 'from ', h('a', { href: '#', title: 'Show the package', onclick: (e: Event) => { e.preventDefault(); x.from!.go(); } }, x.from.name)) : ''),
    x.facts?.length ? h('div', null, x.facts.map(([l, v]) => h('div', { class: 'prop' }, h('label', null, l), h('span', null, v)))) : '',
    h('div', { class: 'pkg-insp-settings' }, h('h4', null, 'Settings'), settings ?? h('p', { class: 'hint' }, 'No settings.')),
    own && isTextFile(own.file) || x.links?.length || x.hint ? h('div', { class: 'pkg-insp-links' },
      own && isTextFile(own.file) ? h('button', { title: 'The whole file as text', onclick: () => openTextEdit(own.files, own.file, own.onChange) }, 'Edit source …') : '',
      (x.links ?? []).map((l) => h('a', { href: '#', title: l.title ?? '', onclick: (e: Event) => { e.preventDefault(); l.run(); } }, l.label)),
      x.hint ? h('p', { class: 'hint' }, x.hint) : '') : '');
}

/** The chosen part of the Packages workspace and the panel showing it. */
export class PartSelection {
  key = '';
  private makers = new Map<string, () => Inspected>();
  /** el: the side panel; onPick: draws the view again after another part was chosen. */
  constructor(private el: HTMLElement, private onPick: () => void) {}

  /** Before a view draws its rows. */
  begin(): void { this.makers.clear(); }

  /** The attributes of a part's row: chosen by a click or Enter, marked when it is the chosen one. */
  row(key: string, make: () => Inspected, cls = ''): Record<string, unknown> {
    this.makers.set(key, make);
    const pick = () => { if (this.key !== key) { this.key = key; this.onPick(); } };
    return {
      class: `${cls} pkg-pick${key === this.key ? ' picked' : ''}`.trim(), tabindex: 0,
      onclick: pick,
      onkeydown: (e: KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(); } },
    };
  }

  /** After a view drew its rows: the chosen part in the panel, as it is now. */
  end(): void {
    const make = this.makers.get(this.key);
    this.el.replaceChildren(make ? inspector(make()) : h('div', { class: 'pkg-insp' },
      h('p', { class: 'hint' }, 'Choose a part – a block, a sprite, a patch, a file – to see its settings and where it is used.')));
  }
}

/** What a view needs to take part: the selection, and the way to a package. */
export interface PartContext { sel: PartSelection; showPackage(id: string): void }
