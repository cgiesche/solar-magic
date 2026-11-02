// Conflicts between the kinds of patches: an external patch against the hooks of UberASM and the
// custom sprites (both orders), free RAM claimed twice (and the ExAnimation engine's claim in Lunar Magic's
// block), long writes into RAM another patch claims, the editor patch's extended object slot, two patches
// with the same fix (no conflict, removed in order), and repeated re-applying leaves no RATS blocks behind.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { applyPatch, uninstallPatch, type PatchSource } from '../src/core/patchapply.ts';
import { listPatches } from '../src/core/patchreg.ts';
import { installEditorPatch } from '../src/core/patches.ts';
import { installExAnim, exanimEntry } from '../src/core/exanim.ts';
import { CDM16_FLAGS, EXANIM_OWN_RAM, EXANIM_SHARED_RAM } from '../src/core/ram.ts';
import { uploadSource, uploadFromFiles } from '../src/core/patchpkg.ts';
import { saveProject, emptyProject, type UberProject } from '../src/core/uberproject.ts';
import { parseList } from '../src/core/uberasm.ts';
import { savePixiProject, parsePixiList, type PixiProject } from '../src/core/pixi.ts';
import { saveBlockProject, parseBlockList, type BlockProject } from '../src/core/blocks.ts';
import { editorImage, cleanImage } from './fixture.ts';

const EDITOR_IMAGE = await editorImage(); // the fixture as the editor opens it

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const enc = new TextEncoder();
const file = EDITOR_IMAGE.slice();
const fresh = () => new Rom(file.slice());
const src = (name: string, main: string): PatchSource => ({ name, main: 'main.asm', files: new Map([['main.asm', main]]) });
// a patch hooking the game's code (at no hook of the editor's own patches) whose code is `body`
const hooked = (name: string, body: string) => src(name, `lorom\norg $00A1DA\n  autoclean JSL Code\n  NOP #2\nfreecode\nCode:\n${body}\n  RTL\n`);
const files = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]));

const uber = (freeram = '$7FAC80'): UberProject => {
  const list = `level:\n105 marker.asm\nfreeram: ${freeram}\n`;
  return { files: files({ 'list.txt': list, 'level/marker.asm': 'main:\n  LDA #$01 : STA $7FB100\n  RTL\n' }), list: parseList(list) };
};
const pixi: PixiProject = {
  files: files({
    'sprites/a.cfg': '01\n36\n00 00 3B 80 00 00\n00 00\na.asm\n',
    'sprites/a.asm': 'print "INIT ",pc\n  RTL\nprint "MAIN ",pc\n  RTL\n',
  }),
  list: parsePixiList('10 a.cfg\n'),
};
const blocks: BlockProject = { files: files({ 'blocks/b.asm': 'db $42\nJMP A : JMP A : JMP A : JMP A : JMP A : JMP A : JMP A : JMP A : JMP A : JMP A\nA: RTL\n' }), list: parseBlockList('2A0 b.asm\n') };

// 1. hooks of UberASM and the custom sprites against an external patch, both orders
{
  const rom = fresh();
  const u = saveProject(rom, uber());
  check(u.ok, 'UberASM applied ' + u.errors.join(' '));
  const p = applyPatch(rom, src('HitsUber', 'lorom\norg $00A242\ndb $EA\n'));
  check(!p.ok && p.errors[0].includes('UberASM'), 'patch on an UberASM hook rejected: ' + p.errors[0]);
}
{
  const rom = fresh();
  const p = applyPatch(rom, src('OnLevelInit', 'lorom\norg $00A5EE\ndb $EA\n'));
  check(p.ok, 'patch at $00A5EE applied');
  const u = saveProject(rom, uber());
  check(!u.ok && u.errors.some((e) => e.includes('OnLevelInit')), 'UberASM on a patched hook rejected: ' + u.errors[0]);
}
{
  const rom = fresh();
  const s = savePixiProject(rom, pixi);
  check(s.ok, 'custom sprites applied ' + s.errors.join(' '));
  const p = applyPatch(rom, src('HitsPixi', 'lorom\norg $02A82A\ndb $EA\n'));
  check(!p.ok && p.errors[0].includes('Custom Sprites'), 'patch on a sprite loader hook rejected: ' + p.errors[0]);
}
{
  const rom = fresh();
  check(applyPatch(rom, src('OnLoader', 'lorom\norg $02A82A\ndb $EA\n')).ok, 'patch at $02A82A applied');
  const s = savePixiProject(rom, pixi);
  check(!s.ok && s.errors.some((e) => e.includes('OnLoader')), 'custom sprites on a patched hook rejected: ' + s.errors[0]);
}

