// "Eigenschaften" in mode 'exit' (Ein-/Ausgänge): the chosen screen's exit, a secondary entrance,
// the main entrance or the midway point – where it leads, who leads here, all chosen by level name.

import type { App, Marker } from './app.ts';
import { h, select, toast, choose } from './dom.ts';
import { hex2, hex3, ENTRANCE_ACTIONS } from '../core/names.ts';
import { newUid, readSecondaryEntrance, readSecondaryHeader, mainTranslevel } from '../core/level.ts';
import { exitTarget, sameBank, type ExitRef } from '../core/exitgraph.ts';
import { levelPicker } from './levelpicker.ts';
import { openTestPlay } from './testplay.ts';

const field = (label: string, ...input: (HTMLElement | string)[]) => h('div', { class: 'prop' }, h('label', null, label), ...input);
const hint = (...txt: (HTMLElement | string)[]) => h('div', { class: 'hint' }, ...txt);
const range = (n: number): [number, string][] => Array.from({ length: n }, (_, i) => [i, String(i)]);
const actions = (): [number, string][] => ENTRANCE_ACTIONS.map((a, i) => [i, `${i} – ${a}`]);

// returns true while the screen's block behaviour (pipes, doors) is still being probed
export function buildExitPanel(app: App, body: HTMLElement): boolean {
  const sel = app.exitMarker;
  if (sel?.kind === 'sec' && !app.secEntrances.includes(sel.index)) app.exitMarker = null;
  else if (sel?.kind === 'sec') { secondaryPanel(app, body, sel.index); return false; }
  else if (sel) { mainPanel(app, body, sel.kind); return false; }
  return exitPanel(app, body);
}

// ---- screen exit ----
function exitPanel(app: App, body: HTMLElement): boolean {
  const lv = app.level, n = lv.number, scr = app.exitScreen;
  const g = app.exitGraph();
  const enter = app.enterableOn(scr);
  const ex = lv.exits.find((e) => e.screen === scr);
  body.append(h('div', { class: 'prop-title' }, `Screen ${hex2(scr)} – Exit`));
  if (!ex) {
    body.append(
      hint(enter ? 'Auf diesem Screen gibt es Rohre oder Türen, aber noch keinen Exit – sie führen nirgendwohin.' : 'Kein Exit auf diesem Screen.'),
      h('button', {
        class: 'primary',
        onclick: () => {
          app.checkpoint();
          lv.exits.push({ uid: newUid(), screen: scr, dest: n & 0x1ff, secondary: false, flags: 0 });
          app.changed(false);
        },
      }, 'Exit anlegen'),
      hint('Ein Exit gilt für alle Rohre und Türen dieses Screens. Anderen Screen per Klick in der Levelansicht wählen, Eingänge (M, Z, S) ebenso.'));
    return enter === null;
  }
  const e = ex;
  const t = exitTarget(app.rom, n, e);
  const upd = (f: () => void) => { app.checkpoint(); f(); app.changed(false); };
  // a secondary exit into `level`: its first entrance, or a new one at its main entrance
  const secondaryTo = (level: number) => {
    const idx = g.entrancesOf(level)[0] ?? newEntranceIn(app, level);
    if (idx !== null) upd(() => { e.secondary = true; e.dest = idx & 0x1ff; });
  };
  const radio = (secondary: boolean, label: string, title: string) => {
    const r = h('input', { type: 'radio', name: 'exit-kind', checked: e.secondary === secondary });
    r.addEventListener('change', () => { if (secondary) secondaryTo(t.to); else upd(() => { e.secondary = false; e.dest = t.to & 0x1ff; }); });
    return h('label', { class: 'row', title }, r, label);
  };
  body.append(
    field('Führt zum', h('div', { class: 'radio-col' },
      radio(false, 'Haupteingang eines Levels', 'Mario kommt am Haupteingang (M) des Ziellevels heraus'),
      radio(true, 'Sekundären Eingang', 'Mario kommt an einem bestimmten Eingang (S) des Ziellevels heraus, z. B. an einem Rohr'))),
    field('Ziellevel', levelPicker(app, t.to, (m) => sameBank(m, n), (m) => {
      if (e.secondary) secondaryTo(m); else upd(() => (e.dest = m & 0x1ff));
    })),
  );
  if (e.secondary) {
    const ents = g.entrancesOf(t.to);
    if (!ents.includes(t.entrance)) ents.unshift(t.entrance);
    const label = (i: number) => {
      const s = readSecondaryEntrance(app.rom, i);
      return g.entrancesOf(t.to).includes(i) ? `${hex3(i)} · Screen ${hex2(s.screen)} · ${ENTRANCE_ACTIONS[s.action]}` : `${hex3(i)} (leer)`;
    };
    body.append(field('Eingang',
      select(ents.map((i) => [i, label(i)]), t.entrance, (v) => upd(() => (e.dest = v & 0x1ff))),
      h('button', {
        title: 'Neuen sekundären Eingang im Ziellevel anlegen (am Haupteingang, danach verschieben)',
        onclick: () => { const idx = newEntranceIn(app, t.to); if (idx !== null) upd(() => (e.dest = idx & 0x1ff)); },
      }, '+ Neu')));
  }
  // where Mario arrives
  const arrive = e.secondary ? (() => {
    const s = readSecondaryEntrance(app.rom, t.entrance);
    return g.entrancesOf(t.to).includes(t.entrance)
      ? `Sekundärer Eingang ${hex3(t.entrance)}: Screen ${hex2(s.screen)}, ${ENTRANCE_ACTIONS[s.action]}`
      : `Sekundärer Eingang ${hex3(t.entrance)} ist leer – „+ Neu“ legt einen an.`;
  })() : (() => {
    const s = t.to === n ? lv.secondary : readSecondaryHeader(app.rom, t.to);
    return `Haupteingang: Screen ${hex2(s.entranceScreen)}, ${ENTRANCE_ACTIONS[s.entranceAction]}`;
  })();
  body.append(
    h('div', { class: 'exit-target' },
      h('div', null, 'Mario landet in ', h('b', null, `Level ${hex3(t.to)}`), ' ', h('span', { class: 'lname' }, g.name(t.to))),
      hint(arrive),
      h('div', { class: 'row' },
        h('button', { title: 'Das Ziellevel öffnen und den Eingang auswählen', onclick: () => app.gotoExitTarget(e) }, '→ Ziel öffnen'),
        h('button', { class: 'danger', onclick: () => { app.checkpoint(); lv.exits = lv.exits.filter((x) => x !== e); app.changed(false); } }, 'Exit löschen'))),
    hint(`Nur Level ${n & 0x100 ? '100–1FF' : '000–0FF'} wählbar: das obere Bit der Zielnummer kommt vom Level, in dem der Exit liegt.`),
    hint(enter === false ? 'Auf diesem Screen wurden keine Rohre oder Türen gefunden.' : 'Der Exit gilt für alle Rohre und Türen dieses Screens.'),
  );
  return enter === null;
}

