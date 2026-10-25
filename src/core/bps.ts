// BPS patches (byuu's format, as created and applied by Floating IPS / Flips): the changes from a
// source ROM to a target ROM. Encoded greedily: unchanged runs as SourceRead, otherwise the longest
// match found through a hash of 4-byte sequences in the source (SourceCopy) or in the target written
// so far (TargetCopy, may overlap – runs of one byte), else literal bytes (TargetRead).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(d: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const MIN_MATCH = 4;
const HASH_BITS = 16;
const CHAIN = 32;

function hash4(d: Uint8Array, i: number): number {
  return (Math.imul(d[i] | d[i + 1] << 8 | d[i + 2] << 16 | d[i + 3] << 24, 0x9e3779b1) >>> (32 - HASH_BITS));
}

// positions of 4-byte sequences, newest first per hash (head/next chains)
class Index {
  head = new Int32Array(1 << HASH_BITS).fill(-1);
  next: Int32Array;
  d: Uint8Array;
  constructor(d: Uint8Array) { this.d = d; this.next = new Int32Array(d.length); }
  add(i: number): void {
    if (i + MIN_MATCH > this.d.length) return;
    const h = hash4(this.d, i);
    this.next[i] = this.head[h];
    this.head[h] = i;
  }
}

export function createBps(source: Uint8Array, target: Uint8Array, metadata = ''): Uint8Array {
  const out: number[] = [];
  const num = (v: number) => {
    for (;;) {
      const x = v % 128;
      v = Math.floor(v / 128);
      if (v === 0) { out.push(0x80 | x); return; }
      out.push(x);
      v--;
    }
  };
  const meta = new TextEncoder().encode(metadata);
  out.push(0x42, 0x50, 0x53, 0x31); // "BPS1"
  num(source.length); num(target.length); num(meta.length);
  for (const b of meta) out.push(b);

  const src = new Index(source);
  for (let i = 0; i + MIN_MATCH <= source.length; i++) src.add(i);
  const tgt = new Index(target);

  let srcRel = 0, tgtRel = 0; // relative offsets of SourceCopy / TargetCopy
  let lit = -1; // start of pending literal bytes
  const flushLit = (end: number) => {
    if (lit < 0) return;
    num(((end - lit - 1) << 2) | 1);
    for (let k = lit; k < end; k++) out.push(target[k]);
    lit = -1;
  };
  const matchLen = (a: Uint8Array, ai: number, i: number) => {
    let n = 0;
    while (i + n < target.length && ai + n < a.length && a[ai + n] === target[i + n]) n++;
    return n;
  };

  let i = 0;
  while (i < target.length) {
    // same bytes at the same place
    let run = 0;
    while (i + run < target.length && i + run < source.length && source[i + run] === target[i + run]) run++;
    let best = 0, bestAt = 0, bestKind = 0; // 2 = SourceCopy, 3 = TargetCopy
    if (run < 64 && i + MIN_MATCH <= target.length) {
      const h = hash4(target, i);
      for (let p = src.head[h], c = 0; p >= 0 && c < CHAIN; p = src.next[p], c++) {
        const n = matchLen(source, p, i);
        if (n > best) { best = n; bestAt = p; bestKind = 2; }
      }
      for (let p = tgt.head[h], c = 0; p >= 0 && c < CHAIN; p = tgt.next[p], c++) {
        const n = matchLen(target, p, i);
        if (n > best) { best = n; bestAt = p; bestKind = 3; }
      }
    }
    let len: number;
    if (run >= MIN_MATCH && run >= best) {
      flushLit(i);
      num(((run - 1) << 2) | 0);
      len = run;
    } else if (best >= MIN_MATCH) {
      flushLit(i);
      num(((best - 1) << 2) | bestKind);
      const rel = bestKind === 2 ? bestAt - srcRel : bestAt - tgtRel;
      num((Math.abs(rel) << 1) | (rel < 0 ? 1 : 0));
      if (bestKind === 2) srcRel = bestAt + best; else tgtRel = bestAt + best;
      len = best;
    } else {
      if (lit < 0) lit = i;
      len = 1;
    }
    for (let k = i; k < i + len; k++) tgt.add(k);
    i += len;
  }
  flushLit(i);

  const u32 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
  u32(crc32(source)); u32(crc32(target));
  u32(crc32(Uint8Array.from(out)));
  return Uint8Array.from(out);
}

