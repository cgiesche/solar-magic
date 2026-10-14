// Level header / secondary header editor.

import type { App } from './app.ts';
import { h, select, hexInput, modal, toast } from './dom.ts';
import { TILESETS, levelModeName, MUSIC, TIME_SETTINGS, VERTICAL_SCROLL, ENTRANCE_ACTIONS, layer2RateName, hex2, hex } from '../core/names.ts';
import { hasLayer2Objects, type PrimaryHeader, type SecondaryHeader, L2_PTRS } from '../core/level.ts';
import { bgBank, levelMusic, setLevelMusic, HEADER_MUSIC_TABLE } from '../core/patches.ts';
import { songHex } from '../core/music.ts';
import { currentSongs, playButton } from './musicdialog.ts';
import { musicPlayer } from './musicplayer.ts';
import { LAYER3_KIND_TEXT } from '../core/layer3.ts';
import { RATE_OPTIONS, hRate, withRates, motionText, type Layer2Motions } from '../core/l2scroll.ts';
import { incompleteSprites, spriteMemText, SPRITE_MEM_HELP } from './spritemem.ts';

function range(n: number, fmt: (i: number) => string = (i) => String(i)): [number, string][] {
  return Array.from({ length: n }, (_, i) => [i, fmt(i)]);
}

