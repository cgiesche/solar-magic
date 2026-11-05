// The ExAnimation triggers of the current level (extrigger.ts): every trigger its slots and the global ones
// use, switched for the view and test play (the level loads, its Trigger Init sets its own, then these are
// set and the game's animation code runs), each with its RAM, an ASM line that sets it and the slots using it.
// The full panel sits in the Animations tab; the View menu switches the same (triggerMenu). A submap's event triggers
// have their own panel (owTriggerPanel).

import type { App } from './app.ts';
import { h, toast, hexInput } from './dom.ts';
import type { MenuItem } from './menu.ts';
import { hex } from '../core/names.ts';
import {
  triggerRam, switchName, slotName, isCustom, isManual, isOneShot, ALL_SWITCHES, CUSTOM, MANUAL, ONE_SHOT, type SlotRef, type TriggerView,
} from '../core/extrigger.ts';
import { isEventTrigger, eventTriggerOf, eventManual, kindOf, triggerName, type ExList } from '../core/exanim.ts';
import { eventTriggerState } from '../core/owanimview.ts';

// the switches shown: those the level's and the global slots (and Trigger Inits) use, and those the view sets
export function shownSwitches(app: App): Map<number, SlotRef[]> {
  const out = app.levelTriggers(), v = app.view.exTriggers;
  const add = (sw: number) => { if (!out.has(sw)) out.set(sw, []); };
  v.game.forEach(add);
  if (app.view.switches.onOff) add(0x03); // (also switched in the View menu's game state: Reset turns it off)
  for (const n of v.custom.keys()) add(CUSTOM + n);
  for (const n of v.manual.keys()) add(MANUAL + n);
  for (const n of v.oneShot) add(ONE_SHOT + n);
  return new Map([...out].sort((a, b) => a[0] - b[0]));
}
// a select of the switches not shown yet: picking one sets it in the view (Lunar Magic's view offers them all)
function otherSwitch(app: App, shown: Map<number, SlotRef[]>): HTMLSelectElement {
  const sel = h('select', { title: 'Switch a trigger no slot here uses yet (e.g. for code that sets it)' }, h('option', { value: '' }, 'Other trigger …'),
    ALL_SWITCHES.filter((sw) => !shown.has(sw)).map((sw) => h('option', { value: String(sw) }, switchName(sw))));
  sel.addEventListener('change', () => { if (sel.value) setSwitch(app, Number(sel.value), isManual(Number(sel.value)) ? 0 : true); });
  return sel;
}

// a switch's state in the view: on / the manual frame (the level's init where the view sets none)
export function switchState(app: App, sw: number): boolean | number {
  const v = app.view.exTriggers;
  if (sw === 0x03) return app.view.switches.onOff;
  if (isManual(sw)) return v.manual.get(sw - MANUAL) ?? app.triggerInit().manual.get(sw - MANUAL) ?? 0;
  if (isCustom(sw)) return v.custom.get(sw - CUSTOM) ?? !!(app.triggerInit().custom & (1 << (sw - CUSTOM)));
  if (isOneShot(sw)) return v.oneShot.has(sw - ONE_SHOT);
  return v.game.has(sw);
}
// switches it on or off, or the manual frame
export function setSwitch(app: App, sw: number, on: boolean | number): void {
  if (sw === 0x03) { app.view.switches.onOff = !!on; app.setTriggers(() => {}); return; }
  app.setTriggers((v: TriggerView) => {
    if (isManual(sw)) v.manual.set(sw - MANUAL, Number(on));
    else if (isCustom(sw)) v.custom.set(sw - CUSTOM, !!on);
    else if (isOneShot(sw)) { if (on) v.oneShot.add(sw - ONE_SHOT); else v.oneShot.delete(sw - ONE_SHOT); }
    else if (on) v.game.add(sw); else v.game.delete(sw);
  });
}
const toggleTitle = (sw: number) => isOneShot(sw) ? 'Fired once the level has loaded: its slots play once (the preview repeats them)'
  : isCustom(sw) ? 'On or off in the view (where it is not switched: as the Trigger Init sets it)' : 'Holds in the view';

