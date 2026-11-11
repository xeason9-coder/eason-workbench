import {Miniflare, createFetchMock} from 'miniflare';
import {build} from 'esbuild';
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {join, dirname, basename} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import http from 'node:http';

mkdirSync('.sites-runtime/tests', {recursive: true});
await build({entryPoints: ['tests/fusion-access-worker.ts'], bundle: true, format: 'esm', platform: 'browser',
  external: ['node:crypto'], target: 'es2022', outfile: '.sites-runtime/tests/fusion-access.mjs'});
const mock = createFetchMock();
mock.disableNetConnect();
const secret = 'fixture-service-token-not-a-real-credential-123456';
const remote = mock.get('http://127.0.0.1:8768');
let revoked = false, archived = false, activeRegistryUnavailable = false, collectorRequests = [], memberWrites = 0, modelCalls = [];
const clients = {a: {id: 'a', name: '虚构甲客户', description: '测试甲'}, b: {id: 'b', name: '虚构乙客户', description: '测试乙'}};
const blank = () => ({documents: [], tasks: [], articles: []});
const externalGrants = {documents: ['doc-a-shared', 'lib-a-shared'], tasks: ['task-a-shared', 'task-a-running'], articles: []};
function headerValues(raw) {
  if (Array.isArray(raw)) return Object.fromEntries(Array.from({length: raw.length / 2}, (_, i) => [raw[i * 2].toLowerCase(), raw[i * 2 + 1]]));
  return Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k.toLowerCase(), v]));
}
function collectorReply(options) {
  const headers = headerValues(options.headers), path = options.path.split('?')[0];
  collectorRequests.push({path: options.path, headers});
  assert.equal(headers.authorization, 'Bearer ' + secret, 'service token must be server-injected');
  const token = /(?:^|;\s*)eason_session=([^;]*)/.exec(headers.cookie || '')?.[1];
  const person = ['admin', 'member', 'external', 'memberb'].includes(token) ? token : null;
  const clientId = headers['x-fusion-client'] || '';
  const allowed = (person === 'admin' ? ['a', 'b'] : person === 'memberb' ? ['b'] : person && !(person === 'external' && revoked) ? ['a'] : []).filter(id => !(archived && id === 'a'));
  const role = person === 'admin' ? 'manager' : person === 'external' ? 'external' : 'member';
  const list = allowed.map(id => ({...clients[id], role, grants: person === 'external' ? externalGrants : blank()}));
  let statusCode = 200, data;
  if (path === '/fusion/internal/clients') {
    if (activeRegistryUnavailable) {statusCode = 503; data = {detail: 'fixture unavailable'};}
    else data = {active_ids: archived ? ['b'] : ['a', 'b']};
  }
  else if (!person) {statusCode = 401; data = {detail: '请登录'};}
  else if (clientId && !allowed.includes(clientId)) {statusCode = 404; data = {detail: '客户不存在'};}
  else if (path === '/fusion/auth/session') data = {authenticated: true, user: {id: person, username: person, role: person === 'admin' ? 'admin' : 'user'}, clients: list, client: list.find(c => c.id === clientId) || null};
  else if (path === '/fusion/monitor/redirect-probe') return {statusCode: 302, data: '', responseOptions: {headers: {location: 'https://never-follow.test/token-sink'}}};
  else if (/^\/fusion\/clients\/[ab]\/members$/.test(path)) {memberWrites++; data = {ok: true};}
  else if (path === '/fusion/monitor/article') {
    const params = new URL('http://fixture' + options.path).searchParams;
    if (params.get('client_id') !== clientId || params.get('article_id') !== 'article-a-shared' || clientId !== 'a') {statusCode = 404; data = {detail: '文章不存在'};}
    else data = {id: 'article-a-shared', title: '虚构监测参考', content: 'MONITOR_A_REFERENCE', source: '虚构公众号', url: 'https://example.test/article', published_at: '2026-01-01'};
  } else if (path === '/fusion/monitor/state') data = {clients: [list.find(c => c.id === clientId)], settings: {brand: 'fixture'}};
  else {statusCode = 404; data = {detail: '接口不存在'};}
  return {statusCode, data: JSON.stringify(data), responseOptions: {headers: {'content-type': 'application/json'}}};
}
for (const method of ['GET', 'POST', 'PUT', 'DELETE']) remote.intercept({path: /^\/fusion\//, method}).reply(collectorReply).persist();
const model = mock.get('https://model.test');
function replyModel(output, status = 200, gate) {
  model.intercept({path: '/chat', method: 'POST'}).reply(status, async options => {
    modelCalls.push(JSON.parse(await new Response(options.body).text()));
    if (gate) {gate.enter(); await gate.wait;}
    return JSON.stringify(status === 200 ? {
      choices: [{finish_reason: 'stop', message: {content: JSON.stringify(output)}}],
      usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15},
    } : {error: 'fixture failure'});
  });
}
function modelGate() {
  let enter, release;
  const entered = new Promise(resolve => {enter = resolve;}), wait = new Promise(resolve => {release = resolve;});
  return {enter, release, wait, async started() {
    let timer;
    try {await Promise.race([entered, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('model fixture did not start')), 10000);})]);}
    finally {clearTimeout(timer);}
  }};
}
const temporaryRoot = realpathSync(tmpdir()), persistentState = mkdtempSync(join(temporaryRoot, 'fusion-access-'));
const options = {modules: true, scriptPath: '.sites-runtime/tests/fusion-access.mjs', compatibilityDate: '2026-05-15',
  compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BUCKET'],
  d1Persist: join(persistentState, 'd1'), r2Persist: join(persistentState, 'r2'),
  bindings: {FUSION_LOCAL: '1', FUSION_COLLECTOR_URL: 'http://127.0.0.1:8768', FUSION_SERVICE_TOKEN: secret,
    AI_URL: 'https://model.test/chat', AI_MODEL: 'fictional-fixture', MODEL_SETTINGS_ENCRYPTION_KEY: 'ab'.repeat(32)},
  // Miniflare's default fetchMock adapter follows redirects inside Node before Workerd can reject them.
  outboundService: async request => fetch(request.url, {method: request.method, headers: Object.fromEntries(request.headers),
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(), dispatcher: mock, redirect: 'manual'})};
let mf = new Miniflare(options);
const failures = [], passes = [];
async function check(name, fn) {
  try {await fn(); passes.push(name); console.log('PASS:', name);}
  catch (error) {failures.push({name, error}); console.error('FAIL:', name, error.message);}
}
async function request(path, {person = 'member', client = 'a', body, method, headers = {}, base = 'https://studio.test', network = false} = {}) {
  const cookie = [person ? 'eason_session=' + person : '', client ? 'fusion_client=' + client : ''].filter(Boolean).join('; ');
  const init = {method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {cookie, ...(body === undefined ? {} : {'content-type': 'application/json'}), ...headers},
    body: body === undefined ? undefined : JSON.stringify(body)};
  // A real HTTP request preserves proxy Host; dispatchFetch rewrites it to its internal bridge.
  const target = network ? new URL(path, await mf.ready) : null;
  const response = target ? await new Promise((resolve, reject) => {
    const call = http.request(target, {...init, agent: false}, incoming => {
      const chunks = [], responseHeaders = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => resolve(new Response(incoming.statusCode === 204 ? null : Buffer.concat(chunks), {status: incoming.statusCode, headers: responseHeaders})));
      incoming.on('error', reject);
    });
    call.on('error', reject); call.end(init.body);
  }) : await mf.dispatchFetch(base + path, init);
  const text = await response.text();
  let data; try {data = JSON.parse(text);} catch {data = text;}
  return {status: response.status, data, text, headers: response.headers};
}
const studio = (path, options) => request('/api/studio/' + path, options);
const tick = () => request('/api/fusion/background/tick', {person: null, client: null, body: {}, headers: {authorization: 'Bearer ' + secret}});
let db, bucket;
const stamp = new Date().toISOString();
async function put(id, kind, client, payload, state = 'ready', updated = stamp) {
  await db.prepare('INSERT INTO studio_records(id,kind,owner,state,revision,payload,created,updated) VALUES(?,?,?,?,1,?,?,?)')
    .bind(id, kind, 'client:' + client, state, JSON.stringify(payload), stamp, updated).run();
}
async function stored(id) {const r = await db.prepare('SELECT * FROM studio_records WHERE id=?').bind(id).first(); return {...r, payload: JSON.parse(r.payload)};}
const sentinel = ['PRIVATE_A_BODY', 'PRIVATE_A_RULE', 'PRIVATE_ARTICLE_EXCERPT', 'PRIVATE_B_BODY'];
function noPrivate(result) {for (const value of sentinel) assert.ok(!result.text.includes(value), 'unauthorized snapshot leaked: ' + value);}
function taskPayload(extra = {}) {return {title: '共享成稿', keyword: '项目', platform: '官网', audience: '读者', description: '',
  stage: 'review', markdown: '可共享成稿[S1]', outline: '共享大纲[S1]', events: [], queries: [], missing: [], issues: [],
  error: '', round: 0, draftVersion: 1, writingRules: '任务表达规则', evidence: [{id: 'chunk-a-private', docId: 'doc-a-private',
    revision: 1, docRevision: 1, title: '内部来源标题', body: 'PRIVATE_A_BODY', ref: 'S1', sourceVersion: 1}],
  rules: [{id: 'rule-private', title: '内部规则', body: 'PRIVATE_A_RULE'}], sourceCandidates: [{body: 'PRIVATE_A_BODY'}],
  referenceArticles: [{id: 'private-article', title: '内部监测原文', excerpt: 'PRIVATE_ARTICLE_EXCERPT'}], ...extra};}

