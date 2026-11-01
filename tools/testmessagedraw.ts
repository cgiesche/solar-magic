// Whether the game draws the editor's messages (messagedraw.ts), by emulation: message boxes opened as players open
// them (Mario hitting a message box from below at two columns, a baby Yoshi growing up: messages 1, 2 and 3), the
// characters the game writes compared with the editor's. In the ROM the editor opens it does, also with Retry System
// (by Kevin/kkevinm, test/fixtures/retry-system_v2.2.0.zip; hijacks near the routine) and a package hooking the
// message box sprite's hit (read only while a box opens) installed; with RPG Hacker's VWF Dialogues Patch
// (test/fixtures/vwf_dialogues.zip, a package replacing the message routine) installed too it does not, that package
// alone is named (not the hook, not Retry) and installing it says that message editing no longer applies; Ctrl+Z of
// the install and removing it, the game draws them once more. No level playing: unknown.
// Learned in the probe worker as the editor asks (App.messageRoutine): as found directly, no level played on the
// main thread, asked again after the install and its undo, known again at once after the redo.
// (The Romhack Races baserom, whose patches leave the routine alone: testrhr.ts.)
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { map16Source } from '../src/core/render.ts';
import { RomHistory } from '../src/core/romhistory.ts';
import { listPatches } from '../src/core/patchreg.ts';
import { listPackages } from '../src/core/pkgreg.ts';
import { inspectUpload, installPackage, removePackage, defaultAssignment, type InstallOptions } from '../src/core/packages.ts';
import { messageRoutine, messageRoutineInput, messageRoutineNote, messageRoutineTaken, type MessageRoutine } from '../src/core/messagedraw.ts';
import { ProbeHost } from '../src/core/probehost.ts';
import type { ProbeMessage, ProbeReply } from '../src/core/probeprotocol.ts';
import { ProbeClient } from '../src/core/probeclient.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { loadLevel, L2_PTRS } from '../src/core/level.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number | null) => (v === null ? '–' : v.toString(16).toUpperCase());
const settle = () => new Promise((r) => setTimeout(r, 0)); // (stored results are awaited first)
const same = (a: MessageRoutine | undefined, b: MessageRoutine) => JSON.stringify(a) === JSON.stringify(b);

// the packages tried without (messagedraw.ts drawnWithout: its copy of the ROM is made with their bytes undone)
const candidates: string[] = [];
const adopt = LevelEmulator.prototype.adoptBoot;
LevelEmulator.prototype.adoptBoot = function (this: LevelEmulator, other: LevelEmulator) {
  const name = listPackages(rom).find((k) => k.patches.some((id) => { const e = listPatches(rom).find((x) => x.id === id); return e && e.segs.some(([pc, n]) => this.rom.data.subarray(pc, pc + n).some((v, i) => v !== rom.data[pc + i])); }))?.name;
  if (name) candidates.push(name);
  return adopt.call(this, other);
};

// levels played, counted by where they run (the stand-in worker sets inWorker while it runs the host)
let inWorker = false, playsHere = 0, playsThere = 0;
const start = PlaySession.start;
PlaySession.start = (emu, n, opt) => { if (inWorker) playsThere++; else playsHere++; return start(emu, n, opt); };

class Worker {
  host = new ProbeHost();
  reply!: (d: ProbeReply) => void;
  connect = (reply: (d: ProbeReply) => void) => {
    this.reply = reply;
    return (m: ProbeMessage) => { this.host.handle(m); };
  };
  run(): void {
    while (this.host.pending) {
      inWorker = true;
      let d: ProbeReply | null;
      try { d = this.host.next(); } finally { inWorker = false; }
      if (d) this.reply(d);
    }
  }
}

const rom = new Rom(await editorImage());
const worker = new Worker();
const client = new ProbeClient({
  results: new ResultCache(new RomFingerprint(rom)), cacheReady: Promise.resolve(),
  rom: () => rom, tileset: () => 0, connect: worker.connect,
  later: () => {}, setBusy: () => {}, ready: () => {}, kindsReady: () => {},
  kindLevel: () => { const lv = loadLevel(rom, 0x105); return { level: { number: lv.number, header: lv.header }, layer2Pointer: rom.r24(L2_PTRS + 0x105 * 3) }; },
});
// as the editor asks (App.messageRoutine): the result, learned in the worker when not known
async function asked(): Promise<{ r: MessageRoutine | undefined; known: boolean }> {
  let got: MessageRoutine | undefined;
  const now = client.learn<MessageRoutine>('msgr1', { kind: 'msgRoutine' }, { lane: 'msgr', input: { patches: messageRoutineInput(rom) }, replace: true, done: (r) => (got = r) });
  if (now) return { r: now, known: true };
  await settle();
  worker.run();
  await settle();
  return { r: got, known: false };
}

{
  const m = messageRoutine(rom);
  check(m.game === true && m.level === 0x105 && !m.packages.length && m.messages.join() === '1,2,3',
    `the editor's ROM: the game draws its messages 1, 2, 3 as opened in level ${hx(m.level)} (${m.messages.join(', ')})`);
  playsHere = playsThere = 0;
  const a = await asked();
  check(!a.known && same(a.r, m) && playsHere === 0 && playsThere > 0, `asked as the editor asks: as found directly, played in the worker (${playsThere}), not on the main thread (${playsHere})`);
}

