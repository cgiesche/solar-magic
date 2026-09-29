// ROM container: LoROM address mapping, header handling, expansion, checksum
// and RATS-tag based free space management.

export const MAX_ROM_SIZE = 0x400000;
// Offsets reachable only through banks $FE/$FF are reserved for the editor's
// emulation overlay, so we never allocate data there.
export const RESERVED_TOP = 0x3f0000;

export function snesToPc(addr: number): number {
  const bank = (addr >> 16) & 0x7f;
  return (bank << 15) | (addr & 0x7fff);
}
export function pcToSnes(off: number): number {
  const bank = off >> 15;
  let a = (bank << 16) | 0x8000 | (off & 0x7fff);
  if (bank >= 0x40) a |= 0x800000; // use FastROM mirror for banks beyond $3F
  return a;
}

export interface RatsBlock {
  start: number; // offset of "STAR"
  size: number; // payload size
}

export class Rom {
  data: Uint8Array;
  smcHeader: Uint8Array | null;

  constructor(file: Uint8Array) {
    const hdr = file.length % 0x8000;
    this.smcHeader = hdr === 512 ? file.slice(0, 512) : null;
    this.data = file.slice(hdr);
  }

  get size(): number {
    return this.data.length;
  }

  r8(snes: number): number {
    return this.data[snesToPc(snes)];
  }
  r16(snes: number): number {
    const o = snesToPc(snes);
    return this.data[o] | (this.data[o + 1] << 8);
  }
  r24(snes: number): number {
    const o = snesToPc(snes);
    return this.data[o] | (this.data[o + 1] << 8) | (this.data[o + 2] << 16);
  }
  w8(snes: number, v: number): void {
    this.data[snesToPc(snes)] = v & 0xff;
  }
  w16(snes: number, v: number): void {
    const o = snesToPc(snes);
    this.data[o] = v & 0xff;
    this.data[o + 1] = (v >> 8) & 0xff;
  }
  w24(snes: number, v: number): void {
    const o = snesToPc(snes);
    this.data[o] = v & 0xff;
    this.data[o + 1] = (v >> 8) & 0xff;
    this.data[o + 2] = (v >> 16) & 0xff;
  }
  bytes(snes: number, len: number): Uint8Array {
    const o = snesToPc(snes);
    return this.data.slice(o, o + len);
  }
  writeBytes(snes: number, b: Uint8Array): void {
    this.data.set(b, snesToPc(snes));
  }

  title(): string {
    return String.fromCharCode(...this.data.subarray(0x7fc0, 0x7fd5)).trim();
  }

  // ---------- expansion ----------
  expand(newSize: number): void {
    if (newSize <= this.data.length) return;
    if (newSize > MAX_ROM_SIZE) throw new Error('ROM size limit is 4 MB');
    const d = new Uint8Array(newSize);
    d.set(this.data);
    this.data = d;
    // header ROM size byte: 2^n KB
    let n = 0;
    while ((1 << n) * 1024 < newSize) n++;
    this.data[0x7fd7] = n;
  }

  fixChecksum(): void {
    const d = this.data;
    // SNES checksum: sum of all bytes; non power-of-two sizes mirror the upper part
    let pow = 1;
    while (pow * 2 <= d.length) pow *= 2;
    let sum = 0;
    d[0x7fdc] = 0xff; d[0x7fdd] = 0xff; d[0x7fde] = 0; d[0x7fdf] = 0;
    for (let i = 0; i < pow; i++) sum += d[i];
    if (pow < d.length) {
      const rest = d.length - pow;
      let part = 0;
      for (let i = pow; i < d.length; i++) part += d[i];
      sum += part * (pow / rest);
    }
    sum &= 0xffff;
    d[0x7fde] = sum & 0xff; d[0x7fdf] = sum >> 8;
    d[0x7fdc] = ~sum & 0xff; d[0x7fdd] = (~sum >> 8) & 0xff;
  }

  output(withHeader: boolean): Uint8Array {
    this.fixChecksum();
    if (!withHeader) return this.data.slice();
    const out = new Uint8Array(this.data.length + 512);
    if (this.smcHeader) out.set(this.smcHeader);
    out.set(this.data, 512);
    return out;
  }

  // ---------- RATS ----------
  isRatsAt(off: number): number {
    const d = this.data;
    if (d[off] !== 0x53 || d[off + 1] !== 0x54 || d[off + 2] !== 0x41 || d[off + 3] !== 0x52) return -1;
    const s = d[off + 4] | (d[off + 5] << 8);
    const inv = d[off + 6] | (d[off + 7] << 8);
    if ((s ^ inv) !== 0xffff) return -1;
    return s + 1;
  }

  scanRats(): RatsBlock[] {
    const out: RatsBlock[] = [];
    const d = this.data;
    for (let i = 0x80000; i < d.length - 8; i++) {
      if (d[i] !== 0x53) continue;
      const size = this.isRatsAt(i);
      if (size > 0) {
        out.push({ start: i, size });
        i += 7 + size;
      }
    }
    return out;
  }

  // Find free space of `len` bytes (+8 for RATS) not crossing a bank boundary,
  // in expanded area (>= 0x80000). Free = not covered by a RATS block and all bytes
  // are 0x00 or 0xFF-filled region that was never claimed.
  findFree(len: number, used?: RatsBlock[]): number {
    const total = len + 8;
    if (total > 0x8000) throw new Error('block larger than one bank');
    const blocks = used ?? this.scanRats();
    const occupied = new Uint8Array(Math.ceil(this.data.length / 16));
    for (const b of blocks) {
      for (let o = b.start; o < b.start + 8 + b.size; o += 16) occupied[o >> 4] = 1;
      occupied[(b.start + 8 + b.size - 1) >> 4] = 1;
    }
    const limit = Math.min(this.data.length, RESERVED_TOP);
    for (let bank = 0x10; bank * 0x8000 < limit; bank++) {
      let run = 0;
      let runStart = bank * 0x8000;
      for (let o = bank * 0x8000; o < (bank + 1) * 0x8000 && o < limit; o += 16) {
        if (occupied[o >> 4]) { run = 0; runStart = o + 16; continue; }
        run += 16;
        if (run >= total + 16) return runStart;
      }
    }
    return -1;
  }

  // Write data with RATS tag in free space; returns SNES address of payload.
  // Expands the ROM if necessary.
  allocWrite(payload: Uint8Array): number {
    let off = this.findFree(payload.length);
    while (off < 0) {
      if (this.data.length >= MAX_ROM_SIZE) throw new Error('ROM is full');
      this.expand(Math.min(MAX_ROM_SIZE, Math.max(0x100000, this.data.length * 2)));
      off = this.findFree(payload.length);
    }
    const s = payload.length - 1;
    const d = this.data;
    d.set([0x53, 0x54, 0x41, 0x52, s & 0xff, s >> 8, ~s & 0xff, (~s >> 8) & 0xff], off);
    d.set(payload, off + 8);
    return pcToSnes(off + 8);
  }

  // Free a RATS-protected block whose payload starts at SNES address `addr`.
  // Returns true if it was a RATS block.
  freeAt(addr: number): boolean {
    const off = snesToPc(addr) - 8;
    if (off < 0x80000) return false;
    const size = this.isRatsAt(off);
    if (size < 0) return false;
    this.data.fill(0, off, off + 8 + size);
    return true;
  }
}