try {
  db = await mf.getD1Database('DB'); bucket = await mf.getR2Bucket('BUCKET');
  for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql'))) await db.exec(readFileSync('drizzle/' + file, 'utf8').replace(/--> statement-breakpoint/g, '').replace(/\n/g, ' '));
  for (const [id, client, body] of [['doc-a-shared', 'a', 'SHARED_A_BODY 项目方法'], ['doc-a-private', 'a', 'PRIVATE_A_BODY 项目内部'], ['doc-b-private', 'b', 'PRIVATE_B_BODY 项目秘密']]) {
    const fileKey = id + '.md'; await bucket.put(fileKey, '# 测试\n' + body);
    await put(id, 'document', client, {name: id + '.md', markdown: '# 测试\n' + body, fileKey, hash: id, purpose: 'fact', external: true, sourceVersion: 1, coverage: true, source: id, events: [], effective: '2020-01-01'});
    await put(id.replace('doc-', 'chunk-'), 'chunk', client, {title: '项目方法', body, originalBody: body, docId: id, docRevision: 1,
      purpose: 'fact', external: true, order: 0, start: 0, end: body.length, heading: [], risks: [], products: ['项目'], platforms: [], regions: [], keywords: ['项目']}, 'approved');
  }
  for (const [id, client, text] of [['lib-a-shared', 'a', 'SHARED_FILE'], ['lib-a-private', 'a', 'PRIVATE_A_BODY'], ['lib-b-private', 'b', 'PRIVATE_B_BODY']]) {
    await bucket.put(id + '.md', text); await bucket.put(id + '.original', text + '_ORIGINAL');
    await put(id, 'library', client, {name: id + '.md', path: 'fixture/' + id + '.md', fileKey: id + '.md', sha256: id,
      originalKey: id + '.original', originalName: id + '.txt', size: text.length}, 'stored');
  }
  await put('task-a-shared', 'task', 'a', taskPayload());
  await put('task-a-private', 'task', 'a', taskPayload({title: 'PRIVATE_A_BODY'}));
  await put('task-b-private', 'task', 'b', taskPayload({title: 'PRIVATE_B_BODY'}));
  await put('task-a-running', 'task', 'a', taskPayload({stage: 'write'}), 'running', '2020-01-01T00:00:00.000Z');
  await put('history-a-shared', 'history', 'a', {...taskPayload(), taskId: 'task-a-shared'}, 'saved');
  await put('history-b-private', 'history', 'b', {...taskPayload({markdown: 'PRIVATE_B_BODY'}), taskId: 'task-b-private'}, 'saved');

  await check('forged OpenAI headers never replace a real local session', async () => {
    const before = collectorRequests.length;
    assert.equal((await studio('state', {person: null, headers: {'oai-authenticated-user-id': 'admin', 'oai-authenticated-user-email': 'owner@example.test', 'x-fusion-client': 'b'}})).status, 401);
    assert.equal(collectorRequests.length, before + 1);
    assert.equal(collectorRequests.at(-1).headers['x-fusion-client'], 'a');
    const source = readFileSync('worker/index.ts', 'utf8');
    const localBranch = source.indexOf("FUSION_LOCAL === '1'"), previewIdentity = source.indexOf('studio-local-preview');
    assert.ok(localBranch >= 0 && (previewIdentity === -1 || localBranch < previewIdentity));
  });
  await check('cross-origin API and mutation calls fail before collector access', async () => {
    const before = collectorRequests.length;
    assert.equal((await studio('state', {headers: {origin: 'https://evil.test'}})).status, 403);
    assert.equal((await studio('createTask', {body: {keyword: 'x'}, headers: {'sec-fetch-site': 'cross-site'}})).status, 403);
    assert.equal((await request('/api/fusion/auth/login', {body: {}, headers: {origin: 'https://evil.test'}})).status, 403);
    assert.equal(collectorRequests.length, before);
  });
  await check('client cookie is validated and membership revocation applies immediately', async () => {
    assert.equal((await studio('state', {client: 'b'})).status, 404);
    assert.equal((await request('/api/fusion/select', {body: {id: 'b'}})).status, 403);
    const selected = await request('/api/fusion/select', {person: 'admin', body: {id: 'b'}});
    assert.equal(selected.status, 200); assert.match(selected.headers.get('set-cookie'), /fusion_client=b;.*HttpOnly/);
    assert.doesNotMatch(selected.headers.get('set-cookie'), /; Secure/i);
    revoked = true;
    assert.equal((await studio('document/doc-a-shared', {person: 'external'})).status, 404);
    revoked = false;
    assert.equal((await studio('document/doc-a-shared', {person: 'external'})).status, 200);
  });
  await check('archived selection recovers the login shell but never grants studio access', async () => {
    archived = true;
    try {
      for (const person of ['admin', 'member', 'external']) {
        const before = collectorRequests.length;
        const result = await request('/api/fusion/auth/session', {person});
        assert.equal(result.status, 200, result.text); assert.equal(result.data.authenticated, true);
        assert.equal(result.data.client, null); assert.ok(!result.data.clients.some(c => c.id === 'a'));
        assert.match(result.headers.get('set-cookie'), /fusion_client=;.*Max-Age=0/);
        assert.equal(collectorRequests.length, before + 2);
        assert.equal(collectorRequests.at(-2).headers['x-fusion-client'], 'a');
        assert.ok(!collectorRequests.at(-1).headers['x-fusion-client']);
        assert.equal((await studio('document/doc-a-shared', {person})).status, 404);
      }
    } finally {archived = false;}
  });
  await check('two customer spaces isolate lists, source URLs, raw downloads and task history', async () => {
    for (const path of ['state', 'library', 'knowledge', 'library?q=PRIVATE_B_BODY', 'knowledge?q=PRIVATE_B_BODY']) {
      const result = await studio(path); assert.equal(result.status, 200, result.text); assert.ok(!result.text.includes('PRIVATE_B_BODY'));
    }
    for (const path of ['document/doc-b-private', 'source/doc-b-private', 'library/lib-b-private', 'library/lib-b-private/download',
      'library/lib-b-private/original', 'task/task-b-private', 'taskHistory/task-b-private', 'taskHistory/task-b-private/history-b-private']) {
      assert.equal((await studio(path)).status, 404, path);
    }
    assert.equal((await studio('document/doc-b-private', {person: 'memberb', client: 'b'})).status, 200);
    assert.equal((await studio('document/doc-a-private', {person: 'memberb', client: 'b'})).status, 404);
    assert.equal((await studio('document/doc-b-private', {person: 'admin', client: 'a'})).status, 404);
  });
  await check('external document grants are independent from external citation flags', async () => {
    for (const path of ['state', 'library', 'knowledge']) {const r = await studio(path, {person: 'external'}); assert.equal(r.status, 200, r.text); noPrivate(r);}
    for (const path of ['document/doc-a-private', 'source/doc-a-private', 'library/lib-a-private', 'library/lib-a-private/download',
      'library/lib-a-private/original', 'knowledge?id=chunk-a-private', 'task/task-a-private']) {
      assert.equal((await studio(path, {person: 'external'})).status, 404, path);
    }
    for (const path of ['document/doc-a-shared', 'source/doc-a-shared', 'library/lib-a-shared/download', 'library/lib-a-shared/original']) assert.equal((await studio(path, {person: 'external'})).status, 200, path);
    const result = await studio('search', {person: 'external', body: {query: '项目'}}); assert.equal(result.status, 200); noPrivate(result);
    assert.deepEqual(result.data.results.map(k => k.docId), ['doc-a-shared']);
    assert.equal((await studio('createTask', {person: 'external', body: {keyword: '项目'}})).status, 403);
    assert.equal((await studio('confirm', {person: 'external', body: {ids: ['chunk-a-shared']}})).status, 403);
    assert.equal((await studio('storage', {person: 'external'})).status, 403);
  });
  await check('shared task details and historical snapshots hide ungranted raw sources', async () => {
    for (const path of ['task/task-a-shared', 'taskHistory/task-a-shared', 'taskHistory/task-a-shared/history-a-shared']) {
      const result = await studio(path, {person: 'external'}); assert.equal(result.status, 200, result.text); noPrivate(result);
    }
  });
  await check('reading a shared stale task never rewrites its private stored snapshots', async () => {
    const before = await stored('task-a-running');
    const result = await studio('task/task-a-running', {person: 'external'}); assert.equal(result.status, 200, result.text); noPrivate(result);
    const after = await stored('task-a-running');
    assert.deepEqual(after.payload.evidence, before.payload.evidence); assert.deepEqual(after.payload.rules, before.payload.rules);
    assert.deepEqual(after.payload.sourceCandidates, before.payload.sourceCandidates);
  });
  await check('model configuration and service token remain server-side', async () => {
    for (const person of ['member', 'external']) {
      assert.equal((await studio('modelSettings', {person})).status, 403);
      assert.equal((await studio('modelSettings', {person, body: {action: 'disable', revision: 0}})).status, 403);
    }
    const result = await studio('modelSettings', {person: 'admin'}); assert.equal(result.status, 200); assert.ok(!result.text.includes(secret)); assert.ok(!result.text.includes('ciphertext'));
    for (const path of ['/api/fusion/auth/session', '/api/fusion/monitor/state', '/api/studio/state']) assert.ok(!(await request(path)).text.includes(secret));
    assert.equal((await request('/api/fusion/background/tick', {body: {}, headers: {authorization: 'Bearer wrong'}})).status, 403);
    const before = collectorRequests.length;
    assert.equal((await request('/api/fusion/monitor/redirect-probe')).status, 503);
    assert.equal(collectorRequests.length, before + 1, 'redirect must not forward the service token to another endpoint');
    assert.equal((await studio('libraryImport', {person: 'admin', body: {offset: 0}})).status, 403);
  });
  await check('membership grants reject other-client and wrong-kind IDs before forwarding', async () => {
    const before = memberWrites;
    for (const grants of [{documents: ['doc-b-private']}, {documents: ['task-a-private']}, {tasks: ['task-b-private']}, {tasks: ['doc-a-shared']}]) {
      assert.equal((await request('/api/fusion/clients/a/members', {person: 'admin', method: 'PUT', body: {user_id: 'external', role: 'external', grants}})).status, 400);
    }
    assert.equal(memberWrites, before);
    assert.equal((await request('/api/fusion/clients/a/members', {method: 'PUT', body: {user_id: 'external', role: 'external', grants: {documents: ['doc-a-shared']}}})).status, 403);
    assert.equal((await request('/api/fusion/clients/a/members', {person: 'admin', method: 'PUT', body: {user_id: 'external', role: 'external', grants: {documents: ['doc-a-shared'], tasks: ['task-a-shared']}}})).status, 200);
    assert.equal(memberWrites, before + 1);
  });
  await check('monitor references are fetched through the selected authenticated client', async () => {
    assert.equal((await studio('createTask', {body: {keyword: '项目', referenceIds: ['article-b-private']}})).status, 404);
    const result = await studio('createTask', {body: {keyword: '项目', referenceIds: ['article-a-shared']}});
    assert.equal(result.status, 200, result.text); assert.equal(result.data.stage, 'planning');
    assert.equal(result.data.referenceArticles[0].usage, '仅选题参考，不是已确认事实来源');
    assert.equal(collectorRequests.at(-1).headers['x-fusion-client'], 'a');
  });

  await check('background worker advances durable stages without a page and stops at human gates', async () => {
    for (let i = 0; i < 20; i++) await put('human-gate-' + i, 'task', 'a', taskPayload({stage: ['outline', 'sources', 'topic', 'review'][i % 4], autoAdvance: true}), 'waiting', '2020-01-01T00:00:00.000Z');
    const base = taskPayload({stage: 'research', autoAdvance: true, sourcesConfirmed: true, selectedSourceIds: ['chunk-a-shared'],
      sourceCandidates: [], evidence: [], rules: [], referenceArticles: [], markdown: '', outline: '', draftVersion: 0});
    await put('background-task', 'task', 'a', base, 'waiting');
    await mf.dispose();
    mf = new Miniflare(options); db = await mf.getD1Database('DB'); bucket = await mf.getR2Bucket('BUCKET');
    assert.equal((await stored('background-task')).payload.autoAdvance, true, 'queued intent survives Worker restart');
    const before = modelCalls.length;
    replyModel({intent: '项目方法', queries: ['项目']});
    replyModel({title: '虚构项目方法', outline: '# 项目方法[S1]', missing: []});
    assert.equal((await tick()).status, 200);
    let row = await stored('background-task'); assert.equal(row.state, 'waiting'); assert.equal(row.payload.stage, 'outline');
    assert.equal(modelCalls.length, before + 2); assert.ok(!JSON.stringify(modelCalls.slice(before)).includes('PRIVATE_B_BODY'));
    assert.ok(!JSON.stringify(modelCalls.slice(before)).includes('PRIVATE_A_BODY'));
    await tick(); assert.equal(modelCalls.length, before + 2, 'outline approval must wait for a human');
    for (let i = 0; i < 20; i++) assert.equal((await stored('human-gate-' + i)).payload.stage, ['outline', 'sources', 'topic', 'review'][i % 4]);
    const approved = await studio('approveOutline', {body: {id: row.id, revision: row.revision}}); assert.equal(approved.status, 200, approved.text);
    const gate = modelGate();
    replyModel({title: '虚构项目方法', markdown: '项目方法基于已确认资料。[S1]', seoTitle: '项目方法', metaDescription: '虚构测试', slug: 'fixture', missing: []}, 200, gate);
    const writing = tick();
    try {
      await gate.started(); const running = await stored(row.id); assert.equal(running.state, 'running');
      const paused = await studio('automation', {body: {id: row.id, revision: running.revision, enabled: false}});
      assert.equal(paused.status, 200, paused.text); assert.equal(paused.data.revision, running.revision);
      assert.equal((await stored(row.id)).payload.autoAdvance, false);
    } finally {gate.release(); await writing;}
    row = await stored(row.id); assert.equal(row.payload.stage, 'check'); assert.equal(row.state, 'waiting');
    assert.equal(row.payload.autoAdvance, false, 'finishing the current step must preserve a concurrent pause');
    await tick(); assert.equal(modelCalls.length, before + 3, 'pause stops the next stage, not the in-flight result');
    assert.equal((await studio('automation', {body: {id: row.id, revision: row.revision, enabled: true}})).status, 200);
    replyModel({summary: '测试通过', issues: [], missing: []});
    await tick(); row = await stored(row.id); assert.equal(row.payload.stage, 'review');
    await tick(); assert.equal(modelCalls.length, before + 4, 'final review must wait for a human');
    const final = await studio('complete', {body: {id: row.id, revision: row.revision, confirmed: true}}); assert.equal(final.status, 200, final.text);
    assert.equal((await stored(row.id)).state, 'done');
  });
  await check('ingestion extraction, links and audit run in the background but wait for manual commit', async () => {
    const callsAtStart = modelCalls.length;
    const starts = await Promise.all([studio('ingestionStart', {body: {id: 'lib-a-shared'}}), studio('ingestionStart', {body: {id: 'lib-a-shared'}})]);
    assert.ok(starts.every(r => [200, 409].includes(r.status)), JSON.stringify(starts.map(r => r.data)));
    const start = starts.find(r => r.status === 200); assert.ok(start, 'one concurrent start must succeed');
    assert.equal(start.status, 200, start.text);
    assert.ok(starts.filter(r => r.status === 200).every(r => r.data.id === start.data.id));
    const count = await db.prepare("SELECT COUNT(*) n FROM studio_records WHERE owner='client:a' AND kind='ingestion' AND json_extract(payload,'$.sourceId')='lib-a-shared'").first();
    assert.equal(count.n, 1, 'concurrent starts must persist exactly one job'); assert.equal(modelCalls.length, callsAtStart);
    assert.equal((await studio('ingestionStart', {body: {id: 'lib-a-shared'}})).data.id, start.data.id);
    let job = start.data; assert.equal(job.state, 'waiting');
    job = (await studio('ingestionJob?id=' + job.id)).data;
    for (const enabled of [false, true]) {
      const toggled = await studio('automation', {body: {id: job.id, revision: job.revision, enabled}});
      assert.equal(toggled.status, 200, toggled.text); assert.equal(toggled.data.configured, true);
      assert.deepEqual(toggled.data.uncovered, job.uncovered); assert.equal('blocks' in toggled.data, false);
      job = toggled.data; assert.equal(job.autoAdvance, enabled);
    }
    const before = modelCalls.length;
    const gate = modelGate();
    replyModel({items: [{title: '虚构原文', statement: 'SHARED_FILE', type: '产品说明', products: [], platforms: [], regions: [],
      keywords: ['fixture'], evidence: [{blockId: 'B1', quote: 'SHARED_FILE'}]}], omissions: []}, 200, gate);
    const extraction = tick();
    try {
      await gate.started(); const running = await stored(job.id); assert.equal(running.state, 'running');
      const paused = await studio('automation', {body: {id: job.id, revision: running.revision, enabled: false}});
      assert.equal(paused.status, 200, paused.text); assert.equal(paused.data.revision, running.revision);
      assert.equal(paused.data.configured, true); assert.ok(Array.isArray(paused.data.uncovered));
    } finally {gate.release(); await extraction;}
    job = (await stored(start.data.id)).payload; assert.equal(job.stage, 'link'); assert.equal(job.autoAdvance, false);
    await tick(); assert.equal(modelCalls.length, before + 1);
    const pausedJob = await stored(start.data.id);
    const resumed = await studio('automation', {body: {id: pausedJob.id, revision: pausedJob.revision, enabled: true}});
    assert.equal(resumed.status, 200, resumed.text); assert.equal(resumed.data.configured, true); assert.ok(Array.isArray(resumed.data.uncovered));
    replyModel({links: []}); await tick(); job = (await stored(start.data.id)).payload; assert.equal(job.stage, 'audit');
    replyModel({checks: [{itemId: 'P0-K1', supported: true, issues: []}], conflicts: [], summary: '虚构检查', uncovered: []});
    await tick(); const row = await stored(start.data.id); assert.equal(row.state, 'succeeded'); assert.equal(row.payload.stage, 'complete');
    await tick(); assert.equal(modelCalls.length, before + 3); assert.equal(row.payload.documentId, undefined);
    assert.equal((await studio('ingestionJob?id=' + row.id, {person: 'external'})).status, 404);
    const existing = await db.prepare("SELECT COUNT(*) n FROM studio_records WHERE kind='document' AND json_extract(payload,'$.ingestionId')=?").bind(row.id).first();
    assert.equal(existing.n, 0, 'background never commits AI results without human review');
    const cached = await studio('ingestionStart', {body: {id: 'lib-a-shared'}});
    assert.equal(cached.data.id, row.id); assert.deepEqual(cached.data.usage, row.payload.usage);
    await tick(); assert.equal(modelCalls.length, before + 3, 'reopening cached completion must not charge another model call');
  });
  await check('ingestion overview returns at most 100 scoped summaries without blocks or items', async () => {
    for (let i = 0; i < 102; i++) await put('summary-job-' + i, 'ingestion', 'a', {name: '虚构摘要' + i,
      stage: 'complete', blocks: [{text: 'SUMMARY_PRIVATE_BLOCK'}], items: [{statement: 'SUMMARY_PRIVATE_ITEM'}]}, 'succeeded');
    await put('summary-other-client', 'ingestion', 'b', {name: 'OTHER_CLIENT_SUMMARY', stage: 'complete'}, 'succeeded');
    const result = await studio('ingestionJobs'); assert.equal(result.status, 200, result.text);
    assert.equal(result.data.jobs.length, 100); assert.equal(result.data.configured, true);
    assert.ok(result.data.jobs.every(j => j.owner === 'client:a' && !('blocks' in j) && !('items' in j) && !('payload' in j)));
    for (const marker of ['SUMMARY_PRIVATE_BLOCK', 'SUMMARY_PRIVATE_ITEM', 'OTHER_CLIENT_SUMMARY']) assert.ok(!result.text.includes(marker));
    assert.deepEqual((await studio('ingestionJobs', {person: 'external'})).data.jobs, []);
  });
  await check('failed and interrupted background work requires explicit retry without automatic model charges', async () => {
    await put('background-fail', 'task', 'a', taskPayload({stage: 'research', autoAdvance: true, sourcesConfirmed: true,
      selectedSourceIds: ['chunk-a-shared'], evidence: [], rules: [], referenceArticles: []}), 'waiting');
    replyModel({}, 503);
    const before = modelCalls.length;
    await tick(); let row = await stored('background-fail'); assert.equal(row.state, 'failed'); assert.match(row.payload.error, /503/);
    await tick(); await tick(); assert.equal(modelCalls.length, before + 1, 'failed work must not restart automatically');
    assert.equal((await studio('run', {body: {id: row.id, revision: row.revision}})).status, 400);
    const retry = await studio('run', {body: {id: row.id, revision: row.revision, retry: true}}); assert.equal(retry.status, 200, retry.text);
    replyModel({intent: '项目方法', queries: ['项目']}); replyModel({title: '重试大纲', outline: '# 项目方法[S1]', missing: []});
    await tick(); row = await stored(row.id); assert.equal(row.payload.stage, 'outline');
    await put('background-interrupted', 'task', 'a', taskPayload({autoAdvance: true, stage: 'write'}), 'running', '2020-01-01T00:00:00.000Z');
    const calls = modelCalls.length; await tick(); const interrupted = await stored('background-interrupted');
    assert.equal(interrupted.state, 'failed'); assert.equal(interrupted.payload.autoAdvance, false); assert.equal(modelCalls.length, calls);
    assert.match(interrupted.payload.error, /中断/);
    assert.equal((await studio('automation', {body: {id: interrupted.id, revision: interrupted.revision, enabled: true}})).status, 400);
  });
  await check('archived customer queues stop without a user session or another model call', async () => {
    await put('archived-task', 'task', 'a', taskPayload({stage: 'write', autoAdvance: true}), 'waiting');
    await put('archived-ingestion', 'ingestion', 'a', {name: '归档入库', stage: 'extract', autoAdvance: true, blocks: [], items: []}, 'waiting');
    const before = modelCalls.length;
    archived = true;
    try {
      const result = await tick(); assert.equal(result.status, 200, result.text);
      for (const id of ['archived-task', 'archived-ingestion']) {
        const row = await stored(id); assert.equal(row.payload.autoAdvance, false); assert.equal(row.state, 'waiting');
      }
      assert.equal(modelCalls.length, before);
      const calls = collectorRequests.filter(r => r.path === '/fusion/internal/clients'); assert.ok(calls.length);
      assert.ok(!calls.at(-1).headers.cookie?.includes('eason_session='));
      assert.equal((await request('/api/fusion/internal/clients', {person: 'admin'})).status, 404, 'internal IDs cannot be proxied to browsers');
    } finally {archived = false;}
    await put('registry-unavailable-task', 'task', 'b', taskPayload({stage: 'write', autoAdvance: true}), 'waiting');
    activeRegistryUnavailable = true;
    try {
      const failed = await tick(); assert.equal(failed.status, 503, failed.text);
      const row = await stored('registry-unavailable-task');
      assert.equal(row.state, 'waiting'); assert.equal(row.payload.autoAdvance, true);
      assert.equal(modelCalls.length, before, 'collector outage must fail closed before a model call');
    } finally {activeRegistryUnavailable = false;}
  });
  await check('HTTPS proxy uses configured origin, validates Host and preserves loopback background auth', async () => {
    await mf.setOptions({...options, bindings: {...options.bindings, FUSION_PUBLIC_ORIGIN: 'https://studio.test'}});
    const proxy = {network: true, headers: {host: 'studio.test', origin: 'https://studio.test'}};
    const initial = await studio('state', proxy); assert.equal(initial.status, 200, initial.text);
    const before = collectorRequests.length;
    for (const headers of [
      {host: 'evil.test', origin: 'https://studio.test'},
      {host: 'studio.test', origin: 'https://evil.test'},
      {host: '127.0.0.1:5173', origin: 'https://studio.test', 'x-forwarded-host': 'studio.test', 'x-forwarded-proto': 'https'},
    ]) assert.equal((await studio('state', {...proxy, headers})).status, 403);
    assert.equal((await request('/api/fusion/select', {...proxy, body: {id: 'a'}, headers: {host: 'studio.test'}})).status, 403);
    assert.equal(collectorRequests.length, before);
    assert.equal((await studio('state', {...proxy, person: null, headers: {...proxy.headers, 'oai-authenticated-user-id': 'admin', 'oai-authenticated-user-email': 'owner@example.test'}})).status, 401);
    const selected = await request('/api/fusion/select', {...proxy, person: 'admin', body: {id: 'b'}});
    assert.equal(selected.status, 200, selected.text);
    assert.match(selected.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Secure/);
    archived = true;
    try {
      const session = await request('/api/fusion/auth/session', {...proxy, person: 'admin'});
      assert.equal(session.status, 200); assert.match(session.headers.get('set-cookie'), /Max-Age=0; HttpOnly; SameSite=Strict; Secure/);
    } finally {archived = false;}
    const local = {network: true, person: null, client: null, body: {}};
    assert.equal((await request('/api/fusion/background/tick', local)).status, 403);
    assert.equal((await request('/api/fusion/background/tick', {...local, headers: {authorization: 'Bearer ' + secret}})).status, 200);
    await mf.setOptions({...options, bindings: {...options.bindings, FUSION_PUBLIC_ORIGIN: 'http://studio.test/path'}});
    assert.equal((await studio('state', proxy)).status, 503);
  });
  console.log(JSON.stringify({passed: passes.length, failed: failures.length, modelFixtureCalls: modelCalls.length, collectorFixtureCalls: collectorRequests.length}));
  assert.equal(failures.length, 0, failures.map(({name, error}) => name + ': ' + error.message).join('\n'));
} finally {
  await mf.dispose(); await mock.close();
  const target = realpathSync(persistentState);
  assert.equal(dirname(target), temporaryRoot); assert.ok(basename(target).startsWith('fusion-access-'));
  rmSync(target, {recursive: true});
}
