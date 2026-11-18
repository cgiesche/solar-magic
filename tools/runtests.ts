// The tests (npm test): each a script of its own, run as a child process – in parallel, the output of each kept
// and printed whole when it fails.
//   node tools/runtests.ts                 all of them
//   node tools/runtests.ts owl lz2         those whose name contains "owl" or "lz2" (npm test -- owl lz2)
//   node tools/runtests.ts --jobs=4        at most 4 at a time (default: os.availableParallelism())
//   node tools/runtests.ts --list          their names
// A tools/test*.ts that is not listed here is warned about at the end: a new test is added to TESTS.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';

// the scripts with their arguments, in the order they are started
const TESTS: readonly string[] = [
  'tools/testlevels.ts',
  'tools/testpatch.ts',
  'tools/testeditorpatches.ts',
  'tools/testfastrom.ts',
  'tools/testmemtiming.ts',
  'tools/fastromsites.ts',
  'tools/testsave.ts',
  'tools/testlevelfile.ts',
  'tools/testbg.ts',
  'tools/testmessages.ts',
  'tools/testmessagebox.ts',
  'tools/testmessageuse.ts',
  'tools/testmessagedraw.ts',
  'tools/testvsprites.ts',
  'tools/testmap16ext.ts',
  'tools/testremap.ts',
  'tools/testtilemove.ts',
  'tools/testusernames.ts',
  'tools/testobjectnames.ts',
  'tools/testtilesearch.ts',
  'tools/testquarters.ts',
  'tools/testasar.ts',
  'tools/testconflicts.ts',
  'tools/testuberasm.ts',
  'tools/testblocks.ts',
  'tools/testcollision.ts',
  'tools/testjumparcs.ts',
  'tools/testcamera.ts',
  'tools/testcamerareach.ts',
  'tools/testprobehost.ts',
  'tools/testprobeclient.ts',
  'tools/testprobeworkers.ts',
  'tools/testspriteprobes.ts',
  'tools/testlanes.ts',
  'tools/testlearner.ts',
  'tools/testresultinputs.ts',
  'tools/testlevelscan.ts',
  'tools/testlayer3.ts',
  'tools/testlayer3gfx.ts',
  'tools/testlayer3map.ts',
  'tools/testlevelusage.ts',
  'tools/testtilesets.ts',
  'tools/testl2scroll.ts',
  'tools/testlevelheader.ts',
  'tools/testlevelheight.ts',
  'tools/testlevelheightplay.ts',
  'tools/testfgbginit.ts',
  'tools/testentranceoptions.ts',
  'tools/testmidway.ts',
  'tools/testmusic.ts',
  'tools/testsfx.ts',
  'tools/testextra.ts',
  'tools/testextgfx.ts',
  'tools/testexgfxrange.ts',
  'tools/testgfxbin.ts',
  'tools/testgfxfiles.ts',
  'tools/testblockpack.ts',
  'tools/testbgpack.ts',
  'tools/testlevelgfx.ts',
  'tools/testgfxslots.ts',
  'tools/testthumbs.ts',
  'tools/testprefabs.ts',
  'tools/testprefabcost.ts',
  'tools/testprefabplaces.ts',
  'tools/testprefabsources.ts',
  'tools/testpastehint.ts',
  'tools/testprefabsuggest.ts',
  'tools/testcdm16.ts',
  'tools/testobj2d.ts',
  'tools/testobjresize.ts',
  'tools/testobjectool.ts',
  'tools/testvram.ts --frames=200',
  'tools/testblanklines.ts',
  'tools/testromhistory.ts',
  'tools/testromedit.ts',
  'tools/testromwatch.ts',
  'tools/testlevelhistory.ts',
  'tools/testeditsession.ts',
  'tools/testlevelmodel.ts',
  'tools/testscheduler.ts',
  'tools/testromgen.ts',
  'tools/testexanim.ts',
  'tools/exanimcost.ts',
  'tools/testrotation.ts',
  'tools/testtriggers.ts',
  'tools/testcolorusers.ts',
  'tools/testanimframes.ts',
  'tools/testanimcells.ts',
  'tools/testlevelpatch.ts',
  'tools/testlevelanimsteps.ts',
  'tools/testloadreuse.ts',
  'tools/testanimtiles.ts',
  'tools/testspritemem.ts',
  'tools/testspriteplace.ts',
  'tools/testpixi.ts',
  'tools/testpkgmap.ts',
  'tools/testpkgreg.ts',
  'tools/testpkgsections.ts',
  'tools/testpackages.ts',
  'tools/testpkgpatchedit.ts',
  'tools/testcallisto.ts',
  'tools/testrommap16.ts',
  'tools/testsharedpal.ts',
  'tools/testowtilebps.ts',
  'tools/testglobalgfx.ts',
  'tools/testglobalanim.ts',
  'tools/testsamples.ts',
  'tools/testrhr.ts',
  'tools/testscrollfix.ts',
  'tools/testgame.ts',
  'tools/testsavestate.ts',
  'tools/testslotwatch.ts',
  'tools/testlagmeter.ts',
  'tools/testplaysession.ts',
  'tools/testrewind.ts',
  'tools/testdeaths.ts',
  'tools/testexits.ts',
  'tools/testscreenrect.ts',
  'tools/testexitbank.ts',
  'tools/testow.ts',
  'tools/testowexit.ts',
  'tools/testowedit.ts',
  'tools/testcolorsources.ts',
  'tools/testsourcetrack.ts',
  'tools/testleveltiles.ts',
  'tools/testlevelimage.ts',
  'tools/testleveloverlays.ts',
  'tools/testleveltilesettings.ts',
  'tools/testrevealwalk.ts',
  'tools/teststartiles.ts',
  'tools/testowoptions.ts',
  'tools/testowpaths.ts',
  'tools/testowreach.ts',
  'tools/testowhardpaths.ts',
  'tools/testworldcheck.ts',
  'tools/testowchecks.ts',
  'tools/testowlook.ts',
  'tools/testowcharbase.ts',
  'tools/testowexitedges.ts',
  'tools/testeventprogress.ts',
  'tools/testeventset.ts',
  'tools/testevents.ts',
  'tools/testeventpaint.ts',
  'tools/testl1events.ts',
  'tools/testowlinks.ts',
  'tools/testowlinkcells.ts',
  'tools/testleveltilelinks.ts',
  'tools/testowsprites.ts',
  'tools/testowcustom.ts',
  'tools/testbowsie.ts',
  'tools/testowlearn.ts',
  'tools/testowlock.ts',
  'tools/testowplay.ts',
  'tools/testowsavesteps.ts',
  'tools/testowundo.ts',
  'tools/testowscrub.ts',
  'tools/testowmap16.ts',
  'tools/testowmusic.ts',
  'tools/testlevelnames.ts',
  'tools/testowlevelname.ts',
  'tools/testowselection.ts',
  'tools/testsubmapgfx.ts',
  'tools/testowtilepick.ts',
  'tools/testowl1sheet.ts',
  'tools/testowpathshape.ts',
  'tools/testowroute.ts',
  'tools/testowpathtool.ts',
  'tools/testowlevelmove.ts',
  'tools/testsecretexits.ts',
  'tools/testowexitevents.ts',
  'tools/testowl2sheet.ts',
  'tools/testowl2pieces.ts',
  'tools/testowlayer3.ts',
  'tools/testowborder.ts',
  'tools/testtitlescreen.ts',
  'tools/testpregame.ts',
  'tools/testmenutext.ts',
  'tools/testpresents.ts',
  'tools/testgamestart.ts',
  'tools/testpoweron.ts',
  'tools/testtitlemovement.ts',
  'tools/testprefs.ts',
  'tools/testtokens.ts',
  'tools/testants.ts',
  'tools/testpalhover.ts',
  'tools/testbrushsurface.ts',
  'tools/testowexanim.ts',
  'tools/testowimport.ts',
  'tools/testentrances.ts',
  'tools/testbps.ts',
  'tools/testnavhistory.ts',
  'tools/testowpages.ts',
  'tools/testowanimated.ts',
  'tools/testowanimsteps.ts',
  'tools/testowanimview.ts',
  'tools/testramframes.ts',
  'tools/testlevelpicture.ts',
  'tools/testowswitches.ts',
  'tools/testowlayers.ts',
  'tools/testowleveltiles.ts',
  'tools/testoweventtiles.ts',
  'tools/testowrefusal.ts',
  'tools/testowfixes.ts',
  'tools/testowbudget.ts',
  'tools/testowpicks.ts',
  'tools/testowcellhistory.ts',
  'tools/testowmovechange.ts',
  'tools/testowexitsentence.ts',
  'tools/testworkerloads.ts',
  'tools/testlz2.ts',
  'tools/testprojectstore.ts',
  'tools/testshortcuts.ts',
];
// Run alone, after the others: they check times of the real clock (a step's budget, a ticker's repaints in a
// time span, one timing against another), which other processes using every core would stretch
const SERIAL: ReadonlySet<string> = new Set(['tools/testants.ts', 'tools/testowsavesteps.ts', 'tools/testrewind.ts']);
// tools/test*.ts that are no tests: what tests import
const NO_TESTS: ReadonlySet<string> = new Set(['tools/testsong.ts']);

