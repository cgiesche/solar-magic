// SNES tile/palette helpers.

// Decode an 8x8 tile in SNES planar format into 64 color indices.
// bpp: 2, 3 (SMW packed 3bpp, 24 bytes/tile), 4 or 8.
export function decodeTile(src: Uint8Array, off: number, bpp: number, out: Uint8Array, outOff = 0): void {
  for (let y = 0; y < 8; y++) {
    const p0 = src[off + y * 2] ?? 0;
    const p1 = src[off + y * 2 + 1] ?? 0;
    let p2 = 0, p3 = 0, p4 = 0, p5 = 0, p6 = 0, p7 = 0;
    if (bpp === 3) {
      p2 = src[off + 16 + y] ?? 0;
    } else if (bpp >= 4) {
      p2 = src[off + 16 + y * 2] ?? 0;
      p3 = src[off + 16 + y * 2 + 1] ?? 0;
      if (bpp === 8) {
        p4 = src[off + 32 + y * 2] ?? 0;
        p5 = src[off + 32 + y * 2 + 1] ?? 0;
        p6 = src[off + 48 + y * 2] ?? 0;
        p7 = src[off + 48 + y * 2 + 1] ?? 0;
      }
    }
    for (let x = 0; x < 8; x++) {
      const s = 7 - x;
      out[outOff + y * 8 + x] =
        ((p0 >> s) & 1) | (((p1 >> s) & 1) << 1) | (((p2 >> s) & 1) << 2) | (((p3 >> s) & 1) << 3) |
        (((p4 >> s) & 1) << 4) | (((p5 >> s) & 1) << 5) | (((p6 >> s) & 1) << 6) | (((p7 >> s) & 1) << 7);
    }
  }
}

// Encode 64 color indices into planar SNES format.
export function encodeTile(pix: Uint8Array, pixOff: number, bpp: number, dst: Uint8Array, off: number): void {
  for (let y = 0; y < 8; y++) {
    let p = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < 8; x++) {
      const c = pix[pixOff + y * 8 + x];
      for (let b = 0; b < 8; b++) if (c & (1 << b)) p[b] |= 0x80 >> x;
    }
    dst[off + y * 2] = p[0];
    dst[off + y * 2 + 1] = p[1];
    if (bpp === 3) dst[off + 16 + y] = p[2];
    else if (bpp >= 4) {
      dst[off + 16 + y * 2] = p[2];
      dst[off + 16 + y * 2 + 1] = p[3];
      if (bpp === 8) {
        dst[off + 32 + y * 2] = p[4];
        dst[off + 32 + y * 2 + 1] = p[5];
        dst[off + 48 + y * 2] = p[6];
        dst[off + 48 + y * 2 + 1] = p[7];
      }
    }
    p = p;
  }
}

export function tileBytes(bpp: number): number {
  return bpp * 8;
}

// BGR555 → packed RGBA (little-endian ABGR for Uint32Array over ImageData)
export function snesColorToRGBA(c: number): number {
  const r = c & 0x1f, g = (c >> 5) & 0x1f, b = (c >> 10) & 0x1f;
  const R = (r << 3) | (r >> 2), G = (g << 3) | (g >> 2), B = (b << 3) | (b >> 2);
  return (0xff000000 | (B << 16) | (G << 8) | R) >>> 0;
}

export function rgbToSnes(r: number, g: number, b: number): number {
  return (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
}

export function cgramToRGBA(cgram: Uint8Array): Uint32Array {
  const out = new Uint32Array(256);
  for (let i = 0; i < 256; i++) out[i] = snesColorToRGBA(cgram[i * 2] | (cgram[i * 2 + 1] << 8));
  return out;
}
