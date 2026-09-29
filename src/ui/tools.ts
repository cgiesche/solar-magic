// Misc. dialogs: secondary entrances, ROM info/expansion, level copy.

import type { App } from './app.ts';
import { h, modal, clear, hexInput, select, toast } from './dom.ts';
import { readSecondaryEntrance, writeSecondaryEntrance, type SecondaryEntrance, loadLevel, cloneLevel } from '../core/level.ts';
import { ENTRANCE_ACTIONS, hex } from '../core/names.ts';
import { saveLevel } from '../core/save.ts';
import { hasSpriteBankPatch, applySpriteBankPatch } from '../core/patches.ts';

export function openEntrancesDialog(app: App): void {
  const rom = app.rom;
  let sel = 0;
  const filter = h('input', { type: 'checkbox', checked: true });
  const list = h('div', { class: 'gfx-list', style: 'height: 420px' });
  const detail = h('div', { class: 'ent-detail' });
  // which secondary exits point into this level (for "only this level")
  const buildList = () => {
    clear(list);
    const lvLow = app.level.number & 0xff;
    for (let i = 0; i < 0x200; i++) {
      const e = readSecondaryEntrance(rom, i);
      if (filter.checked && e.destLevel !== lvLow) continue;
      list.appendChild(h('div', { class: `level-item${i === sel ? ' current' : ''}`, onclick: () => { sel = i; buildList(); buildDetail(); } }, `${hex(i, 3)} → ${hex(e.destLevel, 2)}`));
    }
  };
  const buildDetail = () => {
    clear(detail);
    const e = readSecondaryEntrance(rom, sel);
    const set = (f: (x: SecondaryEntrance) => void) => { const x = readSecondaryEntrance(rom, sel); f(x); writeSecondaryEntrance(rom, sel, x); app.emu.syncRom(); buildList(); buildDetail(); };
    const range = (n: number): [number, string][] => Array.from({ length: n }, (_, i) => [i, String(i)]);
    detail.append(
      h('div', { class: 'prop-title' }, `Sekundärer Eingang ${hex(sel, 3)}`),
      h('div', { class: 'prop' }, h('label', null, 'Ziel-Level (low)'), hexInput(e.destLevel, 2, (v) => set((x) => (x.destLevel = v)))),
      h('div', { class: 'hint' }, 'Das High-Bit der Levelnummer (0xx/1xx) ergibt sich in Vanilla-SMW aus der Karte, auf der das Hauptlevel liegt.'),
      h('div', { class: 'prop' }, h('label', null, 'Screen'), hexInput(e.screen, 2, (v) => set((x) => (x.screen = v)), 0x1f)),
      h('div', { class: 'prop' }, h('label', null, 'X-Position'), select(range(8), e.entranceX, (v) => set((x) => (x.entranceX = v)))),
      h('div', { class: 'prop' }, h('label', null, 'Y-Position'), select(range(16), e.entranceY, (v) => set((x) => (x.entranceY = v)))),
      h('div', { class: 'prop' }, h('label', null, 'Aktion'), select(ENTRANCE_ACTIONS.map((a, i) => [i, `${i} – ${a}`] as [number, string]), e.action, (v) => set((x) => (x.action = v)))),
      h('div', { class: 'prop' }, h('label', null, 'FG Start-Y'), select(range(4), e.fgInitY, (v) => set((x) => (x.fgInitY = v)))),
      h('div', { class: 'prop' }, h('label', null, 'BG Start-Y'), select(range(4), e.bgInitY, (v) => set((x) => (x.bgInitY = v)))),
      h('button', { onclick: () => { const n = app.level.number & 0xff; set((x) => (x.destLevel = n)); } }, `Auf aktuelles Level (${hex(app.level.number & 0xff, 2)}) setzen`),
    );
  };
  filter.addEventListener('change', buildList);
  const first = (() => { for (let i = 0; i < 0x200; i++) if (readSecondaryEntrance(rom, i).destLevel === (app.level.number & 0xff)) return i; return 0; })();
  sel = first;
  buildList();
  buildDetail();
  modal('Sekundäre Eingänge', h('div', { class: 'ent-editor' },
    h('div', null, h('label', { class: 'row small' }, filter, ' nur Ziel = aktuelles Level'), list), detail),
  [{ label: 'Schließen', primary: true, onClick: () => { app.persist(); app.refresh(); } }]);
}

