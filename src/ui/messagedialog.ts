// Message box editor: a level's two messages (its translevel's) and Yoshi's thank-you, preview in the game's font.

import type { App } from './app.ts';
import { h, modal, clear, toast } from './dom.ts';
import { hex } from '../core/names.ts';
import { translevelToLevel, levelName } from '../core/overworld.ts';
import { readMessage, writeMessages, lineToText, textToLine, switchPalace, yoshiHouse, YOSHI_THANKS, MSG_LINES, MSG_COLS, type Message, type MessageChange } from '../core/messages.ts';
import { TileCache, blit8 } from '../core/render.ts';
import { levelTranslevel } from '../core/level.ts';

interface Entry { translevel: number; msg: number; label: string; note: string }

// the messages of translevel tl and Yoshi's thank-you, with when the game shows them
function entries(app: App, tl: number): Entry[] {
  const rom = app.rom, palace = switchPalace(rom, tl), yoshi = yoshiHouse(rom) === tl;
  const thanks = 'Message 3 – Yoshi\'s thank-you';
  const thanksNote = 'Shown in any level the first time Mario frees Yoshi.';
  const out: Entry[] = [
    { translevel: tl, msg: 1, label: 'Message 1', note: yoshi ? 'Shown while Mario isn\'t riding Yoshi.' : palace >= 0 ? `Also presses this switch palace's switch (switch ${palace + 1}) and returns to the overworld when closed.` : '' },
    tl === YOSHI_THANKS.translevel ? { translevel: tl, msg: 2, label: `Message 2 = ${thanks}`, note: thanksNote }
      : { translevel: tl, msg: 2, label: 'Message 2', note: yoshi ? 'Shown instead of message 1 while Mario rides Yoshi.' : '' },
  ];
  if (tl !== YOSHI_THANKS.translevel) out.push({ ...YOSHI_THANKS, label: thanks, note: thanksNote });
  return out;
}

// tl: the translevel whose messages to edit (default: the open level's)
export function openMessagesDialog(app: App, tl = levelTranslevel(app.rom, app.level.number)): void {
  const rom = app.rom;
  const list = entries(app, tl);
  const msgs: Message[] = list.map((e) => readMessage(rom, e.translevel, e.msg));
  const changed = new Set<number>();
  let sel = 0;
  const side = h('div', { class: 'msg-list' });
  const detail = h('div', { class: 'msg-detail' });
  // glyphs: BG3 tile $100 + code, attribute $39 as written by the game
  const r = app.render;
  const tc = new TileCache(r.vram, r.cgram, (r.ppuRegs[0x0c] & 0x0f) << 13);
  const drawPreview = (c: HTMLCanvasElement, m: Message) => {
    const W = MSG_COLS * 8 + 16, H = MSG_LINES * 8 + 16;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const px = new Uint32Array(img.data.buffer).fill(0xff000000);
    m.forEach((line, y) => { for (let x = 0; x < MSG_COLS; x++) blit8(px, W, H, tc.get(0x3900 | (line[x] ?? 0x1f), 2), 8 + x * 8, 8 + y * 8); });
    ctx.putImageData(img, 0, 0);
  };
  const buildList = () => {
    clear(side);
    list.forEach((e, i) => side.appendChild(h('div', { class: `level-item${i === sel ? ' current' : ''}`, title: e.label, onclick: () => { sel = i; buildList(); buildDetail(); } }, e.label)));
  };
  const buildDetail = () => {
    clear(detail);
    const e = list[sel], m = msgs[sel];
    const canvas = h('canvas', { width: MSG_COLS * 8 + 16, height: MSG_LINES * 8 + 16, class: 'msg-preview' });
    const err = h('div', { class: 'hint error' });
    const inputs = Array.from({ length: MSG_LINES }, (_, y) => {
      const inp = h('input', { class: 'msg-line', value: lineToText(m[y] ?? []), spellcheck: false });
      inp.addEventListener('input', () => {
        try {
          msgs[sel][y] = textToLine(inp.value);
          inp.classList.remove('invalid');
          err.textContent = '';
          changed.add(sel);
          drawPreview(canvas, msgs[sel]);
        } catch (ex) {
          inp.classList.add('invalid');
          err.textContent = ex instanceof Error ? ex.message : String(ex);
        }
      });
      return inp;
    });
    detail.append(
      h('div', { class: 'prop-title' }, e.label),
      ...(e.note ? [h('p', { class: 'hint' }, e.note)] : []),
      canvas,
      h('div', { class: 'msg-lines' }, inputs),
      err,
      h('p', { class: 'hint' }, `Up to ${MSG_COLS} characters per line: A–Z a–z 0–7 ! . - , ? # ( ) ' and space; other characters as {xx} (hex code in the font, e.g. {60}{61} for Yoshi's signature). The font has no 8 and 9. A level without text shows an empty box.`),
    );
    drawPreview(canvas, m);
  };
  buildList();
  buildDetail();
  const lvl = translevelToLevel(tl);
  const head = tl ? `Level ${hex(lvl, 3)} ${levelName(rom, tl)} (translevel ${hex(tl, 2)}) – the message box sprite shows message 1 or 2.`
    : 'No level tile leads to this level: its message boxes show the messages of translevel 0 (message 1 the intro\'s).';
  modal('Message boxes', h('div', null, h('p', { class: 'hint' }, head), h('div', { class: 'msg-editor' }, side, detail)), [
    { label: 'Cancel' },
    {
      label: 'Apply', primary: true, onClick: () => {
        if (!changed.size) return;
        const edits: MessageChange[] = [...changed].map((i) => ({ translevel: list[i].translevel, msg: list[i].msg, message: msgs[i] }));
        try {
          const log = app.romEdit(tl ? `Level ${hex(lvl, 3)}: messages` : 'Messages', () => writeMessages(rom, edits));
          toast(`Messages saved: ${log}`);
        } catch (e) {
          toast(String(e instanceof Error ? e.message : e), 'error');
          return false;
        }
      },
    },
  ]);
}
