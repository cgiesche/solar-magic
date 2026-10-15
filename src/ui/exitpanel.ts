// "Properties" in mode 'exit' (Entrances/Exits): the chosen screen's exit, a secondary entrance,
// the main entrance or the midway point – where it leads, who leads here, all chosen by level name.

import type { App, Marker } from './app.ts';
import { h, select, toast, choose, checkbox } from './dom.ts';
import { hex2, hex3, ENTRANCE_ACTIONS } from '../core/names.ts';
import {
  newUid, readSecondaryEntrance, readSecondaryHeader, mainTranslevel, mainSpot, secondarySpot, setSecondarySpot, copyCameraStart, hasRelativeCamera,
  copyEntranceOptions, setExitSecondary, EXIT_WATER, EXIT_MIDWAY, exitToMidway, midwaySpot, midwayEntrance, setMidwayEntrance, midwayStart, nearestMidway, placeMidway, entrancePos,
  type MidwayEntrance,
} from '../core/level.ts';
import { spotText, cameraOptions, cameraValue, setCamera, cameraFields, optionFields } from './entrancefields.ts';
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
      hint(enter ? 'This screen has pipes or doors but no exit yet – they lead nowhere.' : 'No exit on this screen.'),
      h('button', {
        class: 'primary',
        onclick: () => { app.editLevel(() => { lv.exits.push({ uid: newUid(), screen: scr, dest: n & 0x1ff, secondary: false, flags: 0 }); }, false); },
      }, 'Create exit'),
      hint('An exit applies to all pipes and doors of this screen. Click another screen in the level view to select it, likewise entrances (M, Z, S).'));
    return enter === null;
  }
  const e = ex;
  const t = exitTarget(app.rom, n, e);
  const upd = (f: () => void) => app.editLevel(f, false);
  // a secondary exit into `level`: its first entrance, or a new one at its main entrance
  const secondaryTo = (level: number) => {
    const idx = g.entrancesOf(level)[0] ?? newEntranceIn(app, level);
    if (idx !== null) upd(() => { setExitSecondary(e, true); e.dest = idx & 0x1ff; });
  };
  const radio = (secondary: boolean, label: string, title: string) => {
    const r = h('input', { type: 'radio', name: 'exit-kind', checked: e.secondary === secondary });
    r.addEventListener('change', () => { if (secondary) secondaryTo(t.to); else upd(() => { setExitSecondary(e, false); e.dest = t.to & 0x1ff; }); });
    return h('label', { class: 'row', title }, r, label);
  };
  body.append(
    field('Leads to', h('div', { class: 'radio-col' },
      radio(false, 'Main entrance of a level', 'Mario comes out at the main entrance (M) of the target level'),
      radio(true, 'Secondary entrance', 'Mario comes out at a specific entrance (S) of the target level, e.g. at a pipe'))),
    field('Target level', levelPicker(app, t.to, (m) => sameBank(m, n), (m) => {
      if (e.secondary) secondaryTo(m); else upd(() => (e.dest = m & 0x1ff));
    })),
  );
  if (e.secondary) {
    const ents = g.entrancesOf(t.to);
    if (!ents.includes(t.entrance)) ents.unshift(t.entrance);
    const label = (i: number) => {
      const s = readSecondaryEntrance(app.rom, i);
      return g.entrancesOf(t.to).includes(i) ? `${hex3(i)} · Screen ${hex2(s.screen)} · ${ENTRANCE_ACTIONS[s.action]}` : `${hex3(i)} (empty)`;
    };
    body.append(field('Entrance',
      select(ents.map((i) => [i, label(i)]), t.entrance, (v) => upd(() => (e.dest = v & 0x1ff))),
      h('button', {
        title: 'Create a new secondary entrance in the target level (at the main entrance, move it afterwards)',
        onclick: () => { const idx = newEntranceIn(app, t.to); if (idx !== null) upd(() => (e.dest = idx & 0x1ff)); },
      }, '+ New')),
      field('Options', checkbox('Water level', 'Mario swims in the whole target level when he comes through this exit (also when the entrance is no water level)',
        !!(e.flags & EXIT_WATER), (on) => upd(() => { e.flags = on ? e.flags | EXIT_WATER : e.flags & ~EXIT_WATER; }))));
  } else {
    body.append(field('Options', checkbox('Go to midway entrance',
      'Mario comes out at the midway entrance (Z) of the target level – when its midway point has its own position and settings, else at its main entrance (as in Lunar Magic)',
      !!(e.flags & EXIT_MIDWAY), (on) => upd(() => { e.flags = on ? e.flags | EXIT_MIDWAY : e.flags & ~EXIT_MIDWAY; }))));
  }
  // where Mario arrives
  const arrive = e.secondary ? (() => {
    const s = readSecondaryEntrance(app.rom, t.entrance);
    return g.entrancesOf(t.to).includes(t.entrance)
      ? `Secondary entrance ${hex3(t.entrance)}: screen ${hex2(s.screen)}, ${ENTRANCE_ACTIONS[s.action]}`
      : `Secondary entrance ${hex3(t.entrance)} is empty – “+ New” creates one.`;
  })() : (() => {
    const s = t.to === n ? lv.secondary : readSecondaryHeader(app.rom, t.to);
    if (exitToMidway(e) && s.midwayOwn) return `Midway entrance: screen ${hex2(s.midwayScreen)}, ${ENTRANCE_ACTIONS[s.midwayAction]}`;
    const main = `Main entrance: screen ${hex2(s.entranceScreen)}, ${ENTRANCE_ACTIONS[s.entranceAction]}`;
    return exitToMidway(e) ? `${main} – the target's midway point has no own position and settings (give it them in its midway point's properties).` : main;
  })();
  body.append(
    h('div', { class: 'exit-target' },
      h('div', null, 'Mario arrives in ', h('b', null, `level ${hex3(t.to)}`), ' ', h('span', { class: 'lname' }, g.name(t.to))),
      hint(arrive),
      h('div', { class: 'row' },
        h('button', { title: 'Open the target level and select the entrance', onclick: () => app.gotoExitTarget(e) }, '→ Open target'),
        h('button', { class: 'danger', onclick: () => { app.editLevel(() => { lv.exits = lv.exits.filter((x) => x !== e); }, false); } }, 'Delete exit'))),
    hint(`Only levels ${n & 0x100 ? '100–1FF' : '000–0FF'} can be chosen: the high bit of the target number comes from the level the exit is in.`),
    hint(enter === false ? 'No pipes or doors were found on this screen.' : 'The exit applies to all pipes and doors of this screen.'),
  );
  return enter === null;
}

