// The ROM's music project: custom songs in AddmusicK's format (MML .txt with their BRR samples),
// inserted by AddmusicK itself (amk.ts). Like the UberASM project it lives in the patch registry: one
// entry (kind 'music') whose changes are the AddmusicK run – its hijacks with their original bytes and
// its free space – and whose stored sources are the project (zip). Saving removes the old run and
// inserts all songs anew, so the entry can always be removed again completely.
//
// Song numbers are AddmusicK's: 01-09 global songs (jingles), 0A-28 its recreations of the original
// songs, custom songs from 29 on (or in place of an original). Which song a level plays is set per
// level by the music patch (patches.ts, "SMWU").

import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { Rom, MAX_ROM_SIZE, snesToPc, pcToSnes } from './rom.ts';
import { registerChanges, reserveTop, uninstallPatch } from './patchapply.ts';
import { listPatches, patchArchive, hashBytes, missingSources, type PatchEntry } from './patchreg.ts';
import { RESERVED_TOP } from './rom.ts';
import { HEADER_MUSIC_TABLE, levelMusic, setLevelMusic } from './patches.ts';
import { MUSIC } from './names.ts';
import { runAmk, type AmkResult } from './amk.ts';
import { AMK_ORIGINALS } from '../vendor/amk/originals.ts';

export const FIRST_CUSTOM = 0x29;
// AddmusicK's !FreeRAM ($7FB000 in asm/SNES/patch.asm of 1.0.11), up to 1032 bytes (its sample table)
const AMK_FREERAM: [number, number] = [0x7fb000, 0x408];
export const LAST_SONG = 0xff;

export interface MusicSong {
  num: number; // AddmusicK song number
  file: string; // the .txt, relative to AddmusicK's music folder ("<folder>/<song>.txt")
  name: string; // shown in the editor
  volume?: number; // loudness in percent of the song's own (100 when not set), see songWithVolume
  defines?: Record<string, string | null>; // settings differing from the song's own (null: not defined), see songWithDefines
}

export interface MusicProject {
  songs: MusicSong[];
  files: Map<string, Uint8Array>; // relative to AddmusicK's music folder: the songs and their samples
}

export interface SongInfo {
  num: number;
  name: string;
  kind: 'global' | 'original' | 'custom' | 'vanilla';
  file?: string; // custom songs: their .txt
}

export const emptyMusicProject = (): MusicProject => ({ songs: [], files: new Map() });

export const originalName = (file: string) => file.replace(/^originals\/\d+ /, '').replace(/\.txt$/i, '');

// ---------- songs in an upload ----------

const dec = (b: Uint8Array) => strFromU8(b, true).replace(/^﻿/, '');

// an AddmusicK song (or Addmusic 4.05 / AddmusicM one) rather than a readme; channel 0 may follow other
// text on its line, e.g. a replacement ("Channel # = #" … "Channel #0")
export function isSongText(text: string): boolean {
  const code = text.replace(/;[^\n]*/g, '');
  return /^\s*#(amk|am4|amm|samples|instruments|spc|0)\b/m.test(code) && /#0\b/.test(code);
}

// #title of the song's #spc block
export function songTitle(text: string): string | null {
  const m = /#title\s+"([^"]*)"/.exec(text);
  return m && m[1].trim() ? m[1].trim() : null;
}

// the samples a song names (#samples, #instruments), relative to its #path, and the sample groups its
// #samples takes in (from AddmusicK's "Addmusic_sample groups.txt")
export function songSamples(text: string): { path: string; samples: string[]; groups: string[] } {
  const noComments = text.replace(/;[^\n]*/g, '');
  const path = /#path\s+"([^"]*)"/i.exec(noComments)?.[1] ?? '';
  const samples = new Set<string>(), groups = new Set<string>();
  for (const block of ['samples', 'instruments']) {
    const re = new RegExp(`#${block}\\s*\\{([^}]*)\\}`, 'gi');
    for (let m; (m = re.exec(noComments));) {
      for (const q of m[1].matchAll(/"([^"]+)"/g)) samples.add(q[1].replace(/\\/g, '/'));
      if (block === 'samples') for (const g of m[1].replace(/"[^"]*"/g, '').matchAll(/#([^\s"{}]+)/g)) groups.add(g[1]);
    }
  }
  return { path, samples: [...samples], groups: [...groups] };
}

