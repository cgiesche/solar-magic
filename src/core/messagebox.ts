// The message box as the editor edits it: the game's box of 8 lines of 18 characters (character codes of the
// message font, messages.ts) with a caret that moves freely in it. Typing beyond a line's end pads it with
// spaces; Enter splits a line and Backspace at a line's start joins it to the one above, but nothing is ever
// pushed out of the box (refused instead: null). Pasted text wraps into lines of 18 – justified on request,
// as the game's own texts are set – and characters the font lacks are replaced by a look-alike where there is one.

import { MSG_COLS, MSG_LINES, SPACE, charCode, type Message } from './messages.ts';

// lines: 8, each at most 18 codes (spaces typed at the end are kept); the caret: line 0-7, column 0-18
export interface Box { lines: number[][]; line: number; col: number }

const trim = (l: number[]): number[] => {
  let n = l.length;
  while (n && l[n - 1] === SPACE) n--;
  return l.slice(0, n);
};
const pad = (l: number[], n: number): number[] => (l.length >= n ? l.slice() : [...l, ...new Array<number>(n - l.length).fill(SPACE)]);
const withLines = (lines: number[][], line: number, col: number): Box => ({ lines, line, col });

export function boxOf(m: Message): Box {
  return { lines: Array.from({ length: MSG_LINES }, (_, l) => trim(m[l] ?? [])), line: 0, col: 0 };
}
export const boxMessage = (b: Box): Message => b.lines.map(trim);
export const charsLeft = (line: number[]): number => MSG_COLS - trim(line).length;

// the code typed at the caret; null: no room in the line
export function typeCode(b: Box, code: number): Box | null {
  if (b.col >= MSG_COLS) return null;
  const l = pad(b.lines[b.line], b.col);
  l.splice(b.col, 0, code);
  if (trim(l).length > MSG_COLS) return null;
  const lines = b.lines.slice();
  lines[b.line] = l.slice(0, MSG_COLS);
  return withLines(lines, b.line, b.col + 1);
}

// Enter: the rest of the line moves to a new line below; null when the last line has text
export function newline(b: Box): Box | null {
  if (trim(b.lines[MSG_LINES - 1]).length) return null;
  const l = b.lines[b.line];
  const lines = [...b.lines.slice(0, b.line), l.slice(0, b.col), l.slice(b.col), ...b.lines.slice(b.line + 1, MSG_LINES - 1)];
  return withLines(lines, b.line + 1, 0);
}

// line k joined to the end of line k - 1 (the caret there), null when it does not fit
function join(b: Box, k: number): Box | null {
  const above = b.lines[k - 1], joined = [...above, ...b.lines[k]];
  if (trim(joined).length > MSG_COLS) return null;
  const lines = [...b.lines.slice(0, k - 1), joined.slice(0, MSG_COLS), ...b.lines.slice(k + 1), []];
  return withLines(lines, k - 1, above.length);
}

export function backspace(b: Box): Box | null {
  if (b.col > b.lines[b.line].length) return withLines(b.lines, b.line, b.col - 1);
  if (b.col > 0) {
    const lines = b.lines.slice();
    lines[b.line] = b.lines[b.line].filter((_, k) => k !== b.col - 1);
    return withLines(lines, b.line, b.col - 1);
  }
  return b.line ? join(b, b.line) : null;
}

export function del(b: Box): Box | null {
  const l = b.lines[b.line];
  if (b.col < l.length) {
    const lines = b.lines.slice();
    lines[b.line] = l.filter((_, k) => k !== b.col);
    return withLines(lines, b.line, b.col);
  }
  if (b.line === MSG_LINES - 1) return null;
  const lines = b.lines.slice();
  lines[b.line] = pad(l, b.col);
  const j = join({ ...b, lines }, b.line + 1);
  return j && { ...j, col: b.col };
}

