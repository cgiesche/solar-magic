// Scanline renderer for the SNES PPU, sufficient for SMW gameplay: BG modes 0/1
// (8x8 tiles), sprites, priorities, brightness, simple color math (add/half on
// main+sub screen), windows (per-layer masks, clip to black / prevent color math). No mosaic, no mode 7.

import type { Snes } from './snes.ts';

export interface PpuState { hofs: number[]; vofs: number[]; latch: number; hlatch: number; frame: Uint32Array }

export class PPU {
  snes: Snes;
  // scroll registers with SNES write-twice latching
  hofs = [0, 0, 0, 0];
  vofs = [0, 0, 0, 0];
  latch = 0;
  hlatch = 0;
  frame = new Uint32Array(256 * 224);
  private pal = new Uint32Array(256);
  private lineMain = new Uint16Array(256); // color index into cgram (0x100 = backdrop)
  private linePrio = new Uint8Array(256);
  private lineSub = new Uint16Array(256);
  private subPrio = new Uint8Array(256);
  private mainMathOk = new Uint8Array(256); // layer id of the main pixel (for color math enable)
  // window masks of this line (1 = inside the layer's window): BG1-4, OBJ, color
  private win = Array.from({ length: 6 }, () => new Uint8Array(256));
  private winOn = [false, false, false, false, false, false];

  constructor(snes: Snes) {
    this.snes = snes;
  }

  // what a savestate keeps of it (see Snes.saveState): the scroll registers and the frame on screen
  saveState(): PpuState {
    return { hofs: [...this.hofs], vofs: [...this.vofs], latch: this.latch, hlatch: this.hlatch, frame: this.frame.slice() };
  }
  loadState(st: PpuState): void {
    this.hofs = [...st.hofs];
    this.vofs = [...st.vofs];
    this.latch = st.latch;
    this.hlatch = st.hlatch;
    this.frame.set(st.frame);
  }

  // called by Snes on PPU register writes that need special handling
  write(reg: number, v: number): void {
    if (reg >= 0x0d && reg <= 0x14) {
      const bg = (reg - 0x0d) >> 1;
      if (((reg - 0x0d) & 1) === 0) {
        this.hofs[bg] = ((v << 8) | (this.latch & ~7) | (this.hlatch & 7)) & 0x3ff;
        this.latch = v;
        this.hlatch = v;
      } else {
        this.vofs[bg] = ((v << 8) | this.latch) & 0x3ff;
        this.latch = v;
      }
    }
  }

  private updatePalette(): void {
    const cg = this.snes.cgram;
    for (let i = 0; i < 256; i++) {
      const c = cg[i * 2] | (cg[i * 2 + 1] << 8);
      this.pal[i] = c;
    }
  }

  renderLine(y: number): void {
    if (y >= 224) return;
    const s = this.snes;
    const r = s.ppuRegs;
    const out = this.frame;
    const inidisp = r[0x00];
    if (inidisp & 0x80) {
      out.fill(0xff000000, y * 256, y * 256 + 256);
      return;
    }
    if (y === 0) this.updatePalette();
    else if ((y & 7) === 0) this.updatePalette();
    const mode = r[0x05] & 7;
    const bg3prio = (r[0x05] & 0x08) !== 0;
    const tm = r[0x2c], ts = r[0x2d];
    const main = this.lineMain, prio = this.linePrio;
    const sub = this.lineSub, sprio = this.subPrio;
    main.fill(0x100); prio.fill(0); sub.fill(0x100); sprio.fill(0);
    const layerOf = this.mainMathOk;
    layerOf.fill(5); // 5 = backdrop
    this.updateWindows();
    const tmw = r[0x2e], tsw = r[0x2f];
    const mask = (l: number, on: number) => (on >> l) & 1 && this.winOn[l] ? this.win[l] : null;
    // priority values (higher = in front) for mode 1 / mode 0
    const bgPrio = (bg: number, hi: boolean): number => {
      if (mode === 1) {
        if (bg === 0) return hi ? 9 : 6;
        if (bg === 1) return hi ? 8 : 5;
        return hi ? (bg3prio ? 12 : 3) : 1;
      }
      // mode 0
      return [hi ? 11 : 8, hi ? 10 : 7, hi ? 4 : 1, hi ? 3 : 0][bg];
    };
    const objPrio = [2, 4, 7, 10];
    const bpps = mode === 1 ? [4, 4, 2, 0] : mode === 0 ? [2, 2, 2, 2] : [4, 4, 0, 0];
    for (let bg = 0; bg < 4; bg++) {
      const bpp = bpps[bg];
      if (!bpp) continue;
      const onMain = (tm >> bg) & 1, onSub = (ts >> bg) & 1;
      if (!onMain && !onSub) continue;
      this.drawBgLine(bg, bpp, y, mode === 0 ? bg * 32 : 0, (hi) => bgPrio(bg, hi), onMain !== 0, onSub !== 0, mask(bg, tmw), mask(bg, tsw));
    }
    if ((tm | ts) & 0x10) this.drawObjLine(y, objPrio, (tm & 0x10) !== 0, (ts & 0x10) !== 0, mask(4, tmw), mask(4, tsw));
    // color math
    const cgwsel = r[0x30], cgadsub = r[0x31];
    const useSub = (cgwsel & 0x02) !== 0;
    const fixed = s.fixedColor;
    const bright = inidisp & 0x0f;
    const backdrop = this.pal[0];
    // color window regions: 0 never, 1 outside, 2 inside, 3 always
    const cw = this.win[5], cwOn = this.winOn[5];
    const region = (sel: number, x: number) => sel === 3 || (sel === 1 && !(cwOn && cw[x])) || (sel === 2 && cwOn && cw[x] === 1);
    const clipSel = cgwsel >> 6, noMathSel = (cgwsel >> 4) & 3;
    for (let x = 0; x < 256; x++) {
      let c = main[x] === 0x100 ? backdrop : this.pal[main[x]];
      if (clipSel && region(clipSel, x)) c = 0;
      const lid = layerOf[x];
      if (lid !== 6 && ((cgadsub >> lid) & 1) && !(noMathSel && region(noMathSel, x))) {
        const other = useSub ? (sub[x] === 0x100 ? fixed : this.pal[sub[x]]) : fixed;
        const half = (cgadsub & 0x40) !== 0 && !(useSub && sub[x] === 0x100);
        c = mathColor(c, other, (cgadsub & 0x80) !== 0, half);
      }
      out[y * 256 + x] = toRGBA(c, bright);
    }
  }

