// WDC 65C816 interpreter. Accuracy target: correct instruction semantics,
// approximate cycle counts (one unit per bus access plus internal ops).

export interface Bus {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

const FLAG_C = 0x01;
const FLAG_Z = 0x02;
const FLAG_I = 0x04;
const FLAG_D = 0x08;
const FLAG_X = 0x10;
const FLAG_M = 0x20;
const FLAG_V = 0x40;
const FLAG_N = 0x80;

// master cycles of an internal cycle (and of an access to most I/O registers)
const IO = 6;
// source tracking: what an instruction's writes carry (W_*) and what it does to the registers' tags (R_*)
const W_NONE = 0, W_REG = 1, W_PUSH = 2, W_COPY = 3;
const R_OTHER = 0, R_LDA = 1, R_LDX = 2, R_LDY = 3, R_TAX = 4, R_TAY = 5, R_TXA = 6, R_TYA = 7, R_TXY = 8, R_TYX = 9, R_XBA = 10,
  R_NOA = 11, R_NOX = 12;
const TAG_A = 0, TAG_X = 2, TAG_Y = 4; // a register's low byte in CPU.tags, its high byte next
const WRITES = new Uint8Array(256), WREG = new Uint8Array(256), REGS = new Uint8Array(256);
const writes = (ops: number[], mode: number, reg = TAG_A) => { for (const op of ops) { WRITES[op] = mode; WREG[op] = reg; } };
writes([0x81, 0x83, 0x85, 0x87, 0x8d, 0x8f, 0x91, 0x92, 0x93, 0x95, 0x97, 0x99, 0x9d, 0x9f], W_REG, TAG_A); // STA
writes([0x86, 0x8e, 0x96], W_REG, TAG_X); // STX
writes([0x84, 0x8c, 0x94], W_REG, TAG_Y); // STY
writes([0x48], W_PUSH, TAG_A); // PHA
writes([0xda], W_PUSH, TAG_X); // PHX
writes([0x5a], W_PUSH, TAG_Y); // PHY
writes([0x54, 0x44], W_COPY); // MVN, MVP
for (const op of [0xa1, 0xa3, 0xa5, 0xa7, 0xa9, 0xad, 0xaf, 0xb1, 0xb2, 0xb3, 0xb5, 0xb7, 0xb9, 0xbd, 0xbf, 0x68]) REGS[op] = R_LDA; // LDA, PLA
for (const op of [0xa2, 0xa6, 0xae, 0xb6, 0xbe, 0xfa]) REGS[op] = R_LDX; // LDX, PLX
for (const op of [0xa0, 0xa4, 0xac, 0xb4, 0xbc, 0x7a]) REGS[op] = R_LDY; // LDY, PLY
REGS[0xaa] = R_TAX; REGS[0xa8] = R_TAY; REGS[0x8a] = R_TXA; REGS[0x98] = R_TYA; REGS[0x9b] = R_TXY; REGS[0xbb] = R_TYX; REGS[0xeb] = R_XBA;
REGS[0x7b] = REGS[0x3b] = R_NOA; REGS[0xba] = R_NOX; // TDC, TSC, TSX: values not from memory

export class CPU {
  a = 0;
  x = 0;
  y = 0;
  s = 0x01ff;
  d = 0;
  dbr = 0;
  pbr = 0;
  pc = 0;
  p = 0x34;
  e = true;
  cycles = 0; // in master cycles (21.477 MHz)
  fastRom = false; // $420D bit 0: accesses in $80-$BF:8000-FFFF and $C0-$FF take 6 master cycles
  stopped = false;
  waiting = false;
  nmiPending = false;
  irqLine = false;
  bus: Bus;
  // analysis: address of the current instruction, and whether the bus access is an instruction fetch
  opPc = 0;
  op = 0; // opcode of the current instruction
  lastOp = 0; // and of the one before
  lastOpPc = 0;
  idle = false; // in a wait loop (see branch()); the system may skip ahead to the next interrupt
  inFetch = false;
  // told every effective address of an indexed addressing mode (absolute/long,X/Y, (dp),Y, [dp],Y, (sr,s),Y) with
  // the index register's value: what code reads from tables (see spritetables.ts)
  onIndexed: ((addr: number, index: number) => void) | null = null;
  // Source tracking (Snes.trackSources): where each byte of A, X and Y was loaded from, carried through
  // the instructions the way the bus carries it through memory. Off, instructions run without it.
  track = false;
  tags = new Int32Array(6).fill(-1); // A low, A high, X low, X high, Y low, Y high: a source tag each (-1 none)
  private rtags = new Int32Array(8); // the tags of the latest bus reads, a ring
  private nr = 0;
  private wmode = W_NONE; // what the current instruction writes: see writeTag
  private wbase = 0; // its register (index into tags)
  private wwide = false; // pushed 16 bits
  private wi = 0; // writes done

  constructor(bus: Bus) {
    this.bus = bus;
  }

  // ---- memory helpers ----
  // master cycles of a bus access, by the SNES memory map: ROM (and every bank $40-$7F) 8, 6 in $80+ with
  // $420D = 1; in the system banks WRAM and $6000-$7FFF 8, the I/O registers 6, the slow window $4000-$41FF 12
  accessCycles(addr: number): number {
    if (addr & 0x408000) return this.fastRom && (addr & 0x800000) ? 6 : 8;
    if ((addr + 0x6000) & 0x4000) return 8;
    if ((addr - 0x4000) & 0x7e00) return IO;
    return 12;
  }
  rd(addr: number): number {
    this.cycles += this.accessCycles(addr);
    return this.bus.read(addr & 0xffffff);
  }
  wr(addr: number, v: number): void {
    this.cycles += this.accessCycles(addr);
    this.bus.write(addr & 0xffffff, v & 0xff);
  }
  rd16(addr: number): number {
    return this.rd(addr) | (this.rd((addr + 1) & 0xffffff) << 8);
  }
  // 16-bit read wrapping inside bank 0 (direct page / stack style)
  rd16bank0(addr: number): number {
    return this.rd(addr & 0xffff) | (this.rd((addr + 1) & 0xffff) << 8);
  }
  wr16(addr: number, v: number): void {
    this.wr(addr, v);
    this.wr((addr + 1) & 0xffffff, v >> 8);
  }
  wr16bank0(addr: number, v: number): void {
    this.wr(addr & 0xffff, v);
    this.wr((addr + 1) & 0xffff, v >> 8);
  }