// a new secondary entrance into `level`, placed like its main entrance
export function newEntranceIn(app: App, level: number): number | null {
  const idx = app.exitGraph().freeEntrance(level);
  if (idx === null) { toast(`Kein freier sekundärer Eingang mehr in ${level & 0x100 ? '100–1FF' : '000–0FF'}.`, 'error'); return null; }
  const s = level === app.level.number ? app.level.secondary : readSecondaryHeader(app.rom, level);
  app.editSecondaryEntrance(idx, `Sekundärer Eingang ${hex3(idx)} angelegt`, (x) => {
    x.destLevel = level & 0xff; x.screen = s.entranceScreen; x.entranceX = s.entranceX; x.entranceY = s.entranceY;
    x.action = s.entranceAction; x.fgInitY = s.fgInitY; x.bgInitY = s.bgInitY;
  });
  if (level !== app.level.number) toast(`Sekundärer Eingang ${hex3(idx)} in Level ${hex3(level)} angelegt (am Haupteingang) – mit „Ziel öffnen“ hinwechseln und verschieben.`);
  return idx;
}

// ---- who leads here ----
function users(app: App, refs: ExitRef[], extra: HTMLElement[], empty: string): HTMLElement {
  const g = app.exitGraph();
  const rows = refs.map((r) => h('div', { class: 'row' },
    h('span', { class: 'mono' }, `${hex3(r.from)}`), h('span', { class: 'lname' }, g.name(r.from)), `· Screen ${hex2(r.screen)}`,
    h('button', { class: 'link-btn', title: 'Level öffnen und den Screen mit diesem Exit wählen', onclick: () => app.gotoExit(r.from, r.screen) }, 'öffnen')));
  return h('div', { class: 'exit-users' }, h('div', { class: 'hint' }, 'Hierher führen:'), ...extra, ...rows, ...(rows.length || extra.length ? [] : [hint(empty)]));
}