export function openRomInfo(app: App): void {
  const rom = app.rom;
  const body = h('div');
  const build = () => {
    clear(body);
    const rats = rom.scanRats();
    const used = rats.reduce((a, b) => a + b.size + 8, 0);
    const expanded = Math.max(0, rom.size - 0x80000);
    body.append(
      h('div', { class: 'prop' }, h('label', null, 'Titel'), h('span', null, rom.title())),
      h('div', { class: 'prop' }, h('label', null, 'Größe'), h('span', null, `${rom.size / 1024} KB${rom.smcHeader ? ' (+512 Byte Copier-Header)' : ''}`)),
      h('div', { class: 'prop' }, h('label', null, 'Erweiterter Bereich'), h('span', null, `${expanded / 1024} KB, davon ${(used / 1024).toFixed(1)} KB belegt (${rats.length} RATS-Blöcke)`)),
      h('div', { class: 'prop' }, h('label', null, 'Sprite-Bank-Patch'), h('span', null, hasSpriteBankPatch(rom) ? 'installiert' : 'nicht installiert')),
      h('h3', null, 'ROM erweitern'),
      h('p', { class: 'hint' }, 'Mehr Platz für Levels, Grafiken, Musik usw. Beim Speichern wird automatisch erweitert, wenn nötig. Maximal 4 MB (LoROM).'),
      h('div', { class: 'row' }, [0x100000, 0x200000, 0x400000].map((sz) => h('button', {
        disabled: rom.size >= sz,
        onclick: () => { rom.expand(sz); app.emu.syncRom(); app.persist(); toast(`ROM auf ${sz / 1048576} MB erweitert`); build(); },
      }, `${sz / 1048576} MB`))),
      h('h3', null, 'Patches'),
      h('div', { class: 'row' }, h('button', {
        disabled: hasSpriteBankPatch(rom),
        onclick: () => { try { applySpriteBankPatch(rom); app.emu.syncRom(); app.persist(); toast('Sprite-Bank-Patch installiert'); } catch (e) { toast(String(e), 'error'); } build(); },
      }, 'Sprite-Daten in beliebigen Banks erlauben')),
    );
  };
  build();
  modal('ROM-Informationen', body, [{ label: 'Schließen', primary: true }]);
}

export function openCopyLevel(app: App): void {
  let target = app.level.number;
  const body = h('div', null,
    h('p', null, `Level ${hex(app.level.number, 3)} (mit allen aktuellen Änderungen) unter einer anderen Nummer speichern. Das Ziel wird überschrieben.`),
    h('div', { class: 'prop' }, h('label', null, 'Ziel-Level'), hexInput(target, 3, (v) => (target = v), 0x1ff)),
  );
  modal('Level kopieren / speichern unter', body, [
    { label: 'Abbrechen' },
    {
      label: 'Speichern', primary: true, onClick: () => {
        const copy = cloneLevel(app.level);
        const dst = loadLevel(app.rom, target);
        copy.number = target;
        // write into fresh space: pretend old data of target is the destination
        copy.l1Addr = dst.l1Addr; copy.l1Size = 0; copy.l2Size = 0; copy.sprAddr = dst.sprAddr; copy.sprSize = 0;
        try {
          const log = saveLevel(app.rom, copy);
          app.emu.syncRom();
          app.persist();
          toast(`Gespeichert als Level ${hex(target, 3)}: ${log.join(' · ')}`);
          app.emit('level');
        } catch (e) {
          toast(String(e), 'error');
        }
      },
    },
  ]);
}