// sample group definitions ("#name { "x.brr" … }") in a text, by name – as downloads give them in their
// readme for "Addmusic_sample groups.txt"
function sampleGroupDefs(text: string): Map<string, string> {
  const defs = new Map<string, string>();
  for (const m of text.replace(/;[^\n]*/g, '').matchAll(/#([^\s"{}]+)\s*\{([^{}]*)\}/g)) {
    if (/"[^"]+\.brr"/i.test(m[2])) defs.set(m[1].toLowerCase(), `#${m[1]}\n{${m[2].replace(/\r/g, '')}}\n`);
  }
  return defs;
}

// the sample groups a song folder brings along (AddmusicK's own: default, optimized, AMM)
export const SAMPLE_GROUPS = 'Addmusic_sample groups.txt';

export interface SongFiles {
  folder: string; // the song's folder in the project
  songs: { file: string; name: string }[]; // files relative to the music folder
  files: Map<string, Uint8Array>; // all files to add, relative to the music folder
  missing: string[]; // samples the songs name that aren't in the download (or sample groups)
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter((x) => x && x !== '.').join('/');
// ".." taken by the text, as Windows does ("Song/../optimized/x.brr" → "optimized/x.brr")
const resolve = (p: string) => norm(p).split('/').reduce<string[]>((a, x) => (x === '..' ? a.slice(0, -1) : [...a, x]), []).join('/');

// The songs of an upload (zip or loose files) and the files they need, placed the way AddmusicK
// looks for samples: next to the song (its folder + #path) – so an upload keeps its layout under one
// folder of the project, and samples it keeps elsewhere (e.g. a separate "samples" folder) are copied
// to where the song expects them.
export function songsFromFiles(name: string, files: Map<string, Uint8Array>, taken: Set<string> = new Set()): SongFiles {
  const all = new Map<string, Uint8Array>();
  for (const [p, c] of files) {
    const n = norm(p);
    if (!n || n.startsWith('__MACOSX/') || /(^|\/)\.[^/]*$/.test(n)) continue;
    all.set(n, c);
  }
  // a common top folder goes
  const tops = new Set([...all.keys()].map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '')));
  if (tops.size === 1 && !tops.has('')) {
    const t = [...tops][0] + '/';
    for (const [p, c] of [...all]) { all.delete(p); all.set(p.slice(t.length), c); }
  }
  const songs = [...all].filter(([p, c]) => /\.txt$/i.test(p) && isSongText(dec(c)));
  if (!songs.length) throw new Error('No AddmusicK song (.txt with #0 and #amk/#samples) found');
  let folder = name.replace(/\.(zip|txt)$/i, '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'song';
  for (let i = 2; taken.has(folder.toLowerCase()); i++) folder = `${folder.replace(/ \(\d+\)$/, '')} (${i})`;
  const out = new Map<string, Uint8Array>();
  for (const [p, c] of all) if (/\.(brr|bnk)$/i.test(p)) out.set(`${folder}/${p}`, c);
  for (const [p, c] of songs) out.set(`${folder}/${p}`, c);
  const missing: string[] = [];
  const byBase = new Map<string, string[]>();
  for (const p of all.keys()) {
    const b = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
    byBase.set(b, [...(byBase.get(b) ?? []), p]);
  }
  const groupDefs = new Map<string, string>();
  for (const [p, c] of all) if (/\.txt$/i.test(p) && !songs.some(([q]) => q === p)) for (const [g, d] of sampleGroupDefs(dec(c))) groupDefs.set(g, d);
  const groups = new Set<string>();
  for (const [p, c] of songs) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
    const { path, samples, groups: used } = songSamples(dec(c));
    for (const g of used) {
      if (/^(default|optimized|amm)$/i.test(g)) continue;
      if (groupDefs.has(g.toLowerCase())) groups.add(groupDefs.get(g.toLowerCase())!);
      else missing.push(`sample group #${g}`);
    }
    for (const s of samples) {
      const want = resolve(`${dir}${path ? path + '/' : ''}${s}`);
      if (all.has(want)) continue;
      const base = s.slice(s.lastIndexOf('/') + 1).toLowerCase();
      const cand = byBase.get(base) ?? [];
      const pick = cand.find((x) => path && x.toLowerCase().includes(path.toLowerCase() + '/')) ?? cand[0];
      if (pick) out.set(`${folder}/${want}`, all.get(pick)!);
      else if (!/^(default\/|optimized\/|EMPTY\.brr$)/i.test(resolve(`${path}/${s}`))) missing.push(s); // samples of AddmusicK itself
    }
  }
  if (groups.size) out.set(`${folder}/${SAMPLE_GROUPS}`, strToU8([...groups].join('\n'), true));
  return {
    folder,
    songs: songs.map(([p, c]) => ({ file: `${folder}/${p}`, name: songTitle(dec(c)) ?? p.slice(p.lastIndexOf('/') + 1).replace(/\.txt$/i, '') })),
    files: out,
    missing,
  };
}

