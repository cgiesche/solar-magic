// Palette editor: shows the level's CGRAM and writes changes back to the ROM
// location each color was loaded from (traced during emulation).

import type { App } from './app.ts';
import { h, modal, clear, toast, downloadBytes, pickFile } from './dom.ts';
import { snesColorToRGBA } from '../core/gfx.ts';
import { pcToSnes } from '../core/rom.ts';
import { hex } from '../core/names.ts';
import { customPalette, setCustomPalette } from '../core/patches.ts';

function rgbOf(c: number): [number, number, number] {
  return [c & 31, (c >> 5) & 31, (c >> 10) & 31];
}
function cssOf(c: number): string {
  const v = snesColorToRGBA(c);
  return `rgb(${v & 255},${(v >> 8) & 255},${(v >> 16) & 255})`;
}

export function openPaletteEditor(app: App): void {
  let r = app.emu.load(app.level.number, { ...app.buildOverrides(), trackSources: true });
  const backAreaAddr = 0x00b0a0 + app.level.header.backAreaColor * 2;
  let custom = customPalette(app.rom, app.level.number);
  const src = (i: number): number => {
    if (custom) return custom + i * 2;
    if (i === 0) return backAreaAddr;
    const a = r.cgramSrc[i * 2], b = r.cgramSrc[i * 2 + 1];
    if (a >= 0 && b === a + 1) return pcToSnes(a);
    return -1;
  };
  const color = (i: number) => (custom ? app.rom.r16(custom + i * 2) : i === 0 ? app.rom.r16(backAreaAddr) : r.cgram[i * 2] | (r.cgram[i * 2 + 1] << 8));
  let sel = 1;
  const grid = h('div', { class: 'pal-edit-grid' });
  const detail = h('div', { class: 'pal-detail' });

  const build = () => {
    clear(grid);
    for (let i = 0; i < 256; i++) {
      const known = src(i) >= 0;
      grid.appendChild(h('div', {
        class: `pal-sw${i === sel ? ' sel' : ''}${known ? '' : ' unknown'}`,
        style: { background: cssOf(color(i)) },
        title: `Farbe ${hex(i, 2)}${known ? ` – ROM $${hex(src(i), 6)}` : ' – dynamisch/unbekannte Quelle'}`,
        onclick: () => { sel = i; build(); },
      }));
    }
    buildDetail();
  };

  const buildDetail = () => {
    clear(detail);
    const c = color(sel);
    const addr = src(sel);
    const [R, G, B] = rgbOf(c);
    const vals = [R, G, B];
    const sliders = ['R', 'G', 'B'].map((l, k) => {
      const inp = h('input', { type: 'range', min: 0, max: 31, value: String(vals[k]) });
      const num = h('span', { class: 'mono' }, String(vals[k]));
      inp.addEventListener('input', () => { vals[k] = Number(inp.value); num.textContent = inp.value; preview.style.background = cssOf(vals[0] | (vals[1] << 5) | (vals[2] << 10)); });
      inp.addEventListener('change', () => apply(vals[0] | (vals[1] << 5) | (vals[2] << 10)));
      return h('div', { class: 'prop' }, h('label', null, l), inp, num);
    });
    const preview = h('div', { class: 'pal-preview', style: { background: cssOf(c) } });
    const picker = h('input', { type: 'color', value: '#' + [R, G, B].map((v) => ((v << 3) | (v >> 2)).toString(16).padStart(2, '0')).join('') });
    picker.addEventListener('change', () => {
      const v = picker.value;
      const rr = parseInt(v.slice(1, 3), 16) >> 3, gg = parseInt(v.slice(3, 5), 16) >> 3, bb = parseInt(v.slice(5, 7), 16) >> 3;
      apply(rr | (gg << 5) | (bb << 10));
    });
    detail.append(
      h('div', { class: 'prop-title' }, `Farbe ${hex(sel, 2)} (Palette ${sel >> 4}, Index ${sel & 15})`),
      preview,
      h('div', { class: 'prop' }, h('label', null, 'SNES-Wert'), h('span', { class: 'mono' }, `$${hex(c, 4)}`)),
      h('div', { class: 'prop' }, h('label', null, 'ROM-Adresse'), h('span', { class: 'mono' }, addr >= 0 ? `$${hex(addr, 6)}` : '– (nicht editierbar)')),
      ...(addr >= 0 ? [...sliders, h('div', { class: 'prop' }, h('label', null, 'Farbwähler'), picker)] : []),
      (() => {
        const cb = h('input', { type: 'checkbox', checked: custom !== 0 });
        cb.addEventListener('change', () => {
          try {
            if (cb.checked) {
              const pal = new Uint8Array(512);
              for (let i = 0; i < 256; i++) { const v = color(i); pal[i * 2] = v & 0xff; pal[i * 2 + 1] = v >> 8; }
              custom = setCustomPalette(app.rom, app.level.number, pal);
            } else {
              setCustomPalette(app.rom, app.level.number, null);
              custom = 0;
            }
            app.emu.syncRom();
            r = app.emu.load(app.level.number, { ...app.buildOverrides(), trackSources: true });
            app.refresh();
            app.palettesChanged();
            build();
          } catch (e) { toast(String(e), 'error'); }
        });
        return h('label', { class: 'toggle' }, cb, ' Eigene Palette für dieses Level (alle 256 Farben editierbar)');
      })(),
      h('p', { class: 'hint' }, custom ? 'Dieses Level nutzt eine eigene Palette (Editor-Patch). Mario-Farben (Zeile 8, 6–F) und animierte Farben überschreibt das Spiel laufend.' : 'Paletten sind in SMW zwischen Levels geteilt (über FG-/BG-/Sprite-Palettennummer im Header). Änderungen wirken auf alle Levels, die diese Palette benutzen. Graue Kästchen: Farben ohne feste ROM-Quelle (z. B. Statusleiste, dynamisch).'),
    );
  };

  const apply = (v: number) => {
    const addr = src(sel);
    if (addr < 0) return;
    app.rom.w16(addr, v);
    app.emu.syncRom();
    r = app.emu.load(app.level.number, { ...app.buildOverrides(), trackSources: true });
    app.refresh();
    app.palettesChanged();
    build();
  };

  const exportPal = () => {
    const out = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      const v = snesColorToRGBA(color(i));
      out[i * 3] = v & 255; out[i * 3 + 1] = (v >> 8) & 255; out[i * 3 + 2] = (v >> 16) & 255;
    }
    downloadBytes(`level${hex(app.level.number, 3)}.pal`, out);
  };
  const importPal = async () => {
    const f = await pickFile('.pal');
    if (!f) return;
    const d = new Uint8Array(await f.arrayBuffer());
    if (d.length < 768) { toast('.pal-Datei muss 768 Bytes (256 RGB-Farben) haben', 'error'); return; }
    let n = 0;
    for (let i = 0; i < 256; i++) {
      const a = src(i);
      if (a < 0) continue;
      app.rom.w16(a, (d[i * 3] >> 3) | ((d[i * 3 + 1] >> 3) << 5) | ((d[i * 3 + 2] >> 3) << 10));
      n++;
    }
    app.emu.syncRom();
    r = app.emu.load(app.level.number, { ...app.buildOverrides(), trackSources: true });
    app.refresh();
    app.palettesChanged();
    build();
    toast(`${n} Farben übernommen`);
  };

  build();
  modal(`Paletten – Level ${hex(app.level.number, 3)}`, h('div', { class: 'pal-editor' }, grid, detail), [
    { label: '.pal exportieren', onClick: () => { exportPal(); return false; } },
    { label: '.pal importieren', onClick: () => { void importPal(); return false; } },
    { label: 'Schließen', primary: true, onClick: () => { app.persist(); } },
  ]);
}
