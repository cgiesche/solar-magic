import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev -- --host <address>` serves the LAN over https with a self-signed certificate: the
// browser gives AudioWorklet (the game's sound) only to a secure context, and http://<LAN address> is none.
// Plain `npm run dev` stays http on localhost, which counts as secure.
const lan = process.argv.includes('--host') || process.argv.some((a) => a.startsWith('--host='));

// two pages: the editor with its start page, and the static credits page
export default defineConfig({ plugins: lan ? [basicSsl()] : [], build: { rollupOptions: { input: ['index.html', 'credits.html'] } } });
