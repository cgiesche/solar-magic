// Music: the "Music" tab of the patches dialog and the dialog adding songs. Songs are AddmusicK songs
// (MML .txt with BRR samples, e.g. from SMWCentral); adding or removing one inserts the whole project
// with AddmusicK at once (music.ts). Every song can be listened to – songs of the ROM in the current
// level as the emulated game plays them, a song about to be added as AddmusicK's SPC of it – and set as
// the music of the current level (music per level, like Lunar Magic's music bypass).

import type { App } from './app.ts';
import { h, clear, modal, toast, choose, pickFile, select, downloadBytes } from './dom.ts';
import { hex } from '../core/names.ts';
import {
  loadMusicProject, saveMusicProject, emptyMusicProject, songsFromFiles, addSongs, removeSong, romSongs, songSpcs, spcOf,
  folders, hasAmk, musicEntry, originalName, nextFreeSong, songHex, FIRST_CUSTOM, LAST_SONG, projectToZip,
  songDefines, validDefine, type MusicProject, type MusicSong, type SongFiles, type SongInfo,
} from '../core/music.ts';
import { levelMusic, setLevelMusic, musicPatch, HEADER_MUSIC_TABLE } from '../core/patches.ts';
import { AMK_ORIGINALS } from '../vendor/amk/originals.ts';
import { musicPlayer } from './musicplayer.ts';
import { romChanged, errorText, type Pane } from './projectpane.ts';
import { packageFiles } from '../core/patchpkg.ts';
import { strFromU8, strToU8 } from 'fflate';

// levels set to each song (music per level)
export function levelsBySong(app: App): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (!musicPatch(app.rom)) return out;
  for (let l = 0; l < 0x200; l++) {
    const s = levelMusic(app.rom, l);
    if (s) out.set(s, [...(out.get(s) ?? []), l]);
  }
  return out;
}

// the song a level plays: its own setting, else the header's
export function levelSong(app: App, level: number, headerMusic: number): { num: number; own: boolean } {
  const own = levelMusic(app.rom, level);
  return own ? { num: own, own: true } : { num: app.rom.r8(HEADER_MUSIC_TABLE + headerMusic), own: false };
}

export function songLabel(s: SongInfo): string {
  return `${songHex(s.num)} – ${s.name}`;
}

// the songs of the ROM (with the stored project's names), loading errors swallowed
export function currentSongs(app: App): SongInfo[] {
  let p: MusicProject | null = null;
  try { p = loadMusicProject(app.rom); } catch { /* names of custom songs missing */ }
  return romSongs(app.rom, p);
}

const PLAY_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z" fill="currentColor"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor"/></svg>';

// a play/stop toggle for `label`
export function playButton(label: string, play: () => void, title = 'Listen'): HTMLButtonElement {
  const b = h('button', { class: 'icon-btn play-btn', title }) as HTMLButtonElement;
  const sync = () => {
    const on = musicPlayer.label === label;
    b.innerHTML = on ? STOP_ICON : PLAY_ICON;
    b.classList.toggle('active', on);
    b.title = on ? 'Stop' : title;
  };
  b.onclick = () => { if (musicPlayer.label === label) musicPlayer.stop(); else play(); };
  const off = musicPlayer.onChange(() => { if (!b.isConnected) { off(); return; } sync(); });
  sync();
  return b;
}

// plays song `num` in the current level
export function playSong(app: App, s: SongInfo): void {
  void musicPlayer.playLevel(app, app.level.number, `song:${s.num}`, s.num).then(() => {
    if (musicPlayer.error) toast(`Could not play: ${musicPlayer.error}`, 'error');
  });
}

