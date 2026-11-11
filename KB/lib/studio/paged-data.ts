import {classifyKnowledge} from './knowledge-model.mjs';
import {knowledgeTypes} from './ingestion-agent.mjs';

type R = Record<string, any>;
function fail(message: string, code = 400): never {throw Object.assign(new Error(message), {code});}
function params(req: Request) {
  const p = new URL(req.url).searchParams;
  const integer = (key: string, fallback: number, max: number) => {
    const raw = p.get(key);if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) fail('分页参数无效');
    return Number(raw);
  };
  const q = (p.get('q') || '').trim();if (q.length > 200) fail('搜索内容过长');
  return {p, q, page: integer('page', 1, 1000000), pageSize: integer('pageSize', 20, 50)};
}
function access(uid: string, client: R) {
  if (!uid) fail('缺少客户空间', 401);
  const external = client?.role === 'external';
  return {external, binds: [uid, external ? 1 : 0, JSON.stringify(external ? client?.grants?.documents || [] : [])]};
}
const scope = `authorized AS (SELECT * FROM studio_records WHERE owner=? AND kind IN ('library','document') AND (?=0 OR id IN (SELECT value FROM json_each(?))))`;
const libraryBase = `WITH ${scope}, merged AS (
 SELECT * FROM authorized a WHERE kind='document' OR NOT EXISTS (SELECT 1 FROM authorized d WHERE d.kind='document' AND json_extract(d.payload,'$.hash')=json_extract(a.payload,'$.sha256'))
), entries AS (
 SELECT *,coalesce(json_extract(payload,'$.name'),'') name,
 CASE WHEN kind='document' THEN coalesce(json_extract(payload,'$.name'),'') ELSE coalesce(json_extract(payload,'$.path'),json_extract(payload,'$.name'),'') END path,
 coalesce(json_extract(payload,'$.semantic'),0) semantic FROM merged
), files AS (
 SELECT *,CASE WHEN instr(path,'/')=0 THEN '根目录' ELSE substr(path,1,length(path)-length(json_extract('['||replace(json_quote(path),'/', '\",\"')||']','$[#-1]'))-1) END folder FROM entries
)`;
const fileFields = `id,kind,state,revision,created,updated,name,path,folder,semantic,
 coalesce(json_extract(payload,'$.title'),name) title,
 coalesce(json_extract(payload,'$.size'),length(CAST(json_extract(payload,'$.markdown') AS BLOB)),0) size,
 json_extract(payload,'$.source') source,json_extract(payload,'$.collection') collection,
 json_extract(payload,'$.ingestionId') ingestionId,json_extract(payload,'$.warnings') warnings,
 json_extract(payload,'$.originalName') originalName,json_extract(payload,'$.originalKey') IS NOT NULL hasOriginal,
 coalesce(json_extract(payload,'$.sourceVersion'),1) sourceVersion,
 json_extract(payload,'$.familyId') familyId,json_extract(payload,'$.previousId') previousId`;
function fileView(row: R) {return {...row, semantic: !!row.semantic, hasOriginal: !!row.hasOriginal, isDocument: row.kind === 'document', warnings: row.warnings ? JSON.parse(row.warnings) : []};}

export async function libraryPage(req: Request, env: any, uid: string, client: R) {
  const {p, q, page, pageSize} = params(req), {binds} = access(uid, client), folder = p.get('folder') || 'all';
  if (folder.length > 500 || p.has('selectAll') && p.get('selectAll') !== '1') fail('筛选参数无效');
  const selection = p.get('selectAll') === '1';
  const where = " WHERE (?='all' OR folder=?) AND instr(lower(name||' '||path),lower(?))>0" + (selection ? ' AND semantic=0' : '');
  const filter = [...binds, folder, folder, q];
  const counts = await env.DB.prepare(libraryBase + ' SELECT count(*) count FROM files' + where).bind(...filter).first();
  const count = counts.count, pages = Math.max(1, Math.ceil(count / pageSize)), current = Math.min(page, pages);
  const queries = await env.DB.batch([
    env.DB.prepare(libraryBase + ' SELECT ' + (selection ? 'id,name,semantic' : fileFields) + ' FROM files' + where + ' ORDER BY created DESC,id LIMIT ? OFFSET ?').bind(...filter, selection ? 500 : pageSize, selection ? 0 : (current - 1) * pageSize),
    env.DB.prepare(libraryBase + ' SELECT DISTINCT folder FROM files ORDER BY folder').bind(...binds),
    env.DB.prepare(libraryBase + ' SELECT count(*) totalCount,sum(CASE WHEN semantic=0 THEN 1 ELSE 0 END) pendingCount FROM files').bind(...binds)
  ]);
  return {pagination: true, files: selection ? queries[0].results : queries[0].results.map(fileView), count, page: current, pageSize, pages,
    folders: queries[1].results.map((r: R) => r.folder), totalCount: queries[2].results[0].totalCount, pendingCount: queries[2].results[0].pendingCount || 0,
    total: 0, seedCount: 0, ...(selection ? {selectionTotal: count, truncated: count > 500} : {})};
}

