import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {mkdirSync, readFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

mkdirSync('.sites-runtime/tests', {recursive: true});
await build({entryPoints: ['tests/fusion-uploads-worker.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: '.sites-runtime/tests/fusion-uploads.mjs'});
const stateRoot = path.resolve('.sites-runtime/tests');
const state = path.join(stateRoot, 'upload-state-' + crypto.randomUUID());
const options = {modules: true, scriptPath: '.sites-runtime/tests/fusion-uploads.mjs', compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BUCKET'], d1Persist: path.join(state, 'd1'), r2Persist: path.join(state, 'r2'), bindings: {FUSION_STORAGE_QUOTA_BYTES: 100}};
let mf = new Miniflare(options);
async function upload(name, content, owner = 'client:a', extra = {}) {
  const form = new FormData();form.set('file', new File([content], name));form.set('mode', /\.(md|markdown)$/i.test(name) ? 'markdown' : 'parse');
  const request = new Request('https://uploads.test/', {method: 'POST', body: form});
  const r = await mf.dispatchFetch(request.url, {method: 'POST', headers: {'content-type': request.headers.get('content-type'), 'x-test-owner': owner, ...extra}, body: await request.arrayBuffer()});
  return {status: r.status, ...await r.json()};
}
async function usage(owner = 'client:a') {return (await mf.dispatchFetch('https://uploads.test/', {headers: {'x-test-owner': owner}})).json();}
async function objects() {return (await (await mf.getR2Bucket('BUCKET')).list()).objects;}
async function count(owner) {return (await (await mf.getD1Database('DB')).prepare("SELECT count(*) n FROM studio_records WHERE owner=? AND kind='library'").bind(owner).first()).n;}
try {
  let db = await mf.getD1Database('DB');await db.exec(readFileSync('drizzle/0000_mature_bug.sql', 'utf8').replace(/--> statement-breakpoint/g, '').replace(/\n/g, ' '));
  const first = await upload('same.md', 'abc');assert.equal(first.status, 200);assert.equal(first.duplicate, false);assert.equal(first.file.sourceVersion, 1);
  const copied = await upload('other-name.md', 'abc');assert.equal(copied.duplicate, true);assert.equal(copied.file.id, first.file.id);assert.equal((await objects()).length, 1);
  const parsedSame = await upload('same.txt', 'abc');assert.equal(parsedSame.duplicate, true);assert.equal((await objects()).length, 1);
  await db.prepare("UPDATE studio_records SET payload=json_remove(payload,'$.sourceVersion') WHERE id=?").bind(first.file.id).run(); // legacy library records did not include a version
  const second = await upload('same.md', 'abcd');assert.equal(second.status, 200);assert.equal(second.file.sourceVersion, 2);assert.equal(second.file.previousId, first.file.id);assert.equal(second.file.familyId, first.file.id);
  let bucket = await mf.getR2Bucket('BUCKET');assert.equal(await (await bucket.get(first.file.fileKey)).text(), 'abc');assert.equal((await usage()).usedBytes, 7);
  const other = await upload('same.md', 'abc', 'client:b');assert.equal(other.duplicate, false);assert.notEqual(other.file.id, first.file.id);assert.equal((await usage('client:b')).usedBytes, 3);
  const parsed = await upload('new.txt', 'hello');assert.equal(parsed.status, 200);assert.equal(parsed.file.originalSize, 5);assert.ok(parsed.file.originalKey);assert.equal((await usage()).usedBytes, 17);
  const bomBytes = new Uint8Array([239,187,191,...new TextEncoder().encode('BOM sample')]);const bom=await upload('bom.md',bomBytes,'client:bom');assert.ok(bom.file.originalKey);assert.deepEqual(new Uint8Array(await(await bucket.get(bom.file.originalKey)).arrayBuffer()),bomBytes);assert.equal(await(await bucket.get(bom.file.fileKey)).text(),'BOM sample');
  const before = (await objects()).length;
  assert.equal((await upload('broken.docx', 'not a zip')).status, 400);
  assert.equal((await upload('invalid.md', new Uint8Array([255, 254]))).status, 400);
  assert.equal((await upload('huge.txt', 'x'.repeat(2 * 1024 * 1024 + 1))).status, 400);
  assert.equal((await objects()).length, before);
  const failedWrite = await upload('failure.txt', 'will fail', 'client:a', {'x-test-fail-original': '1'});assert.equal(failedWrite.status, 500);assert.equal((await objects()).length, before);assert.equal((await usage()).usedBytes, 17);
  const concurrent = await Promise.all(Array.from({length: 5}, () => upload('concurrent.txt', 'concurrent', 'client:c')));
  assert.equal(concurrent.filter(r => r.status === 200 && !r.duplicate).length, 1);assert.ok(concurrent.every(r => r.status === 409 || r.status === 200));assert.equal(await count('client:c'), 1);assert.equal((await usage('client:c')).usedBytes, 20);
  const almost = await upload('quota.md', 'q'.repeat(80), 'client:quota');assert.equal(almost.status, 200);assert.equal((await usage('client:quota')).warning, true);
  const rejected = await upload('full.md', 'r'.repeat(21), 'client:quota');assert.equal(rejected.status, 413);assert.equal(await count('client:quota'), 1);assert.equal((await usage('client:quota')).usedBytes, 80);
  assert.equal((await upload('quota-copy.md', 'q'.repeat(80), 'client:quota')).duplicate, true);
  const quotaRace = await Promise.all([upload('a.md', 'a'.repeat(60), 'client:race'), upload('b.md', 'b'.repeat(60), 'client:race')]);
  assert.equal(quotaRace.filter(r => r.status === 200).length, 1);assert.ok(quotaRace.some(r => [409, 413].includes(r.status)));assert.equal((await usage('client:race')).usedBytes, 60);
  // Existing documents participate in deduplication and shared blob references count only once.
  await db.prepare("INSERT INTO studio_records(id,kind,owner,state,revision,payload,created,updated) VALUES('document-a','document','client:a','review',1,?,'2026-01-01','2026-01-01')").bind(JSON.stringify({name:'source.md',fileKey:first.file.fileKey,hash:first.file.sha256,markdown:'abc'})).run();
  assert.equal((await usage()).usedBytes, 17);
  const oldText = 'legacy';await bucket.put('legacy.md', oldText);
  const oldHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(oldText))).toString('hex');
  await db.prepare("INSERT INTO studio_records(id,kind,owner,state,revision,payload,created,updated) VALUES('document-legacy','document','client:legacy','review',1,?,'2026-01-01','2026-01-01')").bind(JSON.stringify({name:'legacy.md',fileKey:'legacy.md',hash:oldHash,markdown:oldText})).run();
  const legacy = await upload('legacy-copy.md', oldText, 'client:legacy');assert.equal(legacy.duplicate, true);assert.equal(legacy.file.kind, 'document');assert.equal((await usage('client:legacy')).usedBytes, 6);
  // Simulate an interrupted write; the next upload cleans only its abandoned manifest.
  await bucket.put('abandoned.md', 'temporary');
  await db.prepare("INSERT INTO studio_upload_locks(owner,token,expires) VALUES('client:stale','abandoned',0)").run();
  await db.prepare("INSERT INTO studio_upload_pending(token,owner,fileKey,originalKey) VALUES('abandoned','client:stale','abandoned.md',NULL)").run();
  assert.equal((await upload('resumed.md', 'recovered', 'client:stale')).status, 200);assert.equal(await bucket.head('abandoned.md'), null);assert.ok(await bucket.head(first.file.fileKey));
  const beforeRestart = await usage(), objectCount = (await objects()).length;
  await mf.dispose();mf = new Miniflare(options);db = await mf.getD1Database('DB');bucket = await mf.getR2Bucket('BUCKET');
  assert.deepEqual(await usage(), beforeRestart);assert.equal((await objects()).length, objectCount);assert.equal(await (await bucket.get(first.file.fileKey)).text(), 'abc');
  assert.equal((await upload('restart-copy.txt', 'hello')).file.id, parsed.file.id);
  console.log('PASS: isolated uploads, exact/parsed/document deduplication, original retention only after parse, rollback, version history, quota warnings/rejection/races, concurrency, interrupted cleanup and D1/R2 restart persistence. No model or real customer data used.');
} finally {
  await mf.dispose();
  assert.ok(state.startsWith(stateRoot + path.sep));rmSync(state, {recursive: true, force: true});
}