// 2. free RAM
{
  const rom = fresh();
  check(saveProject(rom, uber()).ok && savePixiProject(rom, pixi).ok, 'UberASM and custom sprites side by side');
  const e = listPatches(rom);
  check(e.find((x) => x.kind === 'uberasm')?.ram?.[0][0] === 0x7fac80 && !!e.find((x) => x.kind === 'sprite')?.ram?.length, 'their RAM is in the registry');
  // a manifest claiming UberASM's free RAM through a define
  const upload = uploadFromFiles('claim.zip', files({
    'patch.json': JSON.stringify({ name: 'Claim', main: 'claim.asm', ram: [{ define: 'freeram', size: 2 }] }),
    'claim.asm': '!freeram = $7FAC81\nlorom\norg $00A1DA\n  autoclean JSL Code\n  NOP #2\nfreecode\nCode:\n  RTL\n',
  }));
  const c = applyPatch(rom, uploadSource(upload, 'claim.asm', {}));
  check(!c.ok && c.errors.some((x) => x.includes('RAM conflict') && x.includes('UberASM') && x.includes('$7FAC81')), 'claim of UberASM\'s free RAM rejected: ' + c.errors.join(' '));
  const moved = applyPatch(rom, uploadSource(upload, 'claim.asm', { freeram: '$7FB200' }));
  check(moved.ok && moved.entry?.ram?.[0][0] === 0x7fb200 && !moved.warnings.some((x) => x.includes('RAM')), 'the same patch with its setting moved applies ' + moved.errors.join(' '));
  // code without a claim: long writes into private RAM warn, into the sprite tables (shared) and vanilla RAM don't
  const w = applyPatch(fresh(), hooked('x', 'RTL'));
  check(w.ok && !w.entry?.ramSeen, 'no long writes, nothing recorded');
}
{
  const rom = fresh();
  savePixiProject(rom, pixi);
  const priv = applyPatch(rom, hooked('Scratch', '  LDA #$01 : STA $7FAC18'));
  check(priv.ok && priv.warnings.some((x) => x.includes('$7FAC18') && x.includes('Custom Sprites')), 'long write into the sprite loader\'s RAM warns: ' + priv.warnings.join(' '));
}
{
  const rom = fresh();
  savePixiProject(rom, pixi);
  const shared = applyPatch(rom, hooked('Spawner', '  LDA #$08 : STA $7FAB10,x\n  LDA #$00 : STA $7F837B'));
  check(shared.ok && !shared.warnings.some((x) => x.includes('RAM')) && shared.entry?.ramSeen?.length === 2, 'writes to the sprite tables and to vanilla RAM give no warning ' + shared.warnings.join(' '));
}
{
  // the other way round: a patch writes $7FB000 without a claim, UberASM then claims it
  const rom = fresh();
  applyPatch(rom, hooked('Writer', '  LDA #$01 : STA $7FB000'));
  const u = saveProject(rom, uber('$7FB000'));
  check(u.ok && u.warnings.some((x) => x.includes('Writer') && x.includes('$7FB000')), 'claiming RAM another patch writes warns: ' + u.warnings.join(' '));
}
{
  // claims in the low RAM mirror are compared as $7Exxxx
  const rom = fresh();
  saveProject(rom, uber('$0DC4'));
  const upload = uploadFromFiles('low.zip', files({
    'patch.json': JSON.stringify({ name: 'Low', main: 'main.asm', ram: [{ addr: '$7E0DC5', size: 1 }] }),
    'main.asm': 'lorom\norg $00A1DA\n  autoclean JSL Code\n  NOP #2\nfreecode\nCode:\n  RTL\n',
  }));
  const c = applyPatch(rom, uploadSource(upload, 'main.asm', {}));
  check(!c.ok && c.errors.some((x) => x.includes('RAM conflict')), 'low RAM claim $0DC4 vs $7E0DC5 rejected: ' + c.errors.join(' '));
}
{
  // the ExAnimation engine claims of Lunar Magic's block $7FC000-$7FC05F only the bytes it writes (#310; the rest is
  // Lunar Magic's or free: docs/research/lunar-magic-submap-graphics.md, "$7FC00B")
  const rom = fresh();
  check(installExAnim(rom).ok, 'ExAnimation engine installed');
  const below = new Set<number>();
  for (const [a, n] of exanimEntry(rom)?.ram ?? []) for (let i = a; i < a + n; i++) if (i < CDM16_FLAGS[0]) below.add(i);
  const [ownAt, ownLen] = EXANIM_OWN_RAM;
  const used = new Set<number>([...EXANIM_SHARED_RAM, ...Array.from({ length: ownLen }, (_, i) => ownAt + i)]);
  check(below.size === used.size && [...used].every((a) => below.has(a)), `its claim below the flags is $7FC003-$7FC004, $7FC00A, $7FC05C-$7FC05F (${[...below].map((a) => a.toString(16)).join(' ')})`);
  const claim = (addr: string, size: number) => applyPatch(new Rom(rom.data.slice()), uploadSource(uploadFromFiles('lmram.zip', files({
    'patch.json': JSON.stringify({ name: 'LM RAM', main: 'main.asm', ram: [{ addr, size }] }),
    'main.asm': 'lorom\norg $00A1DA\n  autoclean JSL Code\n  NOP #2\nfreecode\nCode:\n  RTL\n',
  })), 'main.asm', {}));
  const free = claim('$7FC01D', 0x3f), own = claim('$7FC05B', 2);
  check(free.ok, 'a package claiming the free $7FC01D-$7FC05B applies ' + free.errors.join(' '));
  check(!own.ok && own.errors.some((x) => x.includes('RAM conflict') && x.includes('$7FC05C')), 'one claiming the engine\'s $7FC05C rejected: ' + own.errors.join(' '));
}