  fetch8(): number {
    this.inFetch = true;
    const v = this.rd((this.pbr << 16) | this.pc);
    this.inFetch = false;
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }
  fetch16(): number {
    const lo = this.fetch8();
    return lo | (this.fetch8() << 8);
  }
  fetch24(): number {
    const lo = this.fetch16();
    return lo | (this.fetch8() << 16);
  }

  push8(v: number): void {
    this.wr(this.s, v);
    if (this.e) this.s = 0x100 | ((this.s - 1) & 0xff);
    else this.s = (this.s - 1) & 0xffff;
  }
  pull8(): number {
    if (this.e) this.s = 0x100 | ((this.s + 1) & 0xff);
    else this.s = (this.s + 1) & 0xffff;
    return this.rd(this.s);
  }
  push16(v: number): void {
    this.push8(v >> 8);
    this.push8(v);
  }
  pull16(): number {
    const lo = this.pull8();
    return lo | (this.pull8() << 8);
  }

  get m8(): boolean {
    return (this.p & FLAG_M) !== 0;
  }
  get x8(): boolean {
    return (this.p & FLAG_X) !== 0;
  }

  setP(v: number): void {
    if (this.e) v |= FLAG_M | FLAG_X;
    this.p = v & 0xff;
    if (this.p & FLAG_X) {
      this.x &= 0xff;
      this.y &= 0xff;
    }
  }

  reset(): void {
    this.e = true;
    this.p = 0x34;
    this.s = 0x01ff;
    this.d = 0;
    this.dbr = 0;
    this.pbr = 0;
    this.x &= 0xff;
    this.y &= 0xff;
    this.stopped = false;
    this.waiting = false;
    this.pc = this.rd16(0xfffc);
  }

  interrupt(vecNative: number, vecEmu: number, isBrk: boolean): void {
    if (!this.e) this.push8(this.pbr);
    this.push16(this.pc);
    this.push8(this.e && !isBrk ? this.p & ~0x10 : this.p);
    this.p = (this.p | FLAG_I) & ~FLAG_D;
    this.pbr = 0;
    this.pc = this.rd16(this.e ? vecEmu : vecNative);
  }

  nmi(): void {
    this.waiting = false;
    this.interrupt(0xffea, 0xfffa, false);
  }
  irq(): void {
    this.waiting = false;
    this.interrupt(0xffee, 0xfffe, false);
  }

  // ---- flag helpers ----
  nz8(v: number): void {
    this.p = (this.p & ~(FLAG_N | FLAG_Z)) | (v & 0x80) | ((v & 0xff) === 0 ? FLAG_Z : 0);
  }
  nz16(v: number): void {
    this.p = (this.p & ~(FLAG_N | FLAG_Z)) | ((v >> 8) & 0x80) | ((v & 0xffff) === 0 ? FLAG_Z : 0);
  }
  nzM(v: number): void {
    if (this.m8) this.nz8(v);
    else this.nz16(v);
  }
  nzX(v: number): void {
    if (this.x8) this.nz8(v);
    else this.nz16(v);
  }

  // ---- addressing modes: return 24-bit effective address ----
  dpAddr(off: number): number {
    return (this.d + off) & 0xffff;
  }
  aDp(): number {
    const o = this.fetch8();
    if ((this.d & 0xff) !== 0) this.cycles += IO;
    return this.dpAddr(o);
  }
  aDpX(): number {
    const o = this.fetch8();
    if (this.e && (this.d & 0xff) === 0) return (this.d & 0xff00) | ((o + this.x) & 0xff);
    return (this.d + o + this.x) & 0xffff;
  }
  aDpY(): number {
    const o = this.fetch8();
    if (this.e && (this.d & 0xff) === 0) return (this.d & 0xff00) | ((o + this.y) & 0xff);
    return (this.d + o + this.y) & 0xffff;
  }
  aAbs(): number {
    return (this.dbr << 16) | this.fetch16();
  }
  aAbsX(): number {
    return this.ix((((this.dbr << 16) | this.fetch16()) + this.x) & 0xffffff, this.x);
  }
  aAbsY(): number {
    return this.ix((((this.dbr << 16) | this.fetch16()) + this.y) & 0xffffff, this.y);
  }
  aLong(): number {
    return this.fetch24();
  }
  aLongX(): number {
    return this.ix((this.fetch24() + this.x) & 0xffffff, this.x);
  }
  aDpInd(): number {
    const p = this.aDp();
    return (this.dbr << 16) | this.rd16bank0(p);
  }
  aDpIndY(): number {
    const p = this.aDp();
    return this.ix((((this.dbr << 16) | this.rd16bank0(p)) + this.y) & 0xffffff, this.y);
  }
  aDpXInd(): number {
    const p = this.aDpX();
    return (this.dbr << 16) | this.rd16bank0(p);
  }
  aDpIndLong(): number {
    const p = this.aDp();
    return this.rd16bank0(p) | (this.rd((p + 2) & 0xffff) << 16);
  }
  aDpIndLongY(): number {
    const p = this.aDp();
    const base = this.rd16bank0(p) | (this.rd((p + 2) & 0xffff) << 16);
    return this.ix((base + this.y) & 0xffffff, this.y);
  }
  aSr(): number {
    return (this.fetch8() + this.s) & 0xffff;
  }
  aSrIndY(): number {
    const p = (this.fetch8() + this.s) & 0xffff;
    return this.ix((((this.dbr << 16) | this.rd16bank0(p)) + this.y) & 0xffffff, this.y);
  }
  // an indexed effective address, told to onIndexed
  private ix(addr: number, index: number): number {
    if (this.onIndexed !== null) this.onIndexed(addr, index);
    return addr;
  }

  // read operand of size M or X
  rdM(addr: number): number {
    return this.m8 ? this.rd(addr) : this.rd16(addr);
  }
  rdX(addr: number): number {
    return this.x8 ? this.rd(addr) : this.rd16(addr);
  }
  wrM(addr: number, v: number): void {
    if (this.m8) this.wr(addr, v);
    else this.wr16(addr, v);
  }
  wrX(addr: number, v: number): void {
    if (this.x8) this.wr(addr, v);
    else this.wr16(addr, v);
  }
  // direct page reads wrap in bank 0
  rdMdp(addr: number): number {
    return this.m8 ? this.rd(addr) : this.rd16bank0(addr);
  }
  rdXdp(addr: number): number {
    return this.x8 ? this.rd(addr) : this.rd16bank0(addr);
  }
  wrMdp(addr: number, v: number): void {
    if (this.m8) this.wr(addr, v);
    else this.wr16bank0(addr, v);
  }
  wrXdp(addr: number, v: number): void {
    if (this.x8) this.wr(addr, v);
    else this.wr16bank0(addr, v);
  }
  immM(): number {
    return this.m8 ? this.fetch8() : this.fetch16();
  }
  immX(): number {
    return this.x8 ? this.fetch8() : this.fetch16();
  }

