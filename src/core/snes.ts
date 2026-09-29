// Minimal SNES system model: LoROM mapping, WRAM, SRAM, PPU memories (VRAM/CGRAM/OAM),
// DMA, math registers, simple timing (NMI / V-IRQ) and a high-level fake of the APU
// upload protocol. Nothing is rendered by this module; the editor renders from
// VRAM/CGRAM/WRAM contents itself.

import { CPU, type Bus } from './cpu.ts';

export const CYCLES_PER_LINE = 170; // approximate CPU cycles (bus accesses) per scanline
export const LINES_PER_FRAME = 262;
export const VBLANK_LINE = 225;

export interface MemHook {
  // called for every read of a ROM byte (after mapping): pc offset in rom
  onRomRead?(offset: number): void;
  onWramWrite?(addr: number, value: number): void;
  onOverlayRead?(offset: number): void;
}

export interface SnesState {
  [k: string]: unknown;
}

const STATE_ARRAYS = ['wram', 'sram', 'vram', 'cgram', 'oam', 'ppuRegs', 'dma', 'apuIn', 'apuOut'] as const;
const STATE_SCALARS = ['vmain', 'vaddr', 'vreadLatch', 'cgaddr', 'cgLatch', 'cgReadHigh', 'oamaddr', 'oamLatch', 'm7a', 'm7b',
  'm7latch', 'wmaddr', 'nmitimen', 'wrmpya', 'wrdiv', 'rddiv', 'rdmpy', 'htime', 'vtime', 'nmiFlag', 'irqFlag', 'joy1',
  'apuLastReadAddr', 'apuSpin', 'frame', 'line', 'lineCycle', 'openBus'] as const;
const CPU_SCALARS = ['a', 'x', 'y', 's', 'd', 'dbr', 'pbr', 'pc', 'p', 'e', 'cycles', 'stopped', 'waiting', 'nmiPending', 'irqLine'] as const;

export class Snes implements Bus {
  rom: Uint8Array;
  wram = new Uint8Array(0x20000);
  sram = new Uint8Array(0x8000);
  vram = new Uint8Array(0x10000);
  cgram = new Uint8Array(0x200);
  oam = new Uint8Array(0x220);
  cpu: CPU;
  hook: MemHook | null = null;
  // 64 KB overlay visible at $FE8000-$FEFFFF / $FF8000-$FFFFFF (editor scratch data)
  overlay: Uint8Array | null = null;

  // PPU state
  ppuRegs = new Uint8Array(0x100);
  vmain = 0;
  vaddr = 0;
  vreadLatch = 0;
  cgaddr = 0;
  cgLatch = -1;
  cgReadHigh = false;
  oamaddr = 0;
  oamLatch = 0;
  m7a = 0;
  m7b = 0;
  m7latch = 0;
  wmaddr = 0;

  // CPU regs
  nmitimen = 0;
  wrmpya = 0xff;
  wrdiv = 0xffff;
  rddiv = 0;
  rdmpy = 0;
  htime = 0x1ff;
  vtime = 0x1ff;
  nmiFlag = false;
  irqFlag = false;
  dma = new Uint8Array(0x80);
  joy1 = 0;

  // APU
  apuIn = new Uint8Array(4); // values CPU writes
  apuOut = new Uint8Array([0xaa, 0xbb, 0, 0]); // values CPU reads
  apuLastReadAddr = -1;
  apuSpin = 0;

  // timing
  frame = 0;
  line = 0;
  lineCycle = 0;
  openBus = 0;

  constructor(rom: Uint8Array) {
    this.rom = rom;
    this.cpu = new CPU(this);
  }

  romOffset(addr: number): number {
    const bank = (addr >> 16) & 0x7f;
    return (((bank << 15) | (addr & 0x7fff)) % this.rom.length);
  }

  read(addr: number): number {
    const bank = addr >> 16;
    const off = addr & 0xffff;
    let v: number;
    if (bank === 0x7e || bank === 0x7f) {
      v = this.wram[addr - 0x7e0000];
    } else {
      const b = bank & 0x7f;
      if (off >= 0x8000) {
        if (bank >= 0xfe && this.overlay) {
          const oo = ((bank & 1) << 15) | (off & 0x7fff);
          if (this.hook?.onOverlayRead) this.hook.onOverlayRead(oo);
          this.openBus = this.overlay[oo];
          return this.overlay[oo];
        }
        const ro = this.romOffset(addr);
        if (this.hook?.onRomRead) this.hook.onRomRead(ro);
        v = this.rom[ro];
      } else if (b >= 0x70 && b < 0x7e) {
        v = this.sram[off & 0x7fff];
      } else if (b < 0x40) {
        if (off < 0x2000) v = this.wram[off];
        else v = this.readIO(off);
      } else {
        v = this.openBus;
      }
    }
    this.openBus = v;
    return v;
  }

