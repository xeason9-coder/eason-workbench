import {Miniflare,createFetchMock} from 'miniflare';import {build} from 'esbuild';import {mkdirSync,readdirSync,readFileSync} from 'node:fs';import assert from 'node:assert/strict';
const metadataBundle=await build({entryPoints:['lib/studio/model-settings.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {modelSettingsAPI}=await import('data:text/javascript;base64,'+Buffer.from(metadataBundle.outputFiles[0].text).toString('base64'));
let metadataRecord=null;
const metadataEnv={DB:{prepare:()=>({bind:()=>({first:async()=>metadataRecord})})},AI_URL:'https://api.deepseek.com/chat/completions',AI_MODEL:'deepseek-flash',AI_KEY:'private-deployment-key'};
const metadata=async env=>(await modelSettingsAPI(new Request('https://studio.test/api/studio/modelSettings'),env,'owner',Response.json)).json();
let info=await metadata(metadataEnv);assert.equal(info.provider,'DeepSeek');assert.equal(info.model,'deepseek-flash');assert.deepEqual(info.activeModels,{knowledge:'deepseek-flash',content:'deepseek-flash'});assert.ok(!JSON.stringify(info).includes(metadataEnv.AI_KEY));assert.ok(!JSON.stringify(info).includes(metadataEnv.AI_URL));
info=await metadata({...metadataEnv,KNOWLEDGE_AI_URL:metadataEnv.AI_URL,KNOWLEDGE_AI_MODEL:'knowledge-fixture'});assert.deepEqual(info.activeModels,{knowledge:'knowledge-fixture',content:'deepseek-flash'});
metadataRecord={payload:JSON.stringify({provider:'OpenAI',model:'gpt-fixture',enabled:false}),revision:1};info=await metadata(metadataEnv);assert.equal(info.model,'gpt-fixture');assert.equal(info.activeModels.content,'deepseek-flash');
metadataRecord={...metadataRecord,payload:JSON.stringify({provider:'OpenAI',model:'gpt-fixture',enabled:true})};info=await metadata(metadataEnv);assert.deepEqual(info.activeModels,{knowledge:'gpt-fixture',content:'gpt-fixture'});
metadataRecord=null;info=await metadata({DB:metadataEnv.DB});assert.deepEqual(info.activeModels,{knowledge:null,content:null});assert.equal(info.provider,'OpenAI');
console.log('PASS: active model names distinguish deployment, saved, disabled and separate knowledge configurations without exposing credentials or endpoints.');
mkdirSync('.sites-runtime/tests',{recursive:true});await build({entryPoints:['tests/worker.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'.sites-runtime/tests/model-settings.mjs'});
const mock=createFetchMock();mock.disableNetConnect();const endpoint=mock.get('https://api.openai.com');const key='sk-fixture_NOT_A_REAL_KEY_123456789';
const mf=new Miniflare({modules:true,scriptPath:'.sites-runtime/tests/model-settings.mjs',compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET'],bindings:{MODEL_SETTINGS_ENCRYPTION_KEY:'a'.repeat(64)},fetchMock:mock});
const headers=uid=>({'oai-authenticated-user-id':uid,'oai-authenticated-user-email':uid+'@example.com','content-type':'application/json'});
async function req(path,body,uid='owner',extra={}){const r=await mf.dispatchFetch('https://studio.test/api/studio/'+path,{method:body?'POST':'GET',headers:{...headers(uid),...extra},body:body?JSON.stringify(body):undefined});return {status:r.status,j:await r.json()};}
function respond(status=200,content={ok:true}){endpoint.intercept({path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer '+key}}).reply(status,JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]}));}
try{const db=await mf.getD1Database('DB');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))await db.exec(readFileSync('drizzle/'+f,'utf8').replace(/--> statement-breakpoint/g,'').replace(/\n/g,' '));
 let c=(await req('modelSettings')).j;assert.equal(c.storageReady,true);assert.equal(c.enabled,false);
 const body={action:'testSave',model:'gpt-4.1',apiKey:key,consent:true,revision:0};
 assert.equal((await req('modelSettings',{...body,consent:false})).status,400);assert.equal((await req('modelSettings',body,'owner',{origin:'https://evil.test'})).status,403);assert.equal((await req('modelSettings',{...body,apiKey:'bad'})).status,400);
 respond();let saved=await req('modelSettings',body);assert.equal(saved.status,200,JSON.stringify(saved.j));c=saved.j;assert.equal(c.hasSavedKey,true);assert.equal(c.enabled,true);assert.ok(!JSON.stringify(c).includes(key));assert.ok(!('ciphertext' in c));
 const record=await db.prepare("SELECT payload FROM studio_records WHERE kind='modelSettings' AND owner='owner'").first();assert.ok(!record.payload.includes(key));assert.ok(JSON.parse(record.payload).ciphertext.length>0);
 assert.equal((await req('state')).j.config.knowledgeModel,true);assert.equal((await req('state')).j.config.model,true);assert.equal((await req('state',null,'other')).j.config.knowledgeModel,false);assert.equal((await req('modelSettings',null,'other')).j.hasSavedKey,false);
 assert.equal((await req('modelSettings',{...body,revision:c.revision})).status,429);assert.equal((await req('modelSettings',body)).status,409);
 await db.prepare("UPDATE studio_records SET updated='2000-01-01T00:00:00.000Z' WHERE kind='modelProbe'").run();respond(401);const failed=await req('modelSettings',{...body,apiKey:'',model:'gpt-4.1-mini',revision:c.revision});assert.equal(failed.status,502);assert.match(failed.j.error,/密钥无效/);assert.ok(!JSON.stringify(failed.j).includes(key));assert.equal((await req('modelSettings')).j.model,'gpt-4.1');
 await db.prepare("UPDATE studio_records SET updated='2000-01-01T00:00:00.000Z' WHERE kind='modelProbe'").run();respond();saved=await req('modelSettings',{...body,apiKey:'',revision:c.revision});assert.equal(saved.status,200);assert.equal(saved.j.revision,c.revision+1);c=saved.j;
 assert.equal((await req('modelSettings',{...body,provider:'https://evil.test',revision:c.revision})).status,400);
 assert.equal((await req('modelSettings',{...body,provider:'DeepSeek',apiKey:'',revision:c.revision})).status,400);
 await db.prepare("UPDATE studio_records SET updated='2000-01-01T00:00:00.000Z' WHERE kind='modelProbe'").run();
 const deepseek=mock.get('https://api.deepseek.com');
 deepseek.intercept({path:'/chat/completions',method:'POST',headers:{authorization:'Bearer '+key}}).reply(200,JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
 saved=await req('modelSettings',{...body,provider:'DeepSeek',model:'deepseek-chat',revision:c.revision});assert.equal(saved.status,200,JSON.stringify(saved.j));c=saved.j;assert.equal(c.provider,'DeepSeek');assert.ok(!JSON.stringify(c).includes(key));assert.equal((await req('state')).j.config.knowledgeModel,true);
 await db.prepare("UPDATE studio_records SET updated='2000-01-01T00:00:00.000Z' WHERE kind='modelProbe'").run();
 deepseek.intercept({path:'/chat/completions',method:'POST'}).reply(200,JSON.stringify({choices:[{message:{content:'{"ok":true,"unexpected":true}'}}]}));
 assert.equal((await req('modelSettings',{...body,provider:'DeepSeek',apiKey:'',revision:c.revision})).status,502);assert.equal((await req('modelSettings')).j.revision,c.revision);
 const disabled=await req('modelSettings',{action:'disable',revision:c.revision});assert.equal(disabled.j.enabled,false);assert.equal((await req('state')).j.config.knowledgeModel,false);
 const payload=JSON.parse(record.payload);await db.prepare("INSERT INTO studio_records(id,kind,owner,state,revision,payload,created,updated) VALUES('model-settings:other','modelSettings','other','saved',1,?,?,?)").bind(JSON.stringify(payload),'2026-01-01','2026-01-01').run();assert.equal((await req('state',null,'other')).status,503); // authenticated encryption binds ciphertext to owner
 mock.assertNoPendingInterceptors();console.log('PASS: authenticated model settings, consent, CSRF, encryption at rest, owner isolation, credential non-disclosure, live configuration resolution, strict-schema probe, rate limiting, version conflict, failure preservation, saved-key reuse and disable. Provider responses are fixtures.');
}finally{await mf.dispose();await mock.close();}
