// 65816 disassembler (used for debugging and for locating code in ROM).

const MN = (
  'BRK ORA COP ORA TSB ORA ASL ORA PHP ORA ASL PHD TSB ORA ASL ORA ' +
  'BPL ORA ORA ORA TRB ORA ASL ORA CLC ORA INC TCS TRB ORA ASL ORA ' +
  'JSR AND JSL AND BIT AND ROL AND PLP AND ROL PLD BIT AND ROL AND ' +
  'BMI AND AND AND BIT AND ROL AND SEC AND DEC TSC BIT AND ROL AND ' +
  'RTI EOR WDM EOR MVP EOR LSR EOR PHA EOR LSR PHK JMP EOR LSR EOR ' +
  'BVC EOR EOR EOR MVN EOR LSR EOR CLI EOR PHY TCD JML EOR LSR EOR ' +
  'RTS ADC PER ADC STZ ADC ROR ADC PLA ADC ROR RTL JMP ADC ROR ADC ' +
  'BVS ADC ADC ADC STZ ADC ROR ADC SEI ADC PLY TDC JMP ADC ROR ADC ' +
  'BRA STA BRL STA STY STA STX STA DEY BIT TXA PHB STY STA STX STA ' +
  'BCC STA STA STA STY STA STX STA TYA STA TXS TXY STZ STA STZ STA ' +
  'LDY LDA LDX LDA LDY LDA LDX LDA TAY LDA TAX PLB LDY LDA LDX LDA ' +
  'BCS LDA LDA LDA LDY LDA LDX LDA CLV LDA TSX TYX LDY LDA LDX LDA ' +
  'CPY CMP REP CMP CPY CMP DEC CMP INY CMP DEX WAI CPY CMP DEC CMP ' +
  'BNE CMP CMP CMP PEI CMP DEC CMP CLD CMP PHX STP JML CMP DEC CMP ' +
  'CPX SBC SEP SBC CPX SBC INC SBC INX SBC NOP XBA CPX SBC INC SBC ' +
  'BEQ SBC SBC SBC PEA SBC INC SBC SED SBC PLX XCE JSR SBC INC SBC'
).split(' ');

// addressing modes
// imp, immM, immX, imm8, dp, dpx, dpy, idp, idpx, idpy, ildp, ildpy, abs, absx, absy,
// long, longx, iabs, iabsx, ilabs, rel, rell, sr, isry, mv
const MODES = (
  'imm8 idpx imm8 sr dp dp dp ildp imp immM imp imp abs abs abs long ' +
  'rel idpy idp isry dp dpx dpx ildpy imp absy imp imp abs absx absx longx ' +
  'abs idpx long sr dp dp dp ildp imp immM imp imp abs abs abs long ' +
  'rel idpy idp isry dpx dpx dpx ildpy imp absy imp imp absx absx absx longx ' +
  'imp idpx imm8 sr mv dp dp ildp imp immM imp imp abs abs abs long ' +
  'rel idpy idp isry mv dpx dpx ildpy imp absy imp imp long absx absx longx ' +
  'imp idpx rell sr dp dp dp ildp imp immM imp imp iabs abs abs long ' +
  'rel idpy idp isry dpx dpx dpx ildpy imp absy imp imp iabsx absx absx longx ' +
  'rel idpx rell sr dp dp dp ildp imp immM imp imp abs abs abs long ' +
  'rel idpy idp isry dpx dpx dpy ildpy imp absy imp imp abs absx absx longx ' +
  'immX idpx immX sr dp dp dp ildp imp immM imp imp abs abs abs long ' +
  'rel idpy idp isry dpx dpx dpy ildpy imp absy imp imp absx absx absy longx ' +
  'immX idpx imm8 sr dp dp dp ildp imp immM imp imp abs abs abs long ' +
  'rel idpy idp isry dp dpx dpx ildpy imp absy imp imp ilabs absx absx longx ' +
  'immX idpx imm8 sr dp dp dp ildp imp immM imp imp abs abs abs long ' +
  'rel idpy idp isry abs dpx dpx ildpy imp absy imp imp iabsx absx absx longx'
).split(' ');

