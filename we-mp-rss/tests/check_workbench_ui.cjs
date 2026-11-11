// Offline UI checks: no browser, network, real credentials or production data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../public/workbench');
function harness() {
  const elements = new Map(), storage = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {value:'',textContent:'',innerHTML:'',hidden:false,
      disabled:false,events:{},elements:{},addEventListener(k,fn){this.events[k]=fn;},
      setAttribute(k,v){this[k]=v;},classList:{toggle(){}}});
    return elements.get(id);
  }
  const store = {getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  const context = vm.createContext({document:{getElementById:element,querySelectorAll:()=>[],addEventListener(){}},
    localStorage:store,sessionStorage:store,URL,URLSearchParams,Intl,Date,console,
    setInterval(){},setTimeout(){},clearTimeout(){},clearInterval(){},
    window:{location:{replace(url){context.navigation=url;}}}});
  return {context,element,storage,run:code=>vm.runInContext(code,context)};
}
(async()=>{
  const desk=harness();
  desk.context.testState={user:{id:'user-a',username:'eason',role:'admin'},clients:[],runs:[],available_sources:[],keywords:{},
    settings:{brand:'信源工作台',key_configured:true,daily_enabled:false},sync_running:false};
  desk.context.fetch=async()=>({ok:true,status:200,json:async()=>desk.context.testState});
  await desk.run(fs.readFileSync(path.join(root,'desk.js'),'utf8'));
  assert.equal(desk.element('accountName').textContent,'eason');
  assert.equal(desk.element('openSettings').hidden,false);
  desk.run("clientId='same-client';messages=[{role:'user',content:'private-a'}];persistMessages()");
  desk.run("state.user={id:'user-b',username:'manager',role:'user'};renderState()");
  assert.equal(desk.run('loadMessages().length'),0,'chat must not cross account boundary');
  assert.equal(desk.element('openSettings').hidden,true);
  assert.equal(desk.element('loadShelf').hidden,true);
  desk.run("state.runs=[{client_id:'same-client',status:'partial',started_at:'2026-11-10T10:00:00Z',results:[{source:'来源',status:'partial',added:1,message:'请求中断',articles:[{id:'a1',title:'<script>标题</script>'}]}]}];renderSyncNotice()");
  assert.match(desk.element('syncNotice').innerHTML,/部分完成/);
  assert.match(desk.element('syncNotice').innerHTML,/本轮新增 1 篇/);
  assert.match(desk.element('syncNotice').innerHTML,/&lt;script&gt;/);
  assert.doesNotMatch(desk.element('syncNotice').innerHTML,/<script>/);
  desk.run("state.runs[0].status='success';state.runs[0].results=[];renderSyncNotice()");
  assert.match(desk.element('syncNotice').innerHTML,/本轮没有新文章/);
  assert.equal(desk.element('syncNotice').hidden,false,'completed result survives render');
  desk.context.fetch=async()=>({status:401});
  await assert.rejects(desk.run("api('/state')"),/登录已过期/);
  assert.equal(desk.context.navigation,'/workbench/login');

  const login=harness();
  login.element('loginForm').elements.username={value:' manager '};
  login.element('password').value='synthetic-password';
  login.element('password').type='password';
  login.context.fetch=async(url,options)=>{
    assert.equal(url,'/workbench/api/auth/login');assert.equal(options.headers['X-Workbench'],'1');
    assert.equal(JSON.parse(options.body).username,'manager');
    return {ok:false,json:async()=>({detail:'用户名或密码不正确'})};
  };
  login.run(fs.readFileSync(path.join(root,'login.js'),'utf8'));
  await login.element('loginForm').events.submit({preventDefault(){}});
  assert.equal(login.element('loginError').hidden,false);
  assert.equal(login.element('loginSubmit').disabled,false);
  assert.equal(login.context.navigation,undefined);
  login.context.fetch=async()=>({ok:true,json:async()=>({authenticated:true})});
  await login.element('loginForm').events.submit({preventDefault(){}});
  assert.equal(login.context.navigation,'/workbench/');
  assert.equal(login.element('password').value,'');
  console.log('UI checks passed: account isolation, collection results, expired session, login failure/success.');
})().catch(error=>{console.error(error);process.exitCode=1;});
