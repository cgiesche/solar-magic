// The page's entry: the start page (static HTML in index.html) is painted first, the editor's code (main.ts) is
// loaded after that – it is most of the download, and nothing on the start page needs it to be seen.
// the UI's fonts, bundled (offline, the desktop app too; #473): Inter for text, JetBrains Mono for numbers and code
import '@fontsource-variable/inter/wght.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './style.css';
import { initTheme } from './ui/theme.ts';

initTheme(); // (the theme chosen, before the start page or the editor is shown; #474)

declare global { interface Window { landingShown?: Promise<boolean> } }

let started = false;
function start(): void {
  if (started) return;
  started = true;
  void import('./main.ts').then(() => {
    document.removeEventListener('click', early);
    clicked?.click();
  });
}

// a click on a button of the start page before the editor's code is there loads it right away and is repeated then
let clicked: HTMLElement | null = null;
function early(e: MouseEvent): void {
  const b = (e.target as HTMLElement).closest<HTMLElement>('#landing-new-project, #landing-open-project');
  if (!b) return;
  clicked = b;
  start();
}
document.addEventListener('click', early);

// a project waiting (or no answer): the editor's code right away; the start page shown: once the browser reports it
// painted (a tab in the background paints nothing, hence the timeout)
void (window.landingShown ?? Promise.resolve(false)).then((shown) => {
  if (!shown) return start();
  try {
    new PerformanceObserver((_, obs) => { obs.disconnect(); setTimeout(start); }).observe({ type: 'paint', buffered: true });
  } catch { /* no paint timing: the timeout */ }
  setTimeout(start, 500);
});