// a new secondary entrance into `level`, placed like its main entrance
export function newEntranceIn(app: App, level: number): number | null {
  const idx = app.exitGraph().freeEntrance(level);
  if (idx === null) { toast(`No free secondary entrance left in ${level & 0x100 ? '100–1FF' : '000–0FF'}.`, 'error'); return null; }
  const s = level === app.level.number ? app.level.secondary : readSecondaryHeader(app.rom, level);
  app.editSecondaryEntrance(idx, `Secondary entrance ${hex3(idx)} created`, (x) => {
    x.destLevel = level & 0xff; setSecondarySpot(x, mainSpot(s)); x.action = s.entranceAction; copyCameraStart(x, s); copyEntranceOptions(x, s);
  });
  if (level !== app.level.number) toast(`Secondary entrance ${hex3(idx)} created in level ${hex3(level)} (at the main entrance) – go there with “Open target” and move it.`);
  return idx;
}

// ---- who leads here ----
function users(app: App, refs: ExitRef[], extra: HTMLElement[], empty: string): HTMLElement {
  const g = app.exitGraph();
  const rows = refs.map((r) => h('div', { class: 'row' },
    h('span', { class: 'mono' }, `${hex3(r.from)}`), h('span', { class: 'lname' }, g.name(r.from)), `· screen ${hex2(r.screen)}`,
    h('button', { class: 'link-btn', title: 'Open the level and select the screen with this exit', onclick: () => app.gotoExit(r.from, r.screen) }, 'open')));
  return h('div', { class: 'exit-users' }, h('div', { class: 'hint' }, 'Leading here:'), ...extra, ...rows, ...(rows.length || extra.length ? [] : [hint(empty)]));
}

// test play from a marker: a secondary entrance with its own camera start, options and action, the midway
// point with its own or the main entrance's
function testAt(app: App, kind: Marker['kind'], index: number): void {
  const m = app.markers().find((x) => x.kind === kind && x.index === index);
  if (kind === 'main' || !m) openTestPlay(app);
  else openTestPlay(app, { tx: (m.x + 8) >> 4, ty: (m.y + 16) >> 4, entrance: kind === 'sec' ? readSecondaryEntrance(app.rom, index) : midwayStart(app.level.secondary) });
}