interface Result { name: string; ok: boolean; seconds: number; how: string; output: string }

// a test's name: its entry without the directory and the extension ("testvram --frames=200")
const nameOf = (entry: string): string => entry.replace(/^tools\//, '').replace(/\.ts(?= |$)/, '');
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function run(entry: string): Promise<Result> {
  return new Promise((done) => {
    const t0 = performance.now(), out: Buffer[] = [];
    const child = spawn(process.execPath, entry.split(' '), { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => out.push(d));
    const end = (ok: boolean, how: string) => done({ name: nameOf(entry), ok, seconds: (performance.now() - t0) / 1000, how, output: Buffer.concat(out).toString() });
    child.on('error', (e) => end(false, String(e)));
    child.on('close', (code, signal) => end(code === 0, signal ? `killed by ${signal}` : `exit code ${code}`));
  });
}

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--')), filters = args.filter((a) => !a.startsWith('--'));
const unknown = flags.filter((f) => f !== '--list' && !/^--jobs=[1-9]\d*$/.test(f));
if (unknown.length) { console.error(`unknown option ${unknown.join(' ')} (--jobs=N, --list; other arguments: parts of test names)`); process.exit(2); }
const jobs = Number(flags.find((f) => f.startsWith('--jobs='))?.slice(7) ?? availableParallelism());
process.chdir(`${import.meta.dirname}/..`); // (the tests read test/fixtures by relative paths)

const chosen = TESTS.filter((e) => !filters.length || filters.some((f) => nameOf(e).includes(f)));
// test files nobody listed
const listed = new Set(TESTS.map((e) => e.split(' ')[0]));
const unlisted = readdirSync('tools').filter((f) => /^test.*\.ts$/.test(f)).map((f) => `tools/${f}`).filter((f) => !listed.has(f) && !NO_TESTS.has(f)).sort();
const warn = () => { if (unlisted.length) console.log(`warning: not in the test list (tools/runtests.ts TESTS): ${unlisted.join(' ')}`); };

if (flags.includes('--list')) {
  for (const e of chosen) console.log(nameOf(e) + (SERIAL.has(e.split(' ')[0]) ? '  (run alone)' : ''));
  warn();
  process.exit(0);
}
if (!chosen.length) { console.error(`no test's name contains ${filters.join(' or ')}`); process.exit(1); }

const t0 = performance.now();
// The patched image the tests start from (fixture.ts editorImage), built once and kept before they all ask for it
// at the same time. Failing here (a source that doesn't load) is left to the tests to tell
if (!process.env.SMW_NO_IMAGE_CACHE) {
  try { await (await import('./fixture.ts')).editorImage(); } catch (e) { console.log(`warning: the editor image could not be built ahead: ${e instanceof Error ? e.message : e}`); }
}

const results: Result[] = [];
const report = (r: Result) => {
  results.push(r);
  if (r.ok) console.log(`ok   ${r.name} ${secs(r.seconds * 1000)}`);
  else console.log(`FAIL ${r.name} ${secs(r.seconds * 1000)} (${r.how})\n${r.output.trimEnd()}\n---- end of ${r.name}`);
};
const parallel = chosen.filter((e) => !SERIAL.has(e.split(' ')[0])), serial = chosen.filter((e) => SERIAL.has(e.split(' ')[0]));
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs, parallel.length) }, async () => { while (next < parallel.length) report(await run(parallel[next++])); }));
for (const e of serial) report(await run(e));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length} tests, ${failed.length} failed, ${secs(performance.now() - t0)} (${Math.min(jobs, parallel.length)} at a time${serial.length ? `, ${serial.length} alone` : ''})`);
if (failed.length) console.log(`failed: ${failed.map((r) => r.name).join(', ')}`);
warn();
process.exit(failed.length ? 1 : 0);
