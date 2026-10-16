// Version of a build: MAJOR.MINOR from src-tauri/tauri.conf.json, the build number (commits up to HEAD) as
// the third part, e.g. 0.1.232. The same commit gives the same number in the desktop release and the
// Docker image. Needs the full history (actions/checkout with fetch-depth: 0).
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const [major, minor] = String(conf.version).split('.');
const build = execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim();
console.log(`${major}.${minor}.${build}`);
