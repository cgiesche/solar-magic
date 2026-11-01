# Test fixtures

Files read by the test scripts (`npm test`, `tools/test*.ts`), relative to the repository root.

The ROM is **not** in the repository and must be placed here by hand:

| File | Content |
|---|---|
| `smw.smc` | Super Mario World (USA), unheadered or with copier header – the ROM known as `Super Mario World (U) [!].smc` |

The CI workflow (`.github/workflows/ci.yml`) downloads it from the URL in the secret `SMW_ROM_URL`.

The packages here are third-party resources used as test cases; their authors are listed in `docs/credits.md`.
`rhr-baserom-5.15.zip` is the Romhack Races baserom 5.15 as released
(https://github.com/romhackraces/baserom/releases/tag/5.15, `rhr-baserom-5.15.zip`); it has no license, the rights
stay with the authors of its resources.
`vwf_dialogues.zip` is RPG Hacker's VWF Dialogues Patch (MIT), packed from
https://github.com/RPGHacker/SMW-Workspace (commit 0b1019c, `patches/vwf_dialogues` and `patches/shared`) as its
`package.bat` packs the release, without the manual.