// a BPS patch's target read byte by byte without applying it, for a patch whose source is not at hand
// as a whole: byte(o, source) asks `source` for the bytes the patch takes from the source (null: not
// known) and is null when the target's byte depends on one of those. Null when it is no BPS patch.
export interface BpsReader {
  sourceSize: number;
  targetSize: number;
  sourceCrc: number;
  byte(o: number, source: (o: number) => number | null): number | null;
}
export function bpsReader(patch: Uint8Array): BpsReader | null {
  if (patch.length < 19 || String.fromCharCode(...patch.subarray(0, 4)) !== 'BPS1') return null;
  let p = 4;
  const num = () => {
    let v = 0, shift = 1;
    for (;;) {
      if (p >= patch.length) throw new Error('BPS patch truncated');
      const x = patch[p++];
      v += (x & 0x7f) * shift;
      if (x & 0x80) return v;
      shift *= 128;
      v += shift;
    }
  };
  const end = patch.length - 12;
  // per action: the target offset it starts at, its kind and where it reads (patch offset for
  // TargetRead, source offset for SourceCopy, target offset for TargetCopy)
  const starts: number[] = [], kinds: number[] = [], froms: number[] = [];
  let sourceSize: number, targetSize: number;
  try {
    sourceSize = num(); targetSize = num();
    const meta = num();
    p += meta;
    let o = 0, srcRel = 0, tgtRel = 0;
    while (p < end) {
      const d = num(), len = (d >> 2) + 1, kind = d & 3;
      let from = o;
      if (kind === 1) { from = p; p += len; }
      if (kind === 2) { const r = num(); srcRel += (r & 1 ? -1 : 1) * (r >> 1); from = srcRel; srcRel += len; }
      if (kind === 3) { const r = num(); tgtRel += (r & 1 ? -1 : 1) * (r >> 1); from = tgtRel; tgtRel += len; }
      starts.push(o); kinds.push(kind); froms.push(from);
      o += len;
    }
    if (o !== targetSize || p !== end) return null;
  } catch { return null; }
  const rd = (q: number) => (patch[q] | patch[q + 1] << 8 | patch[q + 2] << 16 | patch[q + 3] << 24) >>> 0;
  return {
    sourceSize, targetSize, sourceCrc: rd(end),
    byte(o, source) {
      if (o < 0 || o >= targetSize) return null;
      for (;;) {
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= o) lo = m; else hi = m - 1; }
        const k = o - starts[lo];
        switch (kinds[lo]) {
          case 0: return source(o);
          case 1: return patch[froms[lo] + k];
          case 2: return source(froms[lo] + k);
          // (a copy overlapping itself repeats the bytes before it)
          default:
            if (froms[lo] >= starts[lo]) return null;
            o = froms[lo] + k % (starts[lo] - froms[lo]);
        }
      }
    },
  };
}

// applies a BPS patch (used to check created patches)
export function applyBps(source: Uint8Array, patch: Uint8Array): Uint8Array {
  let p = 4;
  const num = () => {
    let v = 0, shift = 1;
    for (;;) {
      const x = patch[p++];
      v += (x & 0x7f) * shift;
      if (x & 0x80) return v;
      shift *= 128;
      v += shift;
    }
  };
  if (String.fromCharCode(...patch.subarray(0, 4)) !== 'BPS1') throw new Error('not a BPS patch');
  const srcSize = num(), tgtSize = num(), metaSize = num();
  if (srcSize !== source.length) throw new Error('source size mismatch');
  p += metaSize;
  const target = new Uint8Array(tgtSize);
  let o = 0, srcRel = 0, tgtRel = 0;
  const end = patch.length - 12;
  while (p < end) {
    const d = num(), len = (d >> 2) + 1;
    switch (d & 3) {
      case 0: for (let k = 0; k < len; k++, o++) target[o] = source[o]; break;
      case 1: for (let k = 0; k < len; k++) target[o++] = patch[p++]; break;
      case 2: { const r = num(); srcRel += (r & 1 ? -1 : 1) * (r >> 1); for (let k = 0; k < len; k++) target[o++] = source[srcRel++]; break; }
      case 3: { const r = num(); tgtRel += (r & 1 ? -1 : 1) * (r >> 1); for (let k = 0; k < len; k++) target[o++] = target[tgtRel++]; break; }
    }
  }
  const rd = (q: number) => (patch[q] | patch[q + 1] << 8 | patch[q + 2] << 16 | patch[q + 3] << 24) >>> 0;
  if (rd(end + 4) !== crc32(target)) throw new Error('target checksum mismatch');
  return target;
}