// 3. the editor patch's extended object $05 slot: protected in an opened ROM; in a clean ROM a patch
// that took it first blocks the editor patch
{
  const p = applyPatch(fresh(), src('ExtObj', 'lorom\norg $0DA11E\ndl $0DA000\n'));
  check(!p.ok && p.errors.some((e) => e.includes('SMWE')), 'patch on extended object $05 rejected: ' + p.errors[0]);
  const rom = new Rom(cleanImage());
  check(applyPatch(rom, src('ExtObj', 'lorom\norg $0DA11E\ndl $0DA000\n')).ok, 'the same patch applies to a clean ROM');
  let msg = '';
  try { installEditorPatch(rom); } catch (e) { msg = (e as Error).message; }
  check(msg.includes('ExtObj'), 'editor patch refuses the taken slot and names the patch: ' + msg);
}

// 3b. two patches with the same fix (the baserom's tweaks and Retry both put RTS at $05B31B): the second
// writing the bytes as they are is no conflict, one changing them is; the first can't be removed before it
{
  const rom = fresh();
  const a = applyPatch(rom, src('Tweaks', 'lorom\norg $05B31B\ndb $60\n'));
  const same = applyPatch(rom, src('Retry', `lorom\norg $05B31B\ndb $60,$${rom.r8(0x05b31c).toString(16)}\n`));
  check(a.ok && same.ok, 'the same bytes written again: no conflict ' + same.errors.join(' '));
  const other = applyPatch(rom, src('Other', 'lorom\norg $05B31B\ndb $6B\n'));
  check(!other.ok && other.errors.some((e) => e.includes('Tweaks')), 'other bytes there: conflict ' + other.errors.join(' '));
  let msg = '';
  try { uninstallPatch(rom, a.entry!.id); } catch (e) { msg = (e as Error).message; }
  check(msg.includes('Retry'), 'the first patch is removed only after the second: ' + msg);
}

// 4. re-applying again and again leaves the number of RATS blocks as it is
{
  const rom = fresh();
  installEditorPatch(rom);
  const counts: number[] = [];
  for (let i = 0; i < 3; i++) {
    const s = savePixiProject(rom, pixi);
    const b = saveBlockProject(rom, blocks);
    const u = saveProject(rom, uber());
    if (!s.ok || !b.ok || !u.ok) console.log([...s.errors, ...b.errors, ...u.errors].join('\n'));
    counts.push(rom.scanRats().length);
  }
  check(counts[1] === counts[0] && counts[2] === counts[0], `RATS blocks after each round: ${counts.join(', ')}`);
  check(saveProject(rom, emptyProject()).ok && !listPatches(rom).some((p) => p.kind === 'uberasm'), 'an empty UberASM project removes it');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
