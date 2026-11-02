// The background scheduler: slices of background work (block behavior, sprite graphics, scans …) run as low-priority
// tasks, so input, drawing and audio go first. While something holds the background (App: a dialog is open or music
// plays – they would stall the dialog and make the sound crackle) they wait: the next slice of each job is parked by
// its key and continues once nothing holds it (resume, called by the host when what holds it changed).

export class Scheduler {
  private parked = new Map<string, () => void>();
  private channel: MessageChannel | null = null;
  private queue: (() => void)[] = [];
  // whether the background is held now
  readonly held: () => boolean;

  constructor(held: () => boolean) {
    this.held = held;
  }

  // step as a background task, parked by key while the background is held (a later step of the key replaces it)
  later(key: string, step: () => void): void {
    if (this.held()) { this.parked.set(key, step); return; }
    const go = () => { if (this.held()) this.parked.set(key, step); else step(); };
    const sch = (globalThis as { scheduler?: { postTask?: (f: () => void, o: { priority: string }) => Promise<void> } }).scheduler;
    if (sch?.postTask) { sch.postTask(go, { priority: 'background' }).catch((e) => console.error(e)); return; }
    // otherwise a message (setTimeout is throttled in hidden tabs)
    if (!this.channel) {
      const ch = this.channel = new MessageChannel(), q = this.queue;
      ch.port1.onmessage = () => q.shift()?.();
    }
    this.queue.push(go);
    this.channel.port2.postMessage(0);
  }

  // the parked steps continue, unless the background is still held
  resume(): void {
    if (this.held() || !this.parked.size) return;
    const p = [...this.parked];
    this.parked.clear();
    for (const [k, step] of p) this.later(k, step);
  }
}
