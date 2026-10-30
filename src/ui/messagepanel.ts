// The message panel: a level's messages edited beside the level (Level → Message boxes, a double click on a
// message box sprite, a problem about a message), in place of the picker. The message is typed into the game's
// box itself (messagebox.ts), drawn in the ROM's own font as the level has it; every change is a ROM edit (typing
// in one message merges into one step). Also the hover preview of the message a sprite in the level opens.

import type { App } from './app.ts';
import { h, checkbox, toast } from './dom.ts';
import { hex, hex3 } from '../core/names.ts';
import { levelName, translevelToLevel } from '../core/overworld.ts';
import { spriteId, type LevelSprite } from '../core/level.ts';
import { probeable } from '../core/probeclient.ts';
import { spriteMessage } from '../core/blockprobe.ts';
import { TileCache, blit8 } from '../core/render.ts';
import {
  readMessage, writeMessages, isBlank, switchPalace, yoshiHouse, messageToShow, charCode, codeChar, YOSHI_THANKS, MSG_LINES, MSG_COLS, SPACE, type Message,
} from '../core/messages.ts';
import { boxOf, boxMessage, trimLine, typeCode, newline, backspace, del, move, charsLeft, paste, justifyBox, suggestion, type Box, type Move } from '../core/messagebox.ts';
import { messageTranslevel, messageLevels } from '../core/messageuse.ts';
import { openTestPlay } from './testplay.ts';

const W = MSG_COLS * 8 + 16, H = MSG_LINES * 8 + 16; // the box with its black border, in pixels
const FONT_CODES = 0x80; // the codes the character picker shows (16 × 8)
const MOVES: Record<string, Move> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'home', End: 'end' };

// the translevel whose messages the open level shows (0: no overworld level reaches it)
export const levelMessages = (app: App): number => messageTranslevel(app.entrances.graph(), app.level.number);

// the message box (1-3, 0 none) sprite s of the open level opens, as hitting it does in the game; null while that
// is being found out
export function spriteOpens(app: App, s: LevelSprite): number | null {
  const id = spriteId(s);
  if (!probeable(id)) return 0;
  const p = app.probes.sprite(id);
  return p ? spriteMessage(p, s.x, s.y) : null;
}
// message box m (1-3) of the open level: the translevel and message it shows
export const messageOfBox = (app: App, m: number): { translevel: number; msg: number } => (m === 3 ? { ...YOSHI_THANKS } : { translevel: levelMessages(app), msg: m });

// the name of message msg of translevel tl
export function messageLabel(tl: number, msg: number): string {
  if (tl === YOSHI_THANKS.translevel) return msg === YOSHI_THANKS.msg ? 'Yoshi\'s thank-you' : 'Intro message';
  return `Message ${msg}`;
}

// glyphs of the message font as the open level has it in VRAM (BG3 tile $100 + code, attribute $39 as the game writes it)
function font(app: App): (code: number) => Uint32Array {
  const r = app.render, tc = new TileCache(r.vram, r.cgram, (r.ppuRegs[0x0c] & 0x0f) << 13);
  return (c) => tc.get(0x3900 | c, 2);
}

// message m drawn into canvas c (W × H) as the game's box shows it; caret: a bar left of that cell
function drawMessage(app: App, c: HTMLCanvasElement, m: Message, caret?: { line: number; col: number }): void {
  const ctx = c.getContext('2d')!, img = ctx.createImageData(W, H), px = new Uint32Array(img.data.buffer).fill(0xff000000);
  const g = font(app);
  m.forEach((line, y) => { for (let x = 0; x < MSG_COLS; x++) blit8(px, W, H, g(line[x] ?? SPACE), 8 + x * 8, 8 + y * 8); });
  if (caret) for (let y = 0; y < 8; y++) px[(8 + caret.line * 8 + y) * W + 7 + caret.col * 8] = 0xffffffff;
  ctx.putImageData(img, 0, 0);
}

// ---- hover preview

