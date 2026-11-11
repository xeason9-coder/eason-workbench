import {parseUpload} from './parse-upload';

type R = Record<string, any>;
const encoder = new TextEncoder();
const leaseMs = 10 * 60 * 1000;
function fail(message: string, code = 400): never { throw Object.assign(new Error(message), {code}); }
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))).map(n => n.toString(16).padStart(2, '0')).join('');

export async function ensureUploadSchema(env: any) {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS studio_upload_locks (owner TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS studio_upload_pending (token TEXT PRIMARY KEY, owner TEXT NOT NULL, fileKey TEXT NOT NULL, originalKey TEXT)')
  ]);
}

function quota(env: any) {
  const value = env.FUSION_STORAGE_QUOTA_BYTES === undefined ? 512 * 1024 * 1024 : Number(env.FUSION_STORAGE_QUOTA_BYTES);
  if (!Number.isSafeInteger(value) || value < 1) fail('客户存储配额配置无效', 503);
  return value;
}

export async function storageUsage(env: any, uid: string) {
  const rows = await env.DB.prepare("SELECT json_extract(payload,'$.fileKey') fileKey,json_extract(payload,'$.size') size,json_extract(payload,'$.originalKey') originalKey,json_extract(payload,'$.originalSize') originalSize FROM studio_records WHERE owner=? AND kind IN ('library','document')").bind(uid).all();
  const keys = new Map<string, number | null>();
  for (const row of rows.results) for (const [key, size] of [[row.fileKey, row.size], [row.originalKey, row.originalSize]]) {
    if (!key) continue;
    const bytes = typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null;
    if (!keys.has(key) || bytes !== null && (keys.get(key) === null || bytes > keys.get(key)!)) keys.set(key, bytes);
  }
  let usedBytes = 0;
  for (const [key, size] of keys) usedBytes += size ?? (await env.BUCKET.head(key))?.size ?? 0;
  const quotaBytes = quota(env);
  return {usedBytes, quotaBytes, warning: usedBytes >= quotaBytes * .8};
}

function record(row: R) {
  const p = JSON.parse(row.payload);
  return {...p, id: row.id, owner: row.owner, kind: row.kind, state: row.state, revision: row.revision, created: row.created, updated: row.updated,
    sha256: p.sha256 || p.hash, hash: p.hash || p.sha256, ...(row.kind === 'document' ? {isDocument: true} : {})};
}

async function duplicate(env: any, uid: string, hash: string) {
  const row = await env.DB.prepare("SELECT * FROM studio_records WHERE owner=? AND ((kind='library' AND (json_extract(payload,'$.originalHash')=? OR json_extract(payload,'$.sha256')=?)) OR (kind='document' AND json_extract(payload,'$.hash')=?)) ORDER BY CASE kind WHEN 'library' THEN 0 ELSE 1 END,created LIMIT 1").bind(uid, hash, hash, hash).first();
  return row ? record(row) : null;
}

