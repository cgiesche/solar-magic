// Test play's rewind (CONTEXT.md): the machine's state kept every REWIND_EVERY frames in a ring of REWIND_STATES
// (about 10 s), the oldest dropped; while the rewind key is held the game steps back through them
// (PlaySession.keepRewind / rewind). A state with the PPU and the sound unit is about 514 KiB (KiB: WRAM 128,
// SRAM 32, VRAM 64, the sound unit 65, the frame on screen 224; tools/testrewind.ts prints it), the ring about 50 MiB.

export const REWIND_EVERY = 6; // frames between kept states
export const REWIND_STATES = 100; // states kept: 600 frames, 10 s

// the newest `size` items pushed, taken back from the newest end
export class RewindRing<T> {
  private items: (T | undefined)[];
  private head = 0; // where the next item goes
  private count = 0;
  constructor(size: number) { this.items = new Array<T | undefined>(size); }

  get length(): number { return this.count; }
  push(item: T): void {
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.items.length;
    this.count = Math.min(this.count + 1, this.items.length);
  }
  // the i-th newest (0: the newest)
  at(i: number): T | undefined {
    if (i < 0 || i >= this.count) return undefined;
    return this.items[(this.head - 1 - i + 2 * this.items.length) % this.items.length];
  }
  newest(): T | undefined { return this.at(0); }
  pop(): T | undefined {
    if (!this.count) return undefined;
    this.head = (this.head - 1 + this.items.length) % this.items.length;
    this.count--;
    const it = this.items[this.head];
    this.items[this.head] = undefined;
    return it;
  }
  clear(): void { this.items.fill(undefined); this.head = 0; this.count = 0; }
}
