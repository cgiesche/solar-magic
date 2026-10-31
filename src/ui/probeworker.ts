// Web Worker running the block/sprite probes, object kinds, level scan and the result learner's jobs there (the sprite
// images, the levels' uses, the sprite memory check, the animated tiles and colors; see core/probehost.ts)
// off the main thread: one job or task slice a turn, then a look at the incoming messages (a
// changed ROM drops the queue, asked jobs go first).

import { ProbeHost, pumpProbes } from '../core/probehost.ts';
import type { ProbeMessage, ProbeReply } from '../core/probeprotocol.ts';

// the worker's global scope (the project is typed with the DOM library)
const scope = self as unknown as { postMessage(m: ProbeReply): void; onmessage: ((e: MessageEvent<ProbeMessage>) => void) | null };
const tick = new MessageChannel(); // the next turn, after the messages that came in meanwhile
const send = pumpProbes(new ProbeHost(), (d) => scope.postMessage(d), {
  wait: (run) => { tick.port1.onmessage = run; tick.port2.postMessage(0); },
  startTurn: () => () => false,
});

scope.onmessage = (e) => send(e.data);
