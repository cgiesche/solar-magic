// Minimal SNES system model: LoROM mapping, WRAM, SRAM, PPU memories (VRAM/CGRAM/OAM),
// DMA, math registers, simple timing (NMI / V-IRQ) and a high-level fake of the APU
// upload protocol (or, with an Apu attached, the real sound unit). Nothing is rendered by this module; the editor renders from
// VRAM/CGRAM/WRAM contents itself.

import { CPU, type Bus } from './cpu.ts';
import type { PPU, PpuState } from './ppu.ts';
import { APU_CLOCKS_PER_FRAME, type Apu } from './apu.ts';
import type { RomReads } from './romdeps.ts';

// time is counted in master cycles (21.477 MHz, Cpu.cycles): a bus access takes 6, 8 or 12, an internal cycle 6
export const MASTER_PER_LINE = 1364;
export const LINES_PER_FRAME = 262;
export const VBLANK_LINE = 225;
const REFRESH_AT = 538, REFRESH = 40; // DRAM refresh: the CPU stands still for 40 master cycles of each line
const HBLANK_AT = 274 * 4; // $4212 bit 6 from dot 274
const APU_RATIO = APU_CLOCKS_PER_FRAME / (MASTER_PER_LINE * LINES_PER_FRAME); // SPC clocks per master cycle

export interface MemHook {
  // called for every read of a ROM byte (after mapping): pc offset in rom
  onRomRead?(offset: number): void;
  onWramWrite?(addr: number, value: number): void;
  onWramRead?(addr: number): void; // analysis tools and test play's slot meter (slotwatch.ts)
  onOverlayRead?(offset: number): void;
  onVramWrite?(addr: number): void; // a VRAM byte written (through its port, a DMA's too)
  onCgramWrite?(addr: number): void; // a CGRAM byte written
  onVideoRead?(): void; // VRAM, CGRAM or OAM read through its port
  onVramRead?(addr: number): void; // a VRAM byte read into the port's latch as its address is set
  onOamWrite?(addr: number): void; // a byte of OAM written through its port (a low table's byte lands with its pair's second)
}

// several hooks as one, each called in turn
export function joinHooks(...hooks: MemHook[]): MemHook {
  const all = <K extends keyof MemHook>(k: K) => {
    const fs = hooks.map((h) => h[k]?.bind(h)).filter((f) => !!f) as ((...a: number[]) => void)[];
    return fs.length ? (...a: number[]) => { for (const f of fs) f(...a); } : undefined;
  };
  return { onRomRead: all('onRomRead'), onWramWrite: all('onWramWrite'), onWramRead: all('onWramRead'), onOverlayRead: all('onOverlayRead'),
    onVramWrite: all('onVramWrite'), onCgramWrite: all('onCgramWrite'), onVideoRead: all('onVideoRead'), onVramRead: all('onVramRead'), onOamWrite: all('onOamWrite') };
}

export interface SnesState {
  [k: string]: unknown;
}

const STATE_ARRAYS = ['wram', 'sram', 'vram', 'cgram', 'oam', 'ppuRegs', 'dma', 'apuIn', 'apuOut'] as const;
const STATE_SCALARS = ['vmain', 'vaddr', 'vreadLatch', 'cgaddr', 'cgLatch', 'cgReadHigh', 'oamaddr', 'oamLatch', 'm7a', 'm7b',
  'm7latch', 'wmaddr', 'nmitimen', 'wrmpya', 'wrdiv', 'rddiv', 'rdmpy', 'htime', 'vtime', 'nmiFlag', 'irqFlag', 'joy1',
  'apuLastReadAddr', 'apuSpin', 'apuFrameStart', 'frame', 'line', 'lineCycle', 'lineAt', 'openBus', 'hdmaen', 'hdmaDo', 'hdmaOn',
  'fixedColor', 'cgLatchTaint', 'busyLines', 'sinceNmi', 'waited', 'memsel'] as const;
const CPU_SCALARS = ['a', 'x', 'y', 's', 'd', 'dbr', 'pbr', 'pc', 'p', 'e', 'cycles', 'stopped', 'waiting', 'nmiPending', 'irqLine',
  'lastOp', 'lastOpPc'] as const;