  write(addr: number, v: number): void {
    const bank = addr >> 16;
    const off = addr & 0xffff;
    if (bank === 0x7e || bank === 0x7f) {
      const a = addr - 0x7e0000;
      this.wram[a] = v;
      if (this.hook?.onWramWrite) this.hook.onWramWrite(a, v);
      return;
    }
    const b = bank & 0x7f;
    if (off >= 0x8000) return; // ROM
    if (b >= 0x70 && b < 0x7e) {
      this.sram[off & 0x7fff] = v;
      return;
    }
    if (b < 0x40) {
      if (off < 0x2000) {
        this.wram[off] = v;
        if (this.hook?.onWramWrite) this.hook.onWramWrite(off, v);
      } else this.writeIO(off, v);
    }
  }

  // ---------------- I/O ----------------
  vramStep(): number {
    switch (this.vmain & 3) {
      case 0: return 1;
      case 1: return 32;
      default: return 128;
    }
  }
  vramAddrMapped(): number {
    const a = this.vaddr;
    switch ((this.vmain >> 2) & 3) {
      case 0: return a;
      case 1: return (a & 0xff00) | ((a & 0x001f) << 3) | ((a >> 5) & 7);
      case 2: return (a & 0xfe00) | ((a & 0x003f) << 3) | ((a >> 6) & 7);
      default: return (a & 0xfc00) | ((a & 0x007f) << 3) | ((a >> 7) & 7);
    }
  }

  readIO(off: number): number {
    if (off >= 0x2140 && off < 0x2180) return this.apuRead(off & 3);
    switch (off) {
      case 0x2134: { const r = (this.m7a * ((this.m7b << 24) >> 24)) & 0xffffff; return r & 0xff; }
      case 0x2135: { const r = (this.m7a * ((this.m7b << 24) >> 24)) & 0xffffff; return (r >> 8) & 0xff; }
      case 0x2136: { const r = (this.m7a * ((this.m7b << 24) >> 24)) & 0xffffff; return (r >> 16) & 0xff; }
      case 0x2137: return this.openBus;
      case 0x2138: { const v = this.oam[this.oamaddr % 0x220]; this.oamaddr = (this.oamaddr + 1) % 0x220; return v; }
      case 0x2139: {
        const v = this.vreadLatch & 0xff;
        if (!(this.vmain & 0x80)) this.vramPrefetchAdvance();
        return v;
      }
      case 0x213a: {
        const v = (this.vreadLatch >> 8) & 0xff;
        if (this.vmain & 0x80) this.vramPrefetchAdvance();
        return v;
      }
      case 0x213b: {
        let v: number;
        if (!this.cgReadHigh) v = this.cgram[(this.cgaddr * 2) & 0x1ff];
        else { v = this.cgram[(this.cgaddr * 2 + 1) & 0x1ff]; this.cgaddr = (this.cgaddr + 1) & 0xff; }
        this.cgReadHigh = !this.cgReadHigh;
        return v;
      }
      case 0x213c: case 0x213d: return 0;
      case 0x213e: return 0x01;
      case 0x213f: return 0x03;
      case 0x2180: { const v = this.wram[this.wmaddr]; this.wmaddr = (this.wmaddr + 1) & 0x1ffff; return v; }
      case 0x4016: case 0x4017: return 0;
      case 0x4210: { const v = (this.nmiFlag ? 0x80 : 0) | 0x02; this.nmiFlag = false; return v; }
      case 0x4211: { const v = this.irqFlag ? 0x80 : 0; this.irqFlag = false; this.cpu.irqLine = false; return v; }
      case 0x4212: {
        let v = 0;
        if (this.line >= VBLANK_LINE) v |= 0x80;
        if (this.lineCycle >= CYCLES_PER_LINE - 24) v |= 0x40;
        if (this.line >= VBLANK_LINE && this.line <= VBLANK_LINE + 2) v |= 0x01;
        return v;
      }
      case 0x4213: return 0;
      case 0x4214: return this.rddiv & 0xff;
      case 0x4215: return this.rddiv >> 8;
      case 0x4216: return this.rdmpy & 0xff;
      case 0x4217: return this.rdmpy >> 8;
      case 0x4218: return this.joy1 & 0xff;
      case 0x4219: return this.joy1 >> 8;
      case 0x421a: case 0x421b: case 0x421c: case 0x421d: case 0x421e: case 0x421f: return 0;
    }
    if (off >= 0x4300 && off < 0x4380) return this.dma[off - 0x4300];
    return this.openBus;
  }