let hover: { root: HTMLElement; canvas: HTMLCanvasElement; text: HTMLElement; drawn: string; render: unknown } | null = null;
// message msg of translevel tl next to the mouse
export function showMessageHover(app: App, e: MouseEvent, tl: number, msg: number, what: string): void {
  if (!hover) {
    const canvas = h('canvas', { width: W, height: H }), text = h('div', { class: 'hint' });
    hover = { root: h('div', { class: 'msg-hover' }, text, canvas), canvas, text, drawn: '', render: null };
  }
  if (!hover.root.isConnected) document.body.append(hover.root);
  const m = readMessage(app.rom, tl, msg), key = `${what}:${m.join('/')}`;
  // (drawn again when the message or the level's font changed)
  if (key !== hover.drawn || app.render !== hover.render) {
    hover.text.textContent = `${what}${isBlank(m) ? ' – empty' : ''} · double click to edit`;
    drawMessage(app, hover.canvas, m);
    hover.drawn = key;
    hover.render = app.render;
  }
  const w = hover.root.offsetWidth, hh = hover.root.offsetHeight;
  const x = Math.min(innerWidth - 4 - w, e.clientX + 16), y = e.clientY + 16 + hh < innerHeight ? e.clientY + 16 : e.clientY - 16 - hh;
  hover.root.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
}
export function hideMessageHover(): void {
  hover?.root.remove();
}

// ---- the panel

export class MessagePanel {
  readonly root = h('div', { class: 'panel msg-panel' });
  private readonly app: App;
  private box: Box | null = null; // the shown message being edited
  private shown = ''; // its translevel:msg
  private justify = false; // pasted text justified
  private input: HTMLTextAreaElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private left: HTMLElement[] = [];
  private where: HTMLElement | null = null;
  private note: HTMLElement | null = null;
  private blink = 0;
  private caretOn = true;

  constructor(app: App) {
    this.app = app;
    app.on('messages', () => this.build());
    // undo/redo or another change of the ROM: the message as it is now
    app.on('rom-change', () => { if (app.messages) this.build(); });
    // the font as the level has it
    app.on('render', () => this.draw());
    // another level: its messages
    app.on('level', () => { if (app.messages) app.openMessages(levelMessages(app), 1); });
  }

  // the caret into the box (once the panel is shown)
  focus(): void {
    this.input?.focus();
  }

  private target(): { translevel: number; msg: number } {
    return this.app.messages!;
  }

  build(): void {
    const app = this.app, rom = app.rom;
    const focused = !!this.input && document.activeElement === this.input;
    clearInterval(this.blink);
    this.root.replaceChildren();
    if (!app.messages) { this.box = null; this.shown = ''; return; }
    const { translevel: t, msg: n } = app.messages;
    const key = `${t}:${n}`, m = readMessage(rom, t, n);
    // the box as edited while it shows the same text (the caret, spaces typed at a line's end stay)
    if (!this.box || this.shown !== key || JSON.stringify(boxMessage(this.box).map(trimLine)) !== JSON.stringify(m.map(trimLine))) {
      const caret = this.box && this.shown === key ? { line: this.box.line, col: this.box.col } : { line: 0, col: 0 };
      this.box = { ...boxOf(m), ...caret };
    }
    this.shown = key;

    const here = levelMessages(app), tl = n === YOSHI_THANKS.msg && t === YOSHI_THANKS.translevel && here !== 0 ? here : t;
    const tabs = [[tl, 1], [tl, 2], ...(tl ? [[YOSHI_THANKS.translevel, YOSHI_THANKS.msg]] : [])].map(([a, b]) => {
      const empty = isBlank(readMessage(rom, a, b));
      return h('button', { class: a === t && b === n ? 'active' : '', title: empty ? 'Empty: a message box opening it shows an empty box' : '', onclick: () => app.openMessages(a, b) },
        tl ? messageLabel(a, b) : b === 1 ? 'Message 1 · intro' : 'Message 2 · Yoshi\'s thank-you', empty ? ' (empty)' : '');
    });

    this.canvas = h('canvas', { width: W, height: H, class: 'msg-canvas' });
    this.input = h('textarea', { class: 'msg-input', spellcheck: false, autocomplete: 'off', 'aria-label': 'Message text', title: 'Type into the box: Enter starts a new line, Backspace at a line\'s start joins it to the line above' });
    this.left = Array.from({ length: MSG_LINES }, (_, l) => h('span', { class: 'msg-left', style: { top: `${((8 + l * 8) / H) * 100}%`, height: `${(8 / H) * 100}%` } }));
    this.where = h('div', { class: 'hint' });
    this.note = h('div', { class: 'hint msg-note' });
    this.wireInput();

    const show = messageToShow(rom, t, n);
    const playable = t === YOSHI_THANKS.translevel && n === YOSHI_THANKS.msg ? true : t === here;
    this.root.append(
      h('div', { class: 'panel-title' }, 'Message boxes', h('button', { class: 'msg-close', title: 'Close (Esc in the box) – back to the picker', onclick: () => app.closeMessages() }, '×')),
      ...this.context(t),
      h('div', { class: 'btn-group msg-tabs' }, tabs),
      h('div', { class: 'msg-box' }, this.canvas, this.input, this.left),
      this.where,
      this.note,
      h('div', { class: 'row msg-actions' },
        checkbox(' Justify pasted text', 'Spread the spaces of pasted lines to fill them, as the game\'s own texts are set (a paragraph\'s last line stays)', this.justify, (on) => (this.justify = on)),
        h('button', { title: 'Spread the spaces of every line of a paragraph but its last to fill the line, as the game\'s own texts are set', onclick: () => this.edit(justifyBox(this.box!), '') }, 'Justify'),
        h('button', { title: 'Empty the message', onclick: () => this.edit(boxOf([]), '') }, 'Clear')),
      h('div', { class: 'row' }, h('button', {
        disabled: !playable, onclick: () => openTestPlay(app, undefined, false, show),
        title: playable ? `Test play this level with the message box open${show.yoshi ? ' (on Yoshi: Yoshi\'s house shows its message 2 then)' : ''}` : 'The open level shows other messages',
      }, '▶ Show in game')),
      h('div', { class: 'hint' }, 'Characters of the ROM\'s font (click to type one):'),
      this.fontPicker(),
    );
    this.draw();
    this.blink = window.setInterval(() => { this.caretOn = !this.caretOn; this.draw(); }, 530);
    if (focused) this.input.focus();
  }

