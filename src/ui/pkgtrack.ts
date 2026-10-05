// Keeps what adding a package puts into the ROM as one installed package (core/pkgreg.ts): the ROM's
// projects are compared when its dialog opens and after each step it (or a part of it, "Further
// steps") finishes. The package's files go with the record – into the ROM when small, otherwise into
// the browser – so its graphics, docs and parts can be taken later.

import { zipSync, unzipSync } from 'fflate';
import type { App } from './app.ts';
import { kvGet, kvSet, kvDel } from './storage.ts';
import { snapshot, partsBetween, mergeParts, isEmptyParts, emptyParts, savePackage, listPackages, packageArchive, type PkgRecord } from '../core/pkgreg.ts';

const MAX_ROM_ARCHIVE = 256 << 10;
const kvKey = (id: string) => `pkg:${id}`;

export interface Tracker {
  done(): void; // a step finished: what came in since the last one goes into the record
}

// `rec`: an installed package getting more (a part, an imported graphic, new settings)
export function trackPackage(app: App, name: string, fileName: string, files: Map<string, Uint8Array> | null, rec?: PkgRecord): Tracker {
  let before = snapshot(app.rom);
  let cur: PkgRecord | null = rec ?? null;
  return {
    done() {
      const after = snapshot(app.rom);
      const parts = partsBetween(before, after);
      before = after;
      if (isEmptyParts(parts) && (!cur || cur.patches.every((p) => after.patches.has(p)))) return;
      const first = !cur;
      const base: PkgRecord = cur ?? { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name, fileName, added: new Date().toISOString(), ...emptyParts() };
      let archive: Uint8Array | undefined;
      if (first && files) {
        const z = zipSync(Object.fromEntries(files), { level: 9 });
        if (z.length <= MAX_ROM_ARCHIVE) archive = z;
        else void kvSet(kvKey(base.id), [...files]).catch(() => {});
      }
      try {
        cur = savePackage(app.rom, mergeParts(base, parts, after), archive);
        app.persist();
      } catch (e) { console.warn('package record', e); }
    },
  };
}

// the files of an installed package, null if they are kept nowhere
export async function recordFiles(app: App, rec: PkgRecord): Promise<Map<string, Uint8Array> | null> {
  const a = packageArchive(app.rom, rec);
  if (a) return new Map(Object.entries(unzipSync(a)));
  const kept = await kvGet<[string, Uint8Array][]>(kvKey(rec.id)).catch(() => undefined);
  return kept ? new Map(kept) : null;
}

export function forgetRecordFiles(id: string): void {
  kvDel(kvKey(id)).catch(() => {});
}

export function findPackage(app: App, id: string): PkgRecord | null {
  try { return listPackages(app.rom).find((r) => r.id === id) ?? null; } catch { return null; }
}
