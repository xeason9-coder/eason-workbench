import {api} from './studio/api';
import {collector, fusionSession, publicOrigin, requireSameOrigin} from './fusion-service';
import {timingSafeEqual} from 'node:crypto';

type R = Record<string, any>;
const json = (value: any, status = 200, extra = {}) => Response.json(value, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra}});
let schemaReady = false;
async function ensureSchema(env: R) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS studio_records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,owner TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,payload TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS studio_owner_kind ON studio_records(owner,kind)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS studio_queue ON studio_records(state,kind,updated)')
  ]);
  schemaReady = true;
}

export async function fusionApi(request: Request, env: R) {
  try {
    requireSameOrigin(request, env);
    await ensureSchema(env);
    const url = new URL(request.url), path = url.pathname.replace('/api/fusion/', '');
    if (path === 'select' && request.method === 'POST') {
      const {id} = await request.json() as R;
      const headers = new Headers(request.headers);
      headers.set('cookie', (headers.get('cookie') || '').split(';').filter(v => !v.trim().startsWith('fusion_client=')).join(';'));
      const session = await fusionSession(new Request(request.url, {headers}), env);
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_.-]{1,60}$/.test(id) || !session.clients.some((c: R) => c.id === id)) return json({error: '无权访问此客户'}, 403);
      return json({ok: true}, 200, {'Set-Cookie': `fusion_client=${id}; Path=/; HttpOnly; SameSite=Strict${publicOrigin(env) ? '; Secure' : ''}`});
    }
    if (path === 'background/tick') {
      const expected = Buffer.from('Bearer ' + (env.FUSION_SERVICE_TOKEN || '')), supplied = Buffer.from(request.headers.get('authorization') || '');
      if (!env.FUSION_SERVICE_TOKEN || expected.length !== supplied.length || !timingSafeEqual(expected, supplied) || request.method !== 'POST') return json({error: '无权访问'}, 403);
      const stale = new Date(Date.now() - 180000).toISOString();
      await env.DB.prepare("UPDATE studio_records SET state='failed', revision=revision+1, payload=json_set(payload,'$.error','上次执行已中断；已保存中间结果，请明确重试当前步骤。','$.autoAdvance',json('false')) WHERE kind IN ('task','ingestion') AND state='running' AND updated<?").bind(stale).run();
      const queueWhere = "state='waiting' AND json_extract(payload,'$.autoAdvance')=1 AND (kind='ingestion' OR (kind='task' AND json_extract(payload,'$.stage') IN ('planning','research','write','check','revise')))";
      if (!await env.DB.prepare('SELECT id FROM studio_records WHERE ' + queueWhere + ' LIMIT 1').first()) return json({processed: []});
      const accessResponse = await collector(new Request(url.origin), env, 'internal/clients');
      if (!accessResponse.ok) return json({error: '暂时无法核对客户状态，后台任务已保留'}, 503);
      const access: R = await accessResponse.json();
      if (!Array.isArray(access.active_ids) || access.active_ids.some((id: any) => typeof id !== 'string')) throw Error('客户状态返回无效');
      const activeOwners = JSON.stringify(access.active_ids.map((id: string) => 'client:' + id));
      await env.DB.prepare("UPDATE studio_records SET payload=json_set(payload,'$.autoAdvance',json('false')) WHERE owner LIKE 'client:%' AND owner NOT IN (SELECT value FROM json_each(?)) AND kind IN ('task','ingestion') AND state IN ('waiting','running')").bind(activeOwners).run();
      const rows = await env.DB.prepare('SELECT * FROM studio_records WHERE ' + queueWhere + ' AND owner IN (SELECT value FROM json_each(?)) ORDER BY updated LIMIT 2').bind(activeOwners).all();
      const jobs = rows.results.filter((r: R) => {
        const p = JSON.parse(r.payload);
        return r.kind === 'ingestion' || ['planning', 'research', 'write', 'check', 'revise'].includes(p.stage);
      }).slice(0, 2);
      const results = await Promise.all(jobs.map(async (r: R) => {
        const clientId = r.owner.startsWith('client:') ? r.owner.slice(7) : '';
        if (!clientId) return {id: r.id, error: '空间标识无效'};
        const context = {user: {id: 'local-background', username: '后台调度', role: 'admin'}, client: {id: clientId, role: 'manager', grants: {documents: [], tasks: [], articles: []}}};
        const payload = {id: r.id, revision: r.revision};
        const p = JSON.parse(r.payload);
        const action = r.kind === 'ingestion' ? 'ingestionRun' : p.stage === 'planning' ? 'planTopics' : 'run';
        const req = new Request(url.origin + '/api/studio/' + action, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
        const response = await api(req, {...env, FUSION_CONTEXT: context, FUSION_BACKGROUND: true});
        const result: R = await response.json();
        return {id: r.id, status: response.status, stage: result.stage, state: result.state, error: result.error};
      }));
      return json({processed: results});
    }
    const allowed = /^(?:auth\/(?:login|logout|session)|clients(?:\/[a-zA-Z0-9_.-]+(?:\/members(?:\/[a-zA-Z0-9_.-]+)?)?)?|admin\/users(?:\/[a-zA-Z0-9_.-]+)?|monitor\/[a-zA-Z0-9_\-/]+)$/;
    if (!allowed.test(path)) return json({error: '接口不存在'}, 404);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    if (body && body.byteLength > 65536) return json({error: '请求过大'}, 413);
    if (/^clients\/[^/]+\/members$/.test(path) && request.method === 'PUT' && body) {
      const value = JSON.parse(new TextDecoder().decode(body)), clientId = path.split('/')[1];
      const session = await fusionSession(request, env);
      if (!session.clients.some((c: R) => c.id === clientId && c.role === 'manager')) return json({error: '需要客户管理员权限'}, 403);
      for (const [kind, kinds] of [['documents', ['document', 'library']], ['tasks', ['task']]] as const) {
        const ids = value.grants?.[kind] || [];
        if (!Array.isArray(ids) || ids.length > 1000 || ids.some((v: any) => typeof v !== 'string')) return json({error: '授权内容格式无效'}, 400);
        if (!ids.length) continue;
        const rows = await env.DB.prepare("SELECT id,kind FROM studio_records WHERE owner=? AND id IN (SELECT value FROM json_each(?))").bind('client:' + clientId, JSON.stringify(ids)).all();
        if (ids.some((id: string) => !rows.results.some((r: R) => r.id === id && (kinds as readonly string[]).includes(r.kind)))) return json({error: '授权内容不属于此客户空间'}, 400);
      }
    }
    let response = await collector(request, env, path + url.search, {method: request.method, headers: {'Content-Type': request.headers.get('content-type') || 'application/json'}, body});
    let clearClient = false;
    if (path === 'auth/session' && response.status === 404) {
      const headers = new Headers(request.headers);
      headers.set('cookie', (headers.get('cookie') || '').split(';').filter(v => !v.trim().startsWith('fusion_client=')).join(';'));
      response = await collector(new Request(request.url, {headers}), env, 'auth/session');
      clearClient = response.ok;
    }
    const headers = new Headers(response.headers);
    headers.delete('server'); headers.delete('content-length');
    headers.set('Cache-Control', 'no-store');
    if (clearClient || response.ok && ['auth/login', 'auth/logout'].includes(path)) headers.append('Set-Cookie', 'fusion_client=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' + (publicOrigin(env) ? '; Secure' : ''));
    if (headers.get('content-type')?.includes('application/json')) {
      const result: R = await response.json();
      if (!response.ok) return json({error: typeof result.detail === 'string' ? result.detail : result.error || '请求未完成', detail: result.detail}, response.status);
      if (/^clients\/[^/]+$/.test(path) && request.method === 'PUT' && result.archived === true) await env.DB.prepare("UPDATE studio_records SET payload=json_set(payload,'$.autoAdvance',json('false')) WHERE owner=? AND kind IN ('task','ingestion')").bind('client:' + path.split('/')[1]).run();
      const rewritten = JSON.stringify(result).replaceAll('/workbench/api/', '/api/fusion/monitor/');
      return new Response(rewritten, {status: response.status, headers});
    }
    return new Response(response.body, {status: response.status, headers});
  } catch (e: any) {
    return json({error: e.message || '操作失败'}, e.code || 400);
  }
}

export async function fusionStudio(request: Request, env: R) {
  try {
    requireSameOrigin(request, env);
    await ensureSchema(env);
    const session = await fusionSession(request, env);
    if (!session.client) return json({error: '请先选择客户空间'}, 409);
    return api(request, {...env, FUSION_CONTEXT: session});
  } catch (e: any) { return json({error: e.message || '登录服务未响应'}, e.code || 503); }
}