export async function receiveUpload(form: FormData, env: any, uid: string): Promise<{file: R, duplicate: boolean}> {
  if (!uid || typeof uid !== 'string') fail('缺少客户空间', 401);
  const file = form.get('file'), mode = form.get('mode'), isMarkdown = mode === 'markdown';
  if (!(file instanceof File)) fail('请选择文件');
  if (!['markdown', 'parse'].includes(String(mode))) fail('上传方式无效');
  if (isMarkdown ? !/\.(md|markdown)$/i.test(file.name) : !/\.(pdf|docx|pptx|xlsx|txt)$/i.test(file.name)) fail(isMarkdown ? '请选择 Markdown 文件' : '支持 PDF、DOCX、PPTX、XLSX、TXT');
  if (!file.size || file.size > (isMarkdown ? 2 : 20) * 1024 * 1024) fail(isMarkdown ? 'Markdown 最大2 MB' : '原始文件最大20 MB');
  if (!file.name.trim() || file.name.length > 500 || /[\x00-\x1f\\/]/.test(file.name)) fail('文件名无效');
  const bytes = new Uint8Array(await file.arrayBuffer()), originalHash = await digest(bytes);
  const existing = await duplicate(env, uid, originalHash);
  if (existing) return {file: existing, duplicate: true};
  await ensureUploadSchema(env);
  const token = crypto.randomUUID(), id = crypto.randomUUID(), fileKey = 'library/' + encodeURIComponent(uid) + '/' + id + '.md';
  let originalKey: string | null = isMarkdown ? null : 'library/' + encodeURIComponent(uid) + '/' + id + '.original';
  // shortcut: one upload per client; use per-fingerprint leases plus atomic quota reservations if parallel uploads are needed.
  const lock = await env.DB.prepare('INSERT INTO studio_upload_locks(owner,token,expires) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE studio_upload_locks.expires<?').bind(uid, token, Date.now() + leaseMs, Date.now()).run();
  if (lock.meta.changes !== 1) fail('该客户有资料正在上传，请稍后重试', 409);
  const renew = async () => {
    const result = await env.DB.prepare('UPDATE studio_upload_locks SET expires=? WHERE owner=? AND token=?').bind(Date.now() + leaseMs, uid, token).run();
    if (result.meta.changes !== 1) fail('上传已中断，请重新上传', 409);
  };
  const removePending = async (pending: R) => {
    await env.BUCKET.delete([pending.fileKey, pending.originalKey].filter(Boolean));
    await env.DB.prepare('DELETE FROM studio_upload_pending WHERE token=? AND owner=?').bind(pending.token, uid).run();
  };
  try {
    const stale = await env.DB.prepare('SELECT * FROM studio_upload_pending WHERE owner=? AND token<>?').bind(uid, token).all();
    for (const pending of stale.results) await removePending(pending);
    const raced = await duplicate(env, uid, originalHash);
    if (raced) return {file: raced, duplicate: true};
    let markdown: string, warnings: string[] = [];
    if (isMarkdown) {
      try { markdown = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { fail('Markdown 请保存为 UTF-8 编码'); }
    } else {
      try { ({markdown, warnings} = await parseUpload(bytes, file.name)); } catch (e: any) { fail(e.message || '文件解析失败'); }
    }
    if (!markdown.trim()) fail('文件正文为空');
    const parsedBytes = encoder.encode(markdown);
    if (parsedBytes.length > 2 * 1024 * 1024) fail('转换结果超过2 MB，请拆分文件');
    const sha256 = await digest(parsedBytes), parsedDuplicate = await duplicate(env, uid, sha256);
    if (parsedDuplicate) return {file: parsedDuplicate, duplicate: true};
    await renew();
    if (isMarkdown && originalHash !== sha256) originalKey = 'library/' + encodeURIComponent(uid) + '/' + id + '.original';
    const usage = await storageUsage(env, uid), originalSize = originalKey ? bytes.length : 0;
    if (usage.usedBytes + parsedBytes.length + originalSize > usage.quotaBytes) fail('客户存储配额已满，无法新增资料；已有资料不会删除', 413);
    const name = isMarkdown ? file.name : file.name.replace(/\.[^.]+$/, '.md');
    const previous = await env.DB.prepare("SELECT * FROM studio_records WHERE owner=? AND kind='library' AND coalesce(json_extract(payload,'$.originalName'),json_extract(payload,'$.name'))=? ORDER BY coalesce(json_extract(payload,'$.sourceVersion'),1) DESC,created DESC LIMIT 1").bind(uid, file.name).first();
    const old = previous ? record(previous) : null, time = new Date().toISOString();
    const payload = {name, title: name.replace(/\.(md|markdown)$/i, ''), path: name, size: parsedBytes.length, sha256, hash: sha256, originalHash, originalSize, originalKey, originalName: file.name, fileKey, source: file.name, collection: '用户上传', warnings, imported: time.slice(0, 10), familyId: old?.familyId || old?.id || id, previousId: old?.id || null, sourceVersion: old ? (old.sourceVersion || 1) + 1 : 1};
    await env.DB.prepare('INSERT INTO studio_upload_pending(token,owner,fileKey,originalKey) VALUES(?,?,?,?)').bind(token, uid, fileKey, originalKey).run();
    await renew();
    await env.BUCKET.put(fileKey, parsedBytes, {httpMetadata: {contentType: 'text/markdown;charset=utf-8'}});
    if (originalKey) { await renew(); await env.BUCKET.put(originalKey, bytes, {httpMetadata: {contentType: 'application/octet-stream'}}); }
    await renew();
    const result = await env.DB.batch([
      env.DB.prepare("INSERT INTO studio_records(id,kind,owner,state,revision,payload,created,updated) SELECT ?,'library',?,'stored',1,?,?,? WHERE EXISTS (SELECT 1 FROM studio_upload_locks WHERE owner=? AND token=?)").bind(id, uid, JSON.stringify(payload), time, time, uid, token),
      env.DB.prepare('DELETE FROM studio_upload_pending WHERE token=? AND owner=?').bind(token, uid),
      env.DB.prepare('DELETE FROM studio_upload_locks WHERE owner=? AND token=?').bind(uid, token)
    ]);
    if (result[0].meta.changes !== 1) fail('上传已中断，请重新上传', 409);
    return {file: {...payload, id, owner: uid, kind: 'library', state: 'stored', revision: 1, created: time, updated: time}, duplicate: false};
  } catch (error) {
    // A response may fail after D1 committed; never remove a successfully referenced object.
    const saved = await env.DB.prepare("SELECT * FROM studio_records WHERE id=? AND owner=? AND kind='library'").bind(id, uid).first();
    if (saved) return {file: record(saved), duplicate: false};
    await removePending({token, fileKey, originalKey});
    throw error;
  } finally {
    await env.DB.prepare('DELETE FROM studio_upload_locks WHERE owner=? AND token=?').bind(uid, token).run();
  }
}