  // ---- ALU ----
  getA(): number {
    return this.m8 ? this.a & 0xff : this.a;
  }
  setA(v: number): void {
    if (this.m8) this.a = (this.a & 0xff00) | (v & 0xff);
    else this.a = v & 0xffff;
  }

  ora(v: number): void {
    const r = this.getA() | v;
    this.setA(r);
    this.nzM(r);
  }
  and(v: number): void {
    const r = this.getA() & v;
    this.setA(r);
    this.nzM(r);
  }
  eor(v: number): void {
    const r = this.getA() ^ v;
    this.setA(r);
    this.nzM(r);
  }
  adc(v: number): void {
    const c = this.p & FLAG_C;
    if (this.m8) {
      const a = this.a & 0xff;
      let r: number;
      if (this.p & FLAG_D) {
        r = (a & 0x0f) + (v & 0x0f) + c;
        if (r > 0x09) r += 0x06;
        const carryLo = r > 0x0f ? 0x10 : 0;
        r = (a & 0xf0) + (v & 0xf0) + carryLo + (r & 0x0f);
      } else {
        r = a + v + c;
      }
      const ov = ~(a ^ v) & (a ^ r) & 0x80;
      if ((this.p & FLAG_D) && r > 0x9f) r += 0x60;
      this.p = (this.p & ~(FLAG_C | FLAG_V)) | (r > 0xff ? FLAG_C : 0) | (ov ? FLAG_V : 0);
      this.setA(r & 0xff);
      this.nz8(r & 0xff);
    } else {
      const a = this.a;
      let r: number;
      if (this.p & FLAG_D) {
        r = (a & 0x000f) + (v & 0x000f) + c;
        if (r > 0x0009) r += 0x0006;
        r = (a & 0x00f0) + (v & 0x00f0) + (r > 0x000f ? 0x10 : 0) + (r & 0x000f);
        if (r > 0x009f) r += 0x0060;
        r = (a & 0x0f00) + (v & 0x0f00) + (r > 0x00ff ? 0x100 : 0) + (r & 0x00ff);
        if (r > 0x09ff) r += 0x0600;
        r = (a & 0xf000) + (v & 0xf000) + (r > 0x0fff ? 0x1000 : 0) + (r & 0x0fff);
      } else {
        r = a + v + c;
      }
      const ov = ~(a ^ v) & (a ^ r) & 0x8000;
      if ((this.p & FLAG_D) && r > 0x9fff) r += 0x6000;
      this.p = (this.p & ~(FLAG_C | FLAG_V)) | (r > 0xffff ? FLAG_C : 0) | (ov ? FLAG_V : 0);
      this.a = r & 0xffff;
      this.nz16(this.a);
    }
  }
  sbc(v: number): void {
    const c = this.p & FLAG_C;
    if (this.m8) {
      const a = this.a & 0xff;
      v = ~v & 0xff;
      let r: number;
      if (this.p & FLAG_D) {
        r = (a & 0x0f) + (v & 0x0f) + c;
        if (r <= 0x0f) r -= 0x06;
        const carryLo = r > 0x0f ? 0x10 : 0;
        r = (a & 0xf0) + (v & 0xf0) + carryLo + (r & 0x0f);
      } else {
        r = a + v + c;
      }
      const ov = ~(a ^ v) & (a ^ r) & 0x80;
      if ((this.p & FLAG_D) && r <= 0xff) r -= 0x60;
      this.p = (this.p & ~(FLAG_C | FLAG_V)) | (r > 0xff ? FLAG_C : 0) | (ov ? FLAG_V : 0);
      this.setA(r & 0xff);
      this.nz8(r & 0xff);
    } else {
      const a = this.a;
      v = ~v & 0xffff;
      let r: number;
      if (this.p & FLAG_D) {
        r = (a & 0x000f) + (v & 0x000f) + c;
        if (r <= 0x000f) r -= 0x0006;
        r = (a & 0x00f0) + (v & 0x00f0) + (r > 0x000f ? 0x10 : 0) + (r & 0x000f);
        if (r <= 0x00ff) r -= 0x0060;
        r = (a & 0x0f00) + (v & 0x0f00) + (r > 0x00ff ? 0x100 : 0) + (r & 0x00ff);
        if (r <= 0x0fff) r -= 0x0600;
        r = (a & 0xf000) + (v & 0xf000) + (r > 0x0fff ? 0x1000 : 0) + (r & 0x0fff);
      } else {
        r = a + v + c;
      }
      const ov = ~(a ^ v) & (a ^ r) & 0x8000;
      if ((this.p & FLAG_D) && r <= 0xffff) r -= 0x6000;
      this.p = (this.p & ~(FLAG_C | FLAG_V)) | (r > 0xffff ? FLAG_C : 0) | (ov ? FLAG_V : 0);
      this.a = r & 0xffff;
      this.nz16(this.a);
    }
  }
  cmp(reg: number, v: number, is8: boolean): void {
    if (is8) {
      const r = (reg & 0xff) - v;
      this.p = (this.p & ~FLAG_C) | (r >= 0 ? FLAG_C : 0);
      this.nz8(r & 0xff);
    } else {
      const r = (reg & 0xffff) - v;
      this.p = (this.p & ~FLAG_C) | (r >= 0 ? FLAG_C : 0);
      this.nz16(r & 0xffff);
    }
  }
  bit(v: number, imm: boolean): void {
    const a = this.getA();
    const z = (a & v) === 0 ? FLAG_Z : 0;
    if (imm) {
      this.p = (this.p & ~FLAG_Z) | z;
    } else if (this.m8) {
      this.p = (this.p & ~(FLAG_Z | FLAG_N | FLAG_V)) | z | (v & 0xc0);
    } else {
      this.p = (this.p & ~(FLAG_Z | FLAG_N | FLAG_V)) | z | ((v >> 8) & 0xc0);
    }
  }

