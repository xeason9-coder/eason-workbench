import assert from 'node:assert/strict';
import {mkdirSync, readdirSync, readFileSync} from 'node:fs';
import {Miniflare, createFetchMock} from 'miniflare';
import {build} from 'esbuild';

mkdirSync('.sites-runtime/tests', {recursive: true});
await build({entryPoints: ['tests/fusion-access-worker.ts'], bundle: true, format: 'esm', platform: 'browser',
  external: ['node:crypto'], target: 'es2022', outfile: '.sites-runtime/tests/client-models.mjs'});
const mock = createFetchMock(); mock.disableNetConnect();
const service = 'fixture-service-token-for-client-models-123456';
const keys = {a: 'sk-fictional_client_A_key_123456789', b: 'sk-fictional_client_B_key_123456789'};
const profiles = {ownera: {id: 'a', role: 'manager'}, ownerb: {id: 'b', role: 'manager'}, member: {id: 'a', role: 'member'}, external: {id: 'a', role: 'external'}};
function headers(raw) {
  return Array.isArray(raw) ? Object.fromEntries(Array.from({length: raw.length / 2}, (_, i) => [raw[i * 2].toLowerCase(), raw[i * 2 + 1]])) : Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
}
mock.get('http://127.0.0.1:8768').intercept({path: /^\/fusion\//, method: 'GET'}).reply(options => {
  const h = headers(options.headers); assert.equal(h.authorization, 'Bearer ' + service);
  if (options.path === '/fusion/internal/clients') return {statusCode: 200, data: JSON.stringify({active_ids: ['a', 'b']})};
  const person = /eason_session=(\w+)/.exec(h.cookie || '')?.[1], p = profiles[person];
  if (!p) return {statusCode: 401, data: '{"detail":"请登录"}'};
  if (h['x-fusion-client'] !== p.id) return {statusCode: 404, data: '{"detail":"客户不存在"}'};
  const client = {...p, name: '虚构客户 ' + p.id, owned: p.role === 'manager', grants: {documents: [], tasks: [], articles: []}};
  return {statusCode: 200, data: JSON.stringify({user: {id: person, username: person, role: 'user'}, clients: [client], client})};
}).persist();
const mf = new Miniflare({modules: true, scriptPath: '.sites-runtime/tests/client-models.mjs', compatibilityDate: '2026-05-15',
  compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BUCKET'], fetchMock: mock,
  bindings: {FUSION_LOCAL: '1', FUSION_COLLECTOR_URL: 'http://127.0.0.1:8768', FUSION_SERVICE_TOKEN: service,
    MODEL_SETTINGS_ENCRYPTION_KEY: 'bc'.repeat(32), AI_URL: 'https://default-model.test/chat', AI_MODEL: 'default-fixture', AI_KEY: 'default-private-fixture'}});
