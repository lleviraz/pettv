// Assembles dist-web/ for Firebase Hosting: only the 404 page and robots.txt at the root,
// the viewer page (with its config) under the secret folder from web/firebase-config.js.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { webPath } from '../web/firebase-config.js';

if (!/^[a-z0-9]{20,}$/.test(webPath ?? '')) {
  throw new Error('web/firebase-config.js needs webPath: at least 20 random lowercase letters/digits');
}

const out = new URL('../dist-web/', import.meta.url);
const web = new URL('../web/', import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(new URL(`${webPath}/`, out), { recursive: true });
for (const f of ['404.html', 'robots.txt']) cpSync(new URL(f, web), new URL(f, out));
cpSync(new URL('app/', web), new URL(`${webPath}/`, out), { recursive: true });
cpSync(new URL('firebase-config.js', web), new URL(`${webPath}/firebase-config.js`, out));
console.log('dist-web ready');