// the console's state without its large memories (WRAM, SRAM, VRAM, CGRAM), the sound unit and the PPU's renderer: what
// a frame of a level load is compared and replayed by (loadframes.ts)
export interface SmallState { mem: Uint8Array; vals: unknown[] }
const SMALL_ARRAYS = ['oam', 'ppuRegs', 'dma', 'apuIn', 'apuOut'] as const;

export class Snes implements Bus {
  private romData!: Uint8Array;
  private romMask = 0; // size - 1 for power-of-two sizes (mirroring by masking), else 0
  get rom(): Uint8Array { return this.romData; }
  set rom(r: Uint8Array) {
    this.romData = r;
    this.romMask = r.length & (r.length - 1) ? 0 : r.length - 1;
  }
  wram = new Uint8Array(0x20000);
  sram = new Uint8Array(0x8000);
  vram = new Uint8Array(0x10000);
  cgram = new Uint8Array(0x200);
  oam = new Uint8Array(0x220);
  cpu: CPU;
  hook: MemHook | null = null;
  romReads: RomReads | null = null; // records the ROM reads (see romdeps.ts)
  romSkip = new Set<number>(); // ROM offsets whose reads aren't recorded
  sramWrites = 0; // SRAM bytes written since power-on, counted (not part of the state: loadframes.ts)
  romSkipMask: Uint8Array | null = null; // the same per byte (1 = not recorded), e.g. GFX file data
  romMasked: RomReads | null = null; // when set: records the reads romSkipMask leaves out
  // data provenance tracking (ROM offset each WRAM/CGRAM byte was copied from, see trackSources)
  taintOn = false;
  taint = new Int32Array(0x20000).fill(-1);
  cgTaint = new Int32Array(0x200).fill(-1);
  private inDma = false; // the bus access is a DMA transfer's
  private wtag = -1; // tracking sources: the tag of the byte written now
  // tracking sources: where the byte being written was loaded from (a ROM offset, -1 none) – for a hook that keeps
  // the sources of what it sees written (VRAM: menutext.ts)
  get writeSource(): number { return this.wtag; }
  // 64 KB overlay visible at $FE8000-$FEFFFF / $FF8000-$FFFFFF (editor scratch data)
  overlay: Uint8Array | null = null;

  // PPU state
  ppu: PPU | null = null;
  fixedColor = 0;
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
  hdmaen = 0; // $420C
  hdmaDo = 0; // per channel: transfer on the next line
  hdmaOn = 0; // per channel: table not yet terminated this frame
  // $420D: fast ROM access in banks $80+ (bit 0; the CPU times it)
  get memsel(): number { return this.cpu.fastRom ? 1 : 0; }
  set memsel(v: number) { this.cpu.fastRom = (v & 1) !== 0; }
  joy1 = 0;

  // APU
  apuIn = new Uint8Array(4); // values CPU writes
  apuOut = new Uint8Array([0xaa, 0xbb, 0, 0]); // values CPU reads
  apuLastReadAddr = -1;
  apuSpin = 0;
  // the real sound unit instead of the fake; its time runs with the CPU's cycles
  apu: Apu | null = null;
  apuFrameStart = 0; // cpu.cycles when the APU's current frame began
  audio: Int16Array | null = null; // with an Apu: the samples of the latest frame (stereo, 32 kHz)

  // timing
  frame = 0;
  line = 0;
  lineCycle = 0; // master cycles since the current line began
  lineAt = 0; // Cpu.cycles when the next line begins (lines run at fixed times; a DMA takes the lines it lasts)
  openBus = 0;

  constructor(rom: Uint8Array) {
    this.rom = rom;
    this.cpu = new CPU(this);
  }

  romOffset(addr: number): number {
    const o = (((addr >> 16) & 0x7f) << 15) | (addr & 0x7fff);
    return this.romMask ? o & this.romMask : o % this.romData.length;
  }

