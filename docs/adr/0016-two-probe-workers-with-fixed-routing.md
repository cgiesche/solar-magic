# Two probe workers with fixed routing

Everything emulated off the main thread ran in one probe worker (core/probehost.ts): the block and sprite probes, the tasks (object kinds, level scan, camera) and the result learner's jobs in their lanes, taking turns. After a switch to a level not opened before, several long jobs are wanted at once – the object thumbnails, the tileset's object kinds, the sprite images, the sprite memory check – and each one's wall time became a multiple of its CPU time: in a Firefox profile (#513) the object kinds needed 85 s for 27 s of CPU, while the main thread idled at about 3 %.

We decided that **the probe client (core/probeclient.ts) talks to two probe workers, and which one a message goes to is fixed by what it is for** (core/probeprotocol.ts `probeWorker`):

- **the second worker**: the task `kinds` and the lanes `sprites`, `variants`, `bytes`, `spritemem`;
- **the first worker**: everything else – the asked and prefetched probes, the tasks `scan` and `camera`, every other lane.

Each worker is a probe host as before, with its own copy of the ROM, its own boot and its own result store. The ROM and the ranges a change wrote go to both; every other message only to the worker of its task or lane. Both workers' replies go through the same handlers into the editor's one result cache. What the client keeps about a host – the ROM generation and size it probes on, the levels as edited it has whole – it keeps per connection.

The split follows what jobs share inside a host (probehost.ts `LearnState`): jobs that share something a host keeps between them are on the same worker.

- the levels' uses (`uses`) and the block prober are shared by the levels' uses job and the saves at an event progress (`owSave`: lanes `owps`, `owpn`, `owpa`) – all on the first worker, with the block probes;
- the overworld's loads (`ow`) and the ROM copy for layer 1 without an event (`l1Copy`) are the overworld lanes' – all on the first;
- the prefab suggestions (`suggest`) and the object boxes (`sizes`) each belong to one lane on the first;
- the sprite groups' results (`groups`) are the sprite memory check's alone, on the second.

Nothing on the second worker reads what a job on the first keeps, or the other way round. Where one job needs another's result across the workers (the object thumbnails need the object kinds), it reaches it through the editor as before: the thumbnails' specs are built on the main thread from the kinds in the editor's cache.

**One worker** where `navigator.hardwareConcurrency` is below 4 (two workers, the main thread and the browser need the cores), when the second worker doesn't start, and in the tools, which use a `ProbeHost` directly: the routing maps everything to the one connection. A worker that breaks down hands its side to the host on the main thread, as the single worker did; the other worker goes on with its ROM and queue.

## Considered options

- **A pool that gives each job to the next free worker**: rejected. Jobs keep state on their host – a lane's emulator with its prepared level, the levels' uses, the overworld's loads, results in the host's store that a later job takes as stored, a cancelled task taken up again where it stood. A job moving between workers would lose it or need it shipped; a fixed side per lane keeps all of that where it is.
- **A worker per lane or per group of lanes**: rejected. Each worker costs a boot and a copy of the ROM (and its own result store); most lanes are idle most of the time. Two cover the case measured: the second worker's jobs were about 46 s of the 126 s of CPU.
- **Balancing the two by load**: rejected for the same reason as the pool; the fixed table is also what makes "which worker has this" answerable when reading a profile.
