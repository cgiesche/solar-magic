// The lanes of the result learner's jobs (lanes.ts), shared by the probe client and the probe host: jobs in the order
// asked, a request for a job already in its lane joins it, replace drops the lane's others (the running one's progress
// with it), clear drops them all; the busy label is the running job's progress, else its own (by the lane's count).
import { Lanes, laneId, type LaneLabel } from '../src/core/lanes.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };

interface J { key: string; input?: string; label?: LaneLabel }
const lanes = new Lanes<'a' | 'b', J>((j) => laneId(j.key, j.input));
const ask = (lane: 'a' | 'b', key: string, input?: string, label?: LaneLabel) => lanes.join(lane, laneId(key, input), () => ({ key, input, label }));
const keys = (lane: 'a' | 'b') => (lanes.get(lane)?.jobs ?? []).map((j) => `${j.key}${j.input ?? ''}`).join();
const label = (lane: 'a' | 'b') => lanes.label(lane, (j) => j.label);

// joining
const first = ask('a', 'k', '1', (n) => `Jobs (${n})`), again = ask('a', 'k', '1');
check(first.added && !again.added && again.job === first.job && keys('a') === 'k1', 'a request for the same key and input joins the job');
ask('a', 'k', '2'); ask('a', 'm');
check(keys('a') === 'k1,k2,m' && lanes.get('a')?.first === first.job, 'another input or key: queued in the order asked, the first runs');
check(lanes.find('a', laneId('k', '2'))?.input === '2' && lanes.find('b', laneId('k', '2')) === undefined, 'found by id in its own lane only');

// labels
check(label('a') === 'Jobs (3)' && label('b') === null, 'the label of the first job, by the lane\'s count; none without jobs');
lanes.lane('a').progress = 'Halfway';
check(label('a') === 'Halfway', 'the running job\'s progress replaces it');

// replace and remove
check(lanes.replace('a', laneId('k', '1')).map((j) => j.key + j.input).join() === 'k2,mundefined' && keys('a') === 'k1' && label('a') === 'Halfway',
  'replace drops the others (handed back), the running job kept keeps its progress');
ask('a', 'n', undefined, 'N');
check(lanes.replace('a', laneId('n', undefined)).length === 1 && label('a') === 'N', 'the running job replaced: its progress goes');
check(lanes.replace('a', laneId('n', undefined)).length === 0, 'nothing else to drop');
ask('a', 'o');
lanes.lane('a').progress = 'Busy';
lanes.remove('a', lanes.find('a', laneId('o', undefined))!);
check(keys('a') === 'n' && label('a') === 'Busy', 'a later job done: the running one\'s progress stays');
lanes.remove('a', lanes.get('a')!.first!);
check(keys('a') === '' && label('a') === null, 'the running job done: the lane empty, no label');

// clear
ask('b', 'x'); ask('b', 'y');
lanes.lane('b').progress = 'p';
check(lanes.clear('b').length === 2 && keys('b') === '' && lanes.lane('b').progress === null && lanes.clear('b').length === 0, 'clear drops all of the lane\'s jobs');

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all ok');
