// Runs a sliced job (a generator, one slice per step, see learner.ts) to its end at once: what it yields
// between slices (a progress label of the learner's jobs) is ignored.

export function runJob<T>(job: Generator<unknown, T>): T {
  for (;;) { const r = job.next(); if (r.done) return r.value; }
}