// runs AddmusicK on the project, with a note while it works; true when inserted
export async function insertMusic(app: App, p: MusicProject, what: string): Promise<boolean> {
  if (app.dirty) app.saveLevel(true);
  musicPlayer.stop();
  const wait = modal('Music', h('p', null, `${what} – AddmusicK is inserting the music …`), []);
  let r;
  try { r = await saveMusicProject(app.rom, p); } catch (e) { r = { ok: false, errors: [errorText(e)], warnings: [], log: '' }; }
  wait.close(true);
  if (!r.ok) {
    modal('Music – AddmusicK failed', h('div', { class: 'patch-log' },
      r.errors.map((e) => h('div', { class: 'err' }, e)),
      r.log ? h('details', null, h('summary', null, 'AddmusicK output'), h('pre', { class: 'amk-log' }, r.log)) : ''), [{ label: 'OK', primary: true }]);
    return false;
  }
  romChanged(app);
  toast(`${what}${r.warnings.length ? ` – ${r.warnings.join(' ')}` : ''}`);
  return true;
}

// The dialog adding the songs of a download: what was found, missing samples, the song number, listening
// before adding (AddmusicK's SPC of the song), then inserting. done: after it was inserted.
export function openAddSongDialog(app: App, fileName: string, files: Map<string, Uint8Array>, done: () => void): void {
  let proj: MusicProject;
  try { proj = loadMusicProject(app.rom) ?? emptyMusicProject(); } catch (e) { toast(errorText(e), 'error'); return; }
  let sf: SongFiles;
  try { sf = songsFromFiles(fileName, files, folders(proj)); } catch (e) { toast(errorText(e), 'error'); return; }
  // numbers: the next free ones, or one of AddmusicK's originals to replace
  let num = nextFreeSong(proj);
  if (num < 0) { toast('All song numbers up to FF are used.', 'error'); return; }
  const free: [number, string][] = [];
  for (let n = FIRST_CUSTOM; n <= LAST_SONG; n++) if (!proj.songs.some((s) => s.num === n)) { free.push([n, `${songHex(n)} – new`]); if (free.length >= 8) break; }
  // AddmusicK's originals (by AddmusicK's names, also before it is installed), unless a custom song replaced one
  const replace: [number, string][] = AMK_ORIGINALS.filter((o) => !o[2] && !proj.songs.some((x) => x.num === o[0]))
    .map(([n, f]) => [n, `${songHex(n)} – instead of “${originalName(f)}”`]);
  const customs: [number, string][] = proj.songs.map((s) => [s.num, `${songHex(s.num)} – instead of “${s.name}” (custom)`]);
  const numSel = select([...free, ...replace, ...customs], num, (v) => { num = v; });
  const setLevel = h('input', { type: 'checkbox', checked: true });
  const preview = new Map<string, Uint8Array>();
  const status = h('div', { class: 'hint' });
  const listen = (file: string) => {
    const label = `spc:${file}`;
    const go = (spc: Uint8Array) => void musicPlayer.playSpc(spc, label);
    const have = preview.get(file);
    if (have) { go(have); return; }
    status.textContent = 'AddmusicK is compiling the song …';
    const p: MusicProject = { songs: [], files: new Map(sf.files) };
    void songSpcs(p, [file]).then((r) => {
      const spc = spcOf(r.spcs, file);
      status.textContent = spc ? '' : `AddmusicK could not compile the song: ${r.errors.join(' ') || 'no SPC'}`;
      if (spc) { preview.set(file, spc); go(spc); }
    }, (e) => { status.textContent = errorText(e); });
  };
  const body = h('div', { class: 'song-add' },
    h('p', null, sf.songs.length === 1 ? 'Song found:' : `${sf.songs.length} songs found:`),
    h('table', { class: 'uber-table' }, sf.songs.map((s) => h('tr', null,
      h('td', null, playButton(`spc:${s.file}`, () => listen(s.file), 'Listen (compiled by AddmusicK)')),
      h('td', null, h('b', null, s.name)), h('td', { class: 'mono hint' }, s.file)))),
    sf.missing.length ? h('div', { class: 'warn-box' }, `⚠ Samples not in the download: ${sf.missing.join(', ')}. AddmusicK will stop with an error unless they are found elsewhere.`) : '',
    h('div', { class: 'grid2' },
      h('div', { class: 'prop' }, h('label', null, sf.songs.length === 1 ? 'Song number' : 'Number of the first song'), numSel,
        h('span', { class: 'hint' }, sf.songs.length > 1 ? 'The others get the next free numbers.' : 'A new number, or in place of a song.')),
      h('label', { class: 'row' }, setLevel, ` Play in level ${hex(app.level.number, 3)} (instead of its header music)`)),
    status,
    h('p', { class: 'hint' }, hasAmk(app.rom) ? 'All songs are inserted again with AddmusicK.'
      : 'This installs AddmusicK in the ROM: its sound driver, its versions of the original songs and sound effects, and the song. It can be removed again completely (Music tab).'),
  );
  modal(`Add music – ${fileName}`, body, [
    { label: 'Cancel', onClick: () => { if (musicPlayer.label?.startsWith('spc:')) musicPlayer.stop(); } },
    {
      label: 'Insert', primary: true, onClick: () => {
        const added = addSongs(proj, sf, num);
        if (musicPlayer.label?.startsWith('spc:')) musicPlayer.stop();
        const level = app.level.number;
        void insertMusic(app, proj, `${added.map((s) => `Song ${songHex(s.num)} “${s.name}”`).join(', ')} inserted`).then((ok) => {
          if (!ok) return;
          if (setLevel.checked) {
            try { setLevelMusic(app.rom, level, added[0].num); romChanged(app); } catch (e) { toast(errorText(e), 'error'); }
          }
          done();
        });
      },
    },
  ]);
}

