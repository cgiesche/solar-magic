// The ExAnimation triggers of the current level (extrigger.ts): every trigger its slots and the global ones
// use, switched for the view and test play (the level loads, its Trigger Init sets its own, then these are
// set and the game's animation code runs), each with its RAM, an ASM line that sets it and the slots using it.
// The full panel sits in the Animations tab; the View menu switches the same (triggerMenu).

import type { App } from './app.ts';
import { h, toast, hexInput } from './dom.ts';
import type { MenuItem } from './menu.ts';
import { hex } from '../core/names.ts';
import {
  triggerRam, switchName, slotName, isCustom, isManual, isOneShot, ALL_SWITCHES, CUSTOM, MANUAL, ONE_SHOT, type SlotRef, type TriggerView,
} from '../core/extrigger.ts';

// the switches shown: those the level's and the global slots (and Trigger Inits) use, and those the view sets
export function shownSwitches(app: App): Map<number, SlotRef[]> {
  const out = app.levelTriggers(), v = app.exTriggers;
  const add = (sw: number) => { if (!out.has(sw)) out.set(sw, []); };
  v.game.forEach(add);
  if (app.switches.onOff) add(0x03); // (also switched in the View menu's game state: Reset turns it off)
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
  const v = app.exTriggers;
  if (sw === 0x03) return app.switches.onOff;
  if (isManual(sw)) return v.manual.get(sw - MANUAL) ?? app.triggerInit().manual.get(sw - MANUAL) ?? 0;
  if (isCustom(sw)) return v.custom.get(sw - CUSTOM) ?? !!(app.triggerInit().custom & (1 << (sw - CUSTOM)));
  if (isOneShot(sw)) return v.oneShot.has(sw - ONE_SHOT);
  return v.game.has(sw);
}
// switches it on or off, or the manual frame
export function setSwitch(app: App, sw: number, on: boolean | number): void {
  if (sw === 0x03) { app.switches.onOff = !!on; app.setTriggers(() => {}); return; }
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
  box.append(otherSwitch(app, used), h('button', { title: 'Every trigger as the level\'s Trigger Init leaves it', onclick: () => { if (used.has(0x03)) app.switches.onOff = false; app.setTriggers((v) => { v.game.clear(); v.custom.clear(); v.oneShot.clear(); v.manual.clear(); }); } }, 'Reset'));
  return box;
}

// the View menu's part: the level's triggers switched (Lunar Magic's View > ExAnimation Triggers); a manual
// trigger steps to its next frame
export function triggerMenu(app: App): MenuItem[] {
  const used = [...shownSwitches(app).keys()].filter((sw) => sw !== 0x03); // ON/OFF: the game state's own item
  return [
    { heading: 'Animation triggers' },
    ...used.map((sw): MenuItem => isManual(sw)
      ? { label: `${switchName(sw)}: frame ${hex(Number(switchState(app, sw)), 2)}`, title: 'View and test play: the next frame (all of it in the Animations tab\'s trigger panel)', onClick: () => setSwitch(app, sw, (Number(switchState(app, sw)) + 1) % 0xff) }
      : { label: `${switchName(sw)}${isOneShot(sw) ? ' (fire)' : ''}`, title: `View and test play: ${toggleTitle(sw).toLowerCase()}`, checked: () => !!switchState(app, sw), onToggle: (v) => setSwitch(app, sw, v) }),
    ...(used.length ? [] : [{ label: 'None used in this level', onClick: () => {}, disabled: () => true }]),
  ];
}
