// Log bar at the bottom of the editor: collapsed it shows the latest message, expanded the whole
// history with times (toasts vanish after a few seconds, the log keeps them).
import { h, logEntries, onLog, clearLog, type LogEntry } from './dom.ts';

const PREF = 'smw-log-open';
const KIND_LABEL = { info: 'Meldung', error: 'Fehler', event: 'Ereignis' } as const;

const pad = (n: number) => String(n).padStart(2, '0');
const timeStr = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export class LogBar {
  readonly root: HTMLElement;
  private list = h('div', { class: 'log-list' });
  private latest = h('span', { class: 'log-latest' });
  private toggleBtn = h('button', { class: 'log-toggle', title: 'Protokoll ein-/ausklappen (L)' });
  private errBadge = h('span', { class: 'log-badge', title: 'Neue Fehler seit dem letzten Aufklappen' });
  private rows = new Map<LogEntry, HTMLElement>();
  private unseenErrors = 0;
  private open = false;

  constructor() {
    const copyBtn = h('button', { title: 'Protokoll als Text in die Zwischenablage' }, 'Kopieren');
    copyBtn.onclick = () => this.copy(copyBtn);
    const clearBtn = h('button', { class: 'danger', title: 'Alle Einträge entfernen', onclick: () => clearLog() }, 'Leeren');
    const head = h('div', { class: 'log-head' }, this.toggleBtn, this.errBadge, this.latest, h('span', { class: 'log-actions' }, copyBtn, clearBtn));
    // clicking the collapsed line opens it, the buttons keep their own action
    head.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.log-actions')) this.toggle(); });
    this.root = h('div', { class: 'logbar' }, head, this.list);
    for (const e of logEntries) this.list.append(this.row(e));
    onLog((e, repeat) => this.add(e, repeat));
    let open = false;
    try { open = localStorage.getItem(PREF) === '1'; } catch { /* no storage */ }
    this.setOpen(open);
    this.updateLatest();
  }

  toggle(): void { this.setOpen(!this.open); }

  private setOpen(open: boolean): void {
    this.open = open;
    this.root.classList.toggle('open', open);
    this.toggleBtn.textContent = open ? '▾ Protokoll' : '▸ Protokoll';
    try { localStorage.setItem(PREF, open ? '1' : '0'); } catch { /* no storage */ }
    if (open) {
      this.unseenErrors = 0;
      this.list.scrollTop = this.list.scrollHeight;
    }
    this.updateLatest();
  }

  private row(e: LogEntry): HTMLElement {
    const r = h('div', { class: `log-row ${e.kind}`, title: KIND_LABEL[e.kind] },
      h('span', { class: 'log-time' }, timeStr(e.time)),
      h('span', { class: 'log-msg' }, e.msg),
      e.count > 1 ? h('span', { class: 'log-count' }, `×${e.count}`) : null);
    this.rows.set(e, r);
    return r;
  }

  private add(e: LogEntry | null, repeat: boolean): void {
    if (!e) {
      this.list.replaceChildren();
      this.rows.clear();
      this.unseenErrors = 0;
      this.updateLatest();
      return;
    }
    const atEnd = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 4;
    const old = this.rows.get(e);
    if (repeat && old) {
      this.rows.delete(e);
      old.replaceWith(this.row(e));
    } else {
      this.list.append(this.row(e));
      // keep the DOM in step with the capped history
      while (this.list.childElementCount > logEntries.length) {
        const first = this.list.firstElementChild!;
        for (const [k, v] of this.rows) if (v === first) this.rows.delete(k);
        first.remove();
      }
    }
    if (e.kind === 'error' && !this.open) this.unseenErrors++;
    // follow new messages unless the user scrolled up to read older ones
    if (atEnd) this.list.scrollTop = this.list.scrollHeight;
    this.updateLatest();
  }

  private updateLatest(): void {
    const e = logEntries[logEntries.length - 1];
    this.latest.replaceChildren(...(e
      ? [h('span', { class: 'log-time' }, timeStr(e.time)), h('span', { class: `log-msg ${e.kind}` }, e.msg), e.count > 1 ? h('span', { class: 'log-count' }, `×${e.count}`) : '']
      : [h('span', { class: 'hint' }, 'Noch keine Meldungen')]));
    this.latest.style.visibility = this.open ? 'hidden' : '';
    this.errBadge.textContent = this.unseenErrors ? `${this.unseenErrors} Fehler` : '';
    this.errBadge.hidden = !this.unseenErrors;
  }

  private copy(btn: HTMLButtonElement): void {
    const text = logEntries.map((e) => `${timeStr(e.time)}  [${KIND_LABEL[e.kind]}]  ${e.msg}${e.count > 1 ? `  ×${e.count}` : ''}`).join('\n');
    const done = (label: string) => { btn.textContent = label; setTimeout(() => (btn.textContent = 'Kopieren'), 1500); };
    navigator.clipboard.writeText(text).then(() => done('Kopiert ✓'), () => done('Fehlgeschlagen'));
  }
}