  // read-modify-write ops, value in / value out
  asl(v: number): number {
    if (this.m8) {
      this.p = (this.p & ~FLAG_C) | ((v >> 7) & 1);
      v = (v << 1) & 0xff;
      this.nz8(v);
    } else {
      this.p = (this.p & ~FLAG_C) | ((v >> 15) & 1);
      v = (v << 1) & 0xffff;
      this.nz16(v);
    }
    return v;
  }
  lsr(v: number): number {
    this.p = (this.p & ~FLAG_C) | (v & 1);
    v >>= 1;
    this.nzM(v);
    return v;
  }
  rol(v: number): number {
    const c = this.p & FLAG_C;
    if (this.m8) {
      this.p = (this.p & ~FLAG_C) | ((v >> 7) & 1);
      v = ((v << 1) | c) & 0xff;
      this.nz8(v);
    } else {
      this.p = (this.p & ~FLAG_C) | ((v >> 15) & 1);
      v = ((v << 1) | c) & 0xffff;
      this.nz16(v);
    }
    return v;
  }
  ror(v: number): number {
    const c = this.p & FLAG_C;
    this.p = (this.p & ~FLAG_C) | (v & 1);
    if (this.m8) v = (v >> 1) | (c << 7);
    else v = (v >> 1) | (c << 15);
    this.nzM(v);
    return v;
  }
  inc(v: number): number {
    v = (v + 1) & (this.m8 ? 0xff : 0xffff);
    this.nzM(v);
    return v;
  }
  dec(v: number): number {
    v = (v - 1) & (this.m8 ? 0xff : 0xffff);
    this.nzM(v);
    return v;
  }
  tsb(v: number): number {
    const a = this.getA();
    this.p = (this.p & ~FLAG_Z) | ((a & v) === 0 ? FLAG_Z : 0);
    return v | a;
  }
  trb(v: number): number {
    const a = this.getA();
    this.p = (this.p & ~FLAG_Z) | ((a & v) === 0 ? FLAG_Z : 0);
    return v & ~a;
  }

  rmw(addr: number, dp: boolean, op: (v: number) => number): void {
    if (dp) {
      const v = this.rdMdp(addr);
      this.cycles += IO;
      this.wrMdp(addr, op.call(this, v));
    } else {
      const v = this.rdM(addr);
      this.cycles += IO;
      this.wrM(addr, op.call(this, v));
    }
  }

  branch(cond: boolean): void {
    const off = this.fetch8();
    if (cond) {
      this.cycles += IO;
      this.pc = (this.pc + ((off << 24) >> 24)) & 0xffff;
      // LDA dp : Bxx back to it (waiting for the NMI to change a WRAM byte): nothing can change
      // until an interrupt
      if (off === 0xfc && this.lastOp === 0xa5 && this.d === 0 && this.lastOpPc === ((this.pbr << 16) | this.pc)) this.idle = true;
    }
  }

  setX(v: number): void {
    this.x = this.x8 ? v & 0xff : v & 0xffff;
  }
  setY(v: number): void {
    this.y = this.x8 ? v & 0xff : v & 0xffff;
  }

  step(): void {
    if (this.stopped) {
      this.cycles += 4 * IO;
      return;
    }
    if (this.nmiPending) {
      this.nmiPending = false;
      this.nmi();
      return;
    }
    if (this.irqLine && !(this.p & FLAG_I)) {
      this.irq();
      return;
    }
    if (this.waiting) {
      this.cycles += 4 * IO;
      return;
    }
    this.lastOpPc = this.opPc;
    this.lastOp = this.op;
    this.opPc = (this.pbr << 16) | this.pc;
    const op = this.fetch8();
    this.op = op;
    if (this.track) this.execTracked(op);
    else this.exec(op);
  }

  // ---- source tracking ----
  // the bus reports the tag of every byte read (ROM offset, or what the memory byte carries)
  noteRead(tag: number): void {
    this.rtags[this.nr++ & 7] = tag;
  }
  // the tag of the k-th latest read (1: the latest)
  readTag(k = 1): number {
    return this.rtags[(this.nr - k) & 7];
  }
  // the tag of the byte the instruction writes now (stores and pushes of a register, block moves);
  // other writes (results of arithmetic, return addresses, interrupts) have no source
  resetTags(): void {
    this.tags.fill(-1);
  }
  writeTag(): number {
    switch (this.wmode) {
      case W_REG: return this.tags[this.wbase + (this.wi++ & 1)]; // low byte first
      case W_PUSH: return this.wwide ? this.tags[this.wbase + 1 - (this.wi++ & 1)] : this.tags[this.wbase]; // high byte first
      case W_COPY: return this.readTag();
      default: return -1;
    }
  }

  // the index register at r loaded from memory (8 bits: its high byte is 0)
  private loaded(r: number, x8: boolean): void {
    if (x8) { this.tags[r] = this.readTag(); this.tags[r + 1] = -1; } else { this.tags[r] = this.readTag(2); this.tags[r + 1] = this.readTag(); }
  }
  // register from copied to register to, 8 bits wide or 16
  private moved(from: number, to: number, to8: boolean): void {
    this.tags[to] = this.tags[from];
    if (!to8) this.tags[to + 1] = this.tags[from + 1];
    else if (to !== TAG_A) this.tags[to + 1] = -1; // an 8-bit index register's high byte is 0; A's is kept
  }
  // index register at r after an instruction changed it from v0 to v, at the width it has now (SEP #$10 clears the high byte)
  private changed(r: number, v: number, v0: number): void {
    if (v === v0) return;
    if (this.x8) { if ((v ^ v0) & 0xff) this.tags[r] = -1; this.tags[r + 1] = -1; } else this.tags[r] = this.tags[r + 1] = -1;
  }

