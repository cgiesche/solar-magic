// Test fixtures that are not in the repository, because they contain the game's own graphics: downloaded
// from where their authors publish them into test/fixtures/ and checked against the checksum of the file the
// tests were written for. `npm test` runs this first; alone: node tools/fetchfixtures.ts
// (The ROM is not among them: it is placed by hand, test/fixtures/README.md.)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

interface Download { file: string; url: string; sha256: string }
const DOWNLOADS: readonly Download[] = [
  // the Romhack Races baserom 5.15 as released (it brings Lunar Magic's export of the game's GFX00–33)
  { file: 'rhr-baserom-5.15.zip', url: 'https://github.com/romhackraces/baserom/releases/download/5.15/rhr-baserom-5.15.zip',
    sha256: 'c908f3b58b5d130d9089beba41ba433a7dc20d943058c9ef004823b0c2dfb1ca' },
];
const DIR = `${import.meta.dirname}/../test/fixtures`;
const sha256 = (d: Uint8Array): string => createHash('sha256').update(d).digest('hex');

/** Every missing fixture downloaded; what could not be (the file and why) is returned, not thrown. */
export async function fetchFixtures(): Promise<string[]> {
  const failed: string[] = [];
  for (const d of DOWNLOADS) {
    const to = `${DIR}/${d.file}`;
    try {
      if (existsSync(to)) {
        if (sha256(readFileSync(to)) !== d.sha256) failed.push(`${d.file}: the file in test/fixtures is not the one the tests expect (delete it to download it again)`);
        continue;
      }
      const res = await fetch(d.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      if (sha256(data) !== d.sha256) throw new Error('the download is not the file the tests expect (checksum)');
      mkdirSync(DIR, { recursive: true });
      writeFileSync(`${to}.part`, data); // (tests starting meanwhile never see half a file)
      renameSync(`${to}.part`, to);
      console.log(`downloaded test/fixtures/${d.file}`);
    } catch (e) {
      failed.push(`${d.file}: ${e instanceof Error ? e.message : e} (${d.url})`);
    }
  }
  return failed;
}

if (import.meta.main) {
  const failed = await fetchFixtures();
  for (const f of failed) console.error(f);
  process.exit(failed.length ? 1 : 0);
}
