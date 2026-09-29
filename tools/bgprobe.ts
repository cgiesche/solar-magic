import { readFileSync } from 'node:fs';
import { Snes } from '../src/core/snes.ts';
import { hex } from '../src/core/disasm.ts';
const raw = readFileSync('Super Mario World (U) [!].smc');
const rom = new Uint8Array(raw.subarray(raw.length % 0x8000));
const snes = new Snes(rom); snes.reset();
while (snes.wram[0x100] !== 0x07) snes.runFrame();
const level = parseInt(process.argv[2] ?? '105', 16); const w = snes.wram;
w[0x141a] = 1; w[0x95] = 0; w[0x97] = 0; w[0x5b] = 0; w[0x19b8] = level & 0xff; w[0x0dd6] = 0; w[0x1f11] = (level >> 8) & 1; w[0x1b93] = 0; w[0x100] = 0x11;
while (w[0x100] !== 0x14) snes.runFrame();
const bg2sc = snes.ppuRegs[0x08]; const base = (bg2sc & 0xfc) << 9; // byte address = word<<1 ; word addr = (sc&0xfc)<<8
console.log('bg2sc', hex(bg2sc,2), 'bg1sc', hex(snes.ppuRegs[7],2), 'bg12nba', hex(snes.ppuRegs[0xb],2),'bg34',hex(snes.ppuRegs[0xc],2),'mode',hex(snes.ppuRegs[5],2), 'l2ptr', hex(w[0x68]|w[0x69]<<8|w[0x6a]<<16,6));
const vw = (wa: number) => snes.vram[(wa*2)&0xffff] | (snes.vram[(wa*2+1)&0xffff] << 8);
const wbase = (bg2sc & 0xfc) << 8;
for (let ty = 16; ty < 27; ty+=2) for (let tx = 0; tx < 16; tx+=5) {
  const r0=(ty*2)%32, r1=(ty*2+1)%32; const e = [vw(wbase + r0*32 + tx*2), vw(wbase + r1*32 + tx*2), vw(wbase + r0*32 + tx*2+1), vw(wbase + r1*32 + tx*2+1)];
  const bt = w[0xb900 + ty*16 + tx] | (w[0xbd00 + ty*16+tx] << 8);
  // search rom
  const hits: string[] = [];
  for (let o = 0; o < rom.length - 8; o += 2) { let ok = true; for (let k = 0; k < 4; k++) if ((rom[o+k*2] | rom[o+k*2+1]<<8) !== e[k]) { ok = false; break; } if (ok) hits.push(hex(o,6)); if (hits.length>3) break; }
  console.log(tx, ty, 'bgtile', hex(bt,3), e.map(v=>hex(v,4)).join(' '), 'rom@', hits.join(','));
}
console.log('--- search');
for (const T of [0x09, 0x0e, 0x25, 0x16, 0x18]) {
  const o = 0x069100 + T * 8;
  const e = [0,1,2,3].map(k => rom[o+k*2] | rom[o+k*2+1]<<8);
  const found: string[] = [];
  for (let r = 0; r < 31; r++) for (let c = 0; c < 63; c++) {
    const tb = wbase + (c >= 32 ? 0x400 : 0);
    const cc = c & 31;
    const get = (rr: number, ccc: number) => vw(wbase + (ccc >= 32 ? 0x400 : 0) + rr * 32 + (ccc & 31));
    if (get(r, c) === e[0] && get(r + 1, c) === e[1] && get(r, c + 1) === e[2] && get(r + 1, c + 1) === e[3]) found.push(`${c},${r}`);
  }
  console.log(hex(T,3), e.map(v=>hex(v,4)).join(' '), found.slice(0,10).join(' '));
}
