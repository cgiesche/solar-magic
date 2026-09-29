// Minimal 65816 "assembler": raw bytes plus labels for branches and long addresses.

type Fix = { at: number; label: string; kind: 'rel8' | 'long' | 'abs' | 'bank' };

export class Asm {
  bytes: number[] = [];
  labels = new Map<string, number>();
  fixes: Fix[] = [];

  get pc(): number {
    return this.bytes.length;
  }
  b(...v: number[]): this {
    for (const x of v) this.bytes.push(x & 0xff);
    return this;
  }
  w(v: number): this {
    return this.b(v, v >> 8);
  }
  l(v: number): this {
    return this.b(v, v >> 8, v >> 16);
  }
  label(name: string): this {
    this.labels.set(name, this.pc);
    return this;
  }
  // branch opcode with 8-bit displacement to label
  br(op: number, label: string): this {
    this.b(op, 0);
    this.fixes.push({ at: this.pc - 1, label, kind: 'rel8' });
    return this;
  }
  // opcode followed by 24-bit address of a label (in this block)
  long(op: number, label: string): this {
    this.b(op, 0, 0, 0);
    this.fixes.push({ at: this.pc - 3, label, kind: 'long' });
    return this;
  }
  // opcode followed by 16-bit address of a label
  abs(op: number, label: string): this {
    this.b(op, 0, 0);
    this.fixes.push({ at: this.pc - 2, label, kind: 'abs' });
    return this;
  }
  // immediate 8-bit bank byte of a label
  bankImm(op: number, label: string): this {
    this.b(op, 0);
    this.fixes.push({ at: this.pc - 1, label, kind: 'bank' });
    return this;
  }
  fill(n: number, v = 0): this {
    for (let i = 0; i < n; i++) this.bytes.push(v);
    return this;
  }
  addrOf(label: string, base: number): number {
    const o = this.labels.get(label);
    if (o === undefined) throw new Error(`asm: unknown label ${label}`);
    return base + o;
  }
  link(base: number): Uint8Array {
    const out = Uint8Array.from(this.bytes);
    for (const f of this.fixes) {
      const t = this.labels.get(f.label);
      if (t === undefined) throw new Error(`asm: unknown label ${f.label}`);
      const a = base + t;
      if (f.kind === 'rel8') {
        const d = t - (f.at + 1);
        if (d < -128 || d > 127) throw new Error(`asm: branch to ${f.label} out of range`);
        out[f.at] = d & 0xff;
      } else if (f.kind === 'long') {
        out[f.at] = a & 0xff; out[f.at + 1] = (a >> 8) & 0xff; out[f.at + 2] = (a >> 16) & 0xff;
      } else if (f.kind === 'abs') {
        out[f.at] = a & 0xff; out[f.at + 1] = (a >> 8) & 0xff;
      } else {
        out[f.at] = (a >> 16) & 0xff;
      }
    }
    return out;
  }
}
