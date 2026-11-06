// per frame of a level played as testblanklines.ts plays it: the $2100 writes and DMAs of the NMI, with line and caller,
// the stripe buffer, the stripe upload's lines and its instructions ("hot": PC: times executed).
// traceblank.ts <level> <from frame> <to frame>
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { PAD } from '../src/core/ram.ts';
import { cleanImage, editorImage } from './fixture.ts';

const lv = parseInt(process.argv[2], 16), from = Number(process.argv[3]), to = Number(process.argv[4]);
const input = (f: number) => PAD.y | PAD.right | (f % 70 < 34 ? PAD.b : 0);
const hex = (n: number, d = 6) => n.toString(16).padStart(d, '0');
for (const [name, img] of [['clean', cleanImage()], ['editor', await editorImage()]] as const) {
  const emu = new LevelEmulator(new Rom(img)); emu.boot();
  const p = PlaySession.start(emu, lv);
  const s = emu.snes as any;
  let log: string[] | null = null;
  const at = () => `L${s.line}+${s.cpu.cycles - (s.lineAt - 1364)}`;
  const w = s.writeIO.bind(s);
  s.writeIO = (a: number, v: number) => { if (log && !s.inDma && (a === 0x2100)) log.push(`${at()} $2100=${hex(v, 2)} pc=${hex((s.cpu.pbr << 16) | s.cpu.pc)}`); w(a, v); };
  const d = s.runDma.bind(s);
  s.runDma = (m: number) => {
    const l0 = s.line, c0 = s.cpu.cycles;
    const desc: string[] = [];
    for (let ch = 0; ch < 8; ch++) if (m & (1 << ch)) { const b = ch * 16; const n = s.dma[b + 5] | (s.dma[b + 6] << 8); desc.push(`ch${ch} B${hex(s.dma[b + 1], 2)} src${hex((s.dma[b + 4] << 16) | s.dma[b + 2] | (s.dma[b + 3] << 8))} n${hex(n, 4)}`); }
    d(m);
    if (log) log.push(`L${l0} DMA ${desc.join(' ')} (${((s.cpu.cycles - c0) / 1364).toFixed(1)} lines) pc=${hex((s.cpu.pbr << 16) | s.cpu.pc)}`);
  };
  let lastLine = -1, t0 = 0; const hist = new Map<number, number>();
  const st = s.cpu.step.bind(s.cpu);
  s.cpu.step = () => { if (log && s.line !== lastLine && (s.line >= 225 || s.line < 30)) { lastLine = s.line; log.push(`L${s.line} pc=${hex((s.cpu.pbr << 16) | s.cpu.pc)}`); } const pc = (s.cpu.pbr << 16) | s.cpu.pc; if (log && (pc & 0x7fffff) === 0x85e3) { const w = s.wram; const st = w[0x1837b] | (w[0x1837c] << 8); log.push(`STRIPES $7F837B=${hex(st, 4)} src=${hex(w[2] << 16 | w[1] << 8 | w[0])}: ` + (Array.from(w.slice(0x1837d, 0x1837d + Math.min(st + 1, 120))) as number[]).map((b: number) => hex(b, 2)).join(' ')); } if (log && (pc & 0x7fffff) === 0x85e3) t0 = s.cpu.cycles; if (log && t0 && ((pc & 0x7fffff) === 0x85e6 || (pc & 0x7fffff) === 0x85e7)) { log.push(`stripe upload took ${((s.cpu.cycles - t0) / 1364).toFixed(1)} lines`); t0 = 0; } if (log && t0) hist.set(pc, (hist.get(pc) ?? 0) + 1); return st(); };
  for (let f = 0; f <= to; f++) {
    if (f >= from) log = [];
    p.play(1, input(f));
    if (log && hist.size) { console.log('hot', [...hist].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${hex(k)}:${v}`).join(' ')); hist.clear(); }
    if (log) { console.log(`${name} f${f}:\n  ` + log.join('\n  ')); }
  }
}
