// Message box editor: 25 vanilla messages, preview in the game's font.

import type { App } from './app.ts';
import { h, modal, clear, toast } from './dom.ts';
import { hex } from '../core/names.ts';
import { translevelToLevel, levelName } from '../core/overworld.ts';
import { readMessage, writeMessages, lineToText, textToLine, messageUsers, MSG_COUNT, MSG_LINES, MSG_COLS, type Message } from '../core/messages.ts';
import { TileCache, blit8 } from '../core/render.ts';
import { levelTranslevel } from '../core/level.ts';

function label(app: App, i: number, users: { translevel: number; msg: number }[]): string {
  if (i < 4) return `Switch palace ${i + 1}`;
  if (i === 0x17) return 'Yoshi\'s House (with Yoshi)';
  if (i === 0x18) return 'Message 3 (intro)';
  return users.map((u) => `Level ${hex(translevelToLevel(u.translevel), 3)} ${levelName(app.rom, u.translevel)} · message ${u.msg}`).join(', ') || '(unused)';
}

export function openMessagesDialog(app: App): void {
  const rom = app.rom;
  const msgs: Message[] = Array.from({ length: MSG_COUNT }, (_, i) => readMessage(rom, i));
  const users = messageUsers(rom);
  const tl = levelTranslevel(rom, app.level.number) || -1;
  let sel = Math.max(0, users.findIndex((u) => u.some((x) => x.translevel === tl)));
  let changed = false;
  const list = h('div', { class: 'msg-list' });
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
    clear(list);
    for (let i = 0; i < MSG_COUNT; i++) {
      const mine = users[i].some((x) => x.translevel === tl);
      list.appendChild(h('div', { class: `level-item${i === sel ? ' current' : ''}${mine ? ' used' : ''}`, title: label(app, i, users[i]), onclick: () => { sel = i; buildList(); buildDetail(); } },
        `${hex(i, 2)} ${label(app, i, users[i])}`));
    }
  };
  const buildDetail = () => {
    clear(detail);
    const m = msgs[sel];
    const canvas = h('canvas', { width: MSG_COLS * 8 + 16, height: MSG_LINES * 8 + 16, class: 'msg-preview' });
    const err = h('div', { class: 'hint error' });
    const inputs = m.map((line, y) => {
      const inp = h('input', { class: 'msg-line', value: lineToText(line), spellcheck: false });
      inp.addEventListener('input', () => {
        try {
          msgs[sel][y] = textToLine(inp.value);
          inp.classList.remove('invalid');
          err.textContent = '';
          changed = true;
          drawPreview(canvas, msgs[sel]);
        } catch (e) {
          inp.classList.add('invalid');
          err.textContent = e instanceof Error ? e.message : String(e);
        }
      });
      return inp;
    });
    detail.append(
      h('div', { class: 'prop-title' }, `Message ${hex(sel, 2)} – ${label(app, sel, users[sel])}`),
      canvas,
      h('div', { class: 'msg-lines' }, inputs),
      err,
      h('p', { class: 'hint' }, `Up to ${MSG_COLS} characters per line: A–Z a–z 0–7 ! . - , ? # ( ) ' and space; other characters as {xx} (hex code in the font, e.g. {60}{61} for Yoshi's signature). The font has no 8 and 9.`),
    );
    drawPreview(canvas, m);
  };
  buildList();
  buildDetail();
  modal('Messages', h('div', { class: 'msg-editor' }, list, detail), [
    { label: 'Cancel' },
    {
      label: 'Apply', primary: true, onClick: () => {
        if (!changed) return;
        try {
          const log = app.romEdit('Messages changed', () => writeMessages(rom, msgs));
          toast(`Messages saved: ${log}`);
        } catch (e) {
          toast(String(e instanceof Error ? e.message : e), 'error');
          return false;
        }
      },
    },
  ]);
}
