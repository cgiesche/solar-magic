// SMW's RLE format (overworld layer 2, level BG tilemaps): control byte n, bit 7 set =
// repeat the next byte (n & $7F) + 1 times, else copy n + 1 literal bytes.

export function rleDecode(src: Uint8Array, off: number, out: Uint16Array, shift: number, count: number): number {
  let p = off, n = 0;
  while (n < count) {
    const c = src[p++];
    if (c & 0x80) {
      const v = src[p++];
      for (let i = 0; i <= (c & 0x7f) && n < count; i++) out[n++] |= v << shift;
    } else {
      for (let i = 0; i <= c && n < count; i++) out[n++] |= src[p++] << shift;
    }
  }
  return p - off;
}

// optimal RLE (dynamic programming over literal/repeat runs of up to 128)
// noEndMark: never emit a chunk starting with FF FF (end mark of the level BG decoder at $058126)
export function rleEncode(vals: number[], noEndMark = false): number[] {
  const n = vals.length;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const how = new Int16Array(n + 1); // >0 literal length, <0 repeat length
  cost[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    let r = 1;
    const maxRun = noEndMark && vals[i] === 0xff ? 127 : 128;
    while (i + r < n && r < maxRun && vals[i + r] === vals[i]) r++;
    for (let k = 2; k <= r; k++) {
      const c = 2 + cost[i + k];
      if (c < cost[i]) { cost[i] = c; how[i] = -k; }
    }
    for (let L = 1; L <= 128 && i + L <= n; L++) {
      const c = 1 + L + cost[i + L];
      if (c < cost[i]) { cost[i] = c; how[i] = L; }
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n;) {
    const k = how[i];
    if (k < 0) { out.push(0x80 | (-k - 1), vals[i]); i += -k; }
    else { out.push(k - 1); for (let j = 0; j < k; j++) out.push(vals[i + j]); i += k; }
  }
  return out;
}