  vramPrefetchAdvance(): void {
    const m = this.vramAddrMapped() & 0x7fff;
    this.vreadLatch = this.vram[m * 2] | (this.vram[m * 2 + 1] << 8);
    this.vaddr = (this.vaddr + this.vramStep()) & 0xffff;
  }

  writeIO(off: number, v: number): void {
    if (off >= 0x2140 && off < 0x2180) { this.apuWrite(off & 3, v); return; }
    if (off >= 0x2100 && off < 0x2200) this.ppuRegs[off - 0x2100] = v;
    switch (off) {
      case 0x2102: this.oamaddr = (v | ((this.ppuRegs[3] & 1) << 8)) << 1; return;
      case 0x2103: this.oamaddr = (this.ppuRegs[2] | ((v & 1) << 8)) << 1; return;
      case 0x2104: {
        const a = this.oamaddr % 0x220;
        if (a >= 0x200) this.oam[a] = v;
        else if ((a & 1) === 0) this.oamLatch = v;
        else { this.oam[a - 1] = this.oamLatch; this.oam[a] = v; }
        this.oamaddr = (this.oamaddr + 1) % 0x220;
        return;
      }
      case 0x2115: this.vmain = v; return;
      case 0x2116: this.vaddr = (this.vaddr & 0xff00) | v; this.vramPrefetchLoad(); return;
      case 0x2117: this.vaddr = (this.vaddr & 0x00ff) | (v << 8); this.vramPrefetchLoad(); return;
      case 0x2118: {
        const m = this.vramAddrMapped() & 0x7fff;
        this.vram[m * 2] = v;
        if (!(this.vmain & 0x80)) this.vaddr = (this.vaddr + this.vramStep()) & 0xffff;
        return;
      }
      case 0x2119: {
        const m = this.vramAddrMapped() & 0x7fff;
        this.vram[m * 2 + 1] = v;
        if (this.vmain & 0x80) this.vaddr = (this.vaddr + this.vramStep()) & 0xffff;
        return;
      }
      case 0x211b: this.m7a = ((v << 8) | this.m7latch) & 0xffff; this.m7a = (this.m7a << 16) >> 16; this.m7latch = v; return;
      case 0x211c: this.m7b = v; this.m7latch = v; return;
      case 0x2121: this.cgaddr = v; this.cgLatch = -1; this.cgReadHigh = false; return;
      case 0x2122:
        if (this.cgLatch < 0) this.cgLatch = v;
        else {
          this.cgram[this.cgaddr * 2] = this.cgLatch;
          this.cgram[this.cgaddr * 2 + 1] = v & 0x7f;
          this.cgaddr = (this.cgaddr + 1) & 0xff;
          this.cgLatch = -1;
        }
        return;
      case 0x2180: this.wram[this.wmaddr] = v; if (this.hook?.onWramWrite) this.hook.onWramWrite(this.wmaddr, v); this.wmaddr = (this.wmaddr + 1) & 0x1ffff; return;
      case 0x2181: this.wmaddr = (this.wmaddr & 0x1ff00) | v; return;
      case 0x2182: this.wmaddr = (this.wmaddr & 0x100ff) | (v << 8); return;
      case 0x2183: this.wmaddr = (this.wmaddr & 0x0ffff) | ((v & 1) << 16); return;
      case 0x4200: this.nmitimen = v; if (!(v & 0x30)) { this.cpu.irqLine = false; this.irqFlag = false; } return;
      case 0x4202: this.wrmpya = v; return;
      case 0x4203: this.rdmpy = this.wrmpya * v; this.rddiv = v; return;
      case 0x4204: this.wrdiv = (this.wrdiv & 0xff00) | v; return;
      case 0x4205: this.wrdiv = (this.wrdiv & 0x00ff) | (v << 8); return;
      case 0x4206:
        if (v === 0) { this.rddiv = 0xffff; this.rdmpy = this.wrdiv; }
        else { this.rddiv = Math.floor(this.wrdiv / v); this.rdmpy = this.wrdiv % v; }
        return;
      case 0x4207: this.htime = (this.htime & 0x100) | v; return;
      case 0x4208: this.htime = (this.htime & 0xff) | ((v & 1) << 8); return;
      case 0x4209: this.vtime = (this.vtime & 0x100) | v; return;
      case 0x420a: this.vtime = (this.vtime & 0xff) | ((v & 1) << 8); return;
      case 0x420b: this.runDma(v); return;
    }
    if (off >= 0x4300 && off < 0x4380) this.dma[off - 0x4300] = v;
  }

  vramPrefetchLoad(): void {
    const m = this.vramAddrMapped() & 0x7fff;
    this.vreadLatch = this.vram[m * 2] | (this.vram[m * 2 + 1] << 8);
  }

