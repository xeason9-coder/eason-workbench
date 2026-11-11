import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {mkdirSync,readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
mkdirSync('.sites-runtime/tests',{recursive:true});
await build({entryPoints:['tests/fusion-pages-worker.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'.sites-runtime/tests/fusion-pages.mjs'});
const mf=new Miniflare({modules:true,scriptPath:'.sites-runtime/tests/fusion-pages.mjs',compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET']});
async function req(url,headers={}){const r=await mf.dispatchFetch('https://pages.test'+url,{headers});return {status:r.status,...await r.json()};}
try{
 const db=await mf.getD1Database('DB');await db.exec(readFileSync('drizzle/0000_mature_bug.sql','utf8').replace(/--> statement-breakpoint/g,'').replace(/\n/g,' '));
 async function insert(id,kind,payload,state='stored',owner='client:a'){await db.prepare('INSERT INTO studio_records(id,kind,owner,state,revision,payload,created,updated) VALUES(?,?,?,?,1,?,?,?)').bind(id,kind,owner,state,JSON.stringify(payload),'2026-01-01','2026-01-01').run();}
 for(let i=0;i<26;i++)await insert('l'+String(i).padStart(2,'0'),'library',{name:'文件'+i+'.md',path:(i<20?'公开/产品':'隐私/合同')+'/文件'+i+'.md',sha256:'hash'+i,size:100,originalKey:'private-original-'+i,fileKey:'private-key-'+i,originalName:'原件'+i+'.docx',sourceVersion:1});
 await insert('d0','document',{name:'正式来源.md',hash:'hash0',fileKey:'private-key-0',markdown:'NEVER_RETURN_FULL_SOURCE',effective:'2020-01-01',sourceVersion:2},'ready');
 await insert('secret','document',{name:'未共享机密来源.md',hash:'secret',fileKey:'SECRET_BLOB',markdown:'HIDDEN_SECRET_CONTENT',effective:'2020-01-01'},'ready');
 await insert('other','library',{name:'其他客户秘密.md',path:'跨客户秘密/文件.md',fileKey:'OTHER_OWNER'},'stored','client:b');
 for(let i=0;i<25;i++)await insert('k'+String(i).padStart(2,'0'),'chunk',{docId:'d0',docRevision:1,title:'知识'+i,body:'仅当前页正文 '+i+(i===24?' 指定检索词':''),type:'产品说明',products:['共同产品'],platforms:[],regions:[],keywords:[],risks:i===22?['需复核']:[],external:true,purpose:'fact'},i<20?'approved':'pending');
 await insert('hidden-chunk','chunk',{docId:'secret',docRevision:1,title:'绝不能泄漏的标题',body:'HIDDEN_SECRET_CONTENT',products:['共同产品'],risks:[]},'pending');
 let r=await req('/library?page=1&pageSize=10');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.pagination,true);assert.equal(r.count,27);assert.equal(r.files.length,10);assert.equal(r.total,0);assert.ok(!r.files.some(f=>f.id==='l00'));assert.ok(!JSON.stringify(r).includes('private-key'));assert.ok(!JSON.stringify(r).includes('NEVER_RETURN'));assert.ok(r.folders.includes('公开/产品'));assert.ok(r.folders.includes('隐私/合同'));
 const page2=await req('/library?page=2&pageSize=10');assert.equal(page2.files.length,10);assert.ok(page2.files.every(f=>!r.files.some(x=>x.id===f.id)));
 r=await req('/library?folder='+encodeURIComponent('公开/产品'));assert.equal(r.count,19);assert.ok(r.files.every(f=>f.folder==='公开/产品'));
 r=await req('/library?q='+encodeURIComponent('文件24'));assert.equal(r.count,1);assert.equal(r.files[0].id,'l24');
 r=await req('/library?selectAll=1');assert.equal(r.files.length,27);assert.ok(r.files.every(f=>Object.keys(f).sort().join(',')==='id,name,semantic'));
 const ext={'x-test-role':'external','x-test-documents':JSON.stringify(['l01','d0'])};
 r=await req('/library',ext);assert.equal(r.count,2);assert.deepEqual(r.folders,['公开/产品','根目录']);assert.ok(!JSON.stringify(r).includes('隐私'));assert.ok(!JSON.stringify(r).includes('机密'));
 assert.equal((await req('/library?q='+encodeURIComponent('机密'),ext)).count,0);
 assert.equal((await req('/library',{'x-test-role':'external'})).count,0);
 const sharedLibrary=await req('/library',{'x-test-role':'external','x-test-documents':JSON.stringify(['l00'])});assert.equal(sharedLibrary.count,1);assert.equal(sharedLibrary.files[0].id,'l00');
 assert.equal((await req('/library',{'x-test-owner':'client:b'})).count,1);
 for(const bad of ['page=0','page=-1','page=1.1','pageSize=51','pageSize=abc','selectAll=0'])assert.equal((await req('/library?'+bad)).status,400);
 r=await req('/knowledge?pageSize=10',ext);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.count,25);assert.equal(r.items.length,10);assert.deepEqual(r.stats,{total:25,available:20,pending:5,priority:1});assert.deepEqual(r.safePendingIds,[]);assert.ok(r.items[0].related.length);assert.ok(!JSON.stringify(r).includes('绝不能泄漏'));assert.ok(!JSON.stringify(r).includes('HIDDEN_SECRET'));assert.ok(!JSON.stringify(r.documents).includes('markdown'));assert.ok(!JSON.stringify(r).includes('private-key'));
 const knowledge2=await req('/knowledge?page=2&pageSize=10',ext);assert.ok(knowledge2.items.every(k=>!r.items.some(x=>x.id===k.id)));
 r=await req('/knowledge?q='+encodeURIComponent('指定检索词'),ext);assert.equal(r.count,1);assert.equal(r.items[0].id,'k24');assert.ok(r.items[0].related.some(x=>x.id==='k00'));
 r=await req('/knowledge?status=pending',ext);assert.equal(r.count,5);assert.ok(r.items.every(k=>k.state==='pending'));
 assert.equal((await req('/knowledge?type='+encodeURIComponent('费用与计算'),ext)).count,0);
 assert.equal((await req('/knowledge?id=hidden-chunk',ext)).status,404);
 r=await req('/knowledge?id=k24',ext);assert.equal(r.count,1);assert.equal(r.items[0].body,'仅当前页正文 24 指定检索词');
 r=await req('/knowledge');assert.equal(r.stats.total,26);assert.equal(r.safePendingIds.length,5);assert.ok(r.safePendingIds.includes('hidden-chunk'));
 for(const bad of ['status=invalid','type=invalid','page=0'])assert.equal((await req('/knowledge?'+bad)).status,400);
 // Explicit selection caps do not turn a page selection into an unbounded body response.
 const large=Array.from({length:505},(_,i)=>({id:'cap-l'+i,name:'cap-'+i+'.md',path:'cap/'+i+'.md',sha256:'cap-hash'+i,size:1}));
 await db.prepare("INSERT INTO studio_records(id,kind,owner,state,revision,payload,created,updated) SELECT json_extract(value,'$.id'),'library','client:cap','stored',1,value,'2026-01-01','2026-01-01' FROM json_each(?)").bind(JSON.stringify(large)).run();
 r=await req('/library?selectAll=1',{'x-test-owner':'client:cap'});assert.equal(r.files.length,500);assert.equal(r.selectionTotal,505);assert.equal(r.truncated,true);
 await insert('cap-d','document',{name:'cap-source.md',hash:'cap-document',markdown:'SOURCE_BODY_NOT_RETURNED'},'review','client:cap');
 const chunks=Array.from({length:205},(_,i)=>({id:'cap-k'+i,docId:'cap-d',docRevision:1,title:'待确认'+i,body:'普通虚构条目',risks:[],products:[],platforms:[],regions:[]}));
 await db.prepare("INSERT INTO studio_records(id,kind,owner,state,revision,payload,created,updated) SELECT json_extract(value,'$.id'),'chunk','client:cap','pending',1,value,'2026-01-01','2026-01-01' FROM json_each(?)").bind(JSON.stringify(chunks)).run();
 r=await req('/knowledge',{'x-test-owner':'client:cap'});assert.equal(r.items.length,20);assert.equal(r.safePendingIds.length,200);assert.equal(r.stats.pending,205);
 assert.equal((await req('/knowledge?id=k00',{'x-test-owner':'client:cap'})).status,404);
 console.log('PASS: SQL pagination, metadata-only library, folder/search filters, deduplication, page-scoped bodies, source metadata, statistics, cross-page relations, safe pending IDs and external/owner isolation. Only synthetic D1 data.');
}finally{await mf.dispose();}
