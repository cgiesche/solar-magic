// Nintendo LC_LZ2 compression as used by Super Mario World (GFX files, BG tilemaps, ...).

// (src: any indexable bytes, e.g. a ROM read through a patch)
export function lz2Decompress(src: { readonly [i: number]: number }, offset: number): { data: Uint8Array; size: number } {
  const out: number[] = [];
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
    switch (cmd) {
      case 0:
        for (let i = 0; i < len; i++) out.push(src[p++]);
        break;
      case 1: {
        const b = src[p++];
        for (let i = 0; i < len; i++) out.push(b);
        break;
      }
      case 2: {
        const a = src[p++], b = src[p++];
        for (let i = 0; i < len; i++) out.push(i & 1 ? b : a);
        break;
      }
      case 3: {
        let b = src[p++];
        for (let i = 0; i < len; i++) out.push(b++ & 0xff);
        break;
      }
      case 4: {
        const off = (src[p] << 8) | src[p + 1];
        p += 2;
        for (let i = 0; i < len; i++) out.push(out[off + i] ?? 0);
        break;
      }
      default:
        throw new Error(`LZ2: bad command ${cmd} at ${p - 1}`);
    }
    if (out.length > 0x40000) throw new Error('LZ2: output too large');
  }
  return { data: new Uint8Array(out), size: p - offset };
}

// Returns compressed stream including terminating $FF. Uses dynamic programming
// over positions to choose the cheapest command sequence.
export function lz2Compress(data: Uint8Array): Uint8Array {
  const n = data.length;
  const MAXLEN = 1024;
  // candidate best match at each position for each command
  const cost = new Float64Array(n + 1).fill(Infinity);
  const choice: { cmd: number; len: number; arg: number }[] = new Array(n + 1);
  cost[n] = 0;
  // hash chains for back references (3-byte keys)
  const head = new Map<number, number[]>();
  const positions: number[][] = new Array(n);
  for (let i = 0; i + 2 < n; i++) {
    const key = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16);
    let list = head.get(key);
    if (!list) { list = []; head.set(key, list); }
    positions[i] = list.slice(-64);
    list.push(i);
  }
  const hdr = (len: number) => (len > 32 ? 2 : 1);
  for (let i = n - 1; i >= 0; i--) {
    let best = Infinity;
    let bc = { cmd: 0, len: 1, arg: 0 };
    // byte fill
    let l = 1;
    while (i + l < n && l < MAXLEN && data[i + l] === data[i]) l++;
    for (const len of l > 1 ? [l, Math.min(l, 32)] : []) {
      const c = hdr(len) + 1 + cost[i + len];
      if (c < best) { best = c; bc = { cmd: 1, len, arg: 0 }; }
    }
    // word fill
    if (i + 1 < n) {
      l = 2;
      while (i + l < n && l < MAXLEN && data[i + l] === data[i + (l & 1)]) l++;
      if (l > 2) for (const len of [l, Math.min(l, 32)]) {
        const c = hdr(len) + 2 + cost[i + len];
        if (c < best) { best = c; bc = { cmd: 2, len, arg: 0 }; }
      }
    }
    // increasing fill
    l = 1;
    while (i + l < n && l < MAXLEN && data[i + l] === ((data[i] + l) & 0xff)) l++;
    if (l > 1) for (const len of [l, Math.min(l, 32)]) {
      const c = hdr(len) + 1 + cost[i + len];
      if (c < best) { best = c; bc = { cmd: 3, len, arg: 0 }; }
    }
    // back reference
    const cand = positions[i];
    if (cand) {
      for (let k = cand.length - 1; k >= 0; k--) {
        const s = cand[k];
        let m = 0;
        while (i + m < n && m < MAXLEN && data[s + m] === data[i + m]) m++;
        if (m >= 4) for (const len of [m, Math.min(m, 32)]) {
          const c = hdr(len) + 2 + cost[i + len];
          if (c < best) { best = c; bc = { cmd: 4, len, arg: s }; }
        }
      }
    }
    // direct copy: try extending from i over a few lengths (cost accounting per run)
    for (let len = 1; len <= Math.min(MAXLEN, n - i); len++) {
      const c = hdr(len) + len + cost[i + len];
      if (c < best) { best = c; bc = { cmd: 0, len, arg: 0 }; }
      if (len > 40) break; // long literal runs are rare; stop early for speed
    }
    cost[i] = best;
    choice[i] = bc;
  }
  const out: number[] = [];
  let i = 0;
  while (i < n) {
    const { cmd, len, arg } = choice[i];
    const L = len - 1;
    if (len > 32) { out.push(0xe0 | (cmd << 2) | (L >> 8), L & 0xff); }
    else out.push((cmd << 5) | L);
    switch (cmd) {
      case 0: for (let k = 0; k < len; k++) out.push(data[i + k]); break;
      case 1: out.push(data[i]); break;
      case 2: out.push(data[i], data[i + 1]); break;
      case 3: out.push(data[i]); break;
      case 4: out.push(arg >> 8, arg & 0xff); break;
    }
    i += len;
  }
  out.push(0xff);
  return new Uint8Array(out);
}