export function triggerPanel(app: App, openSlot: (r: SlotRef) => void): HTMLElement {
  const used = shownSwitches(app);
  const box = h('div', { class: 'tp' }, h('div', { class: 'panel-title' }, 'Triggers', h('span', { class: 'hint' }, 'view and test play')));
  if (!used.size) {
    box.append(h('p', { class: 'hint' }, 'No animation of this level or the global list waits for a trigger.'), otherSwitch(app, used));
    return box;
  }
  box.append(h('p', { class: 'hint' }, 'The level loads with its Trigger Init, then these are set and the game\'s animation code runs – the preview shows the result.'));
  for (const [sw, slots] of used) {
    const state = switchState(app, sw);
    const control = isManual(sw)
      ? h('label', { class: 'tp-frame', title: 'The frame its slots show (00–FE)' }, 'frame ', hexInput(Number(state), 2, (f) => setSwitch(app, sw, f), 0xfe))
      : h('label', { class: 'toggle', title: toggleTitle(sw) }, h('input', { type: 'checkbox', checked: !!state, onchange: (e: Event) => setSwitch(app, sw, (e.target as HTMLInputElement).checked) }),
        isOneShot(sw) ? 'fire' : isCustom(sw) ? 'on' : 'holds');
    const ram = triggerRam(sw);
    const copy = (text: string) => h('button', { class: 'tp-copy', title: 'Copy the ASM line', onclick: () => { void navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copying failed', 'error')); } }, 'Copy');
    box.append(h('div', { class: `tp-row${state === false ? '' : ' on'}` },
      h('div', { class: 'row' }, h('b', null, switchName(sw)), h('span', { class: 'spacer' }), control),
      ram ? h('div', { class: 'hint' }, h('span', { class: 'mono' }, ram.ram), ` – ${ram.what}`) : '',
      ram?.asm ? h('div', { class: 'tp-asm' }, h('code', { class: 'mono' }, ram.asm), copy(ram.asm)) : '',
      ram?.off ? h('div', { class: 'tp-asm' }, h('code', { class: 'mono' }, ram.off), copy(ram.off)) : '',
      h('div', { class: 'gt-users' }, h('span', { class: 'hint' }, slots.length ? 'used by' : 'no slot uses it'),
        slots.map((r) => h('a', { href: '#', class: 'mono', title: 'Open the slot', onclick: (e: Event) => { e.preventDefault(); openSlot(r); } }, slotName(r))))));
  }
  box.append(otherSwitch(app, used), h('button', { title: 'Every trigger as the level\'s Trigger Init leaves it', onclick: () => { if (used.has(0x03)) app.view.switches.onOff = false; app.setTriggers((v) => { v.game.clear(); v.custom.clear(); v.oneShot.clear(); v.manual.clear(); }); } }, 'Reset'));
  return box;
}

// the View menu's part: the level's triggers switched (Lunar Magic's View > ExAnimation Triggers); a manual
// trigger steps to its next frame
export function triggerMenu(app: App): MenuItem[] {
  const used = [...shownSwitches(app).keys()].filter((sw) => sw > 0x03); // P-switches, ON/OFF: the game state's own items
  return [
    { heading: 'Animation triggers' },
    ...used.map((sw): MenuItem => isManual(sw)
      ? { label: `${switchName(sw)}: frame ${hex(Number(switchState(app, sw)), 2)}`, title: 'View and test play: the next frame (all of it in the Animations tab\'s trigger panel)', onClick: () => setSwitch(app, sw, (Number(switchState(app, sw)) + 1) % 0xff) }
      : { label: `${switchName(sw)}${isOneShot(sw) ? ' (fire)' : ''}`, title: `View and test play: ${toggleTitle(sw).toLowerCase()}`, checked: () => !!switchState(app, sw), onToggle: (v) => setSwitch(app, sw, v) }),
    ...(used.length ? [] : [{ label: 'None used in this level', onClick: () => {}, disabled: () => true }]),
  ];
}

// The overworld's part (a submap as the graphics workspace's target, #260): the event triggers 01–08 (Event Manual
// 8–F) the submap's and the overworld global list's slots wait for or their Trigger Inits give an event, each with its
// event and whether that is passed at the workspace's event progress (read from the console after the submap's load:
// owanimview.ts eventTriggerState), switched for the map preview only (holds / doesn't / as the progress has it);
// never saved, test play and the game go by the events.
export interface OwTriggers {
  lists: [submap: ExList | null, global: ExList | null];
  loaded: Uint8Array | null; // the WRAM after the submap's load, null while it is emulated
  progress: number;
  switched: ReadonlyMap<number, boolean>;
  pending: boolean; // the map with the switched triggers is still emulated
  switchTrigger(t: number, holds: boolean | null): void;
  reset(): void;
  openSlot(r: SlotRef): void;
}
export function owTriggerPanel(p: OwTriggers): HTMLElement {
  const used = new Map<number, SlotRef[]>();
  p.lists.forEach((l, k) => {
    if (!l) return;
    for (const [slot, e] of [...l.slots].sort((a, b) => a[0] - b[0])) {
      if (!isEventTrigger(e.trigger) || !kindOf(e.type)) continue;
      if (!used.has(e.trigger)) used.set(e.trigger, []);
      used.get(e.trigger)!.push({ global: k === 1, slot });
    }
    for (const n of l.manual.keys()) { const t = eventTriggerOf(n); if (isEventTrigger(t) && !used.has(t)) used.set(t, []); }
  });
  for (const t of p.switched.keys()) if (!used.has(t)) used.set(t, []);
  const box = h('div', { class: 'tp' }, h('div', { class: 'panel-title' }, 'Triggers', h('span', { class: 'hint' }, 'map preview only')));
  if (!used.size) {
    box.append(h('p', { class: 'hint' }, 'No animation of this submap or the overworld global list waits for an event (Event Manual 8–F). Your code\'s triggers (custom, manual) are set by it in the game.'));
    return box;
  }
  box.append(h('p', { class: 'hint' }, `The map is loaded at event progress ${p.progress} (the events before it passed). An event trigger holds while the event its Manual byte names is passed (the Trigger Init's, else what was there before the load); switched here, the map shows its slots as then – the events and the ROM stay as they are.${p.pending ? ' The map is being emulated …' : ''}`));
  for (const [t, slots] of [...used].sort((a, b) => a[0] - b[0])) {
    const st = p.loaded ? eventTriggerState(p.loaded, t) : null, sw = p.switched.get(t);
    // a Manual byte no Trigger Init names keeps what was there before the load (#311): in the game the level played
    // before decides, the preview shows what its load left
    const init = p.lists.some((l) => l?.manual.has(eventManual(t)));
    const kept = init ? '' : `no event in the Trigger Init: Manual ${hex(eventManual(t), 1)} keeps what the level before left – in this load: `;
    const at = !st ? 'the map is being loaded …' : `${kept}${st.event === null ? 'past the overworld\'s events, never holds' : `event ${hex(st.event, 2)}, ${st.holds ? 'passed' : 'not passed'} at progress ${p.progress}`}`;
    const sel = h('select', { title: 'For the map preview only: as the event progress has it, or switched' },
      h('option', { value: '', selected: sw === undefined }, `as the progress${st ? ` (${st.holds ? 'holds' : 'doesn\'t hold'})` : ''}`),
      h('option', { value: 'on', selected: sw === true }, 'holds'),
      h('option', { value: 'off', selected: sw === false }, 'doesn\'t hold'));
    sel.addEventListener('change', () => p.switchTrigger(t, sel.value === '' ? null : sel.value === 'on'));
    box.append(h('div', { class: `tp-row${sw ?? st?.holds ? ' on' : ''}` },
      h('div', { class: 'row' }, h('b', null, triggerName(t, true)), h('span', { class: 'spacer' }), sel),
      h('div', { class: 'hint' }, at),
      h('div', { class: 'gt-users' }, h('span', { class: 'hint' }, slots.length ? 'used by' : 'no slot uses it'),
        slots.map((r) => h('a', { href: '#', class: 'mono', title: 'Open the slot', onclick: (e: Event) => { e.preventDefault(); p.openSlot(r); } }, slotName(r, true))))));
  }
  if (p.switched.size) box.append(h('button', { title: 'Every event trigger as the event progress has it', onclick: () => p.reset() }, 'Reset'));
  return box;
}