// The settings of a custom song: its #defines (music.ts, songDefines) as a form – choices, on/off or a
// number – kept with the song in the project and set when AddmusicK inserts it, so its file stays as it
// came; listening compiles the song with the values in the form. save: the song with new settings.
export function openSongSettings(proj: MusicProject, song: MusicSong, save: (s: MusicSong) => void, editText: () => void): void {
  const text = strFromU8(proj.files.get(song.file)!, true);
  const defs = songDefines(text);
  const own = song.defines ?? {};
  const fields = defs.map((d, i) => {
    const cur = d.name in own ? own[d.name] : d.value;
    let input: HTMLInputElement | HTMLSelectElement;
    let read: () => string | null;
    if (d.flag) {
      const cb = h('input', { type: 'checkbox', checked: cur !== null });
      input = cb;
      read = () => (cb.checked ? d.value : null);
    } else if (d.choices.length) {
      const sel = h('select', null, d.choices.map((c) => h('option', { value: c.value, selected: c.value === cur }, c.label ? `${c.value} – ${c.label}` : c.value)));
      input = sel;
      read = () => sel.value;
    } else {
      const inp = h('input', { value: cur ?? '', spellcheck: false, style: 'width: 8em' });
      input = inp;
      read = () => inp.value.trim();
    }
    const doc = d.doc && d.doc !== defs[i - 1]?.doc ? h('div', { class: 'hint define-doc' }, d.doc) : null;
    const row = h('div', { class: 'define-row' }, doc,
      h('div', { class: 'prop' }, h('label', { title: d.comment || d.doc }, d.name), input, d.comment ? h('span', { class: 'hint' }, d.comment) : null));
    return { d, input, read, row };
  });
  const sections = [...new Set(defs.map((d) => d.section))];
  const rows: HTMLElement[] = [];
  for (const [i, f] of fields.entries()) {
    if ((sections.length > 1 || sections[0]) && f.d.section && f.d.section !== fields[i - 1]?.d.section) rows.push(h('h4', { class: 'define-section' }, f.d.section));
    rows.push(f.row);
  }
  const status = h('div', { class: 'hint' });
  // the values differing from the song's own; null when one is no whole number
  const values = (): Record<string, string | null> | null => {
    const out: Record<string, string | null> = {};
    for (const f of fields) {
      const v = f.read();
      if (v !== null && v !== f.d.value && !validDefine(v)) { status.textContent = `${f.d.name}: “${v}” is no whole number.`; f.input.focus(); return null; }
      if (v !== f.d.value) out[f.d.name] = v;
    }
    status.textContent = '';
    return out;
  };
  const label = `spc:settings:${song.file}`;
  const listen = () => {
    const v = values();
    if (!v) return;
    status.textContent = 'AddmusicK is compiling the song …';
    const p: MusicProject = { songs: [{ ...song, defines: v }], files: proj.files };
    void songSpcs(p, [song.file]).then((r) => {
      const spc = spcOf(r.spcs, song.file);
      status.textContent = spc ? '' : `AddmusicK could not compile the song: ${r.errors.join(' ') || 'no SPC'}`;
      if (spc) void musicPlayer.playSpc(spc, label);
    }, (e) => { status.textContent = errorText(e); });
  };
  const reset = () => {
    for (const f of fields) {
      if (f.input instanceof HTMLInputElement && f.input.type === 'checkbox') f.input.checked = true;
      else f.input.value = f.d.value;
    }
  };
  const stop = () => { if (musicPlayer.label === label) musicPlayer.stop(); };
  const dlg = modal(`Song settings: ${song.name}`, h('div', { class: 'patch-settings define-dialog' },
    h('div', { class: 'row' },
      playButton(label, listen, 'Listen with these settings (compiled by AddmusicK)'),
      h('span', { class: 'hint grow' }, 'Options the song offers (its #defines). They are kept with the song and take effect when AddmusicK inserts it; the file stays as it came.'),
      h('button', { title: 'The song’s own values', onclick: reset }, 'Reset'),
      h('button', { title: 'The whole song file as text – for anything that is not one of its #defines', onclick: () => { dlg.close(); editText(); } }, 'Edit as text …')),
    rows, status), [
    { label: 'Cancel' },
    { label: 'OK', primary: true, onClick: () => {
      const v = values();
      if (!v) return false;
      const before = JSON.stringify(song.defines ?? {});
      if (JSON.stringify(v) === before) return;
      const next: MusicSong = { ...song, defines: v };
      if (!Object.keys(v).length) delete next.defines;
      save(next);
    } },
  ], stop);
}

