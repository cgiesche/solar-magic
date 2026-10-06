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
  type MusicProject, type SongFiles, type SongInfo,
} from '../core/music.ts';
import { levelMusic, setLevelMusic, musicPatch, HEADER_MUSIC_TABLE } from '../core/patches.ts';
import { AMK_ORIGINALS } from '../vendor/amk/originals.ts';
import { musicPlayer } from './musicplayer.ts';
import { romChanged, errorText, type Pane } from './projectpane.ts';
import { packageFiles } from '../core/patchpkg.ts';

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

// a play/stop toggle for `label`
export function playButton(label: string, play: () => void, title = 'Listen'): HTMLButtonElement {
  const b = h('button', { class: 'icon-btn play-btn', title }) as HTMLButtonElement;
  const sync = () => { b.textContent = musicPlayer.label === label ? '■' : '▶'; b.classList.toggle('active', musicPlayer.label === label); };
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
      if (!original) for (const l of users) setLevelMusic(app.rom, l, 0);
      if (users.length && !original) romChanged(app);
      reload();
      changed();
    }
  };

  const removeAll = async () => {
    const i = await choose('Remove AddmusicK', 'Remove AddmusicK with all custom songs from the ROM? The original sound driver and music come back; levels set to custom songs get their header music back. Export the songs as .zip first if you still need them.',
      [{ label: 'Cancel' }, { label: 'Remove', danger: true }]);
    if (i !== 1) return;
    const users = levelsBySong(app);
    if (await insertMusic(app, emptyMusicProject(), 'Music removed – AddmusicK is no longer in the ROM')) {
      for (const [song, ls] of users) if (song >= FIRST_CUSTOM || !hasAmk(app.rom)) for (const l of ls) setLevelMusic(app.rom, l, 0);
      romChanged(app);
      reload();
      changed();
    }
  };

  const setForLevel = (num: number) => {
    try {
      setLevelMusic(app.rom, app.level.number, levelMusic(app.rom, app.level.number) === num ? 0 : num);
      romChanged(app);
    } catch (e) { toast(errorText(e), 'error'); return; }
    render();
  };

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
        h('tr', null, h('th'), h('th', null, 'No.'), h('th', null, 'Song'), h('th', null, 'Type'), h('th', null, 'Set for levels'), h('th')),
        songs.map((s) => {
          const ls = users.get(s.num) ?? [];
          const mine = cur.own && cur.num === s.num;
          return h('tr', { class: mine ? 'current' : '' },
            h('td', null, playButton(`song:${s.num}`, () => playSong(app, s))),
            h('td', { class: 'mono' }, songHex(s.num)),
            h('td', null, s.name, s.file ? h('div', { class: 'hint mono' }, s.file) : ''),
            h('td', { class: 'hint' }, kindText(s)),
            h('td', { class: 'mono hint' }, ls.length > 6 ? `${ls.slice(0, 6).map((l) => hex(l, 3)).join(' ')} … (${ls.length})` : ls.map((l) => hex(l, 3)).join(' ')),
            h('td', { class: 'actions' },
              h('button', { class: mine ? 'active' : '', title: mine ? `Level ${hex(lv, 3)}: back to its header music` : `Make this the music of level ${hex(lv, 3)}`, onclick: () => setForLevel(s.num) }, 'Level'),
              s.kind === 'custom' && entry ? h('button', { class: 'icon-btn', title: 'Remove the song', onclick: () => void remove(s.num) }, '✕') : ''));
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
