// The message box editor's model (messagebox.ts): 18 × 8 like the game's box – typing at the caret (beyond a
// line's end it pads with spaces), Enter splits a line, Backspace at a line's start joins it to the one above,
// the arrows move freely within the box; nothing is pushed out of it (refused instead). Pasted text wraps into
// lines of 18, justified on request as the game's texts are set; characters the font lacks are replaced by a
// suggestion where there is one.
import { type Box, boxOf, boxMessage, typeCode, newline, backspace, del, move, charsLeft, paste, wrap, justifyLine, justifyBox, encodeText, suggestion } from '../src/core/messagebox.ts';
import { textToLine, lineToText, MSG_COLS, MSG_LINES, type Message } from '../src/core/messages.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const msg = (...l: string[]): Message => Array.from({ length: MSG_LINES }, (_, i) => textToLine(l[i] ?? ''));
const text = (b: Box | null) => (b ? b.lines.map(lineToText).join('/').replace(/\/+$/, '') : 'refused');
const at = (b: Box | null) => (b ? `${b.line},${b.col}` : '-');
const code = (c: string) => textToLine(c)[0];
const put = (b: Box, line: number, col: number): Box => ({ ...b, line, col });

// typing
{
  const b = boxOf(msg('Hello', 'World'));
  check(text(b) === 'Hello/World' && at(b) === '0,0' && b.lines.length === MSG_LINES, 'a message as a box: 8 lines, the caret at the start');
  const t = typeCode(put(b, 0, 5), code('!'));
  check(text(t) === 'Hello!/World' && at(t) === '0,6', 'typing inserts at the caret and moves it');
  const p = typeCode(put(b, 1, 9), code('?'));
  check(text(p) === 'Hello/World    ?' && at(p) === '1,10', 'beyond the line\'s end: padded with spaces');
  const full = boxOf(msg('ABCDEFGHIJKLMNOPQR'));
  check(typeCode(put(full, 0, 3), code('x')) === null, 'a full line refuses more characters');
  check(charsLeft(full.lines[0]) === 0 && charsLeft(b.lines[0]) === MSG_COLS - 5, 'characters left per line');
  const sp = typeCode(put(b, 0, 5), code(' '));
  check(text(sp) === 'Hello/World' && at(sp) === '0,6', 'a trailing space is kept only as the caret\'s move');
}

// Enter, Backspace, Delete
{
  const b = boxOf(msg('Hello World', 'second'));
  const e = newline(put(b, 0, 6));
  check(text(e) === 'Hello/World/second' && at(e) === '1,0', 'Enter splits the line, the rest moves down');
  const eight = boxOf(msg('1', '2', '3', '4', '5', '6', '7', '0'));
  check(newline(put(eight, 2, 1)) === null, 'Enter is refused when the last line has text (nothing is pushed out)');
  check(text(newline(put(boxOf(msg('1', '2', '3', '4', '5', '6', '7')), 2, 1))) === '1/2/3//4/5/6/7', 'an empty last line makes room');
  const j = backspace(put(e!, 1, 0));
  check(text(j) === 'Hello World/second' && at(j) === '0,6', 'Backspace at a line\'s start joins it to the line above');
  const k = backspace(put(boxOf(msg('Hello World', 'other long words')), 1, 0));
  check(k === null, 'a join that does not fit is refused');
  const d = backspace(put(b, 0, 5));
  check(text(d) === 'Hell World/second' && at(d) === '0,4', 'Backspace deletes before the caret');
  check(backspace(b) === null, 'Backspace at the box\'s start: nothing');
  const x = del(put(b, 0, 11));
  check(text(x) === 'Hello Worldsecond' && at(x) === '0,11', 'Delete at a line\'s end joins the next line');
  check(text(del(put(b, 0, 0))) === 'ello World/second', 'Delete removes the character at the caret');
  check(text(backspace(put(b, 0, 14))) === 'Hello World/second' && at(backspace(put(b, 0, 14))) === '0,13', 'Backspace beyond the line\'s end only moves');
}

