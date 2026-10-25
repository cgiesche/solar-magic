// "Properties" in mode 'exit' (Entrances/Exits): the chosen screen's exit, a secondary entrance,
// the main entrance or the midway point – where it leads, who leads here, all chosen by level name.

import type { App, Marker } from './app.ts';
import { h, select, toast, choose, checkbox } from './dom.ts';
import { hex2, hex3, ENTRANCE_ACTIONS } from '../core/names.ts';
import {
  newUid, mainTranslevel, levelTranslevel, mainSpot, secondarySpot, hasRelativeCamera, EXIT_WATER, EXIT_MIDWAY, EXIT_NEW, exitToMidway, exitLandsAtMidway, midwaySpot, midwayEntrance, mainEntrance, setMidwayEntrance, midwayStart, nearestMidway, placeMidway, entrancePos,
  type Level, type ScreenExit, type MidwayEntrance, type SecondaryHeader, type OverworldExit,
} from '../core/level.ts';
import { overworldFields, overworldLabel } from './owexit.ts';
import { spotText, cameraOptions, cameraValue, setCamera, cameraFields, optionFields } from './entrancefields.ts';
import { exitTarget, type ExitRef } from '../core/exitgraph.ts';
import { NO_FREE_ENTRANCE, type ExitLeadsTo } from '../core/entrances.ts';
import { arrivesSlippery, slipperyEntrances } from '../core/slippery.ts';
import { levelPicker } from './levelpicker.ts';
import { openTestPlay } from './testplay.ts';
import { readL1, readTranslevels, levelTilesOf, l1XY, translevelToLevel } from '../core/overworld.ts';

const field = (label: string, ...input: (HTMLElement | string)[]) => h('div', { class: 'prop' }, h('label', null, label), ...input);
const hint = (...txt: (HTMLElement | string)[]) => h('div', { class: 'hint' }, ...txt);
const range = (n: number): [number, string][] => Array.from({ length: n }, (_, i) => [i, String(i)]);
const actions = (): [number, string][] => ENTRANCE_ACTIONS.map((a, i) => [i, `${i} – ${a}`]);

// returns true while the screen's block behaviour (pipes, doors) is still being probed
export function buildExitPanel(app: App, body: HTMLElement): boolean {
  const sel = app.exitMarker;
  if (sel?.kind === 'sec' && !app.entrances.inOpenLevel().includes(sel.index)) app.exitMarker = null;
  else if (sel?.kind === 'sec') { secondaryPanel(app, body, sel.index); return false; }
  else if (sel) { mainPanel(app, body, sel.kind); return false; }
  return exitPanel(app, body);
}