async function req(path, {person = 'ownera', client = profiles[person]?.id, body, tick = false} = {}) {
  const response = await mf.dispatchFetch('https://studio.test' + (tick ? '/api/fusion/background/tick' : '/api/studio/' + path), {
    method: body ? 'POST' : 'GET', headers: {origin: 'https://studio.test', 'content-type': 'application/json',
      cookie: 'eason_session=' + person + '; fusion_client=' + client, ...(tick ? {authorization: 'Bearer ' + service} : {})},
    body: body ? JSON.stringify(body) : undefined});
  return {status: response.status, data: await response.json()};
}
const calls = [];
function reply(client, output) {
  const deepseek = client === 'a';
  mock.get(deepseek ? 'https://api.deepseek.com' : 'https://api.openai.com').intercept({
    path: deepseek ? '/chat/completions' : '/v1/chat/completions', method: 'POST', headers: {authorization: 'Bearer ' + keys[client]},
  }).reply(200, async options => {
    const body = JSON.parse(await new Response(options.body).text()); assert.equal(body.model, 'fixture-' + client); calls.push(client);
    return JSON.stringify({choices: [{finish_reason: 'stop', message: {content: JSON.stringify(output)}}]});
  });
}
try {
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql'))) await db.exec(readFileSync('drizzle/' + file, 'utf8').replace(/--> statement-breakpoint/g, '').replace(/\n/g, ' '));
  for (const person of ['ownera', 'ownerb']) {
    const result = await req('modelSettings', {person}); assert.equal(result.status, 200);
    assert.equal(result.data.hasSavedKey, false); assert.equal(result.data.usingDefault, false);
    assert.deepEqual(result.data.activeModels, {knowledge: null, content: null});
    assert.equal((await req('state', {person})).data.config.model, false);
  }
  for (const person of ['member', 'external']) {
    assert.equal((await req('modelSettings', {person})).status, 403);
    assert.equal((await req('modelSettings', {person, body: {action: 'useDefault', clientId: 'a', revision: 0}})).status, 403);
  }
  assert.equal((await req('modelSettings?clientId=b')).status, 409);
  assert.equal((await req('modelSettings', {body: {action: 'useDefault', clientId: 'b', revision: 0}})).status, 409);
  assert.equal((await req('modelSettings', {client: 'b'})).status, 404);
  for (const client of ['a', 'b']) {
    reply(client, {ok: true});
    const result = await req('modelSettings', {person: 'owner' + client, body: {action: 'testSave', clientId: client,
      provider: client === 'a' ? 'DeepSeek' : 'OpenAI', model: 'fixture-' + client, apiKey: keys[client], consent: true, revision: 0}});
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.deepEqual(result.data.activeModels, {knowledge: 'fixture-' + client, content: 'fixture-' + client});
    assert.ok(!JSON.stringify(result.data).includes(keys[client]));
    if (client === 'a') assert.equal((await req('state', {person: 'ownerb'})).data.config.model, false);
  }
  const records = await db.prepare("SELECT owner,payload FROM studio_records WHERE kind='modelSettings'").all();
  assert.deepEqual(records.results.map(r => r.owner).sort(), ['client:a', 'client:b']);
  for (const record of records.results) for (const key of Object.values(keys)) assert.ok(!record.payload.includes(key));
  for (const client of ['a', 'b']) {
    const payload = {stage: 'planning', autoAdvance: true, keyword: '虚构选题 ' + client, clientPositioning: '虚构定位',
      audience: '测试读者', platform: '测试', description: '', writingRules: '', referenceArticles: [], events: []};
    await db.prepare("INSERT INTO studio_records(id,kind,owner,state,revision,payload,created,updated) VALUES(?,'task',?,'waiting',1,?,?,?)")
      .bind('task-' + client, 'client:' + client, JSON.stringify(payload), '2026-01-01', '2026-01-01').run();
    reply(client, {topics: [{title: '虚构选题', angle: '测试角度', reason: '验证模型隔离'}]});
  }
  assert.equal((await req('', {tick: true, body: {}})).status, 200);
  const tasks = await db.prepare("SELECT state,payload FROM studio_records WHERE kind='task'").all();
  assert.equal(tasks.results.length, 2);
  for (const task of tasks.results) {assert.equal(task.state, 'waiting', task.payload); assert.equal(JSON.parse(task.payload).stage, 'topic');}
  assert.deepEqual(calls.slice(2).sort(), ['a', 'b'], 'each background task must use its own client key and model');
  let result = await req('modelSettings', {body: {action: 'disable', clientId: 'a', revision: 1}});
  assert.equal(result.status, 200); assert.equal(result.data.usingDefault, false);
  assert.equal((await req('state')).data.config.model, false);
  assert.equal((await req('modelSettings', {person: 'ownerb'})).data.activeModels.content, 'fixture-b');
  result = await req('modelSettings', {body: {action: 'useDefault', clientId: 'a', revision: result.data.revision}});
  assert.equal(result.status, 200); assert.equal(result.data.usingDefault, true);
  assert.equal(result.data.activeModels.content, 'default-fixture');
  assert.equal((await req('modelSettings', {person: 'ownerb'})).data.activeModels.content, 'fixture-b');
  mock.assertNoPendingInterceptors();
  console.log('PASS: ordinary client owners configure independent encrypted keys; members denied; stale client rejected; new clients do not inherit defaults; background tasks use their client provider; default use requires explicit choice. No real provider calls.');
} finally {await mf.dispose(); await mock.close();}
