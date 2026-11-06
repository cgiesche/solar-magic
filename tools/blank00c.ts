// Level 00C (autoscroll) with Mario held on the scale platforms (blankwatch.ts holdOnScales), the clean game and the
// editor's image: black top lines per frame, the stripe bytes the NMI uploads, the latest line the screen is turned
// on, the stripe upload's lines and the stripes of the slowest one.
// blank00c.ts [level] [frames] [--vanilla-stripe] [-v]
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { SPR, SPRITE_SLOTS, get16 } from '../src/core/ram.ts';
import { cleanImage, editorImage } from './fixture.ts';
import { watchNmi, holdOnScales } from './blankwatch.ts';

const verbose = process.argv.includes('-v');
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const lv = parseInt(args[0] ?? 'c', 16), frames = Number(args[1] ?? 1500);
const ed = await editorImage();
const runs: [string, Uint8Array][] = [['clean ', cleanImage()], ['editor', ed]];
// the game's stripe upload instead of the VRAM patch's (JSR $871E : LDA $12 back at $0085E3)
if (process.argv.includes('--vanilla-stripe')) { const v = ed.slice(); v.set([0x20, 0x1e, 0x87, 0xa5, 0x12], 0x5e3); runs.push(['editor, game stripe upload', v]); }
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
for (const [name, img] of runs) {
  const emu = new LevelEmulator(new Rom(img)); emu.boot();
  const p = PlaySession.start(emu, lv);
  const w = emu.snes.wram;
  const nmi = watchNmi(emu.snes);
  nmi.frame();
  let bad = 0, max = 0, maxBytes = 0, scaleFrames = 0, latestOn = 0, maxStripe = 0, slowest: number[] = [];
  const out: string[] = [];
  for (let f = 0; f < frames; f++) {
    holdOnScales(w, f);
    const cx = get16(w, 0x1a);
    const end = p.play(1, 0);
    const m = nmi.frame();
    const scale = [...Array(SPRITE_SLOTS).keys()].some((i) => w[SPR.status + i] && w[SPR.num + i] === 0x8f);
    if (scale) scaleFrames++;
    maxBytes = Math.max(maxBytes, m.stripes.length - 1);
    latestOn = Math.max(latestOn, m.screenOn);
    if (m.stripeLines > maxStripe) { maxStripe = m.stripeLines; slowest = m.stripes; }
    if (verbose && f % 20 === 0) out.push(`f${f} x${cx.toString(16)} stripes ${Math.max(0, m.stripes.length - 1)} screen on L${m.screenOn}${scale ? ' 8F' : ''}`);
    if (m.blank > 0 && m.blank < 224) { bad++; max = Math.max(max, m.blank); out.push(`f${f} x${cx.toString(16)}: ${m.blank} lines, stripes ${m.stripes.length - 1}${scale ? ' 8F' : ''}`); }
    if (end) { out.push(`END ${end} f${f}`); break; }
  }
  console.log(`${name} ${lv.toString(16)}: ${bad} frames with black top lines, max ${max}; max stripe bytes ${maxBytes}, frames with 8F ${scaleFrames}, latest screen-on line ${latestOn}; stripe upload up to ${maxStripe.toFixed(1)} lines (${hex(slowest)})\n  ${out.slice(0, 80).join('\n  ')}`);
}