export function openHeaderDialog(app: App): void {
  const lv = app.level;
  const hd: PrimaryHeader = { ...lv.header };
  const sd: SecondaryHeader = { ...lv.secondary };
  let spriteHeader = lv.spriteHeader;
  let l2ptr = lv.layer2Pointer;

  const f = (label: string, el: HTMLElement, hint?: string) => h('div', { class: 'prop' }, h('label', null, label), el, hint ? h('span', { class: 'hint' }, hint) : null);
  const sel = <K extends keyof PrimaryHeader>(k: K, opts: [number, string][]) => select(opts, hd[k] as number, (v) => { (hd[k] as number) = v; });
  const sel2 = <K extends keyof SecondaryHeader>(k: K, opts: [number, string][]) => select(opts, sd[k] as number, (v) => { (sd[k] as number) = v; });

  // sprite memory with the result of the background check (for the level's current value)
  const memInput = hexInput(spriteHeader & 0x3f, 2, (v) => (spriteHeader = (spriteHeader & 0xc0) | v), 0x3f);
  const incomplete = incompleteSprites(app).length, sm = app.spriteMem;
  const checked = sm && sm.level === lv.number && sm.mem === (lv.spriteHeader & 0x3f);
  const memStatus = !checked ? h('p', { class: 'hint' }, 'Checking sprite memory …')
    : !incomplete ? h('p', { class: 'hint' }, '✓ All sprites are shown completely.')
    : h('div', { class: 'warn-box', title: SPRITE_MEM_HELP }, `⚠ ${spriteMemText(incomplete)}: not enough sprite memory. `,
      sm.suggestion !== null
        ? h('button', { onclick: () => { memInput.value = hex2(sm.suggestion!); memInput.dispatchEvent(new Event('change')); } }, `Set to fit (${hex2(sm.suggestion)})`)
        : 'No other value shows all of them completely – place the sprites further apart.');

  const modes: [number, string][] = range(0x20, (i) => `${hex2(i)} – ${levelModeName(i)}`);
  // BG tilemaps in the vanilla bank ($0C) used by levels; edited ones (own bank) only count for their level
  const bgs = new Map<number, number[]>();
  for (let i = 0; i < 512; i++) {
    const p = app.rom.r24(L2_PTRS + i * 3);
    if (p >> 16 !== 0xff || bgBank(app.rom, i)) continue;
    if (!bgs.has(p)) bgs.set(p, []);
    bgs.get(p)!.push(i);
  }
  const bgOpts: [number, string][] = [...bgs.entries()].map(([p, ls]) => [p, `$${hex(p & 0xffff, 4)} (e.g. level ${ls.slice(0, 3).map((l) => hex(l, 3)).join(', ')})`]);
  const CUSTOM_BG = -1;
  if (lv.bg || bgBank(app.rom, lv.number)) { l2ptr = CUSTOM_BG; bgOpts.unshift([CUSTOM_BG, 'Custom (edited in BG mode)']); }
  else if (!bgs.has(l2ptr) && l2ptr >> 16 === 0xff) bgOpts.push([l2ptr, `$${hex(l2ptr & 0xffff, 4)}`]);

  // layer 3: what each setting does depends on the tileset (found by emulation, see layer3.ts)
  const l3Opts = (): [number, string][] => app.layer3Kinds(hd.tileset).map((k, i) => [i, `${i} – ${LAYER3_KIND_TEXT[k]}`]);
  const l3Sel = sel2('layer3', l3Opts());
  const tilesetSel = select(range(16, (i) => `${hex2(i)} – ${TILESETS[i]}`), hd.tileset, (v) => {
    hd.tileset = v;
    l3Sel.replaceChildren(...l3Opts().map(([v, l]) => h('option', { value: String(v), selected: v === sd.layer3 }, l)));
  });

  // music: the header's 8 settings, or a song of the ROM for this level (music per level)
  const songs = currentSongs(app);
  const songName = (n: number) => songs.find((x) => x.num === n)?.name;
  const tableSong = (i: number) => app.rom.r8(HEADER_MUSIC_TABLE + i);
  let levelSong = levelMusic(app.rom, lv.number);
  const songSel = select([[0, 'Header music'], ...songs.map((x): [number, string] => [x.num, `${songHex(x.num)} – ${x.name}`]),
    ...(levelSong && !songName(levelSong) ? [[levelSong, `${songHex(levelSong)}`] as [number, string]] : [])], levelSong, (v) => { levelSong = v; if (musicPlayer.label === 'header') musicPlayer.stop(); });
  const listen = playButton('header', () => {
    const song = levelSong || tableSong(hd.music);
    void musicPlayer.playLevel(app, lv.number, 'header', song).then(() => { if (musicPlayer.error) toast(`Could not play: ${musicPlayer.error}`, 'error'); });
  }, 'Listen: the level with this music, as the game plays it');
  const musicSel = sel('music', range(8, (i) => `${i} – ${MUSIC[i]} (Song ${hex2(tableSong(i))}${songName(tableSong(i)) && songName(tableSong(i)) !== MUSIC[i] ? ` ${songName(tableSong(i))}` : ''})`));
  musicSel.addEventListener('change', () => { if (musicPlayer.label === 'header') musicPlayer.stop(); });

  // layer 2 scroll: the game's 16 paired settings, or separate horizontal and vertical rates (Lunar
  // Magic 3.40's); what each does is measured by letting the level run (l2scroll.ts), shown once known
  let motions: Layer2Motions | null = null;
  let hr = sd.layer2Separate ? hRate(sd) : 0, vr = sd.layer2Separate ? sd.layer2V : 0;
  const pairedOpts = (): [number, string][] => range(16, (i) => {
    const m = motions?.paired[i];
    return m ? `${hex(i, 1)} – H ${motionText(m.x, 'x')}, V ${motionText(m.y, 'y')}` : hex(i, 1);
  });
  const rateOpts = (axis: 'x' | 'y', cur: number): [number, string][] => {
    const opts = RATE_OPTIONS.map((v, i): [number, string] => {
      const m = motions?.separate[i][axis];
      return [v, `${layer2RateName(v, axis === 'x')}${m ? ` (${motionText(m, axis)})` : ''}`];
    });
    return RATE_OPTIONS.includes(cur) ? opts : [...opts, [cur, layer2RateName(cur, axis === 'x')]];
  };
  const pairedSel = select(pairedOpts(), sd.layer2Scroll, (v) => { sd.layer2Scroll = v; });
  const hSel = select(rateOpts('x', hr), hr, (v) => { hr = v; });
  const vSel = select(rateOpts('y', vr), vr, (v) => { vr = v; });
  const setOpts = (el: HTMLSelectElement, opts: [number, string][], cur: number) =>
    el.replaceChildren(...opts.map(([v, l]) => h('option', { value: String(v), selected: v === cur }, l)));
  const hRow = f('Layer 2 horizontal', hSel), vRow = f('Layer 2 vertical', vSel);
  const sepBox = h('input', { type: 'checkbox', checked: !!sd.layer2Separate });
  const showSeparate = () => {
    pairedSel.style.display = sepBox.checked ? 'none' : '';
    hRow.style.display = vRow.style.display = sepBox.checked ? '' : 'none';
  };
  sepBox.addEventListener('change', () => {
    // separate rates start where the paired setting was, when it is measured
    const m = motions?.paired[sd.layer2Scroll];
    const same = (axis: 'x' | 'y') => RATE_OPTIONS.findIndex((_, i) => motionText(motions!.separate[i][axis], axis) === motionText(m![axis], axis));
    if (sepBox.checked && m && same('x') >= 0 && same('y') >= 0) {
      hr = RATE_OPTIONS[same('x')]; vr = RATE_OPTIONS[same('y')];
      hSel.value = String(hr); vSel.value = String(vr);
    }
    showSeparate();
  });
  showSeparate();
  const measured = () => {
    if (!open) return;
    motions = app.layer2Motions(measured);
    if (!motions) return;
    setOpts(pairedSel, pairedOpts(), sd.layer2Scroll);
    setOpts(hSel, rateOpts('x', hr), hr);
    setOpts(vSel, rateOpts('y', vr), vr);
  };

  let open = true;
  const screensWarn = h('div', { class: 'hint warn-text' });
  const body = h('div', { class: 'header-dialog' },
    h('h3', null, 'General'),
    h('div', { class: 'grid2' },
      f('Level mode', sel('mode', modes)),
      f('Number of screens', select(range(32, (i) => String(i + 1)).map(([v, l]) => [v + 1, l] as [number, string]), hd.screens, (v) => {
        hd.screens = v;
        screensWarn.textContent = v < lv.header.screens ? 'Fewer screens: objects, sprites and exits beyond are kept but cannot be reached in the game.' : '';
      })),
      f('FG/BG tileset', tilesetSel),
      f('FG palette', sel('fgPalette', range(8))),
      f('BG palette', sel('bgPalette', range(8))),
      f('Background color', sel('backAreaColor', range(8))),
      f('Sprite palette', sel('spritePalette', range(8))),
      f('Sprite graphics', sel('spriteGfx', range(16, (i) => hex2(i)))),
      f('Music', h('div', { class: 'row' }, musicSel, listen)),
      f('Song for this level', songSel, 'Instead of the header music – any song of the ROM (songs come with packages: ROM → Packages …)'),
      f('Time', sel('time', range(4, (i) => TIME_SETTINGS[i]))),
      f('Item memory', sel('itemMemory', range(4))),
      f('Vertical scroll', sel('verticalScroll', range(4, (i) => VERTICAL_SCROLL[i]))),
      f('Layer 3 priority', sel('layer3Priority', [[0, 'Off'], [1, 'On']])),
    ),
    screensWarn,
    h('h3', null, 'Entrance & scrolling'),
    h('div', { class: 'grid2' },
      f('Entrance X position', sel2('entranceX', range(8, (i) => hex(i, 1)))),
      f('Entrance Y position', sel2('entranceY', range(16, (i) => hex(i, 1)))),
      f('Entrance screen', sel2('entranceScreen', range(32, hex2))),
      f('Entrance action', sel2('entranceAction', range(8, (i) => `${i} – ${ENTRANCE_ACTIONS[i]}`))),
      f('Midway screen', sel2('midwayScreen', range(16, hex2))),
      f('Layer 2 scroll', h('div', null, h('label', { title: 'Separate horizontal and vertical layer 2 rates, with more rates and auto-scrolls (as Lunar Magic 3.40)' }, sepBox, ' Separate H/V'), pairedSel)),
      hRow, vRow,
      f('Layer 3', l3Sel, 'Depends on the tileset'),
      f('FG start Y', sel2('fgInitY', range(4))),
      f('BG start Y', sel2('bgInitY', range(4))),
      f('Vertical positioning', sel2('verticalPositioning', range(4))),
      f('Yoshi intro', sel2('noYoshiIntro', [[0, 'On'], [1, 'Off']])),
    ),
    h('h3', null, 'Graphics'),
    h('p', { class: 'hint' }, 'The GFX/ExGFX files the level loads (FG1–FG3, BG1–BG3, sprites) and the palettes are chosen and edited in the graphics area – with preview.'),
    h('div', { class: 'row' }, h('button', { onclick: () => { dlg.close(); app.emit('open-gfx'); } }, 'Open graphics area')),
    h('h3', null, 'Sprites & background'),
    memStatus,
    h('div', { class: 'grid2' },
      h('div', { class: 'prop', title: SPRITE_MEM_HELP }, h('label', null, 'Sprite memory'), memInput, h('span', { class: 'hint' }, 'Room for sprite graphics ($1692)')),
      f('Buoyancy in water', select([[0, 'Off'], [0x80, 'On'], [0xc0, 'On + disabled (underwater)'], [0x40, 'Bit 6']], spriteHeader & 0xc0, (v) => (spriteHeader = (spriteHeader & 0x3f) | v))),
      lv.layer2Objects || hasLayer2Objects(hd.mode) ? f('Layer 2', lv.layer2Objects ? h('span', null, 'Layer 2 objects (L2 mode)') : h('span', { class: 'warn-box' }, 'The mode expects layer 2 objects')) :
        f('BG tilemap', select(bgOpts, l2ptr, (v) => (l2ptr = v))),
    ),
  );
  const dlg = modal(`Level ${hex(lv.number, 3)} – Header`, body, [
    { label: 'Cancel', onClick: () => { if (musicPlayer.label === 'header') musicPlayer.stop(); } },
    {
      label: 'Apply', primary: true, onClick: () => {
        if (musicPlayer.label === 'header') musicPlayer.stop();
        if (levelSong !== levelMusic(app.rom, lv.number)) {
          try { app.romEdit(`Music of level ${hex(lv.number, 3)}`, () => setLevelMusic(app.rom, lv.number, levelSong)); } catch (e) { toast(String(e instanceof Error ? e.message : e), 'error'); }
        }
        app.editLevel(() => {
          const lv = app.level; // (the music edit saves a changed level first: a new object)
          const modeChangedL2 = hasLayer2Objects(hd.mode) !== hasLayer2Objects(lv.header.mode);
          lv.header = hd;
          lv.secondary = sepBox.checked ? withRates(sd, hr, vr) : { ...sd, layer2Separate: 0, layer2HAuto: 0, layer2V: 0 };
          lv.spriteHeader = spriteHeader;
          if (l2ptr !== CUSTOM_BG) { lv.bg = null; lv.layer2Pointer = l2ptr; }
          if (modeChangedL2) {
            if (hasLayer2Objects(hd.mode) && !lv.layer2Objects) { lv.layer2Objects = []; lv.layer2Header = new Uint8Array(5); }
            if (!hasLayer2Objects(hd.mode) && lv.layer2Objects) {
              lv.layer2Objects = null;
              if (lv.layer2Pointer >> 16 !== 0xff) lv.layer2Pointer = app.rom.r24(L2_PTRS + 0x105 * 3);
            }
          }
          if (app.mode === 'l2' && !lv.layer2Objects) app.mode = 'l1';
          if (app.mode === 'bg' && lv.layer2Objects) app.mode = 'l1';
        });
        app.emit('level-header');
      },
    },
  ], () => { open = false; if (musicPlayer.label === 'header') musicPlayer.stop(); });
  measured();
}