export type Move = 'left' | 'right' | 'up' | 'down' | 'home' | 'end';
// the caret anywhere in the box; left from a line's start goes to the end of the text above
export function move(b: Box, m: Move): Box {
  const at = (line: number, col: number) => withLines(b.lines, line, col);
  switch (m) {
    case 'left': return b.col ? at(b.line, b.col - 1) : b.line ? at(b.line - 1, trim(b.lines[b.line - 1]).length) : b;
    case 'right': return b.col < MSG_COLS ? at(b.line, b.col + 1) : b.line < MSG_LINES - 1 ? at(b.line + 1, 0) : b;
    case 'up': return at(Math.max(0, b.line - 1), b.col);
    case 'down': return at(Math.min(MSG_LINES - 1, b.line + 1), b.col);
    case 'home': return at(b.line, 0);
    case 'end': return at(b.line, trim(b.lines[b.line]).length);
  }
}

// ---- wrapping

// a wrapped line; src: the index in the wrapped text of each column's code (-1: a space justifying added)
export interface WrappedLine { codes: number[]; src: number[] }

const SENTENCE_END = new Set(['.', '!', '?'].map((c) => charCode(c)!));

// the line's spaces between words spread to fill it, as the game's texts are set: evenly, the ones left over
// first after the end of a sentence, then from the left; leading spaces stay
export function justifyLine(codes: number[], src: number[] = codes.map((_, i) => i)): number[] {
  return justified({ codes, src }).codes;
}
function justified(l: WrappedLine): WrappedLine {
  const t = trim(l.codes);
  let lead = 0;
  while (lead < t.length && t[lead] === SPACE) lead++;
  const words: { codes: number[]; src: number[] }[] = [];
  for (let i = lead; i < t.length;) {
    let j = i;
    while (j < t.length && t[j] !== SPACE) j++;
    words.push({ codes: t.slice(i, j), src: l.src.slice(i, j) });
    while (j < t.length && t[j] === SPACE) j++;
    i = j;
  }
  const gaps = words.length - 1;
  if (gaps < 1) return l;
  const spaces = MSG_COLS - lead - words.reduce((n, w) => n + w.codes.length, 0);
  const each = new Array<number>(gaps).fill(Math.floor(spaces / gaps));
  let left = spaces % gaps;
  for (let g = 0; g < gaps && left; g++) if (SENTENCE_END.has(words[g].codes[words[g].codes.length - 1])) { each[g]++; left--; }
  for (let g = 0; g < gaps && left; g++) if (!SENTENCE_END.has(words[g].codes[words[g].codes.length - 1])) { each[g]++; left--; }
  const out: WrappedLine = { codes: t.slice(0, lead), src: l.src.slice(0, lead) };
  words.forEach((w, g) => {
    out.codes.push(...w.codes);
    out.src.push(...w.src);
    if (g < gaps) { out.codes.push(...new Array<number>(each[g]).fill(SPACE)); out.src.push(...new Array<number>(each[g]).fill(-1)); }
  });
  return out;
}

// one paragraph broken into lines of 18 at its spaces (a longer word broken where the line ends); its leading
// spaces and the spaces between words on a line kept; justify: all lines but the last spread (justifyLine)
export function wrap(codes: number[], justify: boolean): WrappedLine[] {
  const out: WrappedLine[] = [];
  let cur: WrappedLine = { codes: [], src: [] };
  const flush = () => { out.push(cur); cur = { codes: [], src: [] }; };
  let i = 0;
  // the paragraph's leading spaces
  while (i < codes.length && codes[i] === SPACE) { cur.codes.push(SPACE); cur.src.push(i++); }
  while (i < codes.length) {
    const s = i;
    while (i < codes.length && codes[i] === SPACE) i++;
    const w = i;
    while (i < codes.length && codes[i] !== SPACE) i++;
    if (w === i) break; // spaces at the end
    const gap = cur.codes.length && cur.codes.some((c) => c !== SPACE) ? w - s : 0;
    if (cur.codes.length + gap + (i - w) <= MSG_COLS) {
      for (let k = s + (gap ? 0 : w - s); k < i; k++) { cur.codes.push(codes[k]); cur.src.push(k); }
      continue;
    }
    if (cur.codes.some((c) => c !== SPACE)) flush();
    for (let k = w; k < i; k++) {
      if (cur.codes.length === MSG_COLS) flush();
      cur.codes.push(codes[k]); cur.src.push(k);
    }
  }
  flush();
  return justify ? out.map((l, k) => (k < out.length - 1 ? justified(l) : l)) : out;
}

