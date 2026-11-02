// The lanes (CONTEXT.md) of the result learner's jobs, on both sides of the probe worker (probeclient.ts, probehost.ts):
// per lane the jobs asked for in the order asked, one at a time (the first runs); a request for a job already in its
// lane (the same key and input: id) joins it; a request replacing the lane's others drops them (they are not wanted
// any more); the lane's busy label is the running job's progress, else the label it was asked with (given the count of
// the lane's jobs).

// a job's id in its lane: its result's key and input
export const laneId = (key: string, input: string | undefined) => `${key}#${input}`;

// a job's busy label: fixed, or by the count of its lane's jobs
export type LaneLabel = string | ((queued: number) => string);

export class Lane<N extends string, E> {
  jobs: E[] = [];
  progress: string | null = null; // of the first job, while it runs
  readonly name: N;
  constructor(name: N) { this.name = name; }
  get first(): E | undefined { return this.jobs[0]; }
}

export class Lanes<N extends string, E> {
  private lanes = new Map<N, Lane<N, E>>();
  private id: (job: E) => string;
  constructor(id: (job: E) => string) { this.id = id; }

  // the lane (made when first asked for)
  lane(name: N): Lane<N, E> {
    let l = this.lanes.get(name);
    if (!l) this.lanes.set(name, (l = new Lane(name)));
    return l;
  }

  get(name: N): Lane<N, E> | undefined { return this.lanes.get(name); }
  values(): IterableIterator<Lane<N, E>> { return this.lanes.values(); }

  // the lane's job with that id
  find(name: N, id: string): E | undefined { return this.lanes.get(name)?.jobs.find((j) => this.id(j) === id); }

  // the job is in the lane (still asked for)
  has(name: N, job: E): boolean { return this.lanes.get(name)?.jobs.includes(job) ?? false; }

  // the lane's job with that id, else make's, queued last (added), with its lane
  join(name: N, id: string, make: () => E): { job: E; added: boolean; lane: Lane<N, E> } {
    const lane = this.lane(name), known = this.find(name, id);
    if (known !== undefined) return { job: known, added: false, lane };
    const job = make();
    lane.jobs.push(job);
    return { job, added: true, lane };
  }

  // the job's progress label, while it runs (the lane's first)
  setProgress(name: N, job: E, label: string | null): void {
    const lane = this.lanes.get(name);
    if (lane?.first === job) lane.progress = label;
  }

  // drops the lane's jobs other than the one with that id: those dropped (the progress goes with the first)
  replace(name: N, id: string): E[] {
    const lane = this.lanes.get(name);
    if (!lane) return [];
    const gone = lane.jobs.filter((j) => this.id(j) !== id);
    if (!gone.length) return [];
    if (lane.first !== undefined && gone.includes(lane.first)) lane.progress = null;
    lane.jobs = lane.jobs.filter((j) => this.id(j) === id);
    return gone;
  }

  // drops all of the lane's jobs: those dropped
  clear(name: N): E[] {
    const lane = this.lanes.get(name);
    if (!lane) return [];
    const gone = lane.jobs;
    lane.jobs = [];
    lane.progress = null;
    return gone;
  }

  // a job done (or failed, or dropped): out of its lane
  remove(name: N, job: E): void {
    const lane = this.lanes.get(name), i = lane?.jobs.indexOf(job) ?? -1;
    if (!lane || i < 0) return;
    if (i === 0) lane.progress = null;
    lane.jobs.splice(i, 1);
  }

  // the lane's busy label (null: no job), label: the one a job was asked with
  label(name: N, label: (job: E) => LaneLabel | undefined): string | null {
    const lane = this.lanes.get(name), first = lane?.first;
    if (!lane || first === undefined) return null;
    const own = label(first);
    return lane.progress ?? (typeof own === 'function' ? own(lane.jobs.length) : own ?? null);
  }

  clearAll(): void { this.lanes.clear(); }
}