  read(addr: number): number {
    const bank = addr >> 16;
    const off = addr & 0xffff;
    let v: number;
    // ROM first: every opcode fetch goes there
    if (off >= 0x8000 && (bank & 0x7e) !== 0x7e) {
      const ro = this.romOffset(addr);
      if (this.romReads !== null && this.romReads.pages[ro >> 8] === 0) this.recordRead(ro);
      if (this.hook !== null || this.taintOn) return this.readRomSlow(ro);
      v = this.romData[ro];
    } else if ((bank & 0xfe) === 0x7e) {
      v = this.wram[addr - 0x7e0000];
      if (this.taintOn) this.cpu.noteRead(this.taint[addr - 0x7e0000]);
      if (this.hook?.onWramRead) this.hook.onWramRead(addr - 0x7e0000);
    } else if (off >= 0x8000) { // banks $FE/$FF
      if (this.overlay) {
        const oo = ((bank & 1) << 15) | (off & 0x7fff);
        if (this.hook?.onOverlayRead) this.hook.onOverlayRead(oo);
        if (this.taintOn) this.cpu.noteRead(-1);
        this.openBus = this.overlay[oo];
        return this.overlay[oo];
      }
      const ro = this.romOffset(addr);
      if (this.romReads !== null && this.romReads.pages[ro >> 8] === 0) this.recordRead(ro);
      if (this.hook !== null || this.taintOn) return this.readRomSlow(ro);
      v = this.romData[ro];
    } else {
      const b = bank & 0x7f;
      if (b < 0x40 && off < 0x2000) {
        v = this.wram[off];
        if (this.taintOn) this.cpu.noteRead(this.taint[off]);
        if (this.hook?.onWramRead) this.hook.onWramRead(off);
      } else {
        // the port to WRAM carries the byte's source; SRAM and the other registers none
        if (this.taintOn) this.cpu.noteRead(b < 0x40 && off === 0x2180 ? this.taint[this.wmaddr] : -1);
        if (b >= 0x70 && b < 0x7e) v = this.sram[off & 0x7fff];
        else if (b < 0x40) v = this.readIO(off);
        else v = this.openBus;
      }
    }
    this.openBus = v;
    return v;
  }

  // a byte as the CPU would read it from ROM or WRAM, without a bus access (no hooks, no open bus); -1 elsewhere
  peek(addr: number): number {
    const bank = addr >> 16, off = addr & 0xffff;
    if (off >= 0x8000 && (bank & 0x7e) !== 0x7e) {
      if ((bank & 0xfe) === 0xfe && this.overlay) return this.overlay[((bank & 1) << 15) | (off & 0x7fff)];
      return this.romData[this.romOffset(addr)];
    }
    if ((bank & 0xfe) === 0x7e) return this.wram[addr - 0x7e0000];
    return off < 0x2000 && (bank & 0x7f) < 0x40 ? this.wram[off] : -1;
  }

  // first read of a ROM page (or a read in a byte page) while reads are recorded
  private recordRead(ro: number): void {
    if (this.romSkip.has(ro)) return;
    if (this.romSkipMask !== null && this.romSkipMask[ro] === 1) { this.romMasked?.read(ro); return; }
    const r = this.romReads!;
    if (r.bytePages[ro >> 8]) r.bytes.add(ro); else r.pages[ro >> 8] = 1;
  }

  // ROM read with hooks or data provenance tracking on
  private readRomSlow(ro: number): number {
    if (this.hook?.onRomRead) this.hook.onRomRead(ro);
    const v = this.romData[ro];
    if (this.taintOn) this.cpu.noteRead(ro);
    this.openBus = v;
    return v;
  }

  write(addr: number, v: number): void {
    // every write takes its tag, also one to a place without tags: a 16-bit store's next byte is the high byte
    if (this.taintOn) this.wtag = this.inDma ? this.cpu.readTag() : this.cpu.writeTag();
    const bank = addr >> 16;
    const off = addr & 0xffff;
    if (bank === 0x7e || bank === 0x7f) {
      const a = addr - 0x7e0000;
      this.wram[a] = v;
      if (this.taintOn) this.taint[a] = this.wtag;
      if (this.hook?.onWramWrite) this.hook.onWramWrite(a, v);
      return;
    }
    const b = bank & 0x7f;
    if (off >= 0x8000) return; // ROM
    if (b >= 0x70 && b < 0x7e) {
      this.sram[off & 0x7fff] = v;
      this.sramWrites++;
      return;
    }
    if (b < 0x40) {
      if (off < 0x2000) {
        this.wram[off] = v;
        if (this.taintOn) this.taint[off] = this.wtag;
        if (this.hook?.onWramWrite) this.hook.onWramWrite(off, v);
      } else this.writeIO(off, v);
    }
  }

