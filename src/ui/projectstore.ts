// When the working ROM is stored in the browser (the App's one copy, storage.ts): debounced after ROM edits (they come
// in quick succession), at once after a level save, a pending store when the page is left. Closed – the project closed
// or replaced by another – it never writes again: the browser has one slot, an old project's late store would put it
// back over the new one (#499).

export interface StoreHost {
  store: () => Promise<void>;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
}

export class ProjectStore {
  private timer = 0;
  private closed = false;
  private readonly host: StoreHost;
  constructor(host: StoreHost) { this.host = host; }

  get pending(): boolean { return this.timer !== 0; }

  /** After a ROM edit: stored once no other followed for a while. */
  soon(ms = 1000): void {
    if (this.closed) return;
    this.drop();
    this.timer = this.host.setTimer(() => { this.timer = 0; this.now(); }, ms);
  }
  now(): void {
    this.drop();
    if (this.closed) return;
    this.host.store().catch(() => {});
  }
  /** The page is left: a ROM edit not stored yet. */
  flush(): void { if (this.timer) this.now(); }
  close(): void {
    this.closed = true;
    this.drop();
  }
  private drop(): void {
    if (this.timer) this.host.clearTimer(this.timer);
    this.timer = 0;
  }
}
