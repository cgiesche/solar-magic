// Drives Lunar Magic's windows under wine, for making ROMs Lunar Magic saved (ADR 0005; how to use it:
// docs/research/lunar-magic-overworld-options.md, "Making the ROMs"). Wine's X11 input can't be faked on a headless
// Xwayland, so this works by window messages from inside wine: list the windows and their controls, post menu keys
// and button clicks, set an edit's text, select a list item.
// Build (Winelib): winegcc -m64 tools/lmctl.c -o lmctl.exe
// Run: WINEPREFIX=… DISPLAY=… wine lmctl.exe <command> … | cat   (without the pipe wine drops its output)
//   ls [1]                    visible top-level windows (1: with their controls, a button's check state)
//   menu <hwnd> <letter>      opens the window's menu by its underlined letter (Alt+letter)
//   key <hwnd> <vk>           a key (hex: 0x25–0x28 arrows, 0x0D Enter, 0x1B Escape), e.g. within an open menu
//   click <hwnd>              a button
//   settext <hwnd> <text>     an edit's text (its owner gets EN_CHANGE)
//   gettext <hwnd>
//   lbsel <hwnd> <index>      selects a list box item, its dialog gets LBN_SELCHANGE
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void info(HWND h, int d) {
  char c[256], t[512] = "";
  RECT r;
  GetClassNameA(h, c, sizeof c);
  SendMessageTimeoutA(h, WM_GETTEXT, sizeof t, (LPARAM)t, SMTO_ABORTIFHUNG, 500, NULL);
  GetWindowRect(h, &r);
  printf("%*s%p id=%ld [%s] '%s' en=%d %ld,%ld %ldx%ld", d * 2, "", (void *)h, (long)GetDlgCtrlID(h), c, t, IsWindowEnabled(h),
         r.left, r.top, r.right - r.left, r.bottom - r.top);
  if (!strcmp(c, "Button")) printf(" chk=%ld", (long)SendMessageA(h, BM_GETCHECK, 0, 0));
  printf("\n");
}
static int depth;
static BOOL CALLBACK child(HWND h, LPARAM parent) {
  if (GetParent(h) != (HWND)parent || !IsWindowVisible(h)) return TRUE;
  info(h, depth);
  depth++; EnumChildWindows(h, child, (LPARAM)h); depth--;
  return TRUE;
}
static BOOL CALLBACK top(HWND h, LPARAM deep) {
  if (!IsWindowVisible(h)) return TRUE;
  info(h, 0);
  if (deep) { depth = 1; EnumChildWindows(h, child, (LPARAM)h); }
  return TRUE;
}
static HWND hwnd(const char *s) { return (HWND)(ULONG_PTR)strtoull(s, 0, 16); }

int main(int argc, char **argv) {
  setvbuf(stdout, 0, _IONBF, 0);
  const char *c = argc > 1 ? argv[1] : "";
  int need = !strcmp(c, "ls") ? 2 : !strcmp(c, "click") || !strcmp(c, "gettext") ? 3 : 4;
  if (argc < need) { fprintf(stderr, "usage: see the comment at the top of tools/lmctl.c\n"); return 1; }
  if (!strcmp(c, "ls")) EnumWindows(top, argc > 2);
  else if (!strcmp(c, "menu")) PostMessageA(hwnd(argv[2]), WM_SYSCOMMAND, SC_KEYMENU, (unsigned char)argv[3][0]);
  else if (!strcmp(c, "key")) {
    HWND h = hwnd(argv[2]); UINT vk = strtoul(argv[3], 0, 0);
    PostMessageA(h, WM_KEYDOWN, vk, 1); PostMessageA(h, WM_KEYUP, vk, 0xC0000001);
  }
  else if (!strcmp(c, "click")) PostMessageA(hwnd(argv[2]), BM_CLICK, 0, 0);
  else if (!strcmp(c, "settext")) SendMessageA(hwnd(argv[2]), WM_SETTEXT, 0, (LPARAM)argv[3]);
  else if (!strcmp(c, "gettext")) { char t[1024]; SendMessageA(hwnd(argv[2]), WM_GETTEXT, sizeof t, (LPARAM)t); printf("'%s'\n", t); }
  else if (!strcmp(c, "lbsel")) {
    HWND lb = hwnd(argv[2]);
    SendMessageA(lb, LB_SETCURSEL, atoi(argv[3]), 0);
    SendMessageA(GetParent(lb), WM_COMMAND, MAKEWPARAM(GetDlgCtrlID(lb), LBN_SELCHANGE), (LPARAM)lb);
  }
  else { fprintf(stderr, "unknown command %s\n", c); return 1; }
  return 0;
}
