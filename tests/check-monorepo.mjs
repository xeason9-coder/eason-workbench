import assert from 'node:assert/strict';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const name of ['KB/package.json', 'KB/pnpm-lock.yaml', 'we-mp-rss/main.py', 'we-mp-rss/requirements.txt', 'we-mp-rss/LICENSE', '本地服务.ps1', '备份本地数据.ps1']) {
  assert.ok(existsSync(path.join(root, name)), 'Missing component: ' + name);
}
assert.ok(!existsSync(path.join(root, 'KB/.git')) && !existsSync(path.join(root, 'we-mp-rss/.git')), 'Components must be ordinary directories');
assert.ok(!existsSync(path.join(root, 'KB/lib/studio/library-data.json')), 'Private source library must not ship in the public repository');
for (const name of ['本地服务.ps1', '备份本地数据.ps1']) {
  const source = readFileSync(path.join(root, name), 'utf8');
  assert.ok(source.includes("Join-Path $Root 'we-mp-rss'"), 'Collector path must stay inside this repository');
  assert.ok(!source.includes('公众号RSS演示'), 'Old external directory dependency remains');
}

const temporaryParent = realpathSync(tmpdir());
const temporary = mkdtempSync(path.join(temporaryParent, 'eason-monorepo-'));
try {
  const setup = path.join(temporary, 'KB/scripts/configure-local.mjs');
  mkdirSync(path.dirname(setup), {recursive: true});
  copyFileSync(path.join(root, 'KB/scripts/configure-local.mjs'), setup);
  const env = {...process.env, DEEPSEEK_API_KEY: ''};
  const run = () => execFileSync(process.execPath, [setup], {cwd: temporary, env, encoding: 'utf8'});
  const configPath = path.join(temporary, 'KB/.dev.vars');
  const config = () => Object.fromEntries(readFileSync(configPath, 'utf8').trim().split('\n').map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), JSON.parse(line.slice(at + 1))];
  }));
  run();
  const initial = config();
  assert.equal(initial.FUSION_LOCAL, '1');
  assert.equal(initial.FUSION_SERVICE_TOKEN, readFileSync(path.join(temporary, 'we-mp-rss/data/fusion-service.key'), 'utf8').trim());
  assert.match(initial.MODEL_SETTINGS_ENCRYPTION_KEY, /^[a-f0-9]{64}$/);
  assert.equal(initial.AI_KEY, ''); assert.equal(initial.AI_URL, ''); assert.equal(initial.AI_MODEL, '');
  const before = readFileSync(configPath, 'utf8'); run(); assert.equal(readFileSync(configPath, 'utf8'), before);
  rmSync(configPath);
  writeFileSync(path.join(temporary, 'we-mp-rss/data/workbench-settings.json'), JSON.stringify({model: 'fixture-model', api_key: 'fixture-private-key'}));
  const output = run(); const restored = config();
  assert.equal(restored.AI_MODEL, 'fixture-model'); assert.equal(restored.AI_KEY, 'fixture-private-key');
  assert.equal(restored.FUSION_SERVICE_TOKEN, initial.FUSION_SERVICE_TOKEN);
  assert.equal(restored.MODEL_SETTINGS_ENCRYPTION_KEY, initial.MODEL_SETTINGS_ENCRYPTION_KEY);
  assert.ok(!output.includes(restored.AI_KEY));
  console.log('PASS: both source trees, internal paths, clean initialization, existing-key reuse and no-overwrite behavior. No live data or network used.');
} finally {
  assert.equal(path.dirname(temporary), temporaryParent);
  assert.ok(path.basename(temporary).startsWith('eason-monorepo-'));
  rmSync(temporary, {recursive: true, force: true});
}
