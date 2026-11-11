import {test} from 'node:test';import assert from 'node:assert/strict';import {sourceBlocks,extractionBatches,validateExtraction,validateLinks,validateAudit} from '../lib/studio/ingestion-agent.mjs';
const markdown='# 收款\r支持美客多墨西哥收款。\r# 条件\r仅适用于已审核企业。',blocks=sourceBlocks(markdown);
const item=(title,statement,quote)=>({title,statement,type:'产品说明',products:['收款账户'],platforms:['美客多'],regions:['墨西哥'],keywords:['收款'],evidence:[{blockId:'B1',quote}]});
test('source blocks preserve every character and batch all content',()=>{const text='a'.repeat(8000)+'\r\n中文';const bs=sourceBlocks(text);assert.equal(bs.map(b=>b.text).join(''),text);assert.equal(extractionBatches(bs).flat().length,bs.length);assert.throws(()=>sourceBlocks('a'.repeat(160001)));});
test('reject invented, ambiguous or missing evidence',()=>{assert.throws(()=>validateExtraction({items:[item('收款','收款','不存在的原文')],omissions:[]},blocks));assert.throws(()=>validateExtraction({items:[{...item('收款','收款','支持美客多墨西哥收款。'),evidence:[]}],omissions:[]},blocks));const r=validateExtraction({items:[item('收款','支持收款','支持美客多墨西哥收款。')],omissions:[]},blocks);assert.equal(markdown.slice(r.items[0].evidence[0].start,r.items[0].evidence[0].end),'支持美客多墨西哥收款。');});
test('cross chapter conditions require valid target and exact condition quote',()=>{const {items}=validateExtraction({items:[item('收款','支持收款','支持美客多墨西哥收款。'),item('条件','企业资格','仅适用于已审核企业。')],omissions:[]},blocks);const links=validateLinks({links:[{itemId:'K1',conditionItemId:'K2',reason:'收款适用主体限制',evidence:[{blockId:'B1',quote:'仅适用于已审核企业。'}]}]},items,blocks);assert.equal(links.length,1);assert.throws(()=>validateLinks({links:[{...links[0],conditionItemId:'K1'}]},items,blocks));assert.throws(()=>validateAudit({checks:[],conflicts:[],summary:'通过',uncovered:[]},items,[],blocks));});


test('JSON object compatibility preserves strict schema and exact evidence checks',async(t)=>{
 const {modelJSON}=await import('../lib/studio/agent.mjs');
 const {ingestionSchemas}=await import('../lib/studio/ingestion-agent.mjs');
 const env={AI_URL:'https://api.deepseek.com/chat/completions',AI_MODEL:'fixture',AI_RESPONSE_FORMAT:'json_object'};
 let payload,answer={links:[]};
 t.mock.method(globalThis,'fetch',async(_,init)=>{payload=JSON.parse(init.body);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]});});
 await modelJSON(env,[{role:'user',content:'test'}],500,{schema:ingestionSchemas.link,stage:'link'});
 assert.deepEqual(payload.response_format,{type:'json_object'});assert.match(payload.messages[0].content,/JSON Schema/);assert.deepEqual(payload.thinking,{type:'disabled'});
 await modelJSON({...env,AI_URL:'https://api.openai.com/v1/chat/completions'},[],500);assert.equal(payload.thinking,undefined);
 for(const invalid of [{links:[],extra:true},{links:'x'},{links:[{itemId:'K1'}]},null]){
  answer=invalid;await assert.rejects(()=>modelJSON(env,[],500,{schema:ingestionSchemas.link}),/严格结构/);
 }
 answer={links:[]};await modelJSON({...env,AI_RESPONSE_FORMAT:'json_schema'},[],500,{schema:ingestionSchemas.link,stage:'link'});
 assert.equal(payload.response_format.json_schema.strict,true);
 answer={links:[],extra:true};await assert.rejects(()=>modelJSON({...env,AI_RESPONSE_FORMAT:'json_schema'},[],500,{schema:ingestionSchemas.link}),/严格结构/);
 await assert.rejects(()=>modelJSON({...env,AI_RESPONSE_FORMAT:'invalid'},[]),/配置无效/);
 answer={items:[item('伪造','免费','免费')],omissions:[]};
 const result=await modelJSON(env,[],500,{schema:ingestionSchemas.extract,stage:'extract'});
 assert.throws(()=>validateExtraction(result,blocks),/引文与原文不一致/);
 answer={checks:[{itemId:'K1',supported:'true',issues:[]}],conflicts:[],summary:'测试',uncovered:[]};
 await assert.rejects(()=>modelJSON(env,[],500,{schema:ingestionSchemas.audit}),/严格结构/);
});
