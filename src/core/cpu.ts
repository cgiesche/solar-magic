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
  cycles = 0;
  stopped = false;
  waiting = false;
  nmiPending = false;
  irqLine = false;
  bus: Bus;
  // analysis: address of the current instruction, and whether the bus access is an instruction fetch
  opPc = 0;
  inFetch = false;

  constructor(bus: Bus) {
    this.bus = bus;
  }

  // ---- memory helpers ----
  rd(addr: number): number {
    this.cycles++;
    return this.bus.read(addr & 0xffffff);
  }
  wr(addr: number, v: number): void {
    this.cycles++;
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
    if ((this.d & 0xff) !== 0) this.cycles++;
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
    return (((this.dbr << 16) | this.fetch16()) + this.x) & 0xffffff;
  }
  aAbsY(): number {
    return (((this.dbr << 16) | this.fetch16()) + this.y) & 0xffffff;
  }
  aLong(): number {
    return this.fetch24();
  }
  aLongX(): number {
    return (this.fetch24() + this.x) & 0xffffff;
  }
  aDpInd(): number {
    const p = this.aDp();
    return (this.dbr << 16) | this.rd16bank0(p);
  }
  aDpIndY(): number {
    const p = this.aDp();
    return (((this.dbr << 16) | this.rd16bank0(p)) + this.y) & 0xffffff;
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
    return (base + this.y) & 0xffffff;
  }
  aSr(): number {
    return (this.fetch8() + this.s) & 0xffff;
  }
  aSrIndY(): number {
    const p = (this.fetch8() + this.s) & 0xffff;
    return (((this.dbr << 16) | this.rd16bank0(p)) + this.y) & 0xffffff;
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
      this.cycles++;
      this.wrMdp(addr, op.call(this, v));
    } else {
      const v = this.rdM(addr);
      this.cycles++;
      this.wrM(addr, op.call(this, v));
    }
  }

  branch(cond: boolean): void {
    const off = this.fetch8();
    if (cond) {
      this.cycles++;
      this.pc = (this.pc + ((off << 24) >> 24)) & 0xffff;
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
      this.cycles += 4;
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
      this.cycles += 4;
      return;
    }
    this.opPc = (this.pbr << 16) | this.pc;
    const op = this.fetch8();
    this.exec(op);
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
      case 0x0a: this.cycles++; this.setA(this.asl(this.getA())); break;
      case 0x0e: this.rmw(this.aAbs(), false, this.asl); break;
      case 0x16: this.rmw(this.aDpX(), true, this.asl); break;
      case 0x1e: this.rmw(this.aAbsX(), false, this.asl); break;
      case 0x26: this.rmw(this.aDp(), true, this.rol); break;
      case 0x2a: this.cycles++; this.setA(this.rol(this.getA())); break;
      case 0x2e: this.rmw(this.aAbs(), false, this.rol); break;
      case 0x36: this.rmw(this.aDpX(), true, this.rol); break;
      case 0x3e: this.rmw(this.aAbsX(), false, this.rol); break;
      case 0x46: this.rmw(this.aDp(), true, this.lsr); break;
      case 0x4a: this.cycles++; this.setA(this.lsr(this.getA())); break;
      case 0x4e: this.rmw(this.aAbs(), false, this.lsr); break;
      case 0x56: this.rmw(this.aDpX(), true, this.lsr); break;
      case 0x5e: this.rmw(this.aAbsX(), false, this.lsr); break;
      case 0x66: this.rmw(this.aDp(), true, this.ror); break;
      case 0x6a: this.cycles++; this.setA(this.ror(this.getA())); break;
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
      case 0x1a: this.cycles++; this.setA(this.inc(this.getA())); break;
      case 0x3a: this.cycles++; this.setA(this.dec(this.getA())); break;
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
      case 0xe8: this.cycles++; this.setX(this.x + 1); this.nzX(this.x); break;
      case 0xc8: this.cycles++; this.setY(this.y + 1); this.nzX(this.y); break;
      case 0xca: this.cycles++; this.setX(this.x - 1); this.nzX(this.x); break;
      case 0x88: this.cycles++; this.setY(this.y - 1); this.nzX(this.y); break;

      // ---- transfers ----
      case 0xaa: this.cycles++; this.setX(this.a); this.nzX(this.x); break; // TAX
      case 0xa8: this.cycles++; this.setY(this.a); this.nzX(this.y); break; // TAY
      case 0x8a: this.cycles++; this.setA(this.x); this.nzM(this.getA()); break; // TXA
      case 0x98: this.cycles++; this.setA(this.y); this.nzM(this.getA()); break; // TYA
      case 0x9b: this.cycles++; this.setY(this.x); this.nzX(this.y); break; // TXY
      case 0xbb: this.cycles++; this.setX(this.y); this.nzX(this.x); break; // TYX
      case 0xba: this.cycles++; this.setX(this.s); this.nzX(this.x); break; // TSX
      case 0x9a: // TXS
        this.cycles++;
        this.s = this.e ? 0x100 | (this.x & 0xff) : this.x;
        break;
      case 0x5b: this.cycles++; this.d = this.a; this.nz16(this.d); break; // TCD
      case 0x7b: this.cycles++; this.a = this.d; this.nz16(this.a); break; // TDC
      case 0x1b: this.cycles++; this.s = this.e ? 0x100 | (this.a & 0xff) : this.a; break; // TCS
      case 0x3b: this.cycles++; this.a = this.s; this.nz16(this.a); break; // TSC
      case 0xeb: // XBA
        this.cycles += 2;
        this.a = ((this.a >> 8) | (this.a << 8)) & 0xffff;
        this.nz8(this.a & 0xff);
        break;

      // ---- stack ----
      case 0x48: this.cycles++; if (this.m8) this.push8(this.a); else this.push16(this.a); break; // PHA
      case 0x68: this.cycles += 2; if (this.m8) { v = this.pull8(); this.setA(v); } else { this.a = this.pull16(); } this.nzM(this.getA()); break; // PLA
      case 0xda: this.cycles++; if (this.x8) this.push8(this.x); else this.push16(this.x); break; // PHX
      case 0xfa: this.cycles += 2; this.x = this.x8 ? this.pull8() : this.pull16(); this.nzX(this.x); break; // PLX
      case 0x5a: this.cycles++; if (this.x8) this.push8(this.y); else this.push16(this.y); break; // PHY
      case 0x7a: this.cycles += 2; this.y = this.x8 ? this.pull8() : this.pull16(); this.nzX(this.y); break; // PLY
      case 0x08: this.cycles++; this.push8(this.p); break; // PHP
      case 0x28: this.cycles += 2; this.setP(this.pull8()); break; // PLP
      case 0x8b: this.cycles++; this.push8(this.dbr); break; // PHB
      case 0xab: this.cycles += 2; this.dbr = this.pull8(); this.nz8(this.dbr); break; // PLB
      case 0x4b: this.cycles++; this.push8(this.pbr); break; // PHK
      case 0x0b: this.cycles++; this.push16(this.d); break; // PHD
      case 0x2b: this.cycles += 2; this.d = this.pull16(); this.nz16(this.d); break; // PLD
      case 0xf4: this.push16(this.fetch16()); break; // PEA
      case 0xd4: a = this.aDp(); this.push16(this.rd16bank0(a)); break; // PEI
      case 0x62: v = this.fetch16(); this.push16((this.pc + v) & 0xffff); break; // PER

      // ---- flags ----
      case 0x18: this.cycles++; this.p &= ~FLAG_C; break;
      case 0x38: this.cycles++; this.p |= FLAG_C; break;
      case 0x58: this.cycles++; this.p &= ~FLAG_I; break;
      case 0x78: this.cycles++; this.p |= FLAG_I; break;
      case 0xb8: this.cycles++; this.p &= ~FLAG_V; break;
      case 0xd8: this.cycles++; this.p &= ~FLAG_D; break;
      case 0xf8: this.cycles++; this.p |= FLAG_D; break;
      case 0xc2: this.cycles++; this.setP(this.p & ~this.fetch8()); break; // REP
      case 0xe2: this.cycles++; this.setP(this.p | this.fetch8()); break; // SEP
      case 0xfb: { // XCE
        this.cycles++;
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
      case 0x82: v = this.fetch16(); this.pc = (this.pc + v) & 0xffff; this.cycles++; break; // BRL

      // ---- jumps ----
      case 0x4c: this.pc = this.fetch16(); break; // JMP abs
      case 0x5c: v = this.fetch24(); this.pc = v & 0xffff; this.pbr = v >> 16; break; // JML long
      case 0x6c: a = this.fetch16(); this.pc = this.rd16bank0(a); break; // JMP (abs)
      case 0x7c: a = this.fetch16(); this.pc = this.rd16((this.pbr << 16) | ((a + this.x) & 0xffff)); break; // JMP (abs,X)
      case 0xdc: // JML [abs]
        a = this.fetch16();
        this.pc = this.rd16bank0(a);
        this.pbr = this.rd((a + 2) & 0xffff);
        break;
      case 0x20: a = this.fetch16(); this.cycles++; this.push16((this.pc - 1) & 0xffff); this.pc = a; break; // JSR
      case 0xfc: // JSR (abs,X)
        a = this.fetch16();
        this.push16((this.pc - 1) & 0xffff);
        this.pc = this.rd16((this.pbr << 16) | ((a + this.x) & 0xffff));
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
      case 0x60: this.cycles += 3; this.pc = (this.pull16() + 1) & 0xffff; break; // RTS
      case 0x6b: this.cycles += 2; this.pc = (this.pull16() + 1) & 0xffff; this.pbr = this.pull8(); break; // RTL
      case 0x40: // RTI
        this.cycles += 2;
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
          this.cycles += 2;
          this.x = (this.x + inc) & mask;
          this.y = (this.y + inc) & mask;
          this.a = (this.a - 1) & 0xffff;
        } while (this.a !== 0xffff);
        break;
      }

      // ---- misc ----
      case 0xea: this.cycles++; break; // NOP
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