export function songsFromZip(name: string, data: Uint8Array, taken?: Set<string>): SongFiles {
  const files = new Map<string, Uint8Array>();
  for (const [p, c] of Object.entries(unzipSync(data))) if (!p.endsWith('/')) files.set(p, c);
  return songsFromFiles(name, files, taken);
}

// adds the songs of an upload with the next free numbers (or `num` for the first); returns them
export function addSongs(p: MusicProject, sf: SongFiles, num?: number): MusicSong[] {
  for (const [f, c] of sf.files) p.files.set(f, c);
  const added: MusicSong[] = [];
  for (const s of sf.songs) {
    let n = added.length === 0 && num !== undefined ? num : nextFreeSong(p);
    if (n < 0) throw new Error('All song numbers up to FF are used');
    p.songs = p.songs.filter((x) => x.num !== n);
    const song = { num: n, file: s.file, name: s.name };
    p.songs.push(song);
    added.push(song);
  }
  p.songs.sort((a, b) => a.num - b.num);
  return added;
}

export function nextFreeSong(p: MusicProject): number {
  for (let n = FIRST_CUSTOM; n <= LAST_SONG; n++) if (!p.songs.some((s) => s.num === n)) return n;
  return -1;
}

// removes a song and the files only it used (its folder, if no other song is in there)
export function removeSong(p: MusicProject, num: number): void {
  const s = p.songs.find((x) => x.num === num);
  if (!s) return;
  p.songs = p.songs.filter((x) => x !== s);
  const folder = s.file.slice(0, s.file.indexOf('/') + 1);
  if (folder && !p.songs.some((x) => x.file.startsWith(folder))) {
    for (const f of [...p.files.keys()]) if (f.startsWith(folder)) p.files.delete(f);
  } else if (!folder) p.files.delete(s.file);
}

export const folders = (p: MusicProject) => new Set([...p.files.keys()].map((f) => f.slice(0, f.indexOf('/')).toLowerCase()));

// ---------- the project in the ROM ----------

export function musicEntry(rom: Rom): PatchEntry | null {
  return listPatches(rom).find((p) => p.kind === 'music') ?? null;
}

// AddmusicK's mark at $0E8000
export function hasAmk(rom: Rom): boolean {
  return rom.size > 0x70004 && String.fromCharCode(...rom.data.subarray(0x70000, 0x70004)) === '@AMK';
}

export function projectToZip(p: MusicProject): Uint8Array {
  const z: Record<string, Uint8Array> = { 'project.json': strToU8(JSON.stringify({ songs: p.songs })) };
  for (const [f, c] of p.files) z['music/' + f] = c;
  return zipSync(z, { level: 9 });
}

export function projectFromZip(data: Uint8Array): MusicProject {
  const z = unzipSync(data);
  const meta = JSON.parse(strFromU8(z['project.json'])) as { songs: MusicSong[] };
  const files = new Map<string, Uint8Array>();
  for (const [p, c] of Object.entries(z)) if (p.startsWith('music/')) files.set(p.slice(6), c);
  return { songs: meta.songs, files };
}

export function loadMusicProject(rom: Rom): MusicProject | null {
  const e = musicEntry(rom);
  if (!e) return null;
  const a = patchArchive(rom, e);
  if (!a) throw missingSources('music');
  return projectFromZip(a);
}

