// Web Worker running the block/sprite probes (see core/probehost.ts) off the main thread: one job
// at a time, then a look at the incoming messages (a changed ROM drops the queue, asked jobs go
// before prefetched ones).

import { ProbeHost, type ProbeMessage, type ProbeDone } from '../core/probehost.ts';

// the worker's global scope (the project is typed with the DOM library)
const scope = self as unknown as { postMessage(m: ProbeDone): void; onmessage: ((e: MessageEvent<ProbeMessage>) => void) | null };
const host = new ProbeHost();
const tick = new MessageChannel(); // runs the next job after the messages that came in meanwhile
let scheduled = false;

const schedule = () => {
  if (scheduled || !host.pending) return;
  scheduled = true;
  tick.port2.postMessage(0);
};

tick.port1.onmessage = () => {
  scheduled = false;
  const done = host.next();
  if (done) scope.postMessage(done);
  schedule();
};

scope.onmessage = (e) => {
  host.handle(e.data);
  schedule();
};