// ---- secondary entrance ----
function secondaryPanel(app: App, body: HTMLElement, idx: number): void {
  const e = readSecondaryEntrance(app.rom, idx);
  const set = (label: string, f: (x: typeof e) => void, key: string) => app.editSecondaryEntrance(idx, `Secondary entrance ${hex3(idx)}: ${label}`, f, `sec-entrance-${key}:${idx}`);
  const refs = app.exitGraph().usersOfEntrance(idx);
  body.append(
    h('div', { class: 'prop-title' }, `Secondary entrance ${hex3(idx)}`),
    hint(`${spotText(secondarySpot(e))} – drag the marker to move it`),
    field('Action', select(actions(), e.action, (v) => set('Action', (x) => (x.action = v), 'a'))),
    ...cameraFields(e, (l, f) => set(l, f, l), hasRelativeCamera(app.rom, app.level.header.mode)).map(([l, el]) => field(l, el)),
    ...optionFields(e, (l, f) => set(l, f, l)).map(([l, el]) => field(l, el)),
    users(app, refs, [], 'No exit yet. In another level, select a screen, choose “Create exit”, “Secondary entrance” and this level as the target.'),
    h('div', { class: 'row' },
      h('button', { title: 'Test play from this entrance', onclick: () => testAt(app, 'sec', idx) }, '▶ Test here'),
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (refs.length) {
            const r = await choose(`Remove entrance ${hex3(idx)}`, `${refs.length} exit(s) still lead here and will then lead nowhere. Remove anyway? (undoable)`, [{ label: 'Cancel' }, { label: 'Remove', danger: true }]);
            if (r !== 1) return;
          }
          app.removeSecondaryEntrance(idx);
        },
      }, 'Remove')),
    hint('Edits the ROM directly (undoable with Ctrl+Z).'),
  );
}

// ---- main entrance / midway point ----
function mainPanel(app: App, body: HTMLElement, kind: 'main' | 'midway'): void {
  const lv = app.level, s = lv.secondary, n = lv.number;
  const upd = (f: () => void) => app.editLevel(f);
  if (kind === 'midway') {
    // its own settings (Lunar Magic's midway entrance) through an entrance's fields; the BG start is the level's
    const m = midwayEntrance(s);
    const setOwn = (_: string, f: (x: MidwayEntrance) => void) => upd(() => { const x = midwayEntrance(s); f(x); setMidwayEntrance(s, x); });
    const own = (on: boolean) => upd(() => {
      if (!on) { s.midwayOwn = 0; return; }
      const p = entrancePos(app.rom, midwaySpot(s), (s.verticalPositioning & 1) !== 0);
      placeMidway(s, nearestMidway(app.rom, s, p.x, p.y, lv.header.screens - 1));
    });
    body.append(
      h('div', { class: 'prop-title' }, 'Midway point'),
      hint(`${spotText(midwaySpot(s))} – drag the marker to move it`),
      field('Settings', checkbox('Own position and settings', 'Lunar Magic\'s midway entrance: its own tile, action, camera start and options instead of the main entrance\'s', !!s.midwayOwn, own)),
      ...(s.midwayOwn ? [
        field('Action', select(actions(), m.action, (v) => setOwn('Action', (x) => (x.action = v)))),
        ...cameraFields(m, setOwn, hasRelativeCamera(app.rom, lv.header.mode)).map(([l, el]) => field(l, el)),
        ...optionFields(m, setOwn).map(([l, el]) => field(l, el)),
      ] : [
        field('Screen', select(range(Math.min(32, lv.header.screens)).map(([v]) => [v, hex2(v)]), s.midwayScreen, (v) => upd(() => (s.midwayScreen = v)))),
        hint('The midway point shares its position within the screen, its action, camera start and options with the main entrance (M); only the screen is its own. Dragging it gives it its own.'),
      ]),
      hint('It applies once Mario has touched the level\'s midway tape.'),
      s.midwayOwn ? users(app, app.exitGraph().exitsInto(n).filter((r) => r.midway), [], 'No exit leads to the midway entrance.')
        : hint('Exits set to “go to midway entrance” lead to the main entrance while it has no own settings.'),
      h('div', { class: 'row' }, h('button', { onclick: () => testAt(app, 'midway', 0) }, '▶ Test here')),
    );
    return;
  }
  const g = app.exitGraph();
  const tl = mainTranslevel(n);
  const extra = tl ? [h('div', { class: 'row' }, h('span', null, 'Overworld'), h('span', { class: 'lname' }, `(level tile, translevel ${hex2(tl)})`))] : [];
  body.append(
    h('div', { class: 'prop-title' }, 'Main entrance'),
    hint(`${spotText(mainSpot(s))} – drag the marker to move it`),
    field('Action', select(actions(), s.entranceAction, (v) => upd(() => (s.entranceAction = v)))),
    field('Camera start', select(cameraOptions(cameraValue(s), hasRelativeCamera(app.rom, lv.header.mode)), cameraValue(s), (v) => upd(() => setCamera(s, v)))),
    ...optionFields(s, (_, f) => upd(() => f(s))).map(([l, el]) => field(l, el)),
    users(app, g.exitsInto(n).filter((r) => !r.secondary && !(r.midway && s.midwayOwn)), extra, 'No exit leads to the main entrance.'),
    h('div', { class: 'row' }, h('button', { title: 'Test play from the main entrance (T)', onclick: () => testAt(app, 'main', 0) }, '▶ Test here')),
    hint('More settings (scrolling, layer 3 …) in the header dialog (H).'),
  );
}