  private execTracked(op: number): void {
    const t = this.tags;
    const a0 = this.a, x0 = this.x, y0 = this.y, m8 = this.m8, x8 = this.x8;
    this.wmode = WRITES[op];
    this.wbase = WREG[op];
    this.wwide = this.wbase === TAG_A ? !m8 : !x8;
    this.wi = 0;
    this.exec(op);
    this.wmode = W_NONE;
    switch (REGS[op]) {
      case R_LDA: if (m8) t[TAG_A] = this.readTag(); else { t[TAG_A] = this.readTag(2); t[TAG_A + 1] = this.readTag(); } return;
      case R_LDX: this.loaded(TAG_X, x8); return;
      case R_LDY: this.loaded(TAG_Y, x8); return;
      case R_TAX: this.moved(TAG_A, TAG_X, x8); return;
      case R_TAY: this.moved(TAG_A, TAG_Y, x8); return;
      case R_TXA: this.moved(TAG_X, TAG_A, m8); return;
      case R_TYA: this.moved(TAG_Y, TAG_A, m8); return;
      case R_TXY: this.moved(TAG_X, TAG_Y, x8); return;
      case R_TYX: this.moved(TAG_Y, TAG_X, x8); return;
      case R_XBA: { const lo = t[TAG_A]; t[TAG_A] = t[TAG_A + 1]; t[TAG_A + 1] = lo; return; }
      case R_NOA: t[TAG_A] = t[TAG_A + 1] = -1; return;
      case R_NOX: t[TAG_X] = t[TAG_X + 1] = -1; return;
    }
    // anything else: a register it changed (arithmetic, increments, block moves) has no source any more – both
    // bytes of a 16-bit one, computed as one value; one left as it was keeps it
    if (this.a !== a0) { if (m8 && !((this.a ^ a0) & 0xff00)) t[TAG_A] = -1; else t[TAG_A] = t[TAG_A + 1] = -1; }
    this.changed(TAG_X, this.x, x0);
    this.changed(TAG_Y, this.y, y0);
  }

