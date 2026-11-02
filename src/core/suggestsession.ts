// The edit session with the prefab suggestions the editor shows (#266): the list (prefabsuggest.ts SuggestionList)
// is of the used levels as saved and the open level as edited, checked when a level is opened, when the open level
// changes and once a ROM edit or undo/redo is done with its follow-ups (settled) – never during one (the ROM may be
// changed only in part, the open level not loaded again yet): it is not current then. A suggestion saved as prefab
// with its places replaced leaves the list. The runs themselves are the caller's (start, stop; finished: list.done).

import type { Rom } from './rom.ts';
import { EditSession, type SessionHooks } from './editsession.ts';
import { SuggestionList, type SuggestRuns, type SuggestLevels } from './prefabsuggest.ts';
import { usedLevels } from './levelusage.ts';
import type { Prefab } from './prefabs.ts';
import { storePrefab, type LevelPlaces } from './prefabplaces.ts';
import { arrangementKey } from './pastehint.ts';

export interface SuggestRunHooks {
  start(): void; // a run a while after the last change (finished: list.done with its result)
  stop(): void; // the run started, if any, is stopped (its result won't come)
  changed(): void; // the list changed, or became current
}

export class SessionSuggestions {
  readonly edits: EditSession;
  readonly list: SuggestionList;
  private readonly rom: Rom;

  // hooks: the edit session's (told before the list is checked)
  constructor(rom: Rom, kept: SuggestRuns, hooks: SessionHooks, run: SuggestRunHooks) {
    this.rom = rom;
    this.edits = new EditSession(rom, {
      ...hooks,
      changed: (rerender) => { hooks.changed?.(rerender); this.list.check(); },
      // (the open level loaded again by then, whatever the order of the follow-ups)
      settled: () => { hooks.settled?.(); this.list.check(); },
    });
    this.list = new SuggestionList(kept, {
      rom: () => this.rom,
      source: () => this.source(),
      editing: () => this.edits.running,
      ...run,
    });
  }

  // what a run takes: the used levels, the open level as edited
  source(): SuggestLevels {
    return { levels: usedLevels(this.rom), open: this.edits.level };
  }

  // opens level n (see EditSession.open); then: opened, the list checked (the open level as edited is part of it)
  open(n: number, discard = false, opened?: () => void): void {
    this.edits.open(n, discard);
    opened?.();
    this.list.check();
  }

  // stores arrangement s (a suggestion's) as prefab n, its places replaced in the same ROM edit; replaced, it is
  // not offered any more (the next run doesn't find it either). Throws when the edit failed (nothing changed).
  saveArrangement(n: number, s: Prefab, places: LevelPlaces[]): void {
    storePrefab(this.edits, n, s, places, places);
    if (places.length) this.list.drop(arrangementKey(s));
  }
}
