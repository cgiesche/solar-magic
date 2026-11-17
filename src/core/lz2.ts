// Nintendo LC_LZ2 compression as used by Super Mario World (GFX files, BG tilemaps, ...).

// (src: any indexable bytes, e.g. a ROM read through a patch)
export function lz2Decompress(src: { readonly [i: number]: number }, offset: number): { data: Uint8Array; size: number } {
  let out = new Uint8Array(0x2000), n = 0; // grows; the bytes past n are 0
  let p = offset;
  for (;;) {
    const h = src[p++];
    if (h === 0xff) break;
    let cmd = h >> 5;
    let len: number;
    if (cmd === 7) {
      cmd = (h >> 2) & 7;
      len = (((h & 3) << 8) | src[p++]) + 1;
    } else {
      len = (h & 0x1f) + 1;
    }
    if (n + len > out.length) { const grown = new Uint8Array(Math.max(out.length * 2, n + len)); grown.set(out); out = grown; }
    switch (cmd) {
      case 0:
        for (let i = 0; i < len; i++) out[n++] = src[p++];
        break;
      case 1:
        out.fill(src[p++], n, n + len);
        n += len;
        break;
      case 2: {
        const a = src[p++], b = src[p++];
        for (let i = 0; i < len; i++) out[n++] = i & 1 ? b : a;
        break;
      }
      case 3: {
        let b = src[p++];
        for (let i = 0; i < len; i++) out[n++] = b++;
        break;
      }
      case 4: {
        const off = (src[p] << 8) | src[p + 1];
        p += 2;
        for (let i = 0; i < len; i++) out[n++] = out[off + i]; // past the output so far: 0
        break;
      }
      default:
        throw new Error(`LZ2: bad command ${cmd} at ${p - 1}`);
    }
    if (n > 0x40000) throw new Error('LZ2: output too large');
  }
  return { data: out.slice(0, n), size: p - offset };
}

const MAXLEN = 1024; // a command's longest length
const CHAIN = 64; // the back reference sources tried per position: the nearest ones before it with its 3 bytes