  // the levels showing the messages, the translevel's role in the game
  private context(t: number): HTMLElement[] {
    const app = this.app, rom = app.rom;
    if (!t) {
      return [
        h('div', { class: 'hint warn-text' }, `⚠ No level on the overworld leads to level ${hex3(app.level.number)}, also not through exits: its message boxes show translevel 0's messages – message 1 is the intro's, message 2 Yoshi's thank-you. Writing them here changes those.`),
        h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Give it messages of its own: connect it to a level on the overworld through an exit.'),
          h('button', { title: 'Exits mode: the screen exits of this level (the levels leading here need one to it)', onclick: () => app.setMode('exit') }, 'Exits')),
      ];
    }
    const levels = messageLevels(app.entrances.graph(), t), main = translevelToLevel(t), palace = switchPalace(rom, t);
    const subs = levels.slice(1);
    const out = [h('div', { class: 'hint' }, `Shown in ${hex3(main)} ${levelName(rom, t)}${subs.length ? ` and its sub-level${subs.length > 1 ? 's' : ''} ${subs.map(hex3).join(', ')}` : ''} (translevel ${hex(t, 2)}).`)];
    if (palace >= 0) out.push(h('div', { class: 'hint' }, `Switch palace: message 1 also presses its switch (switch ${palace + 1}) and returns to the overworld when closed.`));
    if (yoshiHouse(rom) === t) out.push(h('div', { class: 'hint' }, 'Yoshi\'s house: message 2 is shown instead of message 1 while Mario rides Yoshi.'));
    return out;
  }

  // the font's glyphs as the level has them; a click types one at the caret
  private fontPicker(): HTMLCanvasElement {
    const c = h('canvas', { width: 16 * 8, height: (FONT_CODES / 16) * 8, class: 'msg-font' });
    const ctx = c.getContext('2d')!, img = ctx.createImageData(c.width, c.height), px = new Uint32Array(img.data.buffer).fill(0xff000000);
    const g = font(this.app);
    for (let k = 0; k < FONT_CODES; k++) blit8(px, c.width, c.height, g(k), (k & 15) * 8, (k >> 4) * 8);
    ctx.putImageData(img, 0, 0);
    const codeAt = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      return Math.min(15, Math.floor(((e.clientX - r.left) / r.width) * 16)) + 16 * Math.min(FONT_CODES / 16 - 1, Math.floor(((e.clientY - r.top) / r.height) * (FONT_CODES / 16)));
    };
    c.addEventListener('mousemove', (e) => { const k = codeAt(e), ch = codeChar(k); c.title = `${hex(k, 2)}${ch ? ` “${ch}”` : ''}`; });
    c.addEventListener('mousedown', (e) => {
      e.preventDefault(); // (the box keeps the focus)
      this.edit(typeCode(this.box!, codeAt(e)), 'The line is full');
      this.input?.focus();
    });
    return c;
  }

  private wireInput(): void {
    const inp = this.input!, app = this.app;
    inp.addEventListener('mousedown', (e) => {
      const r = inp.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
      this.setBox({ ...this.box!, line: clamp(Math.floor((y - 8) / 8), 0, MSG_LINES - 1), col: clamp(Math.round((x - 8) / 8), 0, MSG_COLS) });
    });
    inp.addEventListener('focus', () => this.draw());
    inp.addEventListener('blur', () => this.draw());
    inp.addEventListener('keydown', (e) => {
      const k = e.key, ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) app.redo(); else app.undo(); return; }
      if (ctrl && k.toLowerCase() === 'y') { e.preventDefault(); app.redo(); return; }
      if (ctrl || e.altKey) return;
      const b = this.box!;
      if (MOVES[k]) { e.preventDefault(); this.setBox(move(b, MOVES[k])); return; }
      if (k === 'Enter') { e.preventDefault(); this.edit(newline(b), 'No room for another line: the last of the 8 lines has text'); return; }
      if (k === 'Backspace') { e.preventDefault(); this.edit(backspace(b), b.line && !b.col ? 'The line does not fit at the end of the line above' : ''); return; }
      if (k === 'Delete') { e.preventDefault(); this.edit(del(b), 'The next line does not fit at the end of this one'); return; }
      if (k === 'Escape') { e.preventDefault(); app.closeMessages(); }
    });
    // typed characters (the textarea only catches them)
    inp.addEventListener('input', () => {
      const s = inp.value;
      inp.value = '';
      let b: Box | null = this.box!;
      for (const ch of s) {
        const c = charCode(ch);
        if (c === undefined) { this.missing(ch); continue; }
        b = typeCode(b, c);
        if (!b) break;
      }
      this.edit(b, `The line is full (${MSG_COLS} characters)`);
    });
    inp.addEventListener('paste', (e) => {
      e.preventDefault();
      const r = paste(this.box!, e.clipboardData?.getData('text/plain') ?? '', this.justify);
      if (!r) { this.say(`The text does not fit into the box (${MSG_LINES} lines of ${MSG_COLS} characters)`, true); return; }
      this.edit(r.box, '');
      const notes = [
        r.replaced.length ? `Replaced: ${[...new Set(r.replaced.map((x) => `“${x.from}” → “${x.to}”`))].join(', ')}` : '',
        r.dropped.length ? `Left out (not in the font): ${[...new Set(r.dropped)].map((x) => `“${x}”`).join(' ')}` : '',
      ].filter(Boolean);
      if (notes.length) this.say(notes.join('. '), !!r.dropped.length);
    });
  }

  // a character the font lacks: its look-alike offered
  private missing(ch: string): void {
    const like = suggestion(ch);
    this.say(`The font has no “${ch}”${like ? '' : ' and nothing that looks like it – pick a character below (a custom glyph drawn in the graphics)'}`, !like);
    if (like) {
      this.note!.append(' ', h('button', {
        onmousedown: (e: MouseEvent) => e.preventDefault(),
        onclick: () => {
          let b: Box | null = this.box!;
          for (const x of like) b = b && typeCode(b, charCode(x)!);
          this.edit(b, 'The line is full');
        },
      }, `Type “${like}”`));
    }
  }

  private say(text: string, warn = false): void {
    if (!this.note) return;
    this.note.textContent = text;
    this.note.classList.toggle('warn-text', warn);
  }

  // the caret moved
  private setBox(b: Box): void {
    this.box = b;
    this.caretOn = true;
    this.draw();
  }

  // the box changed: a ROM edit when its text did (null: refused, saying why)
  private edit(b: Box | null, refused: string): void {
    if (!b) { if (refused) this.say(refused, true); return; }
    const before = boxMessage(this.box!), after = boxMessage(b);
    this.box = b;
    this.caretOn = true;
    if (JSON.stringify(before) === JSON.stringify(after)) { this.draw(); return; }
    this.say('');
    const { translevel: t, msg: n } = this.target();
    try {
      this.app.romEdit(t ? `Level ${hex3(translevelToLevel(t))}: message ${n}` : messageLabel(t, n), () => writeMessages(this.app.rom, [{ translevel: t, msg: n, message: after }]), { key: `msg:${t}:${n}` });
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), 'error');
      this.box = null;
      this.build();
    }
    this.draw();
  }

  private draw(): void {
    const b = this.box, c = this.canvas;
    if (!b || !c) return;
    const focused = document.activeElement === this.input;
    drawMessage(this.app, c, boxMessage(b), focused && this.caretOn ? b : undefined);
    b.lines.forEach((l, k) => {
      const left = charsLeft(l);
      this.left[k].textContent = String(left);
      this.left[k].classList.toggle('full', !left);
    });
    if (this.where) this.where.textContent = `Line ${b.line + 1} of ${MSG_LINES}, column ${Math.min(b.col, MSG_COLS - 1) + 1} of ${MSG_COLS} · numbers: characters left`;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
