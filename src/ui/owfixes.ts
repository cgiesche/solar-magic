// The ways out of overworld refusals (core/owfixes.ts, #349) as the refusal toast's fix button (ui/owrefusal.ts):
// one ROM edit with the refused edit where it is one, the hover saying what it writes, a toast what was written.

import type { App } from './app.ts';
import { toast } from './dom.ts';
import { refusedToast, type RefusalFix } from './owrefusal.ts';
import type { OwRefusalData } from '../core/owrefusal.ts';
import { unusedLinkEntries, freeLinkEntries } from '../core/owfixes.ts';
import type { LinkKind } from '../core/owlinks.ts';

// a fix as one ROM edit (label): `write` makes the refused edit possible and says what it wrote, `then` makes the
// refused edit in the same ROM edit (it may be a ROM edit of its own: it joins this one), `after` what follows it
// outside the ROM; the toast says what was written. Refused again: told as any refusal
export function editFix(app: App, label: string, preview: string, write: () => string, then?: () => void, after?: () => void): RefusalFix {
  return {
    label, preview,
    run: () => {
      let said = '';
      try { app.romEdit(label, () => { said = write(); then?.(); }); } catch (e) { refusedToast(app.rom, e); return; }
      toast(`${said}.`);
      after?.();
    },
  };
}
// the fix of a full link table (star/pipe, its locations, exit paths): the entries nothing uses removed, then `then`
// (the refused edit, in the same ROM edit); none when nothing can be freed or another refusal
export function linkTableFix(app: App, r: OwRefusalData, then?: () => void, after?: () => void): RefusalFix | undefined {
  const kind: LinkKind | null = r.kind === 'teleportsFull' || r.kind === 'locationsFull' ? 'star' : r.kind === 'exitPathsFull' ? 'exit' : null;
  if (!kind) return undefined;
  const free = unusedLinkEntries(app.rom, kind), n = free.length;
  if (!n) return undefined;
  const what = kind === 'star' ? 'star/pipe' : 'exit path';
  return editFix(app, `Free ${n} unused link${n === 1 ? '' : 's'}`,
    `Removes ${n} ${what} ${n === 1 ? 'entry' : 'entries'} nothing uses (a later entry has the same tile, or a location no exit teleports to), then makes the change – one undo step`,
    () => freeLinkEntries(app.rom, kind, unusedLinkEntries(app.rom, kind)), then, after); // (as the ROM is when clicked)
}