// A song file as text, for anything its settings don't cover; save: the new text (settings it no longer
// defines are dropped by the caller).
export function openSongText(proj: MusicProject, song: MusicSong, save: (text: string) => void): void {
  const text = strFromU8(proj.files.get(song.file)!, true);
  const area = h('textarea', { class: 'text-edit mono', spellcheck: false, value: text, onkeydown: (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end');
  } });
  modal(`Edit: ${song.file}`, h('div', { class: 'text-edit-box' },
    h('p', { class: 'hint' }, 'AddmusicK inserts the music again with “OK”; if it reports an error, nothing changes. “Export songs” keeps a copy of the songs as they are now.'),
    song.defines ? h('p', { class: 'hint' }, `Set on top of the file by the song’s settings: ${Object.entries(song.defines).map(([n, v]) => (v === null ? `${n} off` : `${n} = ${v || 'on'}`)).join(', ')}.`) : '',
    area), [
    { label: 'Cancel' },
    { label: 'OK', primary: true, onClick: () => { if (area.value !== text) save(area.value); } },
  ]);
}

// the files of a .zip, or a single .txt song
async function pickSong(): Promise<{ name: string; files: Map<string, Uint8Array> } | null> {
  const f = await pickFile('.zip,.txt');
  if (!f) return null;
  const data = new Uint8Array(await f.arrayBuffer());
  return { name: f.name, files: /\.zip$/i.test(f.name) ? packageFiles(f.name, data) : new Map([[f.name, data]]) };
}