// ---- screen exit ----
function exitPanel(app: App, body: HTMLElement): boolean {
  const lv = app.level, n = lv.number, scr = app.exitScreen;
  const g = app.entrances.graph();
  const enter = app.enterableOn(scr);
  const ex = lv.exits.find((e) => e.screen === scr);
  body.append(h('div', { class: 'prop-title' }, `Screen ${hex2(scr)} – Exit`));
  if (!ex) {
    body.append(
      hint(enter ? 'This screen has pipes or doors but no exit yet – they lead nowhere.' : 'No exit on this screen.'),
      h('button', {
        class: 'primary',
        onclick: () => { app.editLevel((lv) => { lv.exits.push({ uid: newUid(), screen: scr, dest: n, secondary: false, flags: EXIT_NEW }); }, false); },
      }, 'Create exit'),
      hint('An exit applies to all pipes and doors of this screen. Click another screen in the level view to select it, likewise entrances (M, Z, S).'));
    return enter === null;
  }
  const e = ex;
  const t = exitTarget(app.rom, n, e);
  // changes the screen's exit of the open level (a ROM edit before, e.g. a new entrance, may have loaded it anew)
  const upd = (f: (e: ScreenExit) => void) => app.editLevel((lv) => {
    const x = lv.exits.find((x) => x.screen === scr);
    if (!x) return false;
    f(x);
  }, false);
  const remove = () => app.editLevel((lv) => { lv.exits = lv.exits.filter((x) => x.screen !== scr); }, false);
  // the level the exit leads into (to the overworld: choosing a level starts with this one)
  const level = t.overworld ? n : t.to;
  // where the exit leads; a new entrance into another level gets a toast, a failure an error toast
  const lead = (to: ExitLeadsTo) => {
    try {
      const idx = app.entrances.leadExit(scr, to);
      if (idx !== null && to.kind === 'secondary') createdIn(app, idx, to.level);
    } catch (err) { toast(err instanceof Error ? err.message : String(err), 'error'); }
  };
  const kind = !e.secondary ? 'main' : t.overworld ? 'overworld' : 'secondary';
  const radio = (k: typeof kind, label: string, title: string) => {
    const r = h('input', { type: 'radio', name: 'exit-kind', checked: kind === k });
    r.addEventListener('change', () => lead(k === 'overworld' ? { kind: k } : { kind: k, level }));
    return h('label', { class: 'row', title }, r, label);
  };
  body.append(
    field('Leads to', h('div', { class: 'radio-col' },
      radio('main', 'Main entrance of a level', 'Mario comes out at the main entrance (M) of the target level'),
      radio('secondary', 'Secondary entrance', 'Mario comes out at a specific entrance (S) of the target level, e.g. at a pipe'),
      radio('overworld', 'Overworld', 'Mario goes back to the overworld, the level passed or not (Lunar Magic\'s secondary exit to the overworld)'))),
  );
  if (t.overworld) {
    const o = app.entrances.get(t.entrance).overworld!;
    const shared = g.usersOfEntrance(t.entrance).length;
    const set = (label: string, f: (x: OverworldExit) => void) =>
      app.entrances.edit(t.entrance, label, (x) => f(x.overworld!), label);
    body.append(
      ...overworldFields(app, t.entrance, o, set).map(([l, el]) => field(l, el)),
      h('div', { class: 'exit-target' },
        h('div', null, 'Mario returns to the ', h('b', null, 'overworld')),
        hint(`${overworldLabel(app, o)} – through secondary entrance ${hex3(t.entrance)}${shared > 1 ? `, which ${shared} exits share: a change applies to all of them` : ''}.`),
        h('div', { class: 'row' },
          h('button', { class: 'danger', onclick: remove }, 'Delete exit'))),
      hint(enter === false ? 'No pipes or doors were found on this screen.' : 'The exit applies to all pipes and doors of this screen.'),
    );
    return enter === null;
  }
  body.append(
    field('Target level', levelPicker(app, t.to, (m) => lead({ kind: e.secondary ? 'secondary' : 'main', level: m }))),
  );
  if (e.secondary) {
    const ents = g.entrancesOf(t.to);
    if (!ents.includes(t.entrance)) ents.unshift(t.entrance);
    const label = (i: number) => {
      const s = app.entrances.get(i);
      return g.entrancesOf(t.to).includes(i) ? `${hex3(i)} · Screen ${hex2(s.screen)} · ${ENTRANCE_ACTIONS[s.action]}` : `${hex3(i)} (empty)`;
    };
    body.append(field('Entrance',
      select(ents.map((i) => [i, label(i)]), t.entrance, (v) => lead({ kind: 'secondary', level: t.to, entrance: v })),
      h('button', {
        title: 'Create a new secondary entrance in the target level (at the main entrance, move it afterwards)',
        onclick: () => lead({ kind: 'secondary', level: t.to, entrance: 'new' }),
      }, '+ New')),
      field('Options', checkbox('Water level', 'Mario swims in the whole target level when he comes through this exit (also when the entrance is no water level)',
        !!(e.flags & EXIT_WATER), (on) => upd((e) => { e.flags = on ? e.flags | EXIT_WATER : e.flags & ~EXIT_WATER; }))));
  } else {
    body.append(field('Options', checkbox('Go to midway entrance',
      'Mario comes out at the midway entrance (Z) of the target level – when its midway point has its own position and settings, else at its main entrance (as in Lunar Magic)',
      !!(e.flags & EXIT_MIDWAY), (on) => upd((e) => { e.flags = on ? e.flags | EXIT_MIDWAY : e.flags & ~EXIT_MIDWAY; }))));
  }
  // where Mario arrives (and whether the entrance makes the level slippery)
  const slippery = (x: Parameters<typeof arrivesSlippery>[0]) => (arrivesSlippery(x, app.slipperyActions()) ? ', arrives slippery' : '');
  const arrive = e.secondary ? (() => {
    const s = app.entrances.get(t.entrance);
    return g.entrancesOf(t.to).includes(t.entrance)
      ? `Secondary entrance ${hex3(t.entrance)}: screen ${hex2(s.screen)}, ${ENTRANCE_ACTIONS[s.action]}${slippery(s)}`
      : `Secondary entrance ${hex3(t.entrance)} is empty – “+ New” creates one.`;
  })() : (() => {
    const s = app.entrances.headerOf(t.to);
    if (exitLandsAtMidway(e, s)) return `Midway entrance: screen ${hex2(s.midwayScreen)}, ${ENTRANCE_ACTIONS[s.midwayAction]}${slippery(midwayEntrance(s))}`;
    const main = `Main entrance: screen ${hex2(s.entranceScreen)}, ${ENTRANCE_ACTIONS[s.entranceAction]}${slippery(mainEntrance(s))}`;
    return exitToMidway(e) ? `${main} – the target's midway point has no own position and settings (give it them in its midway point's properties).` : main;
  })();
  body.append(
    h('div', { class: 'exit-target' },
      h('div', null, 'Mario arrives in ', h('b', null, `level ${hex3(t.to)}`), ' ', h('span', { class: 'lname' }, g.name(t.to))),
      hint(arrive),
      h('div', { class: 'row' },
        h('button', { title: 'Open the target level and select the entrance', onclick: () => app.gotoExitTarget(e) }, '→ Open target'),
        h('button', { class: 'danger', onclick: remove }, 'Delete exit'))),
    hint(enter === false ? 'No pipes or doors were found on this screen.' : 'The exit applies to all pipes and doors of this screen.'),
  );
  return enter === null;
}