  // $2123-$2125: per layer a nibble (bit 0/2 invert window 1/2, bit 1/3 enable); $2126-$2129 window
  // edges; $212A/$212B combine both windows (OR, AND, XOR, XNOR)
  private updateWindows(): void {
    const r = this.snes.ppuRegs;
    const l1 = r[0x26], r1 = r[0x27], l2 = r[0x28], r2 = r[0x29];
    for (let l = 0; l < 6; l++) {
      const sel = (r[0x23 + (l >> 1)] >> ((l & 1) * 4)) & 0x0f;
      const e1 = (sel & 2) !== 0, e2 = (sel & 8) !== 0;
      this.winOn[l] = e1 || e2;
      if (!e1 && !e2) continue;
      const i1 = (sel & 1) !== 0, i2 = (sel & 4) !== 0;
      const logic = l < 4 ? (r[0x2a] >> (l * 2)) & 3 : (r[0x2b] >> ((l - 4) * 2)) & 3;
      const m = this.win[l];
      for (let x = 0; x < 256; x++) {
        const a = (x >= l1 && x <= r1) !== i1, b = (x >= l2 && x <= r2) !== i2;
        let v: boolean;
        if (e1 && e2) v = logic === 0 ? a || b : logic === 1 ? a && b : logic === 2 ? a !== b : a === b;
        else v = e1 ? a : b;
        m[x] = v ? 1 : 0;
      }
    }
  }