  runDma(mask: number): void {
    for (let ch = 0; ch < 8; ch++) {
      if (!(mask & (1 << ch))) continue;
      const base = ch * 16;
      const ctrl = this.dma[base];
      const bReg = this.dma[base + 1];
      let aAddr = this.dma[base + 2] | (this.dma[base + 3] << 8);
      const aBank = this.dma[base + 4];
      let count = this.dma[base + 5] | (this.dma[base + 6] << 8);
      if (count === 0) count = 0x10000;
      const toA = (ctrl & 0x80) !== 0;
      const fixed = (ctrl & 0x08) !== 0;
      const dec = (ctrl & 0x10) !== 0;
      const mode = ctrl & 7;
      const pattern = DMA_PATTERNS[mode];
      let i = 0;
      while (count > 0) {
        const b = 0x2100 | ((bReg + pattern[i & 3]) & 0xff);
        const full = (aBank << 16) | aAddr;
        if (toA) this.write(full, this.readIO(b));
        else this.writeIO(b, this.read(full));
        this.cpu.cycles += 1;
        if (!fixed) aAddr = (aAddr + (dec ? -1 : 1)) & 0xffff;
        i++;
        count--;
      }
      this.dma[base + 2] = aAddr & 0xff;
      this.dma[base + 3] = aAddr >> 8;
      this.dma[base + 5] = 0;
      this.dma[base + 6] = 0;
    }
  }

  // --------------- APU high-level fake ---------------
  // Implements the IPL boot-ROM transfer handshake (echo of port 0) and answers
  // "ready" when the game asks the sound engine to return to its loader.
  apuWrite(port: number, v: number): void {
    this.apuIn[port] = v;
    this.apuSpin = 0;
    if (port === 0) this.apuOut[0] = v;
  }
  apuRead(port: number): number {
    // Detect busy-waiting on the ports; after some spinning answer with the
    // IPL loader signature, which is what the game waits for in all cases
    // that matter for level loading.
    const key = (this.cpu.pbr << 16) | this.cpu.pc;
    if (key === this.apuLastReadAddr) {
      if (++this.apuSpin > 64) {
        this.apuOut[0] = 0xaa;
        this.apuOut[1] = 0xbb;
        this.apuSpin = 0;
      }
    } else {
      this.apuLastReadAddr = key;
      this.apuSpin = 0;
    }
    return this.apuOut[port];
  }

  saveState(): SnesState {
    const st: SnesState = {};
    const self = this as unknown as Record<string, unknown>;
    for (const k of STATE_ARRAYS) st[k] = (self[k] as Uint8Array).slice();
    for (const k of STATE_SCALARS) st[k] = self[k];
    const cpu = this.cpu as unknown as Record<string, unknown>;
    for (const k of CPU_SCALARS) st['cpu.' + k] = cpu[k];
    return st;
  }
  loadState(st: SnesState): void {
    const self = this as unknown as Record<string, unknown>;
    for (const k of STATE_ARRAYS) (self[k] as Uint8Array).set(st[k] as Uint8Array);
    for (const k of STATE_SCALARS) self[k] = st[k];
    const cpu = this.cpu as unknown as Record<string, unknown>;
    for (const k of CPU_SCALARS) cpu[k] = st['cpu.' + k];
  }

  // --------------- timing ---------------
  reset(): void {
    this.cpu.reset();
  }

  runFrame(maxSteps = 2_000_000): void {
    const cpu = this.cpu;
    let steps = 0;
    for (this.line = 0; this.line < LINES_PER_FRAME; this.line++) {
      if (this.line === VBLANK_LINE) {
        this.nmiFlag = true;
        this.autoJoypad();
        if (this.nmitimen & 0x80) cpu.nmiPending = true;
      }
      if (this.line === 0) this.nmiFlag = false;
      if ((this.nmitimen & 0x20) && this.line === this.vtime) {
        this.irqFlag = true;
        cpu.irqLine = true;
      }
      const target = cpu.cycles + CYCLES_PER_LINE;
      const start = cpu.cycles;
      while (cpu.cycles < target) {
        this.lineCycle = cpu.cycles - start;
        cpu.step();
        if (++steps > maxSteps) throw new Error('frame step limit exceeded');
      }
    }
    this.frame++;
  }

  autoJoypad(): void {
    // joy1 already holds the "pressed" state for auto-read
  }
}

const DMA_PATTERNS: number[][] = [
  [0, 0, 0, 0],
  [0, 1, 0, 1],
  [0, 0, 0, 0],
  [0, 0, 1, 1],
  [0, 1, 2, 3],
  [0, 1, 0, 1],
  [0, 0, 0, 0],
  [0, 0, 1, 1],
];
