import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const base = 'http://127.0.0.1:5173';
const paths = ['/.dev.vars', '/lib/studio/library-data.json', '/dist/server/index.js', '/dist/server/.dev.vars', '/.sites-runtime/baseline.zip', '/.git/config', '/@vite/client', '/runtime/model-encryption.key', '/%2e%2e/runtime/model-encryption.key', '/@fs/'+fileURLToPath(new URL('../lib/studio/library-data.json',import.meta.url)).replaceAll('\\','/')];
const results = [];
for (const path of paths) {
  const response = await fetch(base + path, {redirect: 'manual', signal: AbortSignal.timeout(10000)});
  await response.arrayBuffer();
  results.push({path, status: response.status});
}
const session = await fetch(base + '/api/fusion/auth/session');
results.push({path: '/api/fusion/auth/session', status: session.status});
writeFileSync(fileURLToPath(new URL('../../runtime/static-boundary-final.json', import.meta.url)), JSON.stringify({time: new Date().toISOString(), results}, null, 2));
for (const r of results) assert.ok(r.path.endsWith('/session') ? r.status === 401 : [403, 404].includes(r.status), 'Unauthenticated boundary failed: ' + r.path + ' HTTP ' + r.status);
console.log('PASS: private source, environment, server bundle, developer routes and data paths are inaccessible; real login is required.');