  // ---------------- I/O ----------------
  cgLatchTaint = -1;
  // Source tracking: every byte of WRAM, CGRAM and the CPU's registers carries where it was loaded from
  // (a ROM offset, -1 none). A byte read takes its place's tag (the CPU keeps it while the value is
  // moved, see Cpu.execTracked), a byte written takes the tag of what is written (DMA: the byte read).
  trackSources(on: boolean): void {
    this.taintOn = on;
    this.cpu.track = on;
    if (!on) return;
    this.taint.fill(-1);
    this.cgTaint.fill(-1);
    this.cgLatchTaint = -1;
    this.inDma = false;
    this.cpu.resetTags();
  }

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
      case 0x2138: { this.hook?.onVideoRead?.(); const v = this.oam[this.oamaddr % 0x220]; this.oamaddr = (this.oamaddr + 1) % 0x220; return v; }
      case 0x2139: {
        this.hook?.onVideoRead?.();
        const v = this.vreadLatch & 0xff;
        if (!(this.vmain & 0x80)) this.vramPrefetchAdvance();
        return v;
      }
      case 0x213a: {
        this.hook?.onVideoRead?.();
        const v = (this.vreadLatch >> 8) & 0xff;
        if (this.vmain & 0x80) this.vramPrefetchAdvance();
        return v;
      }
      case 0x213b: {
        this.hook?.onVideoRead?.();
        let v: number;
        if (!this.cgReadHigh) v = this.cgram[(this.cgaddr * 2) & 0x1ff];
        else { v = this.cgram[(this.cgaddr * 2 + 1) & 0x1ff]; this.cgaddr = (this.cgaddr + 1) & 0xff; }
        this.cgReadHigh = !this.cgReadHigh;
        return v;
      }
      case 0x213c: case 0x213d: return 0;
      case 0x213e: return 0x01;
      case 0x213f: return 0x03;
      case 0x2180: { this.hook?.onWramRead?.(this.wmaddr); const v = this.wram[this.wmaddr]; this.wmaddr = (this.wmaddr + 1) & 0x1ffff; return v; }
      case 0x4016: case 0x4017: return 0;
      case 0x4210: { const v = (this.nmiFlag ? 0x80 : 0) | 0x02; this.nmiFlag = false; return v; }
      case 0x4211: { const v = this.irqFlag ? 0x80 : 0; this.irqFlag = false; this.cpu.irqLine = false; return v; }
      case 0x4212: {
        let v = 0;
        if (this.line >= VBLANK_LINE) v |= 0x80;
        if (this.lineCycle >= HBLANK_AT) v |= 0x40;
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
    if (off >= 0x2100 && off < 0x2200) {
      this.ppuRegs[off - 0x2100] = v;
      if (this.ppu && off >= 0x210d && off <= 0x2114) this.ppu.write(off - 0x2100, v);
      if (off === 0x2132) {
        const c = v & 0x1f;
        if (v & 0x20) this.fixedColor = (this.fixedColor & ~0x1f) | c;
        if (v & 0x40) this.fixedColor = (this.fixedColor & ~0x3e0) | (c << 5);
        if (v & 0x80) this.fixedColor = (this.fixedColor & ~0x7c00) | (c << 10);
      }
    }
    switch (off) {
      case 0x2102: this.oamaddr = (v | ((this.ppuRegs[3] & 1) << 8)) << 1; return;
      case 0x2103: this.oamaddr = (this.ppuRegs[2] | ((v & 1) << 8)) << 1; return;
      case 0x2104: {
        const a = this.oamaddr % 0x220;
        this.hook?.onOamWrite?.(a);
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
        this.hook?.onVramWrite?.(m * 2);
        if (!(this.vmain & 0x80)) this.vaddr = (this.vaddr + this.vramStep()) & 0xffff;
        return;
      }
      case 0x2119: {
        const m = this.vramAddrMapped() & 0x7fff;
        this.vram[m * 2 + 1] = v;
        this.hook?.onVramWrite?.(m * 2 + 1);
        if (this.vmain & 0x80) this.vaddr = (this.vaddr + this.vramStep()) & 0xffff;
        return;
      }
      case 0x211b: this.m7a = ((v << 8) | this.m7latch) & 0xffff; this.m7a = (this.m7a << 16) >> 16; this.m7latch = v; return;
      case 0x211c: this.m7b = v; this.m7latch = v; return;
      case 0x2121: this.cgaddr = v; this.cgLatch = -1; this.cgReadHigh = false; return;
      case 0x2122:
        if (this.cgLatch < 0) { this.cgLatch = v; if (this.taintOn) this.cgLatchTaint = this.wtag; }
        else {
          if (this.taintOn) { this.cgTaint[this.cgaddr * 2] = this.cgLatchTaint; this.cgTaint[this.cgaddr * 2 + 1] = this.wtag; }
          this.cgram[this.cgaddr * 2] = this.cgLatch;
          this.cgram[this.cgaddr * 2 + 1] = v & 0x7f;
          this.hook?.onCgramWrite?.(this.cgaddr * 2);
          this.hook?.onCgramWrite?.(this.cgaddr * 2 + 1);
          this.cgaddr = (this.cgaddr + 1) & 0xff;
          this.cgLatch = -1;
        }
        return;
      case 0x2180: this.wram[this.wmaddr] = v; if (this.taintOn) this.taint[this.wmaddr] = this.wtag; if (this.hook?.onWramWrite) this.hook.onWramWrite(this.wmaddr, v); this.wmaddr = (this.wmaddr + 1) & 0x1ffff; return;
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
      case 0x420c: this.hdmaen = v; return;
      case 0x420d: this.memsel = v & 1; return;
    }
    if (off >= 0x4300 && off < 0x4380) this.dma[off - 0x4300] = v;
  }

