// Local-only live acceptance. --self-test never reads credentials or contacts services.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,chmodSync} from 'node:fs';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const origin='http://127.0.0.1:5173';
const root=fileURLToPath(new URL('../../',import.meta.url));
const runtime=path.join(root,'runtime');
const receiptPath=path.join(runtime,'live-acceptance.json');
const accountsPath=path.join(runtime,'acceptance-accounts.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class CookieJar {
  cookies=new Map();
  accept(headers){for(const raw of headers.getSetCookie()){
    const [pair,...attributes]=raw.split(';'),at=pair.indexOf('=');if(at<1)continue;
    const name=pair.slice(0,at).trim(),value=pair.slice(at+1);
    const expired=attributes.some(a=>/^\s*max-age\s*=\s*0\s*$/i.test(a)||/^\s*expires=/i.test(a)&&Date.parse(a.slice(a.indexOf('=')+1))<=Date.now());
    if(expired)this.cookies.delete(name);else this.cookies.set(name,value);
  }}
  header(){return [...this.cookies].map(([key,value])=>key+'='+value).join('; ');}
}
function cookieSelfTest(){const jar=new CookieJar(),h=new Headers();h.append('Set-Cookie','session=a=b; HttpOnly; Path=/');h.append('Set-Cookie','fusion_client=first; Path=/');jar.accept(h);assert.equal(jar.header(),'session=a=b; fusion_client=first');jar.accept(new Headers({'Set-Cookie':'fusion_client=second; Path=/'}));assert.equal(jar.cookies.get('fusion_client'),'second');jar.accept(new Headers({'Set-Cookie':'session=; Max-Age=0; Path=/'}));assert.equal(jar.header(),'fusion_client=second');jar.accept(new Headers({'Set-Cookie':'fusion_client=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'}));assert.equal(jar.header(),'');}
cookieSelfTest();

