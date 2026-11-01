# Lunar Magic's overworld options in ROMs it saved

Research note, 2026-11-01 (issue #254, part of #69). The question: do the overworld's "Extra Options" the editor
took from `Lunar Magic.exe` (#86, `src/core/owoptions.ts`) match a ROM that Lunar Magic saved? ADR 0005 counts a
place or byte read from the program only once a saved ROM confirms it. This note also explains how to make such
ROMs on Linux. The level names' character table was checked the same way; see
[lunar-magic-level-names.md](lunar-magic-level-names.md), "Confirmed by a ROM Lunar Magic saved".

## Result

Lunar Magic 3.71 (the release of 2026-09-27) saved the clean game (`test/fixtures/smw.smc`) with each option
checked and unchecked:

| Option (Lunar Magic's label) | Place | Checked | Unchecked | The editor |
|---|---|---|---|---|
| "Allow hardcoded default layer 1 paths." | `$049307` | `A6 08` (the game's) | `80 71` | the same |
| "Save Luigi's map position in saved games instead of saving a copy of Mario's." | `$048F9F` | `80 3B` | `C2 30` (the game's) | the same |

- The two saves differ in only these four bytes and in `$0FF025`.
- `$0FF025` is not an option flag. Lunar Magic adjusts it to make up for the bytes it changed, so that the sum
  of the bytes stays the same: `$9C` with both options as in the game, `$90` with both changed, and `$D3` with only
  Luigi's changed. Each value is the earlier one minus the change in the sum of the changed bytes, modulo 256. The
  checksum in the ROM's header at `$00FFDC` stayed the same in every save. The editor doesn't write this byte: it is
  Lunar Magic's own bookkeeping, and neither the game nor Lunar Magic reads it for the options.
- Lunar Magic reads the options from the code. A ROM it saved with both options as in the game, with `80 71` and
  `80 3B` written into it by hand and `$0FF025` left alone, showed both options as changed in the "Extra Options"
  dialog. So a ROM with the editor's bytes should show them correctly in Lunar Magic too. This was checked on a
  ROM that Lunar Magic saved, not on one the editor wrote.

`tools/testowoptions.ts` checks that the editor writes these bytes for each option, both on and off.

## Making the ROMs

Lunar Magic's command line (help `info_command_line.htm`) can't set overworld options or level names, so the
ROMs were saved from its UI. Lunar Magic runs under wine with a WINEPREFIX of its own (`WINEPREFIX=<dir> wineboot -i`),
on a headless display rather than the user's screen:

1. A virtual compositor with Xwayland:
   `env -u DISPLAY -u WAYLAND_DISPLAY kwin_wayland --virtual --xwayland --socket lmwl --width 1280 --height 1024 --no-lockscreen --exit-with-session <script>`.
   The session script writes down the `$DISPLAY` kwin gives it, then sleeps; Lunar Magic and `lmctl` run on that display.
2. `xdotool` can't send input on that display, because Xwayland routes faked input through the compositor, which
   ignores it. `tools/lmctl.c` drives the windows with window messages from inside wine instead. Build it with
   `winegcc -m64 tools/lmctl.c -o lmctl.exe` and run it as `wine lmctl.exe … | cat`. `import -window <X id>` (from
   ImageMagick) takes screenshots of single windows, including open menus.
3. `wine "Lunar Magic.exe" Z:\…\rom.smc` opens the ROM. Start with a copy of the clean game; Lunar Magic expands
   it to 2 MB when it first saves.
4. Open the overworld editor from the main window's Editors menu: `lmctl menu <frame> e`, then `key` with
   Right Right Up Enter ("Overworld Editor Window...", the menu's last item).
5. In the overworld editor's window (`OVFrame`):
   - **Options:** Overworld → "Extra Options..." (the menu's last item: `menu <ov> o`, Left, Up, Enter). The
     dialog's checkboxes have IDs 116 (hardcoded paths) and 119 (Luigi). `lmctl ls 1` shows each window handle and
     its check state. Use `click` on a checkbox, then on OK.
   - **Level names:** Overworld → "Edit Level Names..." (Down 12 times). In the dialog, the list box (ID 101)
     selects a translevel with `lbsel <list> <translevel>`. `settext` on the edit control (ID 102) sets the
     selected translevel's name. Checkbox ID 111 is "Use MultiChar Tiles". Click OK when done.
   - **Save:** File → "Save Overworld to ROM" (`menu <ov> f`, Down, Enter).
6. Compare the saved ROM with the copy made before saving. `tools/lmlevelnames.ts <rom>` lists the level names.