  private drawBgLine(bg: number, bpp: number, y: number, palOff: number, pr: (hi: boolean) => number, onMain: boolean, onSub: boolean, mm: Uint8Array | null, ms: Uint8Array | null): void {
    const s = this.snes, r = s.ppuRegs, vram = s.vram;
    const sc = r[0x07 + bg];
    const mapBase = (sc & 0xfc) << 9; // bytes
    const wide = (sc & 1) !== 0, tall = (sc & 2) !== 0;
    const nba = r[0x0b + (bg >> 1)];
    const charBase = ((bg & 1 ? nba >> 4 : nba) & 0x0f) << 13;
    const hofs = this.hofs[bg], vofs = this.vofs[bg];
    const yy = (y + vofs) & (tall ? 0x1ff : 0xff);
    const ty = yy >> 3, fy = yy & 7;
    const main = this.lineMain, prio = this.linePrio, sub = this.lineSub, sprio = this.subPrio, layerOf = this.mainMathOk;
    const tileBytes = bpp * 8;
    for (let x = 0; x < 256;) {
      const xx = (x + hofs) & (wide ? 0x1ff : 0xff);
      const tx = xx >> 3, fx = xx & 7;
      const scr = ((tx >> 5) & (wide ? 1 : 0)) + ((ty >> 5) & (tall ? 1 : 0)) * (wide ? 2 : 1);
      const ea = (mapBase + scr * 0x800 + ((ty & 31) * 32 + (tx & 31)) * 2) & 0xffff;
      const e = vram[ea] | (vram[ea + 1] << 8);
      const tile = e & 0x3ff, pal = (e >> 10) & 7, hi = (e & 0x2000) !== 0;
      const xf = (e & 0x4000) !== 0, yf = (e & 0x8000) !== 0;
      const row = yf ? 7 - fy : fy;
      const ta = (charBase + tile * tileBytes) & 0xffff;
      const p0 = vram[(ta + row * 2) & 0xffff], p1 = vram[(ta + row * 2 + 1) & 0xffff];
      let p2 = 0, p3 = 0;
      if (bpp === 4) { p2 = vram[(ta + 16 + row * 2) & 0xffff]; p3 = vram[(ta + 17 + row * 2) & 0xffff]; }
      const P = pr(hi);
      for (let px = fx; px < 8 && x < 256; px++, x++) {
        const bit = xf ? px : 7 - px;
        const c = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1) | (((p2 >> bit) & 1) << 2) | (((p3 >> bit) & 1) << 3);
        if (!c) continue;
        const ci = palOff + pal * (1 << bpp) + c;
        if (onMain && P > prio[x] && !(mm && mm[x])) { prio[x] = P; main[x] = ci; layerOf[x] = bg; }
        if (onSub && P > sprio[x] && !(ms && ms[x])) { sprio[x] = P; sub[x] = ci; }
      }
    }
  }

  private drawObjLine(y: number, objPrio: number[], onMain: boolean, onSub: boolean, mm: Uint8Array | null, ms: Uint8Array | null): void {
    const s = this.snes, oam = s.oam, vram = s.vram;
    const obsel = s.ppuRegs[0x01];
    const base = (obsel & 7) << 14;
    const gap = (((obsel >> 3) & 3) + 1) << 13;
    const sizes = [[8, 16], [8, 32], [8, 64], [16, 32], [16, 64], [32, 64], [16, 32], [16, 32]][(obsel >> 5) & 7];
    const main = this.lineMain, prio = this.linePrio, sub = this.lineSub, sprio = this.subPrio, layerOf = this.mainMathOk;
    const drawn = new Uint8Array(256);
    for (let i = 0; i < 128; i++) {
      const hi = (oam[0x200 + (i >> 2)] >> ((i & 3) * 2)) & 3;
      const size = sizes[(hi >> 1) & 1];
      let sy = oam[i * 4 + 1];
      let dy = (y - sy) & 0xff;
      if (dy >= size) continue;
      let sx = oam[i * 4] | ((hi & 1) << 8);
      if (sx >= 256) sx -= 512;
      const tile = oam[i * 4 + 2], attr = oam[i * 4 + 3];
      const xf = (attr & 0x40) !== 0, yf = (attr & 0x80) !== 0;
      const pal = (attr >> 1) & 7, P = objPrio[(attr >> 4) & 3];
      if (yf) dy = size - 1 - dy;
      const trow = dy >> 3, frow = dy & 7;
      for (let px = 0; px < size; px++) {
        const x = sx + px;
        if (x < 0 || x >= 256 || drawn[x]) continue;
        const cx = xf ? size - 1 - px : px;
        const tcol = cx >> 3, fcol = cx & 7;
        const t = ((tile & 0xf0) + ((tile + tcol) & 0x0f) + trow * 16) & 0xff;
        const ta = (base + (attr & 1 ? gap : 0) + t * 32) & 0xffff;
        const bit = 7 - fcol;
        const c = ((vram[(ta + frow * 2) & 0xffff] >> bit) & 1) | (((vram[(ta + frow * 2 + 1) & 0xffff] >> bit) & 1) << 1) |
          (((vram[(ta + 16 + frow * 2) & 0xffff] >> bit) & 1) << 2) | (((vram[(ta + 17 + frow * 2) & 0xffff] >> bit) & 1) << 3);
        if (!c) continue;
        drawn[x] = 1; // lower OAM index wins among sprites
        const ci = 128 + pal * 16 + c;
        if (onMain && P > prio[x] && !(mm && mm[x])) { prio[x] = P; main[x] = ci; layerOf[x] = pal >= 4 ? 4 : 6; }
        if (onSub && P > sprio[x] && !(ms && ms[x])) { sprio[x] = P; sub[x] = ci; }
      }
    }
  }
}

function mathColor(a: number, b: number, subtract: boolean, half: boolean): number {
  let r = a & 31, g = (a >> 5) & 31, bl = (a >> 10) & 31;
  const r2 = b & 31, g2 = (b >> 5) & 31, b2 = (b >> 10) & 31;
  if (subtract) { r -= r2; g -= g2; bl -= b2; } else { r += r2; g += g2; bl += b2; }
  if (half) { r >>= 1; g >>= 1; bl >>= 1; }
  r = Math.max(0, Math.min(31, r)); g = Math.max(0, Math.min(31, g)); bl = Math.max(0, Math.min(31, bl));
  return r | (g << 5) | (bl << 10);
}

function toRGBA(c: number, bright: number): number {
  const f = (bright + 1) / 16;
  const r = Math.round(((c & 31) << 3 | (c & 31) >> 2) * f);
  const g = Math.round((((c >> 5) & 31) << 3 | ((c >> 5) & 31) >> 2) * f);
  const b = Math.round((((c >> 10) & 31) << 3 | ((c >> 10) & 31) >> 2) * f);
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}