// Addmusic_list.txt: AddmusicK's originals, replaced where a custom song has their number
export function amkList(p: MusicProject): string {
  const custom = new Map(p.songs.map((s) => [s.num, s.file]));
  const line = (n: number, f: string) => `${n.toString(16).toUpperCase().padStart(2, '0')}  ${f}`;
  const globals = AMK_ORIGINALS.filter((o) => o[2]).map(([n, f]) => line(n, f));
  const locals: string[] = [];
  for (const [n, f, g] of AMK_ORIGINALS) if (!g) locals.push(line(n, custom.get(n) ?? f));
  for (const s of p.songs) if (!AMK_ORIGINALS.some((o) => o[0] === s.num)) locals.push(line(s.num, s.file));
  return `Globals:\n${globals.join('\n')}\n\nLocals:\n${locals.join('\n')}\n`;
}

// AddmusicK's driver sets a voice's volume from (volume · master volume)² – the master volume is the
// song's global volume ("w", hex $E0, faded to with $E1; $C0 until the song sets one). A song gets
// `percent` of its loudness by scaling all of them by √(percent/100), up to 255; one that never sets it
// gets "w" at the start of channel 0. Replacements ("x = w200") are scaled too; comments and the
// #samples, #instruments and #spc blocks stay.
export function songWithVolume(text: string, percent: number): string {
  const f = Math.sqrt(percent / 100);
  const sc = (v: string, hexa = false) => {
    const n = Math.min(255, Math.round(parseInt(v, hexa ? 16 : 10) * f));
    return hexa ? n.toString(16).toUpperCase().padStart(2, '0') : String(n);
  };
  let found = false;
  const re = /(;[^\n]*|#(?:samples|instruments|spc)\s*\{[^}]*\})|"([^"\n]*)"|(?<![A-Za-z_@#$(.-])(w\s*)(\d+)(?:(\s*,\s*)(\d+))?|(\$E0\s*\$)([0-9A-F]{2})|(\$E1\s*\$[0-9A-F]{2}\s*\$)([0-9A-F]{2})/gi;
  const scale = (t: string): string => t.replace(re, (m, com, q, w, a, sep, b, e0, x0, e1, x1) => {
    if (com !== undefined) return m;
    if (q !== undefined) return q.includes('=') ? `"${q.slice(0, q.indexOf('=') + 1)}${scale(q.slice(q.indexOf('=') + 1))}"` : m;
    found = true;
    if (w !== undefined) return b !== undefined ? `${w}${a}${sep}${sc(b)}` : `${w}${sc(a)}`;
    if (e0 !== undefined) return e0 + sc(x0, true);
    return e1 + sc(x1, true);
  });
  const out = scale(text);
  if (found) return out;
  // no global volume: the driver's $C0, set at the start of channel 0
  const at = /;[^\n]*|#(?:samples|instruments|spc)\s*\{[^}]*\}|"[^"\n]*"|#0(?![\w])/gi;
  for (let m; (m = at.exec(out));) if (m[0] === '#0') return `${out.slice(0, at.lastIndex)} w${sc('192')} ${out.slice(at.lastIndex)}`;
  return out;
}

// ---------- settings of a song ----------

// A setting of a song: a "#define NAME value" of AddmusicK's preprocessor outside its #if…#endif
// blocks, as songs offer options (another key, an instrument on or off). How the song tests it gives
// the form: values compared with "#if NAME == v ; label" are choices (labelled by the comment, or by a
// "; v = text" line in the comments after the define), a define only tested with #ifdef/#ifndef is on
// or off. Read as the preprocessor does: directives anywhere outside quotes – comments go only after it,
// so "; #define X" defines X too – and the value up to the next space.
export interface SongDefine {
  name: string;
  value: string; // the song's own value ('' for a define without one)
  line: number;
  start: number; // "#define NAME value" in the line
  end: number;
  comment: string; // after it on its line
  doc: string; // the comment lines right above
  section: string; // the heading it is under (";=== Title ===" or a title between two such lines)
  choices: { value: string; label: string }[];
  flag: boolean;
}

const DIRECTIVE_RE = /#(define|undef|ifdef|ifndef|if|endif)(?=[ \t\r]|$)(?:[ \t]+([^ \t\r]+))?(?:[ \t]+([^ \t\r]+))?(?:[ \t]+([^ \t\r]+))?/g;
const SEP_RE = /^;\s*[=\-*#~]{3,}\s*(.*?)\s*[=\-*#~;]*\s*$/;
// quoted text (replacements, file names) blanked out, at the same length
const unquoted = (l: string) => l.replace(/"[^"]*"/g, (q) => '"' + '_'.repeat(q.length - 2) + '"');

export function songDefines(text: string): SongDefine[] {
  const lines = text.split(/\r?\n/);
  const dirs = lines.map((l) => [...unquoted(l).matchAll(DIRECTIVE_RE)]);
  // how each name is tested
  const tested = new Map<string, { ifdef: boolean; cmp: boolean; eq: Map<string, string> }>();
  const use = (n: string) => tested.get(n) ?? (tested.set(n, { ifdef: false, cmp: false, eq: new Map() }), tested.get(n)!);
  dirs.forEach((ds, i) => {
    for (const m of ds) {
      if (!m[2]) continue;
      if (m[1] === 'ifdef' || m[1] === 'ifndef') use(m[2]).ifdef = true;
      else if (m[1] === 'if') {
        const u = use(m[2]);
        u.cmp = true;
        const rest = lines[i].slice(m.index + m[0].length);
        if (m[3] === '==' && m[4] && !u.eq.has(m[4])) u.eq.set(m[4], rest.includes(';') ? rest.slice(rest.indexOf(';')).replace(/^;+/, '').trim() : '');
      }
    }
  });
  const out: SongDefine[] = [];
  let depth = 0, section = '', above: string[] = [], sepAt = -2;
  lines.forEach((l, i) => {
    let def: RegExpMatchArray | null = null;
    for (const m of dirs[i]) {
      if (m[1] === 'define' && depth === 0 && m[2] && !def) def = m;
      else if (m[1] === 'endif') depth = Math.max(0, depth - 1);
      else if (m[1].startsWith('if')) depth++;
    }
    if (!def) {
      const t = l.trim();
      const sep = SEP_RE.exec(t);
      if (dirs[i].length) above = [];
      else if (sep) {
        if (sep[1]) section = sep[1];
        else if (above.length && sepAt === i - above.length - 1) section = above.join(' ').trim();
        above = [];
        sepAt = i;
      } else if (t.startsWith(';')) above.push(t.replace(/^;+\s?/, ''));
      else above = [];
      return;
    }
    const doc = above.join('\n').trim();
    above = [];
    const name = def[2]!;
    if (out.some((d) => d.name === name)) return;
    // "#define NAME" alone (AddmusicK's 1), or with a value
    const value = def[3] ?? '';
    const end = def.index! + /^#define[ \t]+[^ \t\r]+(?:[ \t]+[^ \t\r]+)?/.exec(unquoted(l).slice(def.index))![0].length;
    // "; v = text" lines in the comments after it label the values (up to the next code or heading)
    const labels = new Map<string, string>();
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t && (!t.startsWith(';') || SEP_RE.exec(t)?.[1] || dirs[j].length)) break;
      const lm = /^;+\s*(-?\d+)\s*[=:)\-]\s*(.+)$/.exec(t);
      if (lm) labels.set(lm[1], lm[2].trim());
    }
    const u = tested.get(name);
    const choices = [...(u?.eq ?? new Map<string, string>())].map(([v, c]) => ({ value: v, label: labels.get(v) ?? c }));
    if (choices.length && !choices.some((c) => c.value === value)) choices.unshift({ value, label: labels.get(value) ?? '' });
    out.push({
      name, value, line: i, start: def.index!, end, comment: l.slice(end).trim().replace(/^;+\s*/, '').trim(), doc, section,
      choices: choices.length > 1 ? choices : [], flag: !!u?.ifdef && !u.cmp,
    });
  });
  return out;
}