// arrows move freely within the 18 × 8 box
{
  const b = boxOf(msg('Hello', 'a'));
  check(at(move(put(b, 0, 5), 'down')) === '1,5', 'down keeps the column (beyond a shorter line)');
  check(at(move(put(b, 0, 0), 'left')) === '0,0' && at(move(put(b, 1, 0), 'left')) === '0,5', 'left at a line\'s start: the end of the text above');
  check(at(move(put(b, 0, 18), 'right')) === '1,0' && at(move(put(b, 7, 18), 'right')) === '7,18', 'right at the box\'s right edge: the next line');
  check(at(move(put(b, 7, 3), 'down')) === '7,3' && at(move(put(b, 0, 3), 'up')) === '0,3', 'up and down stop at the box');
  check(at(move(put(b, 0, 2), 'end')) === '0,5' && at(move(put(b, 0, 2), 'home')) === '0,0', 'Home and End: the line\'s text');
}

// wrapping and justifying
{
  const w = wrap(encodeText('Welcome! This is Dinosaur Land. In this strange land we find that').codes, false);
  check(w.map((l) => lineToText(l.codes)).join('/') === 'Welcome! This is/Dinosaur Land. In/this strange land/we find that', `wrapped into lines of 18 (${w.map((l) => lineToText(l.codes)).join('/')})`);
  const j = wrap(encodeText('Welcome! This is Dinosaur Land. In this strange land we find that').codes, true);
  check(j.map((l) => lineToText(l.codes)).join('/') === 'Welcome!  This  is/Dinosaur Land.  In/this  strange land/we find that',
    `justified: every line but the last filled, spaces after a sentence first (${j.map((l) => lineToText(l.codes)).join('/')})`);
  check(lineToText(justifyLine(textToLine('on top of the'))) === 'on   top   of  the', 'spaces spread from the left');
  check(lineToText(justifyLine(textToLine('Dinosaur'))) === 'Dinosaur', 'a single word stays');
  const long = wrap(encodeText('Supercalifragilisticexpialidocious').codes, false);
  check(long.map((l) => l.codes.length).join(',') === '18,16', 'a word longer than a line is broken');
}

// pasting
{
  const b = boxOf(msg('Hi', '', 'end'));
  const p = paste(put(b, 0, 2), ' there, this is a longer text that wraps.', false);
  check(text(p?.box ?? null) === 'Hi there, this is/a longer text that/wraps.//end' && at(p?.box ?? null) === '2,6', `a pasted paragraph wraps, the caret after it (${text(p?.box ?? null)} ${at(p?.box ?? null)})`);
  const q = paste(put(b, 0, 2), '\nnew\n\npara', false);
  check(text(q?.box ?? null) === 'Hi/new//para//end', `line breaks kept (${text(q?.box ?? null)})`);
  check(paste(put(b, 0, 0), 'a b c d e f g h i j k l m n o p q r s t u v w x y z a b c d e f g h i j k l m n o p q r s t u v w x y z a b c d e f g h i j k l m n o p q r s t u v w x y z', false) === null,
    'text that does not fit into 8 lines is refused');
  const r = paste(put(b, 0, 2), ' “8 or 9”…', false);
  check(text(r?.box ?? null) === 'Hi \'\'B or g\'\'...//end' && r!.replaced.length === 5, `characters the font lacks replaced (${text(r?.box ?? null)}; ${r?.replaced.map((x) => `${x.from}→${x.to}`).join(' ')})`);
}

// suggestions
{
  check(suggestion('’') === "'" && suggestion('“') === "''" && suggestion('…') === '...' && suggestion('é') === 'e' && suggestion('8') === 'B' && suggestion('9') === 'g', 'suggestions for characters the font lacks');
  check(suggestion('A') === null && suggestion('€') === null, 'none for characters in the font or without a likeness');
  const e = encodeText('a€b');
  check(e.codes.length === 2 && e.dropped.join('') === '€', 'characters without a suggestion are left out and named');
}

// justifying a whole message: every line followed by one with text in the same paragraph
{
  const j = justifyBox(boxOf(msg('Welcome! This is', 'Dinosaur Land.', '', 'on top of the', 'end')));
  check(text(j) === 'Welcome!  This  is/Dinosaur Land.//on   top   of  the/end', `justified (${text(j)})`);
}

// back to a message
{
  const m = boxMessage(boxOf(msg('Hello', '', 'x')));
  check(m.length === MSG_LINES && lineToText(m[0]) === 'Hello' && lineToText(m[2]) === 'x', 'the box as a message');
}

console.log('message box bad', bad);
if (bad) process.exitCode = 1;