// a new secondary entrance into `level`, placed like its main entrance
export function newEntranceIn(app: App, level: number): number | null {
  const idx = app.entrances.create(level);
  if (idx === null) { toast(NO_FREE_ENTRANCE, 'error'); return null; }
  createdIn(app, idx, level);
  return idx;
}

// a toast for a new entrance into another level than the open one (not in view)
function createdIn(app: App, idx: number, level: number): void {
  if (level !== app.level.number) toast(`Secondary entrance ${hex3(idx)} created in level ${hex3(level)} (at the main entrance) – go there with “Open target” and move it.`);
}

// ---- who leads here ----
// the overworld's level tiles entering level n (a sub-level: its main level's), each opening the overworld there
function levelTileRows(app: App, n: number): HTMLElement[] {
  const main = mainTranslevel(n), tl = main ?? levelTranslevel(app.rom, n);
  if (!tl) return [];
  const via = main === null ? ` (through level ${hex3(translevelToLevel(tl))})` : '';
  return levelTilesOf(readL1(app.rom), readTranslevels(app.rom), tl).map((i) => {
    const { x, y } = l1XY(i);
    return h('div', { class: 'row' }, h('span', null, 'Overworld'), h('span', { class: 'lname' }, `level tile ${i >= 0x400 ? 'submaps' : 'main map'} ${hex2(x)},${hex2(y)}${via}`),
      h('button', { class: 'link-btn', title: 'Show the level tile on the overworld (back returns here)', onclick: () => app.gotoOverworldTile(i) }, 'open'));
  });
}