// Existing records normally persist classification; SQL fallback preserves filters for older chunks.
const inferredType = `CASE
 WHEN instr(title||body,'费率') OR instr(title||body,'手续费') OR instr(title||body,'收费') OR instr(title||body,'佣金') OR instr(title||body,'公式') THEN '费用与计算'
 WHEN instr(title,'步骤') OR instr(title,'如何') OR instr(title,'操作') OR instr(title,'绑定') OR instr(title,'注册流程') THEN '操作流程'
 WHEN instr(title,'市场') OR instr(title,'行业') OR instr(title,'白皮书') OR instr(title,'调研') THEN '市场研究'
 WHEN instr(title,'案例') THEN '客户案例'
 WHEN instr(title||body,'法务') OR instr(title||body,'合规') OR instr(title||body,'禁止') OR instr(title||body,'不得') OR instr(title||body,'仅限') OR instr(title||body,'资格') OR instr(title||body,'适用条件') THEN '规则与条件'
 ELSE '产品说明' END`;
const knowledgeBase = `WITH ${scope}, source AS (SELECT * FROM authorized WHERE kind='document'), base AS (
 SELECT k.*,d.id sourceId,d.state sourceState,d.revision sourceRevision,d.payload sourcePayload,
 coalesce(json_extract(k.payload,'$.title'),'') title,coalesce(json_extract(k.payload,'$.body'),'') body,
 json_extract(k.payload,'$.docId') docId FROM studio_records k JOIN source d ON d.id=json_extract(k.payload,'$.docId') WHERE k.owner=? AND k.kind='chunk' AND k.state<>'excluded'
), items AS (
 SELECT *,coalesce(json_extract(payload,'$.type'),${inferredType}) knowledgeType,
 CASE WHEN state='approved' AND sourceState='ready' AND json_extract(payload,'$.docRevision')=sourceRevision
 AND coalesce(json_extract(sourcePayload,'$.supersededBy'),'')='' AND coalesce(json_extract(sourcePayload,'$.disabled'),0)=0
 AND (coalesce(json_extract(sourcePayload,'$.effective'),'')='' OR julianday(json_extract(sourcePayload,'$.effective'))<=julianday('now'))
 AND (coalesce(json_extract(sourcePayload,'$.expires'),'')='' OR julianday(json_extract(sourcePayload,'$.expires'))>julianday('now')) THEN 1 ELSE 0 END available,
 coalesce(json_array_length(json_extract(payload,'$.risks')),0) riskCount FROM base
)`;
const itemFields = `id,state,revision,created,updated,title,body,docId,knowledgeType type,available,
 json_extract(payload,'$.heading') heading,json_extract(payload,'$.products') products,json_extract(payload,'$.platforms') platforms,
 json_extract(payload,'$.regions') regions,json_extract(payload,'$.keywords') keywords,json_extract(payload,'$.risks') risks,
 json_extract(payload,'$.classification') classification,json_extract(payload,'$.start') start,json_extract(payload,'$.end') end,
 json_extract(payload,'$.external') external,json_extract(payload,'$.purpose') purpose,
 coalesce(json_extract(sourcePayload,'$.sourceVersion'),1) sourceVersion,json_extract(sourcePayload,'$.name') sourceName`;
function itemView(row: R) {
  const inferred: R = classifyKnowledge(row.body, row.title), out: R = {...inferred, ...row, available: !!row.available, external: !!row.external};
  for (const key of ['heading','products','platforms','regions','keywords','risks']) out[key] = row[key] === null ? inferred[key] || [] : JSON.parse(row[key]);
  out.classification ||= inferred.classification;
  return out;
}