// the song with its settings set to `values` (null: not defined – the "#define" taken out of its line);
// names it doesn't define are left out
export function songWithDefines(text: string, values: Record<string, string | null>): string {
  const lines = text.split(/(?<=\n)/);
  for (const d of songDefines(text)) {
    if (!(d.name in values)) continue;
    const v = values[d.name];
    const l = lines[d.line];
    lines[d.line] = l.slice(0, d.start) + (v === null ? '' : `#define ${d.name}${v === '' ? '' : ' ' + v}`) + l.slice(d.end);
  }
  return lines.join('');
}

// a setting's value AddmusicK takes: a whole number, or nothing for a define only tested with #ifdef
export const validDefine = (v: string) => /^-?\d+$/.test(v);

// the song file as AddmusicK gets it: its settings, then its volume
export function songText(p: MusicProject, s: MusicSong): string | null {
  const c = p.files.get(s.file);
  if (!c) return null;
  let t = strFromU8(c, true);
  if (s.defines && Object.keys(s.defines).length) t = songWithDefines(t, s.defines);
  if (s.volume && s.volume !== 100) t = songWithVolume(t, s.volume);
  return t;
}

export function amkFiles(p: MusicProject): Map<string, Uint8Array | string> {
  const files = new Map<string, Uint8Array | string>();
  for (const [f, c] of p.files) files.set('music/' + f, c);
  for (const s of p.songs) {
    if (!(s.volume && s.volume !== 100) && !(s.defines && Object.keys(s.defines).length)) continue;
    const t = songText(p, s);
    if (t !== null) files.set('music/' + s.file, strToU8(t, true));
  }
  files.set('Addmusic_list.txt', amkList(p));
  // sample groups the songs brought along (runAmk adds them to AddmusicK's own)
  const groups = [...p.files].filter(([f]) => f.endsWith('/' + SAMPLE_GROUPS)).map(([, c]) => strFromU8(c, true));
  if (groups.length) files.set(SAMPLE_GROUPS, strToU8(groups.join('\n'), true));
  return files;
}