// ---- text into codes

// look-alikes in the font for characters it lacks
const LIKE: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '′': "'", '`': "'", '´': "'", '“': "''", '”': "''", '„': "''", '″': "''", '"': "''",
  '…': '...', '–': '-', '—': '-', '‒': '-', '−': '-', '8': 'B', '9': 'g', ':': '.', ';': ',', '/': '-', '&': 'and',
  '\t': ' ', ' ': ' ', '¡': '!', '¿': '?', '[': '(', ']': ')', '{': '(', '}': ')', '<': '(', '>': ')', 'ß': 'ss',
};
const inFont = (s: string) => [...s].every((c) => charCode(c) !== undefined);

// what to write instead of a character the font lacks (null: it has it, or nothing looks like it)
export function suggestion(ch: string): string | null {
  if (charCode(ch) !== undefined) return null;
  const like = LIKE[ch];
  if (like) return like;
  const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return plain !== ch && plain && inFont(plain) ? plain : null;
}

export interface Encoded { codes: number[]; replaced: { from: string; to: string }[]; dropped: string[] }
// a line of text as codes, characters the font lacks replaced by their suggestion or left out
export function encodeText(s: string): Encoded {
  const out: Encoded = { codes: [], replaced: [], dropped: [] };
  for (const ch of s) {
    const c = charCode(ch);
    if (c !== undefined) { out.codes.push(c); continue; }
    const like = suggestion(ch);
    if (like) { out.codes.push(...[...like].map((x) => charCode(x)!)); out.replaced.push({ from: ch, to: like }); } else out.dropped.push(ch);
  }
  return out;
}

// text pasted at the caret: its lines and the rest of the caret's line wrapped (justify: as the game's texts
// are set), the caret after it; null when it does not fit into the box
export function paste(b: Box, text: string, justify: boolean): (Encoded & { box: Box }) | null {
  const paras = text.replace(/\r\n?/g, '\n').split('\n').map(encodeText);
  const l = pad(b.lines[b.line], b.col), prefix = l.slice(0, b.col), suffix = trim(l.slice(b.col));
  const codes = paras.map((p) => p.codes);
  codes[0] = [...prefix, ...codes[0]];
  const caret = codes[codes.length - 1].length;
  codes[codes.length - 1] = [...codes[codes.length - 1], ...suffix];
  const wrapped = codes.map((c) => wrap(c, justify));
  const last = wrapped[wrapped.length - 1];
  const k = last.findIndex((w) => w.src.some((s) => s >= caret));
  const kk = k < 0 ? last.length - 1 : k, col = k < 0 ? last[kk].codes.length : last[kk].src.findIndex((s) => s >= caret);
  const lines = [...b.lines.slice(0, b.line), ...wrapped.flat().map((w) => w.codes), ...b.lines.slice(b.line + 1)];
  while (lines.length > MSG_LINES && !trim(lines[lines.length - 1]).length) lines.pop();
  if (lines.length > MSG_LINES) return null;
  const line = b.line + wrapped.slice(0, -1).reduce((n, w) => n + w.length, 0) + kk;
  return {
    codes: paras.flatMap((p) => p.codes), replaced: paras.flatMap((p) => p.replaced), dropped: paras.flatMap((p) => p.dropped),
    box: { lines, line, col: Math.min(col, MSG_COLS) },
  };
}
