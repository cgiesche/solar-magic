# Probe workers with fixed routing

_Decided with two workers (#513); a third was added later (#516, the amendment at the end). The text below is the decision as made for two, with what the amendment changed marked._

Everything emulated off the main thread ran in one probe worker (core/probehost.ts): the block and sprite probes, the tasks (object kinds, level scan, camera) and the result learner's jobs in their lanes, taking turns. After a switch to a level not opened before, several long jobs are wanted at once – the object thumbnails, the tileset's object kinds, the sprite images, the sprite memory check – and each one's wall time became a multiple of its CPU time: in a Firefox profile (#513) the object kinds needed 85 s for 27 s of CPU, while the main thread idled at about 3 %.

We decided that **the probe client (core/probeclient.ts) talks to two probe workers, and which one a message goes to is fixed by what it is for** (core/probeprotocol.ts `probeWorker`):

- **the second worker**: the task `kinds` and the lanes `sprites`, `variants`, `bytes`, `spritemem` (with three workers these lanes are the third's, see the amendment);
- **the first worker**: everything else – the asked and prefetched probes, the tasks `scan` and `camera`, every other lane.

Each worker is a probe host as before, with its own copy of the ROM, its own boot and its own result store. The ROM and the ranges a change wrote go to both; every other message only to the worker of its task or lane. Both workers' replies go through the same handlers into the editor's one result cache. What the client keeps about a host – the ROM generation and size it probes on, the levels as edited it has whole – it keeps per connection.

The split follows what jobs share inside a host (probehost.ts `LearnState`): jobs that share something a host keeps between them are on the same worker.

- the levels' uses (`uses`) and the block prober are shared by the levels' uses job and the saves at an event progress (`owSave`: lanes `owps`, `owpn`, `owpa`) – all on the first worker, with the block probes;
- the overworld's loads (`ow`) and the ROM copy for layer 1 without an event (`l1Copy`) are the overworld lanes' – all on the first;
- the prefab suggestions (`suggest`) and the object boxes (`sizes`) each belong to one lane on the first;
- the sprite groups' results (`groups`) are the sprite memory check's alone, on the second (the third of three).

Nothing on the second worker reads what a job on the first keeps, or the other way round. Where one job needs another's result across the workers (the object thumbnails need the object kinds), it reaches it through the editor as before: the thumbnails' specs are built on the main thread from the kinds in the editor's cache.

**One worker** where `navigator.hardwareConcurrency` is below 4 (two workers, the main thread and the browser need the cores; the rule by cores is now `probeWorkersFor`, see the amendment), when the second worker doesn't start, and in the tools, which use a `ProbeHost` directly: the routing maps everything to the one connection. A worker that breaks down hands its side to the host on the main thread, as the single worker did; the other worker goes on with its ROM and queue.

## Considered options

- **A pool that gives each job to the next free worker**: rejected. Jobs keep state on their host – a lane's emulator with its prepared level, the levels' uses, the overworld's loads, results in the host's store that a later job takes as stored, a cancelled task taken up again where it stood. A job moving between workers would lose it or need it shipped; a fixed side per lane keeps all of that where it is.
- **A worker per lane or per group of lanes**: rejected. Each worker costs a boot and a copy of the ROM (and its own result store); most lanes are idle most of the time. Two cover the case measured (see the amendment below for a third): the second worker's jobs were about 46 s of the 126 s of CPU.
- **Balancing the workers by load**: rejected for the same reason as the pool; the fixed table is also what makes "which worker has this" answerable when reading a profile.

## Amendment (#516): a third worker for the sprites' lanes

A profile with the two workers (17.8 s of a level switch) showed both busy the whole time, and on the second the object kinds waiting for the sprite images: they take turns per step, a step of the sprite images (a test level load with its captures) is about five times as long as one of the kinds, so the kinds got 3.8 s of CPU in 17.8 s while the sprite images had 12.2 s. The first worker had its lanes done after 6 s.

We decided on **a third worker, with the same fixed routing**: the object kinds keep the second worker to themselves, the lanes `sprites`, `variants`, `bytes` and `spritemem` move to the third (the sprite groups' results stay with the sprite memory check; nothing there is shared with the kinds). The workers started follow the cores (`probeWorkersFor`: one per two logical cores, so two from four on, three from six); with fewer workers the last one has what the missing ones would, which is the table of two workers above.

This takes back part of "a worker per lane or per group of lanes: rejected": that was measured with the first profile, where the second worker's jobs were 46 s of 126 s. The cost named there stands (a boot and a ROM copy each), and so does the limit: a level switch has three long groups of jobs, a fourth worker would have none.

- **The kinds on the first worker instead**: rejected. Its lanes are idle after 6 s in this profile, but asked probes run before the lanes' turns there, and for a tileset not seen before the object thumbnails are its longest job.
- **A turn lasting a time slice instead of a step**: not decided here. It would give the kinds half of the second worker instead of a fifth, and still not the whole of one.