export interface MusicResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  log: string; // AddmusicK's output
  entry?: PatchEntry;
  spcs?: Map<string, Uint8Array>;
}

// AddmusicK's errors without the noise around them
function amkErrors(r: AmkResult): string[] {
  return r.errors.filter((l) => !/^\s*$/.test(l));
}

// Inserts the project with AddmusicK, replacing an earlier run; on failure the ROM is left as it was.
// An empty project removes AddmusicK again.
export async function saveMusicProject(rom: Rom, p: MusicProject): Promise<MusicResult> {
  const amkBefore = hasAmk(rom);
  const table = rom.data.slice(snesToPc(HEADER_MUSIC_TABLE), snesToPc(HEADER_MUSIC_TABLE) + 8);
  const r = await insertProject(rom, p);
  if (r.ok && hasAmk(rom) !== amkBefore) remapLevelMusic(rom, table);
  return r;
}

// AddmusicK installed or removed: song numbers mean other songs now. The 8 header settings play the
// same songs before and after (AddmusicK rewrites their table), so levels set to one of those songs get
// its new number; levels set to any other song (a custom one gone) get their header music back.
function remapLevelMusic(rom: Rom, before: Uint8Array): void {
  const after = rom.data.subarray(snesToPc(HEADER_MUSIC_TABLE), snesToPc(HEADER_MUSIC_TABLE) + 8);
  for (let l = 0; l < 0x200; l++) {
    const s = levelMusic(rom, l);
    if (!s) continue;
    const i = before.indexOf(s);
    setLevelMusic(rom, l, i >= 0 ? after[i] : 0);
  }
}

