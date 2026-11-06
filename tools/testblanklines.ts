// No black lines at the top of the screen in the editor's image (#406): the NMI's V-blank work must end before the
// frame is drawn. The VRAM layout patch (SMWV) handles single tile changes (stripes) in the NMI; word by word they ran
// past V-blank – 107's Yoshi coin, 104's message box, 00C's scale platforms showed up to 8 black lines.
// Played as the clean game and the editor's image: 107 and 104 (Mario running right, jumping), 00C with Mario held on
// the scale platforms (their tiles change as stripes while they move). The stripe upload of 00C stays near the game's.
// Options: --levels=107,104 --frames=900, --clean (the clean game too, for comparison), -v (frames with black lines),
// --vanilla-stripe (the editor's image with the game's stripe upload at $0085E3, for comparison)
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { PAD, RAM } from '../src/core/ram.ts';
import { cleanImage, editorImage } from './fixture.ts';
import { watchNmi, holdOnScales } from './blankwatch.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const levels = (arg('levels') ?? '107,104').split(',').map((x) => parseInt(x, 16));
const frames = Number(arg('frames') ?? 900);
const verbose = process.argv.includes('-v');
const run = (f: number) => PAD.y | PAD.right | (f % 70 < 34 ? PAD.b : 0);
// the status bar's IRQ (line $24 of the next frame): the NMI, which masks it, must have ended (VRAM patch: its shadow pass
// runs after the screen is on)
const IRQ_LINE = 262 + 0x24;
const hex = (n: number) => n.toString(16).toUpperCase().padStart(3, '0');

interface Result { blackFrames: number; maxBlack: number; latestOn: number; latestEnd: number; maxStripe: number; note: string }

// level n played for `frames` frames, each frame's input and setup from `each`
function play(img: Uint8Array, n: number, frames: number, each: (w: Uint8Array, f: number) => number): Result {
  const emu = new LevelEmulator(new Rom(img)); emu.boot();
  const p = PlaySession.start(emu, n);
  if (!p.ready) throw new Error(`level ${hex(n)} not ready`);
  const nmi = watchNmi(emu.snes);
  nmi.frame();
  const r: Result = { blackFrames: 0, maxBlack: 0, latestOn: 0, latestEnd: 0, maxStripe: 0, note: '' };
  const seen: string[] = [];
  for (let f = 0; f < frames; f++) {
    const coins = emu.snes.wram[RAM.dragonCoins];
    const end = p.play(1, each(emu.snes.wram, f));
    const m = nmi.frame();
    if (emu.snes.wram[RAM.dragonCoins] !== coins) seen.push(`coin f${f}`);
    if (m.blank > 0 && m.blank < 224) { r.blackFrames++; r.maxBlack = Math.max(r.maxBlack, m.blank); if (verbose) seen.push(`f${f}: ${m.blank} lines`); }
    r.latestOn = Math.max(r.latestOn, m.screenOn);
    r.latestEnd = Math.max(r.latestEnd, m.nmiEnd);
    r.maxStripe = Math.max(r.maxStripe, m.stripeLines);
    if (end) { seen.push(`${end} f${f}`); break; }
  }
  r.note = seen.join(', ');
  return r;
}

const say = (name: string, n: number, r: Result) =>
  `${name} ${hex(n)}: ${r.blackFrames} frames with black top lines (max ${r.maxBlack}), screen on by line ${r.latestOn}, NMI done by ${r.latestEnd}, stripe upload up to ${r.maxStripe.toFixed(1)} lines${r.note ? ` (${r.note})` : ''}`;

const images: [string, Uint8Array][] = [];
if (process.argv.includes('--clean')) images.push(['clean game', cleanImage()]);
const ed = await editorImage();
images.push(['editor', ed]);
if (process.argv.includes('--vanilla-stripe')) { const v = ed.slice(); v.set([0x20, 0x1e, 0x87, 0xa5, 0x12], 0x5e3); images.push(['editor, game stripe upload', v]); }

for (const [name, img] of images) {
  const mine = name === 'editor';
  for (const n of levels) {
    const r = play(img, n, frames, (_, f) => run(f));
    if (mine) { check(r.blackFrames === 0, say(name, n, r)); check(r.latestEnd < IRQ_LINE, `${hex(n)}: the NMI ends (shadow written) by line ${r.latestEnd}, before the status bar's IRQ`); }
    else console.log('     ' + say(name, n, r));
  }
  // 00C: the scale platforms' stripes, every frame they move (about 640 frames until Mario falls)
  const r = play(img, 0x00c, 1500, (w, f) => { holdOnScales(w, f); return 0; });
  if (mine) {
    check(r.blackFrames === 0, say(name, 0x00c, r));
    check(r.maxStripe > 0 && r.maxStripe < 6.5, `00C: the stripe upload takes ${r.maxStripe.toFixed(1)} lines at most (the game's: 4.1; per entry about the game's, plus the window's settings once)`);
    check(r.latestOn > 0 && r.latestOn < 262, `00C: the screen is on by line ${r.latestOn}, before the frame is drawn`);
    check(r.latestEnd < IRQ_LINE, `00C: the NMI ends (shadow written) by line ${r.latestEnd}, before the status bar's IRQ`);
  } else console.log('     ' + say(name, 0x00c, r));
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