const src = map16Source(rom, new LevelEmulator(rom).load(0x105));
const opts: InstallOptions = { level: 0x105, blank: src.fg(0x025), tileWords: (t) => src.fg(t) };
// a package hooking the message box sprite's hit: the code it runs there is the game's ($038D87: LDA $E4,x LSR LSR)
{
  const hook = 'org $038D87\n  autoclean JSL Hit\nfreecode\nHit:\n  LDA $E4,x\n  LSR\n  LSR\n  RTL\n';
  const pre = inspectUpload('boxhit.asm', new TextEncoder().encode(hook));
  if (pre.status !== 'ready') throw new Error(`the hook: ${pre.status}`);
  const r = await installPackage(rom, pre, opts);
  check(r.ok, `a package hooking the message box's hit installed${r.ok ? '' : ': ' + r.errors.join(' ')}`);
  const m = messageRoutine(rom);
  check(m.game === true && m.messages.join() === '1,2,3', `with it the game draws the editor's messages (${m.messages.join(', ')})`);
}

const up = inspectUpload('vwf_dialogues.zip', new Uint8Array(readFileSync('test/fixtures/vwf_dialogues.zip')));
if (up.status !== 'ready') throw new Error(`VWF Dialogues: ${up.status}`);
const history = new RomHistory(rom);
const before = (await asked()).r;
history.begin('Install VWF');
const r = await installPackage(rom, up, opts);
history.commit();
check(r.ok, `VWF Dialogues installed${r.ok ? '' : ': ' + r.errors.join(' ')}`);
let replaced: MessageRoutine;
{
  candidates.length = 0;
  const m = replaced = messageRoutine(rom);
  check(m.game === false && m.packages.join() === 'vwf_dialogues' && m.messages.join() === '1,2,3' && candidates.join() === 'boxhit,vwf_dialogues',
    `the game no longer draws the editor's messages (${m.messages.join(', ')} compared), only the package drawing them named (${m.packages.join(', ')}), not the hook read only while a box opens too (tried without: ${candidates.join(', ')})`);
  check(messageRoutineNote(m).startsWith('Messages in this ROM are drawn by package “vwf_dialogues”'), messageRoutineNote(m));
  const said = messageRoutineTaken('vwf_dialogues', before, m);
  check(!!said && messageRoutineTaken('boxhit', before, m) === null, `its install says message editing no longer applies (${said})`);
  const a = await asked();
  check(!a.known && same(a.r, m), 'asked again after the install: learned again, as found directly');
}

// Retry System: hooks in near the message routine (its switch palace hijack), draws no box
const retry = inspectUpload('retry-system_v2.2.0.zip', new Uint8Array(readFileSync('test/fixtures/retry-system_v2.2.0.zip')));
if (retry.status !== 'manual') throw new Error(`Retry: ${retry.status}`);
history.begin('Install Retry');
const rr = await installPackage(rom, retry, { ...opts, assignment: defaultAssignment(retry, 0x105) });
history.commit();
check(rr.ok, `Retry System installed too${rr.ok ? '' : ': ' + rr.errors.join(' ')}`);
{
  const m = messageRoutine(rom);
  check(m.game === false && m.packages.join() === 'vwf_dialogues', `with Retry System still only the package drawing the boxes named (${m.packages.join(', ')})`);
  check(messageRoutineTaken(retry.name, replaced, m) === null, 'Retry System\'s install says nothing of the messages');
}

// Ctrl+Z of the installs: the game draws them again; the redo of VWF's: replaced again, known at once
history.undo();
history.undo();
{
  const m = messageRoutine(rom);
  check(m.game === true, 'the installs undone: the game draws the editor\'s messages again');
  const a = await asked();
  check(a.known && a.r?.game === true, 'asked again after the undo: the game draws them, known at once (as before the install)');
}
history.redo();
{
  playsThere = 0;
  const a = await asked();
  check(a.known && same(a.r, replaced) && playsThere === 0, 'VWF\'s install redone: known again at once, not played again');
}

await removePackage(rom, r.pkg!.id, opts.blank);
{
  const m = messageRoutine(rom);
  check(m.game === true, 'removed: the game draws the editor\'s messages again');
}
{
  const r = await installPackage(rom, retry, { ...opts, assignment: defaultAssignment(retry, 0x105) });
  const m = messageRoutine(rom);
  check(r.ok && m.game === true && m.messages.join() === '1,2,3', `with Retry System alone the game draws the editor's messages (${m.messages.join(', ')})`);
}

// no level plays: unknown, not "the game draws them"
{
  const load = LevelEmulator.prototype.load;
  LevelEmulator.prototype.load = () => { throw new Error('no level plays'); };
  let m: MessageRoutine;
  try { m = messageRoutine(new Rom(await editorImage())); } finally { LevelEmulator.prototype.load = load; }
  check(m.game === null && m.level === null && messageRoutineTaken('x', { ...m, game: true }, m) === null, 'no level plays: unknown, and an install says nothing');
}

console.log('message routine bad', bad);
if (bad) process.exitCode = 1;