  exec(op: number): void {
    let a: number;
    let v: number;
    switch (op) {
      // ---- ORA ----
      case 0x01: this.ora(this.rdM(this.aDpXInd())); break;
      case 0x03: this.ora(this.rdM(this.aSr())); break;
      case 0x05: this.ora(this.rdMdp(this.aDp())); break;
      case 0x07: this.ora(this.rdM(this.aDpIndLong())); break;
      case 0x09: this.ora(this.immM()); break;
      case 0x0d: this.ora(this.rdM(this.aAbs())); break;
      case 0x0f: this.ora(this.rdM(this.aLong())); break;
      case 0x11: this.ora(this.rdM(this.aDpIndY())); break;
      case 0x12: this.ora(this.rdM(this.aDpInd())); break;
      case 0x13: this.ora(this.rdM(this.aSrIndY())); break;
      case 0x15: this.ora(this.rdMdp(this.aDpX())); break;
      case 0x17: this.ora(this.rdM(this.aDpIndLongY())); break;
      case 0x19: this.ora(this.rdM(this.aAbsY())); break;
      case 0x1d: this.ora(this.rdM(this.aAbsX())); break;
      case 0x1f: this.ora(this.rdM(this.aLongX())); break;
      // ---- AND ----
      case 0x21: this.and(this.rdM(this.aDpXInd())); break;
      case 0x23: this.and(this.rdM(this.aSr())); break;
      case 0x25: this.and(this.rdMdp(this.aDp())); break;
      case 0x27: this.and(this.rdM(this.aDpIndLong())); break;
      case 0x29: this.and(this.immM()); break;
      case 0x2d: this.and(this.rdM(this.aAbs())); break;
      case 0x2f: this.and(this.rdM(this.aLong())); break;
      case 0x31: this.and(this.rdM(this.aDpIndY())); break;
      case 0x32: this.and(this.rdM(this.aDpInd())); break;
      case 0x33: this.and(this.rdM(this.aSrIndY())); break;
      case 0x35: this.and(this.rdMdp(this.aDpX())); break;
      case 0x37: this.and(this.rdM(this.aDpIndLongY())); break;
      case 0x39: this.and(this.rdM(this.aAbsY())); break;
      case 0x3d: this.and(this.rdM(this.aAbsX())); break;
      case 0x3f: this.and(this.rdM(this.aLongX())); break;
      // ---- EOR ----
      case 0x41: this.eor(this.rdM(this.aDpXInd())); break;
      case 0x43: this.eor(this.rdM(this.aSr())); break;
      case 0x45: this.eor(this.rdMdp(this.aDp())); break;
      case 0x47: this.eor(this.rdM(this.aDpIndLong())); break;
      case 0x49: this.eor(this.immM()); break;
      case 0x4d: this.eor(this.rdM(this.aAbs())); break;
      case 0x4f: this.eor(this.rdM(this.aLong())); break;
      case 0x51: this.eor(this.rdM(this.aDpIndY())); break;
      case 0x52: this.eor(this.rdM(this.aDpInd())); break;
      case 0x53: this.eor(this.rdM(this.aSrIndY())); break;
      case 0x55: this.eor(this.rdMdp(this.aDpX())); break;
      case 0x57: this.eor(this.rdM(this.aDpIndLongY())); break;
      case 0x59: this.eor(this.rdM(this.aAbsY())); break;
      case 0x5d: this.eor(this.rdM(this.aAbsX())); break;
      case 0x5f: this.eor(this.rdM(this.aLongX())); break;
      // ---- ADC ----
      case 0x61: this.adc(this.rdM(this.aDpXInd())); break;
      case 0x63: this.adc(this.rdM(this.aSr())); break;
      case 0x65: this.adc(this.rdMdp(this.aDp())); break;
      case 0x67: this.adc(this.rdM(this.aDpIndLong())); break;
      case 0x69: this.adc(this.immM()); break;
      case 0x6d: this.adc(this.rdM(this.aAbs())); break;
      case 0x6f: this.adc(this.rdM(this.aLong())); break;
      case 0x71: this.adc(this.rdM(this.aDpIndY())); break;
      case 0x72: this.adc(this.rdM(this.aDpInd())); break;
      case 0x73: this.adc(this.rdM(this.aSrIndY())); break;
      case 0x75: this.adc(this.rdMdp(this.aDpX())); break;
      case 0x77: this.adc(this.rdM(this.aDpIndLongY())); break;
      case 0x79: this.adc(this.rdM(this.aAbsY())); break;
      case 0x7d: this.adc(this.rdM(this.aAbsX())); break;
      case 0x7f: this.adc(this.rdM(this.aLongX())); break;
      // ---- STA ----
      case 0x81: this.wrM(this.aDpXInd(), this.a); break;
      case 0x83: this.wrM(this.aSr(), this.a); break;
      case 0x85: this.wrMdp(this.aDp(), this.a); break;
      case 0x87: this.wrM(this.aDpIndLong(), this.a); break;
      case 0x8d: this.wrM(this.aAbs(), this.a); break;
      case 0x8f: this.wrM(this.aLong(), this.a); break;
      case 0x91: this.wrM(this.aDpIndY(), this.a); break;
      case 0x92: this.wrM(this.aDpInd(), this.a); break;
      case 0x93: this.wrM(this.aSrIndY(), this.a); break;
      case 0x95: this.wrMdp(this.aDpX(), this.a); break;
      case 0x97: this.wrM(this.aDpIndLongY(), this.a); break;
      case 0x99: this.wrM(this.aAbsY(), this.a); break;
      case 0x9d: this.wrM(this.aAbsX(), this.a); break;
      case 0x9f: this.wrM(this.aLongX(), this.a); break;
      // ---- LDA ----
      case 0xa1: v = this.rdM(this.aDpXInd()); this.setA(v); this.nzM(v); break;
      case 0xa3: v = this.rdM(this.aSr()); this.setA(v); this.nzM(v); break;
      case 0xa5: v = this.rdMdp(this.aDp()); this.setA(v); this.nzM(v); break;
      case 0xa7: v = this.rdM(this.aDpIndLong()); this.setA(v); this.nzM(v); break;
      case 0xa9: v = this.immM(); this.setA(v); this.nzM(v); break;
      case 0xad: v = this.rdM(this.aAbs()); this.setA(v); this.nzM(v); break;
      case 0xaf: v = this.rdM(this.aLong()); this.setA(v); this.nzM(v); break;
      case 0xb1: v = this.rdM(this.aDpIndY()); this.setA(v); this.nzM(v); break;
      case 0xb2: v = this.rdM(this.aDpInd()); this.setA(v); this.nzM(v); break;
      case 0xb3: v = this.rdM(this.aSrIndY()); this.setA(v); this.nzM(v); break;
      case 0xb5: v = this.rdMdp(this.aDpX()); this.setA(v); this.nzM(v); break;
      case 0xb7: v = this.rdM(this.aDpIndLongY()); this.setA(v); this.nzM(v); break;
      case 0xb9: v = this.rdM(this.aAbsY()); this.setA(v); this.nzM(v); break;
      case 0xbd: v = this.rdM(this.aAbsX()); this.setA(v); this.nzM(v); break;
      case 0xbf: v = this.rdM(this.aLongX()); this.setA(v); this.nzM(v); break;
      // ---- CMP ----
      case 0xc1: this.cmp(this.a, this.rdM(this.aDpXInd()), this.m8); break;
      case 0xc3: this.cmp(this.a, this.rdM(this.aSr()), this.m8); break;
      case 0xc5: this.cmp(this.a, this.rdMdp(this.aDp()), this.m8); break;
      case 0xc7: this.cmp(this.a, this.rdM(this.aDpIndLong()), this.m8); break;
      case 0xc9: this.cmp(this.a, this.immM(), this.m8); break;
      case 0xcd: this.cmp(this.a, this.rdM(this.aAbs()), this.m8); break;
      case 0xcf: this.cmp(this.a, this.rdM(this.aLong()), this.m8); break;
      case 0xd1: this.cmp(this.a, this.rdM(this.aDpIndY()), this.m8); break;
      case 0xd2: this.cmp(this.a, this.rdM(this.aDpInd()), this.m8); break;
      case 0xd3: this.cmp(this.a, this.rdM(this.aSrIndY()), this.m8); break;
      case 0xd5: this.cmp(this.a, this.rdMdp(this.aDpX()), this.m8); break;
      case 0xd7: this.cmp(this.a, this.rdM(this.aDpIndLongY()), this.m8); break;
      case 0xd9: this.cmp(this.a, this.rdM(this.aAbsY()), this.m8); break;
      case 0xdd: this.cmp(this.a, this.rdM(this.aAbsX()), this.m8); break;
      case 0xdf: this.cmp(this.a, this.rdM(this.aLongX()), this.m8); break;
      // ---- SBC ----
      case 0xe1: this.sbc(this.rdM(this.aDpXInd())); break;
      case 0xe3: this.sbc(this.rdM(this.aSr())); break;
      case 0xe5: this.sbc(this.rdMdp(this.aDp())); break;
      case 0xe7: this.sbc(this.rdM(this.aDpIndLong())); break;
      case 0xe9: this.sbc(this.immM()); break;
      case 0xed: this.sbc(this.rdM(this.aAbs())); break;
      case 0xef: this.sbc(this.rdM(this.aLong())); break;
      case 0xf1: this.sbc(this.rdM(this.aDpIndY())); break;
      case 0xf2: this.sbc(this.rdM(this.aDpInd())); break;
      case 0xf3: this.sbc(this.rdM(this.aSrIndY())); break;
      case 0xf5: this.sbc(this.rdMdp(this.aDpX())); break;
      case 0xf7: this.sbc(this.rdM(this.aDpIndLongY())); break;
      case 0xf9: this.sbc(this.rdM(this.aAbsY())); break;
      case 0xfd: this.sbc(this.rdM(this.aAbsX())); break;
      case 0xff: this.sbc(this.rdM(this.aLongX())); break;

      // ---- shifts / rmw ----
      case 0x06: this.rmw(this.aDp(), true, this.asl); break;
      case 0x0a: this.cycles += IO; this.setA(this.asl(this.getA())); break;
      case 0x0e: this.rmw(this.aAbs(), false, this.asl); break;
      case 0x16: this.rmw(this.aDpX(), true, this.asl); break;
      case 0x1e: this.rmw(this.aAbsX(), false, this.asl); break;
      case 0x26: this.rmw(this.aDp(), true, this.rol); break;
      case 0x2a: this.cycles += IO; this.setA(this.rol(this.getA())); break;
      case 0x2e: this.rmw(this.aAbs(), false, this.rol); break;
      case 0x36: this.rmw(this.aDpX(), true, this.rol); break;
      case 0x3e: this.rmw(this.aAbsX(), false, this.rol); break;
      case 0x46: this.rmw(this.aDp(), true, this.lsr); break;
      case 0x4a: this.cycles += IO; this.setA(this.lsr(this.getA())); break;
      case 0x4e: this.rmw(this.aAbs(), false, this.lsr); break;
      case 0x56: this.rmw(this.aDpX(), true, this.lsr); break;
      case 0x5e: this.rmw(this.aAbsX(), false, this.lsr); break;
      case 0x66: this.rmw(this.aDp(), true, this.ror); break;
      case 0x6a: this.cycles += IO; this.setA(this.ror(this.getA())); break;
      case 0x6e: this.rmw(this.aAbs(), false, this.ror); break;
      case 0x76: this.rmw(this.aDpX(), true, this.ror); break;
      case 0x7e: this.rmw(this.aAbsX(), false, this.ror); break;
      case 0xc6: this.rmw(this.aDp(), true, this.dec); break;
      case 0xce: this.rmw(this.aAbs(), false, this.dec); break;
      case 0xd6: this.rmw(this.aDpX(), true, this.dec); break;
      case 0xde: this.rmw(this.aAbsX(), false, this.dec); break;
      case 0xe6: this.rmw(this.aDp(), true, this.inc); break;
      case 0xee: this.rmw(this.aAbs(), false, this.inc); break;
      case 0xf6: this.rmw(this.aDpX(), true, this.inc); break;
      case 0xfe: this.rmw(this.aAbsX(), false, this.inc); break;
      case 0x1a: this.cycles += IO; this.setA(this.inc(this.getA())); break;
      case 0x3a: this.cycles += IO; this.setA(this.dec(this.getA())); break;
      case 0x04: this.rmw(this.aDp(), true, this.tsb); break;
      case 0x0c: this.rmw(this.aAbs(), false, this.tsb); break;
      case 0x14: this.rmw(this.aDp(), true, this.trb); break;
      case 0x1c: this.rmw(this.aAbs(), false, this.trb); break;

      // ---- BIT ----
      case 0x24: this.bit(this.rdMdp(this.aDp()), false); break;
      case 0x2c: this.bit(this.rdM(this.aAbs()), false); break;
      case 0x34: this.bit(this.rdMdp(this.aDpX()), false); break;
      case 0x3c: this.bit(this.rdM(this.aAbsX()), false); break;
      case 0x89: this.bit(this.immM(), true); break;

      // ---- STX/STY/STZ ----
      case 0x86: this.wrXdp(this.aDp(), this.x); break;
      case 0x8e: this.wrX(this.aAbs(), this.x); break;
      case 0x96: this.wrXdp(this.aDpY(), this.x); break;
      case 0x84: this.wrXdp(this.aDp(), this.y); break;
      case 0x8c: this.wrX(this.aAbs(), this.y); break;
      case 0x94: this.wrXdp(this.aDpX(), this.y); break;
      case 0x64: this.wrMdp(this.aDp(), 0); break;
      case 0x74: this.wrMdp(this.aDpX(), 0); break;
      case 0x9c: this.wrM(this.aAbs(), 0); break;
      case 0x9e: this.wrM(this.aAbsX(), 0); break;

      // ---- LDX/LDY ----
      case 0xa2: v = this.immX(); this.x = v; this.nzX(v); break;
      case 0xa6: v = this.rdXdp(this.aDp()); this.x = v; this.nzX(v); break;
      case 0xae: v = this.rdX(this.aAbs()); this.x = v; this.nzX(v); break;
      case 0xb6: v = this.rdXdp(this.aDpY()); this.x = v; this.nzX(v); break;
      case 0xbe: v = this.rdX(this.aAbsY()); this.x = v; this.nzX(v); break;
      case 0xa0: v = this.immX(); this.y = v; this.nzX(v); break;
      case 0xa4: v = this.rdXdp(this.aDp()); this.y = v; this.nzX(v); break;
      case 0xac: v = this.rdX(this.aAbs()); this.y = v; this.nzX(v); break;
      case 0xb4: v = this.rdXdp(this.aDpX()); this.y = v; this.nzX(v); break;
      case 0xbc: v = this.rdX(this.aAbsX()); this.y = v; this.nzX(v); break;

      // ---- CPX/CPY ----
      case 0xe0: this.cmp(this.x, this.immX(), this.x8); break;
      case 0xe4: this.cmp(this.x, this.rdXdp(this.aDp()), this.x8); break;
      case 0xec: this.cmp(this.x, this.rdX(this.aAbs()), this.x8); break;
      case 0xc0: this.cmp(this.y, this.immX(), this.x8); break;
      case 0xc4: this.cmp(this.y, this.rdXdp(this.aDp()), this.x8); break;
      case 0xcc: this.cmp(this.y, this.rdX(this.aAbs()), this.x8); break;

      // ---- INX/INY/DEX/DEY ----
      case 0xe8: this.cycles += IO; this.setX(this.x + 1); this.nzX(this.x); break;
      case 0xc8: this.cycles += IO; this.setY(this.y + 1); this.nzX(this.y); break;
      case 0xca: this.cycles += IO; this.setX(this.x - 1); this.nzX(this.x); break;
      case 0x88: this.cycles += IO; this.setY(this.y - 1); this.nzX(this.y); break;

      // ---- transfers ----
      case 0xaa: this.cycles += IO; this.setX(this.a); this.nzX(this.x); break; // TAX
      case 0xa8: this.cycles += IO; this.setY(this.a); this.nzX(this.y); break; // TAY
      case 0x8a: this.cycles += IO; this.setA(this.x); this.nzM(this.getA()); break; // TXA
      case 0x98: this.cycles += IO; this.setA(this.y); this.nzM(this.getA()); break; // TYA
      case 0x9b: this.cycles += IO; this.setY(this.x); this.nzX(this.y); break; // TXY
      case 0xbb: this.cycles += IO; this.setX(this.y); this.nzX(this.x); break; // TYX
      case 0xba: this.cycles += IO; this.setX(this.s); this.nzX(this.x); break; // TSX
      case 0x9a: // TXS
        this.cycles += IO;
        this.s = this.e ? 0x100 | (this.x & 0xff) : this.x;
        break;
      case 0x5b: this.cycles += IO; this.d = this.a; this.nz16(this.d); break; // TCD
      case 0x7b: this.cycles += IO; this.a = this.d; this.nz16(this.a); break; // TDC
      case 0x1b: this.cycles += IO; this.s = this.e ? 0x100 | (this.a & 0xff) : this.a; break; // TCS
      case 0x3b: this.cycles += IO; this.a = this.s; this.nz16(this.a); break; // TSC
      case 0xeb: // XBA
        this.cycles += 2 * IO;
        this.a = ((this.a >> 8) | (this.a << 8)) & 0xffff;
        this.nz8(this.a & 0xff);
        break;

      // ---- stack ----
      case 0x48: this.cycles += IO; if (this.m8) this.push8(this.a); else this.push16(this.a); break; // PHA
      case 0x68: this.cycles += 2 * IO; if (this.m8) { v = this.pull8(); this.setA(v); } else { this.a = this.pull16(); } this.nzM(this.getA()); break; // PLA
      case 0xda: this.cycles += IO; if (this.x8) this.push8(this.x); else this.push16(this.x); break; // PHX
      case 0xfa: this.cycles += 2 * IO; this.x = this.x8 ? this.pull8() : this.pull16(); this.nzX(this.x); break; // PLX
      case 0x5a: this.cycles += IO; if (this.x8) this.push8(this.y); else this.push16(this.y); break; // PHY
      case 0x7a: this.cycles += 2 * IO; this.y = this.x8 ? this.pull8() : this.pull16(); this.nzX(this.y); break; // PLY
      case 0x08: this.cycles += IO; this.push8(this.p); break; // PHP
      case 0x28: this.cycles += 2 * IO; this.setP(this.pull8()); break; // PLP
      case 0x8b: this.cycles += IO; this.push8(this.dbr); break; // PHB
      case 0xab: this.cycles += 2 * IO; this.dbr = this.pull8(); this.nz8(this.dbr); break; // PLB
      case 0x4b: this.cycles += IO; this.push8(this.pbr); break; // PHK
      case 0x0b: this.cycles += IO; this.push16(this.d); break; // PHD
      case 0x2b: this.cycles += 2 * IO; this.d = this.pull16(); this.nz16(this.d); break; // PLD
      case 0xf4: this.push16(this.fetch16()); break; // PEA
      case 0xd4: a = this.aDp(); this.push16(this.rd16bank0(a)); break; // PEI
      case 0x62: v = this.fetch16(); this.push16((this.pc + v) & 0xffff); break; // PER

      // ---- flags ----
      case 0x18: this.cycles += IO; this.p &= ~FLAG_C; break;
      case 0x38: this.cycles += IO; this.p |= FLAG_C; break;
      case 0x58: this.cycles += IO; this.p &= ~FLAG_I; break;
      case 0x78: this.cycles += IO; this.p |= FLAG_I; break;
      case 0xb8: this.cycles += IO; this.p &= ~FLAG_V; break;
      case 0xd8: this.cycles += IO; this.p &= ~FLAG_D; break;
      case 0xf8: this.cycles += IO; this.p |= FLAG_D; break;
      case 0xc2: this.cycles += IO; this.setP(this.p & ~this.fetch8()); break; // REP
      case 0xe2: this.cycles += IO; this.setP(this.p | this.fetch8()); break; // SEP
      case 0xfb: { // XCE
        this.cycles += IO;
        const c = this.p & FLAG_C;
        this.p = (this.p & ~FLAG_C) | (this.e ? 1 : 0);
        this.e = c !== 0;
        if (this.e) {
          this.p |= FLAG_M | FLAG_X;
          this.x &= 0xff;
          this.y &= 0xff;
          this.s = 0x100 | (this.s & 0xff);
        }
        break;
      }

      // ---- branches ----
      case 0x10: this.branch(!(this.p & FLAG_N)); break;
      case 0x30: this.branch((this.p & FLAG_N) !== 0); break;
      case 0x50: this.branch(!(this.p & FLAG_V)); break;
      case 0x70: this.branch((this.p & FLAG_V) !== 0); break;
      case 0x90: this.branch(!(this.p & FLAG_C)); break;
      case 0xb0: this.branch((this.p & FLAG_C) !== 0); break;
      case 0xd0: this.branch(!(this.p & FLAG_Z)); break;
      case 0xf0: this.branch((this.p & FLAG_Z) !== 0); break;
      case 0x80: this.branch(true); break;
      case 0x82: v = this.fetch16(); this.pc = (this.pc + v) & 0xffff; this.cycles += IO; break; // BRL

      // ---- jumps ----
      case 0x4c: this.pc = this.fetch16(); break; // JMP abs
      case 0x5c: v = this.fetch24(); this.pc = v & 0xffff; this.pbr = v >> 16; break; // JML long
      case 0x6c: a = this.fetch16(); this.pc = this.rd16bank0(a); break; // JMP (abs)
      case 0x7c: a = this.fetch16(); this.pc = this.rd16(this.ix((this.pbr << 16) | ((a + this.x) & 0xffff), this.x)); break; // JMP (abs,X)
      case 0xdc: // JML [abs]
        a = this.fetch16();
        this.pc = this.rd16bank0(a);
        this.pbr = this.rd((a + 2) & 0xffff);
        break;
      case 0x20: a = this.fetch16(); this.cycles += IO; this.push16((this.pc - 1) & 0xffff); this.pc = a; break; // JSR
      case 0xfc: // JSR (abs,X)
        a = this.fetch16();
        this.push16((this.pc - 1) & 0xffff);
        this.pc = this.rd16(this.ix((this.pbr << 16) | ((a + this.x) & 0xffff), this.x));
        break;
      case 0x22: { // JSL
        const lo = this.fetch16();
        this.push8(this.pbr);
        const bank = this.fetch8();
        this.push16((this.pc - 1) & 0xffff);
        this.pc = lo;
        this.pbr = bank;
        break;
      }
      case 0x60: this.cycles += 3 * IO; this.pc = (this.pull16() + 1) & 0xffff; break; // RTS
      case 0x6b: this.cycles += 2 * IO; this.pc = (this.pull16() + 1) & 0xffff; this.pbr = this.pull8(); break; // RTL
      case 0x40: // RTI
        this.cycles += 2 * IO;
        this.setP(this.pull8());
        this.pc = this.pull16();
        if (!this.e) this.pbr = this.pull8();
        break;

      // ---- block moves ----
      case 0x54: // MVN dst,src
      case 0x44: { // MVP
        const dst = this.fetch8();
        const src = this.fetch8();
        this.dbr = dst;
        const inc = op === 0x54 ? 1 : -1;
        const mask = this.x8 ? 0xff : 0xffff;
        do {
          this.wr((dst << 16) | this.y, this.rd((src << 16) | this.x));
          this.cycles += 2 * IO;
          this.x = (this.x + inc) & mask;
          this.y = (this.y + inc) & mask;
          this.a = (this.a - 1) & 0xffff;
        } while (this.a !== 0xffff);
        break;
      }

      // ---- misc ----
      case 0xea: this.cycles += IO; break; // NOP
      case 0x42: this.fetch8(); break; // WDM
      case 0xcb: this.waiting = true; break; // WAI
      case 0xdb: this.stopped = true; break; // STP
      case 0x00: // BRK
        this.fetch8();
        this.interrupt(0xffe6, 0xfffe, true);
        break;
      case 0x02: // COP
        this.fetch8();
        this.interrupt(0xffe4, 0xfff4, false);
        break;
      default:
        throw new Error(`unhandled opcode ${op.toString(16)}`);
    }
  }
}
