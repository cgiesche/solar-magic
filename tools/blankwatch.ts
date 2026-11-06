// Time the NMI takes in a played level (testblanklines.ts, blank00c.ts): black lines at the top of the screen (lines
// 0-223 drawn while force blank, $2100 bit 7, is still on: the NMI's V-blank work ran into the visible frame), the
// line the screen is turned on (262+ = in the next frame), the line the NMI ends, and the stripe upload ($0085E3, the call of the game's
// routine or the VRAM patch's) in lines
import type { Snes } from '../src/core/snes.ts';
import { PPU } from '../src/core/ppu.ts';
import { RAM, SPR, SPRITE_SLOTS, get16, setMarioPos } from '../src/core/ram.ts';

const STRIPE_CALL = 0x85e3, STRIPE_BACK = [0x85e6, 0x85e7]; // after JSR $871E (the game) or JSL (SMWV)
const NMI_RTI = 0x82c3;
const STRIPE_LEN = 0x1837b, STRIPE_BUF = 0x1837d; // $7F837B: bytes in the buffer, $7F837D: the buffer

export interface NmiFrame {
  blank: number; // black lines at the top
  screenOn: number; // the latest line an NMI turned the screen on (0 if none did)
  nmiEnd: number; // the latest line an NMI returned (its RTI at $0082C3; 262+ = in the next frame, the status bar's IRQ is at 262 + 36)
  stripeLines: number; // the stripe upload's lines (0 without stripes)
  stripes: number[]; // the stripe buffer uploaded
}

// installs the PPU and the hooks; frame() resets them, call it before each played frame and read it after
export function watchNmi(s: Snes): { frame(): NmiFrame } {
  const ppu = new PPU(s); s.ppu = ppu;
  let cur: NmiFrame = { blank: 0, screenOn: 0, nmiEnd: 0, stripeLines: 0, stripes: [] };
  const render = ppu.renderLine.bind(ppu);
  ppu.renderLine = (y: number) => { if (y < 224 && (s.ppuRegs[0] & 0x80) && y === cur.blank) cur.blank++; render(y); };
  const io = s.writeIO.bind(s);
  s.writeIO = (a: number, v: number) => { if (a === 0x2100 && !(v & 0x80)) cur.screenOn = Math.max(cur.screenOn, s.line < 225 ? s.line + 262 : s.line); io(a, v); };
  const step = s.cpu.step.bind(s.cpu);
  let t0 = 0;
  s.cpu.step = () => {
    const pc = ((s.cpu.pbr << 16) | s.cpu.pc) & 0x7fffff;
    if (pc === NMI_RTI) cur.nmiEnd = Math.max(cur.nmiEnd, s.line < 225 ? s.line + 262 : s.line);
    else if (pc === STRIPE_CALL) {
      const n = get16(s.wram, STRIPE_LEN);
      t0 = n ? s.cpu.cycles : 0;
      if (n) cur.stripes = Array.from(s.wram.subarray(STRIPE_BUF, STRIPE_BUF + n + 1));
    } else if (t0 && STRIPE_BACK.includes(pc)) {
      cur.stripeLines = Math.max(cur.stripeLines, (s.cpu.cycles - t0) / 1364);
      t0 = 0;
    }
    return step();
  };
  return {
    frame() { const f = cur; cur = { blank: 0, screenOn: 0, nmiEnd: 0, stripeLines: 0, stripes: [] }; return f; },
  };
}

// level 00C (autoscroll): Mario, with a star, held beside the camera until a scale platform (sprite 8F) is on
// screen, then put on it every 2 seconds – the platforms' tiles change as stripes every frame they move
export function holdOnScales(w: Uint8Array, f: number): void {
  w[RAM.starTimer] = 0xff;
  const cx = get16(w, RAM.layer1X);
  const x = (i: number) => get16(w, SPR.xLo + i, SPR.xHi + i);
  const sl = [...Array(SPRITE_SLOTS).keys()].find((i) => w[SPR.status + i] && w[SPR.num + i] === 0x8f && x(i) >= cx + 0x40 && x(i) < cx + 0xe0);
  if (sl === undefined) { setMarioPos(w, cx + 0x60, 0x60); w[RAM.marioSpeedY] = 0; }
  else if (f % 120 < 2) setMarioPos(w, x(sl) + 4, get16(w, SPR.yLo + sl, SPR.yHi + sl) - 0x30);
}