// Returns compressed stream including terminating $FF. Uses dynamic programming
// over positions to choose the cheapest command sequence: per position a byte fill, a word fill, an increasing
// fill and a back reference to each of the CHAIN nearest earlier places with the same 3 bytes (4 bytes and more), each
// at its full length and cut to 32 (a one byte header), and a direct copy of 1 to 41 bytes; the first of equally cheap
// ones in this order wins.
// Linear in the input (times CHAIN): no length is counted byte by byte – a fill's length at i is the one at i + 1
// plus one, and so is a back reference's from s to i when s + 1 is a source tried at i + 1 (the sources of both
// positions are walked together); only a source that is not (the chain cut at CHAIN) is compared.
export function lz2Compress(data: Uint8Array): Uint8Array {
  const n = data.length;
  const cost = new Int32Array(n + 1); // the bytes the cheapest commands for data[i..] take
  const cmdAt = new Uint8Array(n), lenAt = new Uint16Array(n), argAt = new Int32Array(n);
  // prev[i]: the nearest position before i with the same 3 bytes, -1: none (also without 3 bytes at i). The last
  // position per key in an open hash table (slot: position + 1, 0: free)
  const prev = new Int32Array(n).fill(-1);
  if (n > 2) {
    let bits = 4;
    while ((1 << bits) < n * 2) bits++;
    const slots = new Int32Array(1 << bits), mask = (1 << bits) - 1;
    for (let i = 0; i + 2 < n; i++) {
      const b0 = data[i], b1 = data[i + 1], b2 = data[i + 2];
      let h = (Math.imul(b0 | (b1 << 8) | (b2 << 16), 0x9e3779b1) >>> (32 - bits)) & mask;
      for (;;) {
        const s = slots[h] - 1;
        if (s < 0) break;
        if (data[s] === b0 && data[s + 1] === b1 && data[s + 2] === b2) { prev[i] = s; break; }
        h = (h + 1) & mask;
      }
      slots[h] = i + 1;
    }
  }
  // the sources tried at the position after this one (nearest first) and their lengths, and this position's
  let nextSrc = new Int32Array(CHAIN), nextLen = new Int32Array(CHAIN), nextCount = 0;
  let curSrc = new Int32Array(CHAIN), curLen = new Int32Array(CHAIN);
  let fill = 0, word = 0, inc = 0; // the fills' lengths at the position after this one
  for (let i = n - 1; i >= 0; i--) {
    const rest = n - i, d = data[i];
    let best = 0x7fffffff, bc = 0, bl = 1, ba = 0;
    // byte fill
    fill = rest > 1 && data[i + 1] === d ? (fill < MAXLEN ? fill + 1 : MAXLEN) : 1;
    if (fill > 1) {
      let c = (fill > 32 ? 3 : 2) + cost[i + fill];
      if (c < best) { best = c; bc = 1; bl = fill; }
      if (fill > 32 && (c = 2 + cost[i + 32]) < best) { best = c; bc = 1; bl = 32; }
    }
    // word fill
    if (rest > 1) {
      word = rest > 2 && data[i + 2] === d ? (word < MAXLEN ? word + 1 : MAXLEN) : 2;
      if (word > 2) {
        let c = (word > 32 ? 4 : 3) + cost[i + word];
        if (c < best) { best = c; bc = 2; bl = word; }
        if (word > 32 && (c = 3 + cost[i + 32]) < best) { best = c; bc = 2; bl = 32; }
      }
    }
    // increasing fill
    inc = rest > 1 && data[i + 1] === ((d + 1) & 0xff) ? (inc < MAXLEN ? inc + 1 : MAXLEN) : 1;
    if (inc > 1) {
      let c = (inc > 32 ? 3 : 2) + cost[i + inc];
      if (c < best) { best = c; bc = 3; bl = inc; }
      if (inc > 32 && (c = 2 + cost[i + 32]) < best) { best = c; bc = 3; bl = 32; }
    }
    // back reference
    let count = 0;
    for (let s = prev[i], k = 0; s >= 0 && count < CHAIN; s = prev[s]) {
      while (k < nextCount && nextSrc[k] > s + 1) k++;
      let m: number;
      if (k < nextCount && nextSrc[k] === s + 1) {
        m = nextLen[k] + 1;
        if (m > MAXLEN) m = MAXLEN;
      } else {
        m = 3;
        const max = rest < MAXLEN ? rest : MAXLEN;
        while (m < max && data[s + m] === data[i + m]) m++;
      }
      curSrc[count] = s; curLen[count++] = m;
      if (m >= 4) {
        let c = (m > 32 ? 4 : 3) + cost[i + m];
        if (c < best) { best = c; bc = 4; bl = m; ba = s; }
        if (m > 32 && (c = 3 + cost[i + 32]) < best) { best = c; bc = 4; bl = 32; ba = s; }
      }
    }
    let t = nextSrc; nextSrc = curSrc; curSrc = t;
    t = nextLen; nextLen = curLen; curLen = t;
    nextCount = count;
    // direct copy (long ones are rare: up to 41 bytes)
    const lits = rest < 41 ? rest : 41;
    for (let len = 1; len <= lits; len++) {
      const c = (len > 32 ? 2 : 1) + len + cost[i + len];
      if (c < best) { best = c; bc = 0; bl = len; }
    }
    cost[i] = best;
    cmdAt[i] = bc; lenAt[i] = bl; argAt[i] = ba;
  }
  const out = new Uint8Array((n ? cost[0] : 0) + 1);
  let o = 0;
  for (let i = 0; i < n;) {
    const cmd = cmdAt[i], len = lenAt[i], L = len - 1;
    if (len > 32) { out[o++] = 0xe0 | (cmd << 2) | (L >> 8); out[o++] = L & 0xff; }
    else out[o++] = (cmd << 5) | L;
    switch (cmd) {
      case 0: out.set(data.subarray(i, i + len), o); o += len; break;
      case 1: case 3: out[o++] = data[i]; break;
      case 2: out[o++] = data[i]; out[o++] = data[i + 1]; break;
      case 4: out[o++] = argAt[i] >> 8; out[o++] = argAt[i] & 0xff; break;
    }
    i += len;
  }
  out[o] = 0xff;
  return out;
}