  vramPrefetchLoad(): void {
    const m = this.vramAddrMapped() & 0x7fff;
    if (this.hook?.onVramRead) { this.hook.onVramRead(m * 2); this.hook.onVramRead(m * 2 + 1); }
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
      this.inDma = true;
      while (count > 0) {
        const b = 0x2100 | ((bReg + pattern[i & 3]) & 0xff);
        const full = (aBank << 16) | aAddr;
        if (toA) {
          const v = this.readIO(b);
          if (this.taintOn) this.cpu.noteRead(-1);
          this.write(full, v);
        } else {
          const v = this.read(full);
          if (this.taintOn) this.wtag = this.cpu.readTag();
          this.writeIO(b, v);
        }
        this.cpu.cycles += 8; // a DMA byte: 8 master cycles
        if (!fixed) aAddr = (aAddr + (dec ? -1 : 1)) & 0xffff;
        i++;
        count--;
      }
      this.dma[base + 2] = aAddr & 0xff;
      this.dma[base + 3] = aAddr >> 8;
      this.dma[base + 5] = 0;
      this.dma[base + 6] = 0;
      this.inDma = false;
    }
  }

  // HDMA (only while a PPU renders; the level loader doesn't need it). Uses the real channel registers:
  // $43x8/9 table address, $43xA line counter, $43x5/6 (+ bank $43x7) indirect address.
  hdmaInit(): void {
    this.hdmaOn = this.hdmaen;
    this.hdmaDo = 0;
    for (let ch = 0; ch < 8; ch++) {
      if (!(this.hdmaen & (1 << ch))) continue;
      const d = this.dma, b = ch * 16;
      d[b + 8] = d[b + 2]; d[b + 9] = d[b + 3];
      this.hdmaNextEntry(ch);
    }
  }

  private hdmaTableByte(ch: number): number {
    const d = this.dma, b = ch * 16;
    const a = d[b + 8] | (d[b + 9] << 8);
    const v = this.read((d[b + 4] << 16) | a);
    const n = (a + 1) & 0xffff;
    d[b + 8] = n & 0xff; d[b + 9] = n >> 8;
    return v;
  }

  private hdmaNextEntry(ch: number): void {
    const d = this.dma, b = ch * 16, bit = 1 << ch;
    const c = this.hdmaTableByte(ch);
    d[b + 10] = c;
    if (!c) { this.hdmaOn &= ~bit; return; }
    if (d[b] & 0x40) { d[b + 5] = this.hdmaTableByte(ch); d[b + 6] = this.hdmaTableByte(ch); }
    this.hdmaDo |= bit;
  }

  hdmaLine(): void {
    for (let ch = 0; ch < 8; ch++) {
      const bit = 1 << ch;
      if (!(this.hdmaOn & bit)) continue;
      const d = this.dma, b = ch * 16, ctrl = d[b];
      if (this.hdmaDo & bit) {
        const pattern = DMA_PATTERNS[ctrl & 7];
        const n = HDMA_LENGTHS[ctrl & 7];
        for (let i = 0; i < n; i++) {
          let v: number;
          if (ctrl & 0x40) {
            const a = d[b + 5] | (d[b + 6] << 8);
            v = this.read((d[b + 7] << 16) | a);
            const na = (a + 1) & 0xffff;
            d[b + 5] = na & 0xff; d[b + 6] = na >> 8;
          } else v = this.hdmaTableByte(ch);
          if (this.taintOn) this.wtag = this.cpu.readTag();
          this.writeIO(0x2100 | ((d[b + 1] + pattern[i]) & 0xff), v);
        }
      }
      const c = (d[b + 10] - 1) & 0xff;
      d[b + 10] = c;
      if (c & 0x80) this.hdmaDo |= bit; else this.hdmaDo &= ~bit;
      if (!(c & 0x7f)) this.hdmaNextEntry(ch);
    }
  }

  // --------------- APU high-level fake ---------------
  // Implements the IPL boot-ROM transfer handshake (echo of port 0) and answers
  // "ready" when the game asks the sound engine to return to its loader.
  apuWrite(port: number, v: number): void {
    if (this.apu) { this.apu.write(this.apuTime(), port, v); return; }
    this.apuIn[port] = v;
    this.apuSpin = 0;
    if (port === 0) this.apuOut[0] = v;
  }
  apuRead(port: number): number {
    if (this.apu) return this.apu.read(this.apuTime(), port);
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

  // SPC clocks since the APU's frame began
  private apuTime(): number {
    return Math.floor((this.cpu.cycles - this.apuFrameStart) * APU_RATIO);
  }

  saveState(): SnesState {
    const st: SnesState = {};
    const self = this as unknown as Record<string, unknown>;
    for (const k of STATE_ARRAYS) st[k] = (self[k] as Uint8Array).slice();
    for (const k of STATE_SCALARS) st[k] = self[k];
    const cpu = this.cpu as unknown as Record<string, unknown>;
    for (const k of CPU_SCALARS) st['cpu.' + k] = cpu[k];
    if (this.apu) st.apu = this.apu.save();
    if (this.ppu) st.ppu = this.ppu.saveState();
    return st;
  }
  loadState(st: SnesState): void {
    const self = this as unknown as Record<string, unknown>;
    for (const k of STATE_ARRAYS) (self[k] as Uint8Array).set(st[k] as Uint8Array);
    for (const k of STATE_SCALARS) self[k] = st[k];
    const cpu = this.cpu as unknown as Record<string, unknown>;
    for (const k of CPU_SCALARS) cpu[k] = st['cpu.' + k];
    if (this.ppu && st.ppu) this.ppu.loadState(st.ppu as PpuState);
    if (this.apu) {
      if (st.apu) this.apu.load(st.apu as Uint8Array);
      else this.apu.reset();
    }
  }

  saveSmall(): SmallState {
    const self = this as unknown as Record<string, Uint8Array>, cpu = this.cpu as unknown as Record<string, unknown>;
    let n = 0;
    for (const k of SMALL_ARRAYS) n += self[k].length;
    const mem = new Uint8Array(n), vals: unknown[] = [];
    n = 0;
    for (const k of SMALL_ARRAYS) { mem.set(self[k], n); n += self[k].length; }
    for (const k of STATE_SCALARS) vals.push(self[k]);
    for (const k of CPU_SCALARS) vals.push(cpu[k]);
    return { mem, vals };
  }
  loadSmall(st: SmallState): void {
    const self = this as unknown as Record<string, unknown>, cpu = this.cpu as unknown as Record<string, unknown>;
    let n = 0;
    for (const k of SMALL_ARRAYS) { const a = self[k] as Uint8Array; a.set(st.mem.subarray(n, n + a.length)); n += a.length; }
    let i = 0;
    for (const k of STATE_SCALARS) self[k] = st.vals[i++];
    for (const k of CPU_SCALARS) cpu[k] = st.vals[i++];
  }
  // the console is in this small state
  sameSmall(st: SmallState): boolean {
    const self = this as unknown as Record<string, unknown>, cpu = this.cpu as unknown as Record<string, unknown>;
    let i = 0;
    for (const k of STATE_SCALARS) if (self[k] !== st.vals[i++]) return false;
    for (const k of CPU_SCALARS) if (cpu[k] !== st.vals[i++]) return false;
    let n = 0;
    for (const k of SMALL_ARRAYS) {
      const a = self[k] as Uint8Array;
      for (let j = 0; j < a.length; j++) if (a[j] !== st.mem[n + j]) return false;
      n += a.length;
    }
    return true;
  }

  // --------------- timing ---------------
  reset(): void {
    this.cpu.reset();
  }

  // power on: memory as a fresh console's (cleared, like a new emulator), then reset
  powerOn(): void {
    for (const m of [this.wram, this.sram, this.vram, this.cgram, this.oam]) m.fill(0);
    this.apu?.reset();
    this.apuFrameStart = this.cpu.cycles;
    this.reset();
  }

  // CPU load: lines from an NMI until the CPU waits for the next one (a wait loop, see Cpu.idle),
  // for the frame that ended with the latest NMI; -1: it never waited (a lag frame)
  busyLines = 0;
  sinceNmi = 0;
  waited = -1;

  runFrame(maxSteps = 2_000_000): void {
    const cpu = this.cpu;
    let steps = 0;
    // a state from before lines had fixed times, or a CPU run without frames: the lines start now
    if (this.lineAt === undefined || Math.abs(cpu.cycles - this.lineAt) >= MASTER_PER_LINE * LINES_PER_FRAME) this.lineAt = cpu.cycles;
    for (this.line = 0; this.line < LINES_PER_FRAME; this.line++, this.sinceNmi++) {
      if (this.line === VBLANK_LINE) {
        this.busyLines = this.waited;
        this.waited = -1;
        this.sinceNmi = 0;
        this.nmiFlag = true;
        this.autoJoypad();
        if (this.nmitimen & 0x80) cpu.nmiPending = true;
      }
      if (this.line === 0) this.nmiFlag = false;
      if ((this.nmitimen & 0x20) && this.line === this.vtime) {
        this.irqFlag = true;
        cpu.irqLine = true;
      }
      if (this.ppu && this.line < 224) {
        if (this.line === 0) this.hdmaInit();
        this.hdmaLine();
        this.ppu.renderLine(this.line);
      }
      const start = this.lineAt, target = start + MASTER_PER_LINE;
      this.lineAt = target;
      let refresh = true;
      while (cpu.cycles < target) {
        this.lineCycle = cpu.cycles - start;
        if (refresh && this.lineCycle >= REFRESH_AT) { cpu.cycles += REFRESH; refresh = false; continue; }
        cpu.step();
        if (++steps > maxSteps) throw new Error('frame step limit exceeded');
        // wait loop: skip the rest of the line (interrupts are only raised at line starts)
        if (cpu.idle) {
          cpu.idle = false;
          if (this.waited < 0) this.waited = this.sinceNmi;
          if (!cpu.nmiPending && !(cpu.irqLine && !(cpu.p & 0x04))) { cpu.cycles = target; refresh = false; }
        }
      }
      // refresh: in the line (above), skipped with a wait loop's rest of the line, or here: a DMA ran through
      // the line and the refresh paused it
      if (refresh) cpu.cycles += REFRESH;
    }
    if (this.apu) {
      const t = this.apuTime();
      this.apuFrameStart = cpu.cycles;
      this.audio = this.apu.endFrame(t);
    }
    this.frame++;
  }

  autoJoypad(): void {
    // joy1 already holds the "pressed" state for auto-read
  }
}

const HDMA_LENGTHS = [1, 2, 2, 4, 4, 4, 2, 4];
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