const h2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const h4 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');
const h6 = (v: number) => v.toString(16).toUpperCase().padStart(6, '0');

export interface DisasmResult {
  text: string;
  length: number;
  target?: number; // branch/jump target (24-bit) if static
}

// read: 24-bit address → byte
export function disasm(read: (a: number) => number, addr: number, m8: boolean, x8: boolean): DisasmResult {
  const op = read(addr);
  const mn = MN[op];
  const mode = MODES[op];
  const bank = addr & 0xff0000;
  const b = (i: number) => read(bank | ((addr + i) & 0xffff));
  let len = 1;
  let arg = '';
  let target: number | undefined;
  switch (mode) {
    case 'imp': break;
    case 'imm8': len = 2; arg = `#$${h2(b(1))}`; break;
    case 'immM': if (m8) { len = 2; arg = `#$${h2(b(1))}`; } else { len = 3; arg = `#$${h4(b(1) | (b(2) << 8))}`; } break;
    case 'immX': if (x8) { len = 2; arg = `#$${h2(b(1))}`; } else { len = 3; arg = `#$${h4(b(1) | (b(2) << 8))}`; } break;
    case 'dp': len = 2; arg = `$${h2(b(1))}`; break;
    case 'dpx': len = 2; arg = `$${h2(b(1))},x`; break;
    case 'dpy': len = 2; arg = `$${h2(b(1))},y`; break;
    case 'idp': len = 2; arg = `($${h2(b(1))})`; break;
    case 'idpx': len = 2; arg = `($${h2(b(1))},x)`; break;
    case 'idpy': len = 2; arg = `($${h2(b(1))}),y`; break;
    case 'ildp': len = 2; arg = `[$${h2(b(1))}]`; break;
    case 'ildpy': len = 2; arg = `[$${h2(b(1))}],y`; break;
    case 'sr': len = 2; arg = `$${h2(b(1))},s`; break;
    case 'isry': len = 2; arg = `($${h2(b(1))},s),y`; break;
    case 'abs': {
      len = 3; const v = b(1) | (b(2) << 8); arg = `$${h4(v)}`;
      if (op === 0x4c || op === 0x20) target = bank | v;
      break;
    }
    case 'absx': len = 3; arg = `$${h4(b(1) | (b(2) << 8))},x`; break;
    case 'absy': len = 3; arg = `$${h4(b(1) | (b(2) << 8))},y`; break;
    case 'iabs': len = 3; arg = `($${h4(b(1) | (b(2) << 8))})`; break;
    case 'iabsx': len = 3; arg = `($${h4(b(1) | (b(2) << 8))},x)`; break;
    case 'ilabs': len = 3; arg = `[$${h4(b(1) | (b(2) << 8))}]`; break;
    case 'long': {
      len = 4; const v = b(1) | (b(2) << 8) | (b(3) << 16); arg = `$${h6(v)}`;
      if (op === 0x5c || op === 0x22) target = v;
      break;
    }
    case 'longx': len = 4; arg = `$${h6(b(1) | (b(2) << 8) | (b(3) << 16))},x`; break;
    case 'rel': { len = 2; const t = bank | ((addr + 2 + ((b(1) << 24) >> 24)) & 0xffff); target = t; arg = `$${h4(t & 0xffff)}`; break; }
    case 'rell': { len = 3; const t = bank | ((addr + 3 + (((b(1) | (b(2) << 8)) << 16) >> 16)) & 0xffff); target = t; arg = `$${h4(t & 0xffff)}`; break; }
    case 'mv': len = 3; arg = `$${h2(b(2))},$${h2(b(1))}`; break;
  }
  return { text: `${mn} ${arg}`.trim(), length: len, target };
}

export function hex(v: number, digits: number): string {
  return v.toString(16).toUpperCase().padStart(digits, '0');
}