async function insertProject(rom: Rom, p: MusicProject): Promise<MusicResult> {
  const e = musicEntry(rom);
  const snapshot = rom.snapshot();
  const warnings: string[] = [];
  const fail = (errors: string[], log = ''): MusicResult => { rom.restore(snapshot); return { ok: false, errors, warnings, log }; };
  try {
    if (e) warnings.push(...uninstallPatch(rom, e.id));
  } catch (err) {
    return fail([String((err as Error).message ?? err)]);
  }
  if (!p.songs.length) return { ok: true, errors: [], warnings, log: '' };
  if (hasAmk(rom)) return fail(['AddmusicK is already in this ROM, but not through the editor – it cannot be inserted again here.']);
  const before = rom.data;
  const beforeRats = rom.scanRats();
  // AddmusicK wants more than 512 KB and free space for samples; grow the ROM when it runs out
  let size = Math.max(before.length, 0x100000);
  let r: AmkResult;
  let input: Uint8Array;
  let saved: Uint8Array | null;
  for (;;) {
    input = new Uint8Array(size);
    input.set(before);
    if (size > before.length) { let n = 0; while ((1 << n) * 1024 < size) n++; input[0x7fd7] = n; }
    saved = reserveTop(input);
    r = await runAmk(input, amkFiles(p));
    const full = !r.ok && r.errors.some((l) => /free space|out of space|insufficient space|could not find.*space/i.test(l));
    if (!full || size >= MAX_ROM_SIZE) break;
    size = Math.min(MAX_ROM_SIZE, size * 2);
  }
  if (!r.ok || !r.rom) return fail(amkErrors(r).length ? amkErrors(r) : ['AddmusicK failed.'], r.log);
  const out = r.rom;
  // the reserved banks: AddmusicK must have left them (and our temporary tags there) alone
  const top = saved ? RESERVED_TOP : out.length;
  for (let i = top; i < out.length; i++) {
    if (out[i] !== input[i]) return fail([`AddmusicK wrote at ${'$' + pcToSnes(i).toString(16).toUpperCase()} to banks $7E/$7F, which are reserved for the editor.`], r.log);
  }
  if (saved) out.set(saved, RESERVED_TOP);
  // what AddmusicK wrote: every changed byte, runs closer than 16 bytes joined
  const written: [number, number][] = [];
  for (let i = 0; i < top; i++) {
    if (i < input.length && out[i] === input[i]) continue;
    const last = written[written.length - 1];
    if (last && i - (last[0] + last[1]) < 16) last[1] = i + 1 - last[0];
    else written.push([i, 1]);
  }
  const archive = projectToZip(p);
  const reg = registerChanges(rom, input, beforeRats, out, written, {
    name: 'AddmusicK (music)', version: '1.0.11', hash: hashBytes([archive]).toString(16).padStart(8, '0'),
    settings: {}, kind: 'music', archive, ram: [AMK_FREERAM],
  });
  if (!reg.entry) return fail(reg.errors, r.log);
  warnings.push(...reg.warnings);
  return { ok: true, errors: [], warnings, log: r.log, entry: reg.entry, spcs: r.spcs };
}

// SPC files of songs without a ROM (AddmusicK's -norom), e.g. to listen before inserting
export async function songSpcs(p: MusicProject, files: string[]): Promise<{ spcs: Map<string, Uint8Array>; errors: string[]; log: string }> {
  const r = await runAmk(null, amkFiles(p), ['-norom', ...files]);
  return { spcs: r.spcs, errors: r.ok ? [] : amkErrors(r), log: r.log };
}

// the SPC of song file `file` among AddmusicK's outputs (named after the .txt)
export function spcOf(spcs: Map<string, Uint8Array>, file: string): Uint8Array | null {
  const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.txt$/i, '').toLowerCase();
  for (const [n, d] of spcs) if (n.replace(/\.spc$/i, '').toLowerCase() === base) return d;
  return null;
}

// ---------- songs of a ROM ----------

// The songs a level can play in this ROM. With AddmusicK: its globals, originals and the custom songs;
// without: the songs the 8 header settings play ($0584DB, the level music bank of the original engine).
export function romSongs(rom: Rom, p: MusicProject | null = null): SongInfo[] {
  if (hasAmk(rom)) {
    const custom = new Map((p?.songs ?? []).map((s) => [s.num, s]));
    const out: SongInfo[] = [];
    for (const [n, f, g] of AMK_ORIGINALS) {
      const c = custom.get(n);
      out.push(c ? { num: n, name: c.name, kind: 'custom', file: c.file } : { num: n, name: originalName(f), kind: g ? 'global' : 'original' });
    }
    for (const s of p?.songs ?? []) if (!AMK_ORIGINALS.some((o) => o[0] === s.num)) out.push({ num: s.num, name: s.name, kind: 'custom', file: s.file });
    return out.sort((a, b) => a.num - b.num);
  }
  const seen = new Map<number, string[]>();
  for (let i = 0; i < 8; i++) {
    const n = rom.r8(HEADER_MUSIC_TABLE + i);
    seen.set(n, [...(seen.get(n) ?? []), MUSIC[i]]);
  }
  return [...seen].sort((a, b) => a[0] - b[0]).map(([num, names]) => ({ num, name: names.join(' / '), kind: 'vanilla' }));
}

export const songHex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