function users(app: App, refs: ExitRef[], extra: HTMLElement[], empty: string): HTMLElement {
  const g = app.entrances.graph();
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
  else openTestPlay(app, { tx: (m.x + 8) >> 4, ty: (m.y + 16) >> 4, entrance: kind === 'sec' ? app.entrances.get(index) : midwayStart(app.level.secondary) });
}

// ---- secondary entrance ----
function secondaryPanel(app: App, body: HTMLElement, idx: number): void {
  const e = app.entrances.get(idx);
  const set = (label: string, f: (x: typeof e) => void, key: string) => app.entrances.edit(idx, label, f, key);
  const refs = app.entrances.graph().usersOfEntrance(idx);
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
  // changes the secondary header of the open level
  const upd = (f: (s: SecondaryHeader, lv: Level) => void) => app.editLevel((lv) => f(lv.secondary, lv));
  if (kind === 'midway') {
    // its own settings (Lunar Magic's midway entrance) through an entrance's fields; the BG start is the level's
    const m = midwayEntrance(s);
    const setOwn = (_: string, f: (x: MidwayEntrance) => void) => upd((s) => { const x = midwayEntrance(s); f(x); setMidwayEntrance(s, x); });
    const own = (on: boolean) => upd((s, lv) => {
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
        field('Screen', select(range(Math.min(32, lv.header.screens)).map(([v]) => [v, hex2(v)]), s.midwayScreen, (v) => upd((s) => (s.midwayScreen = v)))),
        hint('The midway point shares its position within the screen, its action, camera start and options with the main entrance (M); only the screen is its own. Dragging it gives it its own.'),
      ]),
      hint('It applies once Mario has touched the level\'s midway tape.'),
      s.midwayOwn ? users(app, app.entrances.graph().exitsInto(n).filter((r) => r.midway), [], 'No exit leads to the midway entrance.')
        : hint('Exits set to “go to midway entrance” lead to the main entrance while it has no own settings.'),
      h('div', { class: 'row' }, h('button', { onclick: () => testAt(app, 'midway', 0) }, '▶ Test here')),
    );
    return;
  }
  const g = app.entrances.graph();
  const extra = levelTileRows(app, n);
  body.append(
    h('div', { class: 'prop-title' }, 'Main entrance'),
    hint(`${spotText(mainSpot(s))} – drag the marker to move it`),
    field('Action', select(actions(), s.entranceAction, (v) => upd((s) => (s.entranceAction = v)))),
    field('Camera start', select(cameraOptions(cameraValue(s), hasRelativeCamera(app.rom, lv.header.mode)), cameraValue(s), (v) => upd((s) => setCamera(s, v)))),
    ...optionFields(s, (_, f) => upd((s) => f(s))).map(([l, el]) => field(l, el)),
    hint(slipperyText(app, s)),
    users(app, g.exitsInto(n).filter((r) => !r.secondary && !(r.midway && s.midwayOwn)), extra, 'No exit leads to the main entrance.'),
    h('div', { class: 'row' }, h('button', { title: 'Test play from the main entrance (T)', onclick: () => testAt(app, 'main', 0) }, '▶ Test here')),
    hint('More settings (scrolling, layer 3 …) in the header dialog (H).'),
  );
}


// which entrances of the open level (s: its secondary header) make it slippery, by their option or their
// action: it depends on the entrance, not on the level
export function slipperyText(app: App, s: SecondaryHeader): string {
  const names = slipperyEntrances(app.rom, s, app.entrances.inOpenLevel(), app.slipperyActions()).map((e) => (e.kind === 'sec' ? `secondary entrance ${hex3(e.index)}`
    : e.kind === 'midway' ? 'the midway entrance' : s.midwayOwn ? 'the main entrance' : 'the main entrance (also at the midway point)'));
  return names.length ? `The level is slippery when Mario enters it through ${names.join(', ')}.` : 'No entrance makes the level slippery.';
}