export async function knowledgePage(req: Request, env: any, uid: string, client: R) {
  const {p, q, page, pageSize} = params(req), {external, binds} = access(uid, client), status = p.get('status') || 'all', type = p.get('type') || 'all', id = p.get('id');
  if (!['all','available','pending','history'].includes(status) || type !== 'all' && !knowledgeTypes.includes(type) || id && id.length > 200) fail('筛选参数无效');
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS studio_owner_chunk_document ON studio_records(owner,kind,json_extract(payload,'$.docId'))").run();
  const scoped = [...binds, uid];
  const where = ` WHERE (?='all' OR ?='available' AND available=1 OR ?='pending' AND state='pending' OR ?='history' AND available=0 AND state='approved') AND (?='all' OR knowledgeType=?)
 AND instr(lower(title||' '||body||' '||coalesce(json_extract(payload,'$.products'),'')||' '||coalesce(json_extract(payload,'$.platforms'),'')||' '||coalesce(json_extract(payload,'$.regions'),'')||' '||coalesce(json_extract(payload,'$.keywords'),'')),lower(?))>0` + (id ? ' AND id=?' : '');
  const filtered = [...scoped, status, status, status, status, type, type, q, ...(id ? [id] : [])];
  const counts = await env.DB.prepare(knowledgeBase + ' SELECT count(*) count FROM items' + where).bind(...filtered).first();
  if (id && !counts.count) fail('知识条目不存在或无权访问', 404);
  const count = counts.count, pages = Math.max(1, Math.ceil(count / pageSize)), current = Math.min(page, pages);
  const results = await env.DB.batch([
    env.DB.prepare(knowledgeBase + ' SELECT ' + itemFields + ' FROM items' + where + ' ORDER BY created DESC,id LIMIT ? OFFSET ?').bind(...filtered, pageSize, (current - 1) * pageSize),
    env.DB.prepare(knowledgeBase + " SELECT count(*) total,sum(available) available,sum(CASE WHEN state='pending' THEN 1 ELSE 0 END) pending,sum(CASE WHEN state='pending' AND riskCount>0 THEN 1 ELSE 0 END) priority FROM items").bind(...scoped),
    env.DB.prepare(knowledgeBase + " SELECT id FROM items WHERE state='pending' AND riskCount=0 ORDER BY created,id LIMIT 200").bind(...scoped)
  ]);
  const items = results[0].results.map(itemView);
  if (items.length) {
    const relations = await env.DB.batch(items.map((item: R) => {
      const tags = JSON.stringify({products:item.products||[],platforms:item.platforms||[],regions:item.regions||[]});
      return env.DB.prepare(knowledgeBase + `, matches AS (SELECT id,title,docId,
       (SELECT json_group_array(DISTINCT tag.value) FROM json_each(json_object('products',json_extract(payload,'$.products'),'platforms',json_extract(payload,'$.platforms'),'regions',json_extract(payload,'$.regions'))) arr, json_each(arr.value) tag WHERE tag.value IN (SELECT value FROM json_each(json_extract(?,'$.'||arr.key)))) sharedTags
       FROM items WHERE id<>?), related AS (SELECT *,json_array_length(sharedTags) shared FROM matches) SELECT id,title,docId,sharedTags FROM related WHERE docId=? OR shared>0 ORDER BY shared*3+(docId=?)*2 DESC,id LIMIT 8`).bind(...scoped, tags, item.id, item.docId, item.docId);
    }));
    items.forEach((item: R, i: number) => {item.related = relations[i].results.map((r: R) => ({id: r.id, title: r.title, docId: r.docId, reason: r.docId === item.docId ? '同一来源章节' : '共同实体：' + JSON.parse(r.sharedTags).join('、')}));});
  }
  const sourceIds = [...new Set(items.map((k: R) => k.docId))];
  const docs = sourceIds.length ? await env.DB.prepare(`WITH ${scope} SELECT id,state,revision,json_extract(payload,'$.name') name,coalesce(json_extract(payload,'$.sourceVersion'),1) sourceVersion FROM authorized WHERE kind='document' AND id IN (SELECT value FROM json_each(?))`).bind(...binds, JSON.stringify(sourceIds)).all() : {results: []};
  const stats = Object.fromEntries(Object.entries(results[1].results[0]).map(([key, value]) => [key, value || 0]));
  return {pagination: true, items, documents: docs.results, count, page: current, pageSize, pages, stats, safePendingIds: external ? [] : results[2].results.map((r: R) => r.id)};
}