// test play from a marker
function testAt(app: App, kind: Marker['kind'], index: number): void {
  const m = app.markers().find((x) => x.kind === kind && x.index === index);
  if (kind === 'main' || !m) openTestPlay(app);
  else openTestPlay(app, { tx: (m.x + 8) >> 4, ty: (m.y + 16) >> 4 });
}

// ---- secondary entrance ----
function secondaryPanel(app: App, body: HTMLElement, idx: number): void {
  const e = readSecondaryEntrance(app.rom, idx);
  const set = (label: string, f: (x: typeof e) => void, key: string) => app.editSecondaryEntrance(idx, `Sekundärer Eingang ${hex3(idx)}: ${label}`, f, `sec-entrance-${key}:${idx}`);
  const refs = app.exitGraph().usersOfEntrance(idx);
  body.append(
    h('div', { class: 'prop-title' }, `Sekundärer Eingang ${hex3(idx)}`),
    hint(`Screen ${hex2(e.screen)}, X ${e.entranceX}, Y ${e.entranceY} – Marker ziehen zum Verschieben`),
    field('Aktion', select(actions(), e.action, (v) => set('Aktion', (x) => (x.action = v), 'a'))),
    field('FG Start-Y', select(range(4), e.fgInitY, (v) => set('FG Start-Y', (x) => (x.fgInitY = v), 'f'))),
    field('BG Start-Y', select(range(4), e.bgInitY, (v) => set('BG Start-Y', (x) => (x.bgInitY = v), 'b'))),
    users(app, refs, [], 'Noch kein Exit. In einem anderen Level einen Screen wählen, „Exit anlegen“, „Sekundären Eingang“ und dieses Level als Ziel wählen.'),
    h('div', { class: 'row' },
      h('button', { title: 'Testspiel ab diesem Eingang', onclick: () => testAt(app, 'sec', idx) }, '▶ Hier testen'),
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (refs.length) {
            const r = await choose(`Eingang ${hex3(idx)} entfernen`, `${refs.length} Exit(s) führen noch hierher und landen danach im Leeren. Trotzdem entfernen? (rückgängig machbar)`, [{ label: 'Abbrechen' }, { label: 'Entfernen', danger: true }]);
            if (r !== 1) return;
          }
          app.removeSecondaryEntrance(idx);
        },
      }, 'Entfernen')),
    hint('Ändert die ROM direkt (rückgängig machbar mit Strg+Z).'),
  );
}

// ---- main entrance / midway point ----
function mainPanel(app: App, body: HTMLElement, kind: 'main' | 'midway'): void {
  const lv = app.level, s = lv.secondary, n = lv.number;
  const upd = (f: () => void) => { app.checkpoint(); f(); app.changed(); };
  if (kind === 'midway') {
    body.append(
      h('div', { class: 'prop-title' }, 'Zwischenziel (Midway)'),
      field('Screen', select(range(Math.min(16, lv.header.screens)).map(([v]) => [v, hex2(v)]), s.midwayScreen, (v) => upd(() => (s.midwayScreen = v)))),
      hint('Höhe und Position im Screen teilt sich das Zwischenziel mit dem Haupteingang (M); nur der Screen ist eigen. Es wirkt, wenn Mario die Zwischenziel-Tafel des Levels berührt hat.'),
      h('div', { class: 'row' }, h('button', { onclick: () => testAt(app, 'midway', 0) }, '▶ Hier testen')),
    );
    return;
  }
  const g = app.exitGraph();
  const tl = mainTranslevel(n);
  const extra = tl ? [h('div', { class: 'row' }, h('span', null, 'Overworld'), h('span', { class: 'lname' }, `(Level-Feld, Translevel ${hex2(tl)})`))] : [];
  body.append(
    h('div', { class: 'prop-title' }, 'Haupteingang'),
    hint(`Screen ${hex2(s.entranceScreen)}, X ${s.entranceX}, Y ${s.entranceY} – Marker ziehen zum Verschieben`),
    field('Aktion', select(actions(), s.entranceAction, (v) => upd(() => (s.entranceAction = v)))),
    users(app, g.exitsInto(n).filter((r) => !r.secondary), extra, 'Kein Exit führt zum Haupteingang.'),
    h('div', { class: 'row' }, h('button', { title: 'Testspiel ab dem Haupteingang (T)', onclick: () => testAt(app, 'main', 0) }, '▶ Hier testen')),
    hint('Weitere Einstellungen (Scrollen, Layer 3 …) im Header-Dialog (H).'),
  );
}

