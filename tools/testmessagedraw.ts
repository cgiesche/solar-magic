// Whether the game draws the editor's messages (messagedraw.ts), by emulation: in the ROM the editor opens it does;
// with RPG Hacker's VWF Dialogues Patch installed (test/fixtures/vwf_dialogues.zip, a package replacing the message
// routine) it does not, the package is named and its install says that message editing no longer applies; removed
// again, the game draws them once more. (The Romhack Races baserom, whose patches leave the routine alone: testrhr.ts.)
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { inspectUpload, installPackage, removePackage, type InstallOptions } from '../src/core/packages.ts';
import { messageRoutine, currentMessageRoutine, messageRoutineNote } from '../src/core/messagedraw.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number | null) => (v === null ? '–' : v.toString(16).toUpperCase());

const rom = new Rom(await editorImage());
{
  const m = messageRoutine(rom);
  check(m.game && m.level === 0x105 && !m.packages.length, `the editor's ROM: the game draws its messages (level ${hx(m.level)})`);
}

const up = inspectUpload('vwf_dialogues.zip', new Uint8Array(readFileSync('test/fixtures/vwf_dialogues.zip')));
if (up.status !== 'ready') throw new Error(`VWF Dialogues: ${up.status}`);
const src = map16Source(rom, new LevelEmulator(rom).load(0x105));
const opts: InstallOptions = { level: 0x105, blank: src.fg(0x025), tileWords: (t) => src.fg(t) };
const r = await installPackage(rom, up, opts);
check(r.ok, `VWF Dialogues installed${r.ok ? '' : ': ' + r.errors.join(' ')}`);
check(!!r.messages && r.warnings.includes(r.messages), `its install says message editing no longer applies (${r.messages})`);
{
  const m = currentMessageRoutine(rom);
  check(!m.game && m.packages.join() === 'vwf_dialogues', `the game no longer draws the editor's messages, the package drawing them named (${m.packages.join(', ')})`);
  check(messageRoutineNote(m).startsWith('Messages in this ROM are drawn by package “vwf_dialogues”'), messageRoutineNote(m));
}

await removePackage(rom, r.pkg!.id, opts.blank);
{
  const m = currentMessageRoutine(rom);
  check(m.game, 'removed: the game draws the editor\'s messages again');
}

console.log('message routine bad', bad);
if (bad) process.exitCode = 1;
