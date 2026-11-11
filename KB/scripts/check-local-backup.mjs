// Restore a completed local backup into an isolated copy; never mutate the live persistence directory.
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,copyFileSync,mkdirSync,realpathSync,readdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import path from 'node:path';
import {build} from 'esbuild';

// Match the launcher: a newer storage runtime can migrate metadata the installed Wrangler cannot read.
const require=createRequire(import.meta.url);
const {Miniflare,createFetchMock}=createRequire(require.resolve('wrangler/package.json'))('miniflare');

const root=fileURLToPath(new URL('../../',import.meta.url)),repo=path.join(root,'KB'),runtime=path.join(root,'runtime');
const name=process.argv[2]||'20261111-152545-816';
const reportPath=path.join(runtime,'restore-check.json');
const report={status:'running',startedAt:new Date().toISOString(),backup:name,checks:[],network:'All external fetches disabled; no model configuration provided',scope:'Real saved local acceptance assets restored from a stopped-service backup; authentication is not re-tested by this worker.'};
let mf,mock;
const sha=value=>createHash('sha256').update(value).digest('hex');
function save(){writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});}
function check(condition,label,data={}){assert.ok(condition,label);report.checks.push({name:label,...data});save();console.log('PASS '+label);}
function contained(child,parent){const relative=path.relative(parent,child);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
try{
  assert.match(name,/^\d{8}-\d{6}-\d{3}$/,'Invalid backup directory name');
  const backups=realpathSync(path.join(root,'backups')),backup=realpathSync(path.join(backups,name));assert.ok(contained(backup,backups),'Backup is outside the allowed directory');
  const marker=path.join(backup,'COMPLETE.txt');assert.ok(existsSync(marker),'Backup completion marker is missing');assert.match(readFileSync(marker,'utf8'),/备份已完成/,'Backup completion marker is invalid');
  const source=realpathSync(path.join(backup,'runtime-kb'));assert.ok(contained(source,backup),'Backup runtime is outside its completed backup');
  const runtimeReal=realpathSync(runtime),live=path.resolve(runtimeReal,'kb');
  const copy=path.resolve(runtimeReal,'restore-check-'+new Date().toISOString().replace(/[-:.TZ]/g,'')+'-'+randomUUID().slice(0,8));
  assert.ok(contained(copy,runtimeReal)&&copy!==live&&!contained(live,copy)&&!contained(copy,live),'Restore destination must be separate from live storage');assert.ok(!existsSync(copy),'Restore destination already exists');
  report.copyDirectory=copy;report.liveDirectoryUnchanged=live;save();
  console.log('PASS completed-backup-and-isolated-path-validated');
  function copyTree(from,to){mkdirSync(to);for(const entry of readdirSync(from,{withFileTypes:true})){assert.ok(!entry.isSymbolicLink(),'Backup contains a link; copy stopped');const input=path.join(from,entry.name),output=path.join(to,entry.name);if(entry.isDirectory())copyTree(input,output);else {assert.ok(entry.isFile(),'Unsupported backup entry');copyFileSync(input,output);}}}
  copyTree(source,copy);
  check(existsSync(path.join(copy,'v3','d1'))&&existsSync(path.join(copy,'v3','r2')),'isolated-backup-copy-created');
  const expected=JSON.parse(readFileSync(path.join(runtime,'pre-restart-state.json'),'utf8'));
  assert.ok(expected.client&&expected.office?.id&&expected.libraryMarkdown?.id&&expected.document?.chunks?.length&&expected.tasks?.length,'Pre-restart snapshot is incomplete');
  const bundleDir=path.join(repo,'.sites-runtime','tests');mkdirSync(bundleDir,{recursive:true});const bundle=path.join(bundleDir,'restore-backup-worker.mjs');
  await build({entryPoints:[path.join(repo,'tests','worker.ts')],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:bundle,absWorkingDir:repo,logLevel:'silent'});
  mock=createFetchMock();mock.disableNetConnect();
  mf=new Miniflare({modules:true,scriptPath:bundle,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],
    d1Databases:{DB:'00000000-0000-4000-8000-000000000000'},d1Persist:path.join(copy,'v3','d1'),
    r2Buckets:{BUCKET:'site-creator-r2'},r2Persist:path.join(copy,'v3','r2'),fetchMock:mock});
  const db=await mf.getD1Database('DB');
  const table=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='studio_records'").first();check(!!table,'restored-d1-table-exists');
  const owner='client:'+expected.client,count=await db.prepare('SELECT count(*) n FROM studio_records WHERE owner=?').bind(owner).first();check(count.n>0,'restored-client-records-not-empty',{records:count.n});
  const integrity=await db.prepare('PRAGMA quick_check').all();check(integrity.results.length===1&&Object.values(integrity.results[0])[0]==='ok','restored-d1-integrity');
  const headers={'oai-authenticated-user-id':owner,'oai-authenticated-user-email':'restore@local'};
  async function get(route,json=true){
    assert.ok(/^(?:library\/[^/]+\/(?:original|download)|document\/[^/]+|task\/[^/]+|taskHistory\/[^/]+(?:\/[^/]+)?)$/.test(route),'Only approved read-only routes may be used');
    const response=await mf.dispatchFetch('https://restore.test/api/studio/'+route,{method:'GET',headers});assert.equal(response.status,200,'Restored endpoint failed: '+route);
    return json?response.json():Buffer.from(await response.arrayBuffer());
  }
  const original=await get('library/'+expected.office.id+'/original',false);check(sha(original)===expected.office.sha256&&original.length===expected.office.bytes,'office-original-byte-hash-restored',{id:expected.office.id,bytes:original.length,sha256:sha(original)});
  const markdown=await get('library/'+expected.libraryMarkdown.id+'/download',false);check(sha(markdown)===expected.libraryMarkdown.sha256,'markdown-download-hash-restored',{id:expected.libraryMarkdown.id,bytes:markdown.length,sha256:sha(markdown)});
  const document=await get('document/'+expected.document.id);
  check(document.state===expected.document.state&&document.revision===expected.document.revision&&document.sourceVersion===expected.document.sourceVersion&&document.external===expected.document.external&&sha(document.markdown)===sha(expected.document.markdown),'reviewed-source-state-and-body-restored',{id:document.id,state:document.state,revision:document.revision});
  check(document.chunks.length===expected.document.chunks.length&&expected.document.chunks.every(old=>{const now=document.chunks.find(c=>c.id===old.id);return now&&now.state===old.state&&now.revision===old.revision&&now.docRevision===old.docRevision&&now.confirmedAt===old.confirmedAt&&sha(now.body)===sha(old.body)&&sha(JSON.stringify(now.evidence))===sha(JSON.stringify(old.evidence));}),'reviewed-chunks-revisions-and-evidence-restored',{chunks:document.chunks.length});
  for(const old of expected.tasks){
    const row=await db.prepare("SELECT state FROM studio_records WHERE id=? AND owner=? AND kind='task'").bind(old.id,owner).first();assert.equal(row?.state,'done','Only completed tasks are eligible for this read-only restoration check');
    const task=await get('task/'+old.id);check(task.stage===old.stage&&task.revision===old.revision&&sha(task.markdown)===old.markdownHash,'completed-task-markdown-restored',{id:task.id,revision:task.revision,sha256:sha(task.markdown)});
    const history=await get('taskHistory/'+old.id);assert.equal(history.versions.length,old.history.length,'Draft version count changed');
    for(const prior of old.history){
      const version=history.versions.find(h=>h.id===prior.id);assert.ok(version,'Saved draft version is missing');
      check(version.draftVersion===prior.version&&sha(version.markdown)===prior.hash,'draft-version-body-hash-restored',{id:version.id,version:version.draftVersion,sha256:sha(version.markdown)});
      const exported=await get('taskHistory/'+old.id+'/'+encodeURIComponent(version.id),false);
      const reconstructed='# '+version.title+'\n\n'+version.markdown+'\n\n## 参考来源\n'+(version.evidence||[]).map(e=>'['+e.ref+'] '+e.title+' · 资料V'+(e.sourceVersion||1)+' · '+(e.source||'')).join('\n')+'\n\n## 写作规则\n'+(version.writingRules||'无额外规则')+'\n\n## SEO信息\n'+(version.seoTitle||version.title)+'\n'+(version.metaDescription||'');
      check(sha(exported)===sha(reconstructed),'draft-export-matches-restored-snapshot',{id:version.id,bytes:exported.length,sha256:sha(exported),comparedTo:'Restored version with pre-backup verified Markdown; original exported-file hash was not recorded.'});
    }
  }
  mock.assertNoPendingInterceptors();report.status='passed';report.finishedAt=new Date().toISOString();report.modelCalls=0;report.copyRetained=true;save();console.log('PASS backup-restore-complete');
}catch(error){report.status='failed';report.finishedAt=new Date().toISOString();report.error=String(error.message||error).slice(0,1000);save();console.error('FAIL backup-restore '+report.error);process.exitCode=1;}
finally{if(mf)await mf.dispose();if(mock)await mock.close();}