// The Music tab: AddmusicK's state, all songs (listen, set for the level, remove), adding songs.
// Changes go into the ROM at once (inserting takes AddmusicK about a second), so nothing is staged.
export function musicPane(app: App, changed: () => void): Pane {
  const el = h('div', { class: 'music-pane' });
  let proj: MusicProject = emptyMusicProject();
  let loadError = '';

  const reload = () => {
    loadError = '';
    try { proj = loadMusicProject(app.rom) ?? emptyMusicProject(); } catch (e) { loadError = errorText(e); proj = emptyMusicProject(); }
    render();
  };

  const add = async () => {
    const picked = await pickSong();
    if (picked) openAddSongDialog(app, picked.name, picked.files, () => { reload(); changed(); });
  };

  const remove = async (num: number) => {
    const s = proj.songs.find((x) => x.num === num);
    if (!s) return;
    const users = levelsBySong(app).get(num) ?? [];
    const i = await choose('Remove song', `Remove song ${songHex(num)} “${s.name}”${users.length ? ` (played in level ${users.map((l) => hex(l, 3)).join(', ')} – they get their header music back)` : ''}?`,
      [{ label: 'Cancel' }, { label: 'Remove', danger: true }]);
    if (i !== 1) return;
    const p: MusicProject = { songs: [...proj.songs], files: new Map(proj.files) };
    removeSong(p, num);
    const original = AMK_ORIGINALS.some((o) => o[0] === num);
    if (await insertMusic(app, p, p.songs.length ? `Song ${songHex(num)} removed` : 'Music removed – AddmusicK is no longer in the ROM')) {
      if (!original && hasAmk(app.rom)) for (const l of users) setLevelMusic(app.rom, l, 0);
      if (users.length && !original) romChanged(app);
      reload();
      changed();
    }
  };

  const removeAll = async () => {
    const i = await choose('Remove AddmusicK', 'Remove AddmusicK with all custom songs from the ROM? The original sound driver and music come back; levels set to custom songs get their header music back. Export the songs as .zip first if you still need them.',
      [{ label: 'Cancel' }, { label: 'Remove', danger: true }]);
    if (i !== 1) return;
    // levels get the same songs of the original driver (or their header music for custom ones), see music.ts
    if (await insertMusic(app, emptyMusicProject(), 'Music removed – AddmusicK is no longer in the ROM')) {
      reload();
      changed();
    }
  };

  // loudness of a custom song (its global volume scaled when AddmusicK inserts it)
  const VOLUMES = [25, 35, 50, 70, 85, 100, 120, 140, 170, 200, 250, 300];
  const setVolume = async (num: number, volume: number) => {
    const p: MusicProject = { songs: proj.songs.map((x) => (x.num === num ? { ...x, volume } : x)), files: proj.files };
    if (await insertMusic(app, p, `Song ${songHex(num)} at ${volume}% volume`)) changed();
    reload();
  };

  // a song with new settings, or its file as new text: inserted again
  const saveSong = async (next: MusicSong, what: string, files = proj.files) => {
    const p: MusicProject = { songs: proj.songs.map((x) => (x.num === next.num ? next : x)), files };
    if (await insertMusic(app, p, what)) changed();
    reload();
  };
  const settings = (s: MusicSong) => openSongSettings(proj, s, (next) => void saveSong(next, `Song ${songHex(s.num)}: settings changed`), () => editText(s));
  const editText = (s: MusicSong) => openSongText(proj, s, (text) => {
    const files = new Map(proj.files);
    files.set(s.file, strToU8(text, true));
    const next: MusicSong = { ...s };
    if (s.defines) {
      const names = new Set(songDefines(text).map((d) => d.name));
      next.defines = Object.fromEntries(Object.entries(s.defines).filter(([n]) => names.has(n)));
      if (!Object.keys(next.defines).length) delete next.defines;
    }
    void saveSong(next, `Song ${songHex(s.num)}: file changed`, files);
  });
  const hasSettings = (s: MusicSong) => { const c = proj.files.get(s.file); return !!c && songDefines(strFromU8(c, true)).length > 0; };

  const setForLevel = (num: number) => {
    try {
      setLevelMusic(app.rom, app.level.number, levelMusic(app.rom, app.level.number) === num ? 0 : num);
      romChanged(app);
    } catch (e) { toast(errorText(e), 'error'); return; }
    render();
  };

  function volumeSelect(num: number): HTMLSelectElement {
    const v = proj.songs.find((x) => x.num === num)?.volume ?? 100;
    const sel = select([...new Set([...VOLUMES, v])].sort((a, b) => a - b).map((x) => [x, `${x}%`]), v, (x) => void setVolume(num, x));
    sel.title = 'Loudness of the song (its global volume, scaled when AddmusicK inserts it; songs already near the maximum get only a little louder)';
    return sel;
  }

  function render(): void {
    const songs = romSongs(app.rom, proj);
    const users = levelsBySong(app);
    const lv = app.level.number;
    const cur = levelSong(app, lv, app.level.header.music);
    const amk = hasAmk(app.rom), entry = musicEntry(app.rom);
    const kindText = (s: SongInfo) => (s.kind === 'global' ? 'jingle (global)' : s.kind === 'original' ? 'original (AddmusicK)' : s.kind === 'custom' ? 'custom' : 'original');
    clear(el).append(
      h('div', { class: 'row pkg-head' },
        h('div', { class: 'grow' },
          h('div', { class: 'pkg-title' }, amk ? `AddmusicK – ${proj.songs.length} custom song${proj.songs.length === 1 ? '' : 's'}` : 'Original sound driver'),
          h('div', { class: 'hint' }, amk && entry ? `inserted ${new Date(entry.applied).toLocaleString()}`
            : amk ? 'AddmusicK was inserted by another tool – songs cannot be added here.'
              : 'Adding a song (AddmusicK format, e.g. from SMWCentral) installs AddmusicK.')),
        h('button', { class: 'primary', disabled: amk && !entry, onclick: () => void add() }, 'Add song …'),
        entry ? h('button', { onclick: () => downloadBytes('music.zip', projectToZip(proj), 'application/zip'), title: 'The custom songs with their samples' }, 'Export songs') : '',
        entry ? h('button', { class: 'danger', onclick: () => void removeAll() }, 'Remove AddmusicK …') : ''),
      loadError ? h('div', { class: 'warn-box' }, loadError) : '',
      h('p', { class: 'hint' }, `Level ${hex(lv, 3)} plays song ${songHex(cur.num)}${cur.own ? ' (set for the level)' : ` (header music ${app.level.header.music})`}. `
        + '▶ plays a song in this level as the game does; “Level” makes it the music of the level (instead of its header music).'),
      h('table', { class: 'uber-table music-table' },
        h('tr', null, h('th'), h('th', null, 'No.'), h('th', null, 'Song'), h('th', null, 'Type'), h('th', null, 'Volume'), h('th', null, 'Set for levels'), h('th')),
        songs.map((s) => {
          const ls = users.get(s.num) ?? [];
          const ps = s.kind === 'custom' && entry ? proj.songs.find((x) => x.num === s.num) : undefined;
          const mine = cur.own && cur.num === s.num;
          return h('tr', { class: mine ? 'current' : '' },
            h('td', null, playButton(`song:${s.num}`, () => playSong(app, s))),
            h('td', { class: 'mono' }, songHex(s.num)),
            h('td', null, s.name, s.file ? h('div', { class: 'hint mono' }, s.file) : ''),
            h('td', { class: 'hint' }, kindText(s)),
            h('td', null, s.kind === 'custom' && entry ? volumeSelect(s.num) : ''),
            h('td', { class: 'mono hint' }, ls.length > 6 ? `${ls.slice(0, 6).map((l) => hex(l, 3)).join(' ')} … (${ls.length})` : ls.map((l) => hex(l, 3)).join(' ')),
            h('td', { class: 'actions' },
              h('button', { class: mine ? 'active' : '', title: mine ? `Level ${hex(lv, 3)}: back to its header music` : `Make this the music of level ${hex(lv, 3)}`, onclick: () => setForLevel(s.num) }, 'Level'),
              ps && hasSettings(ps) ? h('button', { class: ps.defines ? 'active' : '', title: `Options the song offers (its #defines)${ps.defines ? ' – changed' : ''}`, onclick: () => settings(ps) }, 'Settings …') : '',
              ps ? h('button', { title: 'Edit the song file as text', onclick: () => editText(ps) }, 'Edit …') : '',
              ps ? h('button', { class: 'icon-btn', title: 'Remove the song', onclick: () => void remove(s.num) }, '✕') : ''));
        })),
    );
  }

  reload();
  return {
    title: 'Music',
    el,
    dirty: () => false,
    apply: () => true,
    discard: () => undefined,
    reload,
    render,
    project: () => ({ files: proj.files }),
    touch: () => render(),
  };
}