async function main(){
  if(existsSync(path.join(runtime,'acceptance-cleaned.json')))throw Object.assign(Error('本轮验收数据已清理；禁止使用旧收据在正式空间重建测试资料和账号。'),{code:'ACCEPTANCE_ALREADY_CLEANED'});
  mkdirSync(runtime,{recursive:true});
  const receipt=existsSync(receiptPath)?JSON.parse(readFileSync(receiptPath,'utf8')):{version:1,runId:randomUUID(),createdAt:new Date().toISOString(),ids:{},steps:{},usage:{},attempts:{}};
  const secrets=new Set();
  const sanitize=value=>{let text=String(value??'');for(const secret of secrets)if(secret)text=text.split(secret).join('[redacted]');return text.replace(/sk-[a-zA-Z0-9_-]{12,}/g,'[redacted-key]').replace(/(Bearer|Cookie|Set-Cookie|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'$1=[redacted]').slice(0,1500);};
  function save(){receipt.updatedAt=new Date().toISOString();const temporary=receiptPath+'.'+process.pid+'.tmp';writeFileSync(temporary,JSON.stringify(receipt,null,2),{mode:0o600});renameSync(temporary,receiptPath);chmodSync(receiptPath,0o600);}
  function result(name,status,data={}){receipt.steps[name]={status,time:new Date().toISOString(),...data};save();console.log((status==='PASS'?'PASS':'FAIL')+' '+name+(status==='PASS'?'':' '+status)+(data.id?' '+data.id:'')+(data.state?' '+data.state:''));}
  async function step(name,fn){try{const value=await fn();result(name,'PASS',value||{});return value;}catch(e){result(name,e.blocked?'BLOCKED':'FAIL',{error:sanitize(e.message),code:e.code||e.status||'ASSERTION'});return null;}}
  function blocked(message,code='BLOCKED'){throw Object.assign(Error(message),{blocked:true,code});}
  const adminConfig=JSON.parse(readFileSync(path.join(root,'we-mp-rss/data/workbench-access.json'),'utf8')).admin;
  assert.ok(adminConfig?.username&&adminConfig?.password,'Existing local admin credentials are unavailable');secrets.add(adminConfig.password);
  const rawKey=readFileSync(path.join(runtime,'model-encryption.key'),'utf8').trim();assert.match(rawKey,/^[a-fA-F0-9]{64}$/,'Persistent encryption key is unavailable');const key=Buffer.from(rawKey,'hex');secrets.add(rawKey);
  let accounts;
  if(existsSync(accountsPath)){const stored=JSON.parse(readFileSync(accountsPath,'utf8'));assert.equal(stored.format,'aes-256-gcm-v1');const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(stored.iv,'hex'));decipher.setAAD(Buffer.from('fusion-acceptance-accounts-v1'));decipher.setAuthTag(Buffer.from(stored.tag,'hex'));accounts=JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.ciphertext,'hex')),decipher.final()]).toString('utf8'));}
  else{const suffix=receipt.runId.slice(0,8);accounts=Array.from({length:7},(_,i)=>({username:'accept_'+suffix+'_'+i,password:randomBytes(24).toString('base64url'),role:i===6?'external':'member'}));}
  assert.equal(accounts.length,7);for(const account of accounts)secrets.add(account.password);
  function saveAccounts(){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('fusion-acceptance-accounts-v1'));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(accounts)),cipher.final()]);const temporary=accountsPath+'.'+process.pid+'.tmp';writeFileSync(temporary,JSON.stringify({format:'aes-256-gcm-v1',iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('hex')}),{mode:0o600});renameSync(temporary,accountsPath);chmodSync(accountsPath,0o600);}
  saveAccounts();save();
  function session(){return {jar:new CookieJar()};}
  async function request(who,url,body,options={}){
    const target=new URL(url,origin);assert.equal(target.origin,origin,'Only the local KB origin is permitted');
    const headers=new Headers({'Cookie':who.jar.header(),'Origin':origin});let payload;
    if(body instanceof FormData)payload=body;else if(body!==undefined){headers.set('Content-Type','application/json');payload=JSON.stringify(body);}
    const response=await fetch(target,{method:options.method||(body===undefined?'GET':'POST'),headers,body:payload,redirect:'manual',signal:AbortSignal.timeout(options.timeout||180000)});
    who.jar.accept(response.headers);for(const value of who.jar.cookies.values())secrets.add(value);
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={text};}
    if(options.statuses){assert.ok(options.statuses.includes(response.status),'Unexpected HTTP status '+response.status+' for '+target.pathname);return {status:response.status,data};}
    if(!response.ok)throw Object.assign(Error(sanitize(data.error||data.detail||'HTTP '+response.status)),{status:response.status,code:response.status});
    return data;
  }
  const fusion=(s,url,body,options)=>request(s,'/api/fusion/'+url,body,options),studio=(s,url,body,options)=>request(s,'/api/studio/'+url,body,options);
  const select=(s,id)=>fusion(s,'select',{id});
  const admin=session();await fusion(admin,'auth/login',adminConfig);
  const setup=await step('roles-and-two-clients',async()=>{
    let clients=(await fusion(admin,'clients')).items;const a=clients.find(c=>c.name==='PMI');assert.ok(a,'Existing PMI client must already exist');
    let b=clients.find(c=>c.name==='本地验收客户（虚构）');if(!b)b=await fusion(admin,'clients',{name:'本地验收客户（虚构）',description:'虚构青禾项目服务的本地功能验收空间；内容仅供技术验收，不代表真实客户或产品事实。'});
    receipt.ids.a=a.id;receipt.ids.b=b.id;save();
    const users=(await fusion(admin,'admin/users')).items;
    for(const account of accounts){let user=users.find(u=>u.username===account.username);if(!user)user=(await fusion(admin,'admin/users',{username:account.username,password:account.password,role:'user'})).user;account.id=user.id;saveAccounts();}
    for(const [i,account] of accounts.entries()){
      await select(admin,b.id);await fusion(admin,`clients/${b.id}/members`,{user_id:account.id,role:account.role,grants:i===6?(receipt.externalGrants||{documents:[],tasks:[],articles:[]}):{documents:[],tasks:[],articles:[]}},{method:'PUT'});
      if(i<2){await select(admin,a.id);await fusion(admin,`clients/${a.id}/members`,{user_id:account.id,role:'member',grants:{documents:[],tasks:[],articles:[]}},{method:'PUT'});}
    }
    await select(admin,b.id);return {id:b.id,accounts:7};
  });
  if(!setup){process.exitCode=1;return;}
  const a=receipt.ids.a,b=receipt.ids.b,users=[];
  for(const account of accounts){const s=session();await fusion(s,'auth/login',{username:account.username,password:account.password});await select(s,b);users.push(s);}
  const internal=users[0],restricted=users[2],external=users[6];
  const marker='LOCAL_ACCEPTANCE_PRIVATE_'+receipt.runId;
  async function upload(s,name,markdown){const form=new FormData();form.set('mode','markdown');form.set('file',new File([markdown],name,{type:'text/markdown'}));return (await studio(s,'libraryUpload',form)).file;}
  await step('private-a-isolation-marker',async()=>{await select(admin,a);const file=await upload(admin,'本地隔离验收_虚构未审核.md','# 虚构隔离验收标记\n\n'+marker+'\n\n仅用于本地权限验收，内部未审核，不进入正式知识库，不用于模型生成或客户交付。');receipt.ids.aFile=file.id;save();await select(admin,b);return {id:file.id};});
  await step('three-role-access-boundaries',async()=>{
    assert.ok(receipt.ids.aFile,'Missing private isolation file');
    assert.ok(!(await fusion(restricted,'clients')).items.some(c=>c.id===a),'Unassigned client leaked into list');
    await fusion(restricted,'select',{id:a},{statuses:[403,404]});await select(restricted,b);
    await fusion(external,'select',{id:a},{statuses:[403,404]});await select(external,b);
    for(const s of [restricted,external]){
      const list=await studio(s,'library');assert.ok(!list.files.some(f=>f.id===receipt.ids.aFile),'Cross-client library row leaked');
      await studio(s,'library/'+receipt.ids.aFile,undefined,{statuses:[403,404]});await studio(s,'library/'+receipt.ids.aFile+'/download',undefined,{statuses:[403,404]});
      assert.ok(!JSON.stringify(await studio(s,'search',{query:marker})).includes(marker),'Cross-client search leaked');
      await studio(s,'modelSettings',undefined,{statuses:[403]});
      await fusion(s,`monitor/articles?client_id=${a}&days=0&view=all`,undefined,{statuses:[403,404]});
    }
    const modelMeta=await studio(admin,'modelSettings');assert.ok(!['apiKey','AI_KEY','ciphertext','iv'].some(key=>key in modelMeta),'Model credentials returned to browser');
    await fusion(internal,`clients/${b}/members`,{user_id:accounts[0].id,role:'manager',grants:{documents:[],tasks:[],articles:[]}},{method:'PUT',statuses:[403]});
    await fusion(admin,`clients/${b}/members`,{user_id:accounts[6].id,role:'external',grants:{documents:[receipt.ids.aFile],tasks:[],articles:[]}},{method:'PUT',statuses:[400,403,404]});
    const extSession=await fusion(external,'auth/session');assert.ok(!extSession.client.grants.documents.includes(receipt.ids.aFile),'Rejected grant was persisted');
    return {state:'admin/member/external boundaries checked'};
  });
  await step('seven-users-concurrent-lists-and-search',async()=>{
    const started=Date.now();const results=await Promise.allSettled(users.map(async s=>{
      const responses=await Promise.all([studio(s,'library?pageSize=10'),studio(s,'knowledge?pageSize=10'),studio(s,'search',{query:'项目协作'}),fusion(s,`monitor/articles?client_id=${b}&days=0&view=all&limit=10`)]);
      assert.ok(!JSON.stringify(responses).includes(marker),'Concurrent response leaked private marker');return true;
    }));const failed=results.filter(r=>r.status==='rejected');assert.equal(failed.length,0,'One or more real concurrent requests failed');return {users:7,requests:28,elapsedMs:Date.now()-started,paid:false};
  });
  await step('source-configure-once-and-real-sync',async()=>{
    await select(admin,a);const stateA=await fusion(admin,'monitor/state');const source=stateA.clients.find(c=>c.id===a)?.sources.find(s=>s.name==='项有所成');await select(admin,b);if(!source)blocked('PMI has no configured 项有所成 source; no source identifiers invented');
    const stateB=await fusion(admin,'monitor/state');if(!stateB.clients.find(c=>c.id===b)?.sources.some(s=>s.id===source.id))await fusion(admin,`monitor/clients/${b}/sources`,{name:source.name,identifier:source.id,category:'验收参考',enabled:true});
    receipt.ids.source=source.id;save();
    if(!receipt.ids.syncRun&&receipt.attempts.sync)blocked('A prior sync dispatch has no saved run ID; inspect monitor state before retrying','UNKNOWN_DISPATCH');
    if(!receipt.ids.syncRun){receipt.attempts.sync={state:'dispatching',time:new Date().toISOString()};save();const run=await fusion(admin,'monitor/sync',{client_id:b,source_id:source.id});receipt.ids.syncRun=run.id;save();}
    const run=await poll(async options=>{const state=await fusion(admin,'monitor/state',undefined,options);return state.runs.find(r=>r.id===receipt.ids.syncRun);},r=>r&&r.status!=='running','monitor-sync');
    receipt.sync={id:run.id,status:run.status,results:run.results.map(r=>({source_id:r.source_id,status:r.status,added:r.added,code:r.code??null,message:sanitize(r.message||'')}))};save();
    if(run.status!=='success')blocked('Source sync ended '+run.status+'; inspect receipt for genuine upstream codes',run.results.find(r=>r.code)?.code||run.status);
    return {id:run.id,state:run.status};
  });
  await select(admin,b);
  const articles=await step('read-existing-reference-article',async()=>{if(!receipt.ids.source)blocked('Configured 项有所成 source is unavailable');const rows=await fusion(admin,`monitor/articles?client_id=${b}&days=0&view=all&limit=10&source_id=${encodeURIComponent(receipt.ids.source||'')}`);if(!rows.items.length)blocked('No real monitoring article available; reference workflow will not fabricate one');receipt.ids.referenceArticle=rows.items[0].id;save();return {id:receipt.ids.referenceArticle};});
  async function poll(read,done,label){const deadline=Date.now()+360000;let last;while(Date.now()<deadline){last=await read({timeout:Math.max(1,Math.min(180000,deadline-Date.now()))});if(last){receipt.progress={label,id:last.id,state:last.state||last.status,stage:last.stage,time:new Date().toISOString()};if(last.usage)receipt.usage[last.id]=last.usage;save();if(last.state==='failed')throw Object.assign(Error(last.error||'Task failed'),{code:'MODEL_TASK_FAILED'});if(done(last))return last;}await sleep(Math.min(3000,Math.max(0,deadline-Date.now())));}blocked('Polling deadline reached; persisted job retained for inspection','POLL_TIMEOUT');}
  const fixture=`# 青禾项目服务：项目协作入门包（虚构验收资料）

## 资料性质与客户定位
青禾项目服务及本页产品均为虚构，只用于本地系统功能验收，不代表真实公司、收费承诺或客户案例。本页允许在带有“虚构验收示例”标记的测试稿中引用，不得作为真实客户对外发布。目标读者是需要整理项目信息的小型团队负责人，以及首次承担任务协调工作的成员。

## 项目协作入门包的支持范围
入门包提供资料整理建议，帮助团队把需求说明、会议记录与交付要求分别归档，并在记录中标出负责人及更新时间。资料整理建议针对团队已经提供的文字材料，不补造客户事实，也不判断资料本身是否真实。
入门包提供任务看板示例。每项任务包含任务名称、负责人、计划完成时间、当前状态和待确认事项。看板用于共同查看进展，不能代替负责人做决定，也不等于已经完成的工作证明。
入门包提供每周复盘建议。团队可以核对已完成任务、尚未解决的问题和下一周的行动安排；涉及责任调整或时间变更时，由负责人确认后再更新记录。

## 交付形式与条件
当前示例仅交付Markdown文字资料，不提供软件账号、自动执行或跨系统数据同步。使用者应自行核验团队成员与项目安排，原始记录不足时标记待补充。服务不代为发布官网、公众号或其他平台内容，不保证培训结果、项目进度或经营收益。

## 复核边界
文字草稿应保留上述限制条件，不把建议写成保证。任何对外使用仍需人工审核；本次自动确认仅是虚构样本的技术验收动作，不是客户终审。
`;
  await step('four-agents-knowledge-organizing',async()=>{
    const file=await upload(admin,'青禾项目服务_项目协作入门包_虚构验收.md',fixture);receipt.ids.bFile=file.id;save();
    let job=receipt.ids.ingestion?await studio(admin,'ingestionJob?id='+receipt.ids.ingestion):await studio(admin,'ingestionStart',{id:file.id});receipt.ids.ingestion=job.id;save();
    if(job.state==='failed')throw Object.assign(Error(job.error||'Previous ingestion failed; no automatic paid retry'),{code:'MODEL_TASK_FAILED'});
    job=await poll(options=>studio(admin,'ingestionJob?id='+job.id,undefined,options),j=>j.state==='succeeded','knowledge-agent');
    const supported=job.checks.filter(c=>c.supported).map(c=>c.itemId);assert.ok(supported.length,'No evidence-supported knowledge item');
    if(!job.documentId){const committed=await studio(admin,'ingestionCommit',{id:job.id,revision:job.revision,ids:supported,reviewed:true});receipt.ids.document=committed.document.id;}else receipt.ids.document=job.documentId;save();
    let document=await studio(admin,'document/'+receipt.ids.document);
    if(!document.external)await studio(admin,'documentPermission',{id:document.id,revision:document.revision,external:true});
    document=await studio(admin,'document/'+document.id);
    for(const chunk of document.chunks.filter(k=>k.state==='pending'))await studio(admin,'confirm',{ids:[chunk.id],riskConfirmed:!!chunk.risks.length});
    document=await studio(admin,'document/'+document.id);assert.equal(document.state,'ready','Synthetic source did not reach ready state');
    receipt.reviewBoundary='Script executes approval nodes only for explicitly fictional technical acceptance; not customer final approval.';receipt.usage[job.id]=job.usage||null;save();return {id:job.id,state:job.state,supported:supported.length};
  });
  async function taskFlow(kind,referenceIds=[]){
    if(!receipt.ids.document)blocked('Verified fictional source unavailable');
    const taskKey=kind==='direct'?'direct':'referenceTask';
    const label=kind==='direct'?'项目协作（虚构验收直接路径）':'项目协作（虚构验收参考路径）';
    let task;if(receipt.ids[taskKey])task=await studio(admin,'task/'+receipt.ids[taskKey]);
    else{const source=await studio(admin,'document/'+receipt.ids.document);const sourceIds=source.chunks.filter(k=>k.state==='approved'&&k.external).slice(0,20).map(k=>k.id);const prior=(await studio(admin,'state')).tasks.find(t=>t.keyword===label||t.description?.includes('acceptance:'+receipt.runId+':'+kind));task=prior?await studio(admin,'task/'+prior.id):await studio(admin,'createTask',{keyword:label,platform:'官网',audience:'小型团队负责人',description:'acceptance:'+receipt.runId+':'+kind+'。请写一篇简短的虚构验收示例，说明项目协作的资料整理、任务看板和每周复盘。保留适用条件；不承诺收益。',writingRules:'明确标注虚构验收示例。内容精炼，避免重复。只引用人工选定Sources；监测文章仅是选题参考。',sourceStage:true,sourceIds,referenceIds});receipt.ids[taskKey]=task.id;save();}
    if(task.state==='failed')throw Object.assign(Error(task.error||'Prior task failed; no automatic paid retry'),{code:'MODEL_TASK_FAILED'});
    if(task.stage==='planning'){if(!task.autoAdvance)task=await studio(admin,'planTopics',{id:task.id,revision:task.revision});task=await poll(options=>studio(admin,'task/'+task.id,undefined,options),t=>t.stage==='topic','planning-agent');}
    if(task.stage==='topic'){assert.equal(task.state,'waiting');assert.ok(task.topics?.length);result(kind+'-topic-human-stop','PASS',{id:task.id,state:task.stage});task=await studio(admin,'selectTopic',{id:task.id,revision:task.revision,index:0});}
    if(task.stage==='sources'){task=await studio(admin,'prepareSources',{id:task.id,revision:task.revision});const candidates=task.sourceCandidates.filter(c=>c.docId===receipt.ids.document).slice(0,20);assert.ok(candidates.length,'No verified fictional source candidate');task=await studio(admin,'confirmSources',{id:task.id,revision:task.revision,ids:candidates.map(c=>c.id)});}
    if(task.stage==='research'&&!task.autoAdvance)task=await studio(admin,'run',{id:task.id,revision:task.revision});
    if(task.stage==='research')task=await poll(options=>studio(admin,'task/'+task.id,undefined,options),t=>t.stage==='outline','research-agent');
    if(task.stage==='outline'){assert.equal(task.state,'waiting');assert.ok(task.outline.trim());result(kind+'-outline-human-stop','PASS',{id:task.id,state:task.stage});task=await studio(admin,'approveOutline',{id:task.id,revision:task.revision});}
    if(['write','check','revise'].includes(task.stage)){if(!task.autoAdvance)task=await studio(admin,'run',{id:task.id,revision:task.revision});task=await poll(options=>studio(admin,'task/'+task.id,undefined,options),t=>t.stage==='review','writer-and-checker');}
    if(task.stage==='review'){assert.ok(task.markdown.trim());task=await studio(admin,'complete',{id:task.id,revision:task.revision,confirmed:true});}
    assert.equal(task.stage,'done');const history=await studio(admin,'taskHistory/'+task.id);assert.ok(history.versions.length,'No persisted draft version');
    const download=await studio(admin,'taskHistory/'+task.id+'/'+encodeURIComponent(history.versions[0].id));assert.ok(download.text?.includes('## 参考来源'),'Draft download is missing reference snapshot');
    receipt.usage[task.id]=task.usage||null;receipt[kind]={id:task.id,draftVersions:history.versions.length,usageReported:!!task.usage,checkIssues:task.issues?.length||0};save();return {id:task.id,state:task.stage};
  }
  await step('direct-research-write-check-workflow',()=>taskFlow('direct'));
  await step('reference-planning-to-writing-workflow',async()=>{if(!articles)blocked('No real monitoring reference; not substituted with a fabricated article');return taskFlow('reference',[receipt.ids.referenceArticle]);});
  await step('exact-external-grants-and-downloads',async()=>{
    if(!receipt.ids.document||!receipt.ids.direct)blocked('Completed fixture content is unavailable for exact grants');
    receipt.externalGrants={documents:[receipt.ids.bFile,receipt.ids.document],tasks:[receipt.ids.direct],articles:receipt.ids.referenceArticle?[receipt.ids.referenceArticle]:[]};save();
    await fusion(admin,`clients/${b}/members`,{user_id:accounts[6].id,role:'external',grants:receipt.externalGrants},{method:'PUT'});await select(external,b);
    const library=await studio(external,'library');assert.ok(library.files.length>0);assert.ok(library.files.every(f=>receipt.externalGrants.documents.includes(f.id)));
    await studio(external,'source/'+receipt.ids.document);await studio(external,'task/'+receipt.ids.direct);
    if(receipt.ids.referenceArticle)await fusion(external,`monitor/article?client_id=${b}&article_id=${encodeURIComponent(receipt.ids.referenceArticle)}`);
    if(receipt.ids.referenceTask)await studio(external,'task/'+receipt.ids.referenceTask,undefined,{statuses:[403,404]});
    await studio(external,'createTask',{keyword:'不得创建',sourceStage:true},{statuses:[403]});
    return {documents:receipt.externalGrants.documents.length,tasks:1,articles:receipt.externalGrants.articles.length};
  });
  async function actualChat(index,load=false){const tag=(load?'chat-load-user-':'chat-user-')+index;if(receipt.attempts[tag]){if(receipt.attempts[tag].state==='succeeded')return {state:'reused',id:accounts[index].id};blocked('Chat already attempted; not repeating a possibly charged call',receipt.attempts[tag].state);}
    receipt.attempts[tag]={state:'dispatching',time:new Date().toISOString()};save();try{const answer=await fusion(users[index],'monitor/chat',{client_id:b,message:'查全部历史提到PMP的文章',history:[]});assert.equal(typeof answer.answer,'string');assert.equal(answer.client_id,b,'Eason crossed client scope');assert.equal(answer.days,0,'Eason did not search all history');for(const item of answer.items||[])await fusion(users[index],`monitor/article?client_id=${b}&article_id=${encodeURIComponent(item.id)}`);receipt.attempts[tag]={state:'succeeded',usage:answer.usage||null,articles:answer.items?.length||0,time:new Date().toISOString()};save();return {id:accounts[index].id,state:'succeeded'};}catch(e){receipt.attempts[tag]={state:'failed',code:e.code||e.status||'ERROR',error:sanitize(e.message)};save();throw e;}}
  if(process.argv.includes('--chat-load')){await step('seven-real-concurrent-eason-chats',async()=>{const results=await Promise.allSettled(users.map((_,index)=>actualChat(index,true)));assert.ok(results.every(r=>r.status==='fulfilled'),'One or more real Eason requests failed; inspect saved per-user result');return {users:7,newCalls:results.filter(r=>r.status==='fulfilled'&&r.value.state==='succeeded').length,reused:results.filter(r=>r.status==='fulfilled'&&r.value.state==='reused').length};});}
  else {await step('one-real-eason-chat',()=>actualChat(0));result('seven-real-concurrent-eason-chats','NOT_RUN',{reason:'Not run by default; --chat-load explicitly authorizes extra model calls.'});}
  receipt.finishedAt=new Date().toISOString();receipt.costBoundary='Provider-reported Token usage only; absent usage remains null; no price estimate.';save();
  if(Object.values(receipt.steps).some(s=>s.status==='FAIL'||s.status==='BLOCKED'))process.exitCode=1;
}
if(process.argv.includes('--self-test'))console.log('PASS cookie-self-test (no files, network or model calls)');
else await main().catch(error=>{console.error('FAIL acceptance-initialization '+(error.code||error.status||'ERROR'));process.exitCode=1;});
