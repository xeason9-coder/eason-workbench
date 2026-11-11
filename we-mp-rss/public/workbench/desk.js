"use strict";
const $ = id => document.getElementById(id);
const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const safeUrl = value => {try {const u = new URL(value); return u.protocol === "https:" && u.hostname === "mp.weixin.qq.com" ? u.href : "";} catch {return "";}};
const date = value => value ? new Intl.DateTimeFormat("zh-CN", {timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(value)) : "—";
let state, clientId = "", view = "recent", page = 1, total = 0;
let detail, editingClient = null, messages = [], chatBusy = false, querySequence = 0, qrTimer, toastTimer, readerObserver;
let sourceOptions = [];
const labels = {recent:"近七天文章",all:"积累文章库",favorites:"我的收藏",excluded:"已排除",sources:"来源管理"};
const client = () => state && state.clients.find(c => c.id === clientId && !c.archived);
const admin = () => state && state.user.role === "admin";
const storageKey = (kind, owner="") => "eason-"+state.user.id+"-"+kind+(owner?"-"+owner:"");
async function api(path, method="GET", body) {
  const options = {method, headers:{"X-Workbench":"1"}};
  if (body !== undefined) {options.body=JSON.stringify(body); options.headers["Content-Type"]="application/json";}
  const response = await fetch("/workbench/api"+path, options);
  if(response.status===401){window.location.replace("/workbench/login");throw new Error("登录已过期，请重新登录");}
  const result = await response.json();
  if (!response.ok) {
    let problem = result.detail || "操作未完成，请重试";
    if (Array.isArray(problem)) problem = problem.map(v=>String(v.msg)).join("；");
    throw new Error(problem);
  }
  return result;
}
function toast(message) {
  $("toast").textContent=message; $("toast").hidden=false;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>$("toast").hidden=true,4500);
}
function guarded(fn) {return async event=>{try {await fn(event);} catch(error) {toast(error.message || "操作失败，请重试");}};}
function params(extra={}) {
  return new URLSearchParams({client_id:clientId,q:$("searchInput").value.trim(),
    days:$("daysFilter").value,source_id:$("sourceFilter").value,view,...extra});
}
function setClient(id) {
  clientId=id; localStorage.setItem(storageKey("client"),id); page=1; $("searchInput").value="";
  $("sourceFilter").value=""; messages=loadMessages(); renderState(); renderMessages(); loadArticles().catch(e=>toast(e.message));
}
function loadMessages() {
  try {const saved=JSON.parse(sessionStorage.getItem(storageKey("chat",clientId))||"[]");return Array.isArray(saved)?saved.slice(-24):[];} catch {return [];}
}
function persistMessages(items=messages, owner=clientId) {
  try {sessionStorage.setItem(storageKey("chat",owner),JSON.stringify(items.slice(-24)));} catch {}
}
async function refresh() {
  const firstLoad=!state;
  state=await api("/state");
  if(firstLoad)clientId=localStorage.getItem(storageKey("client"))||"";
  if (!client()) {
    clientId=(state.clients.find(c=>!c.archived)||{}).id || "";
    localStorage.setItem(storageKey("client"),clientId);
  }
  renderState();
}
function renderState() {
  const c=client(), active=state.clients.filter(x=>!x.archived);
  $("accountName").textContent=state.user.username;
  $("accountRole").textContent=admin()?"管理员":"成员";
  $("openSettings").hidden=!admin(); $("loadShelf").hidden=!admin();
  $("clientSelect").innerHTML=active.length ? active.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join("") : '<option value="">先创建一个客户</option>';
  $("clientSelect").value=clientId;
  $("brandName").textContent=state.settings.brand; document.title=state.settings.brand;
  $("breadcrumb").textContent=(c?c.name:"客户空间")+" / 内容参考库";
  $("viewTitle").textContent=labels[view];
  const descriptions={recent:"按发布时间滚动筛选，保留每条信息的原始出处。",all:"持续积累的文章资料，超过七天仍会保留。",favorites:"留住值得继续研究、讨论和写作的内容。",excluded:"仅对当前客户排除；恢复后重新参与检索。",sources:"一次配置，持续更新。每个客户独立管理监测对象。"};
  $("viewDescription").textContent=descriptions[view];
  [["recentCount","recent"],["allCount","all"],["favCount","favorites"],["hiddenCount","excluded"]].forEach(([id,key])=>$(id).textContent=c?c.counts[key]:0);
  $("sourceCount").textContent=c?c.sources.length:0;
  $("chatScope").textContent="当前客户 · "+(c?c.name:"未选择");
  $("assistantStatus").textContent=state.settings.key_configured ? "已就绪 · 检索文章库" : "等待管理员配置连接";
  $("scheduleLabel").textContent=state.settings.daily_enabled ? "每日 "+state.settings.daily_time+" 自动采集" : "每日采集已暂停";
  $("nextRun").textContent=state.next_run ? "下次："+date(state.next_run)+"（北京时间）" : "服务运行时按计划检查更新";
  const old=$("sourceFilter").value;
  $("sourceFilter").innerHTML='<option value="">全部来源</option>'+(c?c.sources.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.name)+'</option>').join(""):"");
  $("sourceFilter").value=(c && c.sources.some(s=>s.id===old)) ? old : "";
  $("syncButton").disabled=!c || !c.sources.some(s=>s.enabled) || state.sync_running;
  $("syncButton").textContent=state.sync_running ? "采集中…" : "↻ 更新文章";
  $("exportButton").disabled=!c; $("editClient").disabled=!c;
  document.querySelectorAll("[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  const isSources=view==="sources";
  $("filters").hidden=isSources; $("articleList").hidden=isSources; $("pagination").hidden=isSources;
  $("sourcePanel").hidden=!isSources; $("exportButton").hidden=isSources;
  if (isSources) renderSources();
  renderSyncNotice();
  const keywords=state.keywords||{};
  $("extractKeywords").disabled=!!keywords.running || !c || !state.settings.key_configured;
  $("keywordProgress").textContent=keywords.running ? "正在提取："+keywords.completed+" / "+keywords.total+" 篇" : keywords.message||"已有文章可按需补全，正文检索一直可用。";
}
function renderSyncNotice() {
  const run=state.runs.find(r=>r.client_id===clientId);
  const panel=$("syncNotice");panel.hidden=!run;
  if(!run)return;
  const results=run.results||[], added=results.reduce((n,r)=>n+(Number(r.added)||0),0);
  const titles=results.flatMap(r=>r.articles||[]);
  const words={running:"正在采集",success:added?"采集完成":"检查完成，本轮没有新文章",partial:"部分完成",failed:"采集未完成",interrupted:"服务重启，采集中断"};
  panel.innerHTML='<div class="sync-summary"><strong>'+esc(words[run.status]||run.status)+'</strong><span>'+esc(date(run.started_at))+' · 本轮新增 '+added+' 篇</span></div>'+
    (run.status==="running"?'<p>正在逐个检查来源，已入库文章可以继续检索。结果会自动更新。</p>':"")+
    results.filter(r=>r.status!=="success").map(r=>'<p>'+esc(r.source)+'：'+esc(r.message||"未完成")+(r.code?'（'+esc(r.code)+'）':"")+'</p>').join("")+
    (titles.length?'<details class="sync-titles" open><summary>本轮新增文章</summary>'+titles.map(a=>'<button class="sync-article" data-article="'+esc(a.id)+'" data-owner="'+esc(run.client_id)+'">'+esc(a.title)+'</button>').join("")+'</details>':"");
}
function articleCard(a) {
  return '<article class="article-card"><div class="article-top"><span class="source-mark">'+esc(a.source.slice(0,1))+'</span><span>'+esc(a.source)+'</span><span>· '+esc(a.category)+'</span><time datetime="'+esc(a.published_at)+'">'+esc(date(a.published_at))+'</time></div>'+
    '<h2><button class="title-button" data-article="'+esc(a.id)+'">'+esc(a.title)+'</button></h2><p class="article-excerpt">'+esc(a.excerpt||"正文尚未取得")+'</p>'+
    '<div class="card-bottom">'+(a.match_type?'<span class="small-tag">'+esc(a.match_type)+'</span>':"")+a.keywords.slice(0,3).map(t=>'<span class="tag">'+esc(t)+'</span>').join("")+
    '<span class="reading" title="当前通道未采集微信公众号阅读量">阅读量未采集</span>'+
    '<button class="favorite-btn '+(a.favorite?"selected":"")+'" data-favorite="'+esc(a.id)+'" data-value="'+(!a.favorite)+'" aria-label="'+(a.favorite?"取消收藏":"收藏文章")+'" title="'+(a.favorite?"取消收藏":"收藏")+'">'+(a.favorite?"★":"☆")+'</button>'+
    (safeUrl(a.url)?'<a class="card-original" href="'+esc(safeUrl(a.url))+'" target="_blank" rel="noopener noreferrer">原文 ↗</a>':"")+'</div></article>';
}
async function loadArticles() {
  const sequence=++querySequence;
  if(view==="sources") return;
  if(!client()) {$("articleList").innerHTML='<div class="empty"><strong>创建第一个客户空间</strong>添加客户、配置公众号，就可以开始积累文章。<br><button class="button primary" data-new-client>新建客户</button></div>'; $("pagination").hidden=true; $("resultCount").textContent=""; return;}
  $("resultCount").textContent="检索中…";
  const result=await api("/articles?"+params({page,limit:12}));
  if(sequence!==querySequence)return;
  total=result.total;
  if(page>Math.max(1,Math.ceil(total/12))){page=Math.max(1,Math.ceil(total/12));return loadArticles();}
  $("resultCount").textContent="共 "+total+" 篇";
  $("articleList").innerHTML=result.items.length ? result.items.map(articleCard).join("") :
    '<div class="empty"><strong>'+($("searchInput").value?"没有匹配的文章":view==="favorites"?"还没有收藏":view==="excluded"?"没有已排除的文章":"还没有文章")+'</strong>'+
    ($("searchInput").value?"试试更短的关键词，或将时间改为全部历史。":view==="favorites"?"点击文章旁的星标，将值得参考的内容留在这里。":view==="excluded"?"在文章详情中可以排除不适合当前客户的内容。":"先添加来源并更新；没有抓取到的内容不会自动补造。")+'</div>';
  $("pageInfo").textContent="第 "+page+" / "+Math.max(1,Math.ceil(total/12))+" 页 · "+($("searchInput").value.trim()?"主题匹配优先":"按发布时间倒序");
  $("prevPage").disabled=page<=1; $("nextPage").disabled=page*12>=total;
  $("pagination").hidden=total===0;
}
async function setView(next) {
  view=next; page=1; $("daysFilter").value=next==="recent"?"7":"0"; $("searchInput").value="";
  renderState(); await loadArticles();
}
function renderSources() {
  const c=client();
  $("sourcePanel").innerHTML='<div class="source-toolbar"><p>分类用于整理当前客户的来源。<br>暂停更新后，已积累文章仍然保留。</p><button class="button primary" data-add-source '+(!c?"disabled":"")+'>＋ 添加来源</button></div>'+
  (!c || !c.sources.length?'<div class="empty"><strong>添加第一个监测来源</strong>从已有来源、微信读书书架中选择，或一次性填写公众号标识。</div>':c.sources.map(s=>
    '<article class="source-card"><div class="source-head"><span class="source-mark">'+esc(s.name[0])+'</span><h3>'+esc(s.name)+'</h3><span class="small-tag '+(s.enabled?"":"off")+'">'+(s.enabled?"监测中":"已暂停")+'</span></div>'+
    '<p>最近采集：'+esc(date(s.synced_at))+' · 标识：'+esc(s.id)+'</p>'+
    '<div class="source-controls" data-source-row="'+esc(s.id)+'"><input class="source-category" aria-label="'+esc(s.name)+'的分类" value="'+esc(s.category)+'" maxlength="50"><label class="checkbox-line"><input class="source-enabled" type="checkbox" '+(s.enabled?"checked":"")+'>启用更新</label><button class="button" data-save-source="'+esc(s.id)+'">保存</button><button class="button" data-sync-source="'+esc(s.id)+'" '+(state.sync_running || !s.enabled?"disabled":"")+'>更新</button><button class="button danger" data-remove-source="'+esc(s.id)+'">移除</button></div></article>').join(""));
}
function openClient(existing=false) {
  editingClient=existing?client():null;
  $("clientForm").reset(); $("clientDialogTitle").textContent=existing?"管理客户":"新建客户";
  $("clientForm").elements.name.value=editingClient?editingClient.name:"";
  $("clientForm").elements.description.value=editingClient?editingClient.description:"";
  $("archiveClient").hidden=!existing; renderArchives();
  $("clientDialog").showModal();
}
function fillSourceOptions() {
  $("existingSource").innerHTML='<option value="">新公众号／手动配置</option>'+sourceOptions.map(s=>'<option value="'+esc(s.id)+'">'+esc(s.name)+'</option>').join("");
}
function openSource() {
  if(!client())return toast("请先创建客户");
  $("sourceForm").reset(); $("shelfMessage").textContent=""; $("sourceSearchMessage").textContent=""; sourceOptions=state.available_sources.slice();
  fillSourceOptions(); $("sourceDialog").showModal();
}
async function openArticle(id, owner=clientId) {
  detail=await api("/article?"+new URLSearchParams({client_id:owner,article_id:id}));
  detail.client_id=owner;
  $("detailTitle").textContent=detail.title;
  $("detailMeta").textContent=detail.source+" · "+date(detail.published_at)+"（北京时间） · 正文 "+detail.body_length+" 字符 · 阅读量未采集";
  const link=safeUrl(detail.url); $("detailOriginal").hidden=!link; $("detailOriginal").href=link || "#";
  $("detailFavorite").textContent=detail.favorite?"★ 已收藏":"☆ 收藏";
  $("detailHide").textContent=detail.hidden?"恢复到文章库":"排除这篇";
  $("detailForm").elements.keywords.value=detail.keywords.join("，");
  $("detailForm").elements.note.value=detail.note || "";
  $("detailTopics").innerHTML=detail.keywords.slice(0,3).map(t=>'<span class="tag">'+esc(t)+'</span>').join("");
  $("detailSearchTerms").textContent="后台检索词："+(detail.search_keywords||detail.keywords).join("、")+"。正文也参与检索。";
  $("keywordMethod").textContent=detail.keyword_method==="manual"?"人工词优先，仍保留后台提取词":detail.keyword_method==="ai"?"已根据标题与正文提取，可人工修订":"暂用标题词，可在设置中补全主题词";
  $("detailContent").src="/workbench/api/article/reader?"+new URLSearchParams({client_id:owner,article_id:id});
  if(!$("articleDialog").open){$("articleDialog").showModal();$("articleDialog").scrollTop=0;}
}
$("detailContent").addEventListener("load",()=>{
  if(readerObserver)readerObserver.disconnect();
  const frame=$("detailContent"), body=frame.contentDocument && frame.contentDocument.body;
  if(!body)return;
  readerObserver=new ResizeObserver(()=>{frame.style.height=Math.max(200,Math.ceil(body.getBoundingClientRect().height)+12)+"px";});
  readerObserver.observe(body);
});
async function changeSelection(id, changes, owner=clientId) {
  await api("/article?"+new URLSearchParams({client_id:owner,article_id:id}),"PUT",changes);
  await refresh(); await loadArticles();
}
function renderMessages() {
  const c=client();
  if(!messages.length) {
    $("messages").innerHTML='<div class="welcome"><h3>从信息里，<br>找到下一个选题。</h3><p>告诉我客户和关键词，我会检索文章库，整理近期主题，并附上可核对的出处。</p><div class="suggestions"><button class="suggestion" data-question="找一下最近七天关于 PMP 的文章">最近七天，有哪些 PMP 相关内容？ <span>↗</span></button><button class="suggestion" data-question="整理最近七天人工智能相关的文章主题">整理人工智能相关的近期主题 <span>↗</span></button><button class="suggestion" data-question="看看这个客户最近七天都更新了什么">看看当前客户最近更新了什么 <span>↗</span></button></div>'+
      (!state.settings.key_configured?'<div class="setup-prompt"><p>管理员配置 Eason 的服务连接后即可对话。左侧关键词搜索已经可以使用。</p>'+(admin()?'<button class="button" data-open-settings>配置 Eason</button>':"")+'</div>':"")+'</div>';
    return;
  }
  $("messages").innerHTML=messages.map(m=>{
    if(m.role==="user")return '<div class="chat-message user">'+esc(m.content)+'</div>';
    return '<div class="chat-message assistant"><span class="message-label">✳ Eason</span>'+esc(m.content)+
      (m.items||[]).map((a,i)=>'<button class="reference-card" data-article="'+esc(a.id)+'" data-owner="'+esc(m.client_id||clientId)+'">['+(i+1)+'] '+esc(a.title)+'<small>'+esc(a.source)+' · '+esc(date(a.published_at))+' · '+esc(a.match_type||"已入库文章")+' · 阅读量未采集</small></button>'+(safeUrl(a.url)?'<a class="reference-original" href="'+esc(safeUrl(a.url))+'" target="_blank" rel="noopener noreferrer">['+(i+1)+'] 打开原文 ↗</a>':"")).join("")+
      (m.query!==undefined?'<p class="query-note">匹配 '+m.total+' 篇 · 展示 '+(m.items||[]).length+' 篇 · '+esc(m.days===0?"全部历史":"近 "+m.days+" 天")+' · 关键词：'+esc(m.query||"全部")+'</p>':"")+'</div>';
  }).join("")+(chatBusy?'<div class="chat-message assistant"><span class="message-label">✳ Eason</span>正在理解问题、检索文章并整理出处…</div>':"");
  $("messages").scrollTop=$("messages").scrollHeight;
}
async function askQuestion(text) {
  if(chatBusy)return;
  if(!client())return toast("请先创建并选择客户");
  if(!state.settings.key_configured){if(admin())openSettings();toast("请联系管理员配置 Eason 的服务连接");return;}
  $("chatError").hidden=true;
  const owner=clientId, conversation=messages, history=messages.slice(-6).map(m=>({role:m.role,content:m.content.slice(0,6000)}));
  messages.push({role:"user",content:text}); chatBusy=true; $("sendChat").disabled=true; $("chatInput").value="";
  renderMessages();
  try {
    const answer=await api("/chat","POST",{client_id:owner,message:text,history});
    conversation.push({role:"assistant",content:answer.answer,...answer});
    persistMessages(conversation,owner);
  } catch(error) {
    $("chatError").textContent=error.message; $("chatError").hidden=false;
  } finally {
    chatBusy=false; $("sendChat").disabled=false; renderMessages(); $("chatInput").focus();
  }
}
function openSettings() {
  if(!admin())return toast("设置与连接由管理员管理");
  const f=$("settingsForm"), s=state.settings;
  f.elements.brand.value=s.brand; f.elements.model.value=s.model; f.elements.api_key.value="";
  f.elements.clear_key.checked=false; f.elements.weread_api_key.value=""; f.elements.clear_weread_key.checked=false; f.elements.daily_time.value=s.daily_time; f.elements.daily_enabled.checked=s.daily_enabled;
  f.elements.api_key.disabled=s.key_from_env; f.elements.clear_key.disabled=s.key_from_env;
  $("keyStatus").textContent=s.key_from_env?"密钥由服务器环境变量提供。":s.key_configured?"密钥已保存，页面不会回显。留空则保留当前密钥。":"尚未配置。密钥只保存在服务端，不写入浏览器缓存。";
  $("wereadKeyStatus").textContent=s.weread_search_configured?"官方搜索密钥已保存，页面不会回显。":"未配置可选搜索密钥。"; $("modelTestResult").textContent="";
  $("wechatStatus").textContent=state.wechat_configured?"已保存公众号后台凭据，可在添加来源时按名称搜索；是否有效以实际搜索为准。":"按名称搜索需用公众号管理员或运营者的微信扫码登录。";
  $("wereadStatus").textContent=state.weread_configured?"已保存登录凭据。是否仍有效，以最近一次实际采集结果为准。":"尚未保存微信读书登录，请扫码。";
  renderLogs(); $("qrArea").hidden=true; $("wechatQrArea").hidden=true; clearInterval(qrTimer); $("settingsDialog").showModal();
}
function renderLogs() {
  const words={running:"采集中",success:"完成",partial:"部分完成",failed:"未完成",interrupted:"服务重启，中断"};
  $("runLogs").innerHTML=state.runs.length?state.runs.map(r=>'<div class="run-log">'+esc(date(r.started_at))+'<span>'+esc(words[r.status]||r.status)+'</span>'+r.results.map(x=>'<p>'+esc(x.source)+' · '+(x.status==="success"?"新增 "+x.added+" 篇":esc(x.message)+(x.code?"（错误码 "+esc(x.code)+"）":""))+'</p>').join("")+'</div>').join(""):'<p class="hint">工作台尚未执行新任务。既有文章已从采集数据库接入。</p>';
  renderArchives();
}
function renderArchives() {
  const archived=state.clients.filter(c=>c.archived);
  const html=archived.length?archived.map(c=>'<div class="archived-client"><span>'+esc(c.name)+'</span><button class="button" data-restore-client="'+esc(c.id)+'">恢复</button></div>').join(""):'<p class="hint">暂无已归档客户</p>';
  $("archivedClients").innerHTML=html; $("clientArchives").innerHTML=html;
}
async function beginSync(sourceId="") {
  const result=await api("/sync","POST",{client_id:clientId,source_id:sourceId});
  toast("已开始更新 "+result.source_count+" 个来源"); await refresh();
}

$("clientSelect").addEventListener("change",()=>{if(chatBusy){$("clientSelect").value=clientId;return toast("请等当前回答结束后切换客户");}setClient($("clientSelect").value);});
$("newClient").addEventListener("click",()=>openClient());
$("editClient").addEventListener("click",()=>openClient(true));
$("clientForm").addEventListener("submit",guarded(async e=>{
  e.preventDefault(); const f=e.target, data={name:f.elements.name.value,description:f.elements.description.value,archived:false};
  const result=await api("/clients"+(editingClient?"/"+editingClient.id:""),editingClient?"PUT":"POST",data);
  const id=editingClient?editingClient.id:result.id; $("clientDialog").close(); await refresh(); setClient(id); toast("客户已保存");
}));
$("archiveClient").addEventListener("click",guarded(async()=>{
  if(!confirm("归档当前客户？来源、收藏和文章不会删除，可在客户管理中恢复。"))return;
  await api("/clients/"+clientId,"PUT",{name:client().name,description:client().description,archived:true});
  $("clientDialog").close(); await refresh(); setClient(clientId); toast("客户已归档");
}));
$("searchForm").addEventListener("submit",guarded(async e=>{e.preventDefault();page=1;await loadArticles();}));
$("searchInput").addEventListener("search",guarded(async()=>{page=1;await loadArticles();}));
$("sourceFilter").addEventListener("change",guarded(async()=>{page=1;await loadArticles();}));
$("daysFilter").addEventListener("change",guarded(async()=>{page=1;await loadArticles();}));
$("prevPage").addEventListener("click",guarded(async()=>{page=Math.max(1,page-1);await loadArticles();window.scrollTo({top:0});}));
$("nextPage").addEventListener("click",guarded(async()=>{page++;await loadArticles();window.scrollTo({top:0});}));
$("exportButton").addEventListener("click",()=>{window.location.href="/workbench/api/export?"+params();});
$("syncButton").addEventListener("click",guarded(()=>beginSync()));
$("existingSource").addEventListener("change",()=>{
  const s=sourceOptions.find(x=>x.id===$("existingSource").value);
  if(s){$("sourceForm").elements.name.value=s.name;$("sourceForm").elements.identifier.value=s.id;}
});
$("loadShelf").addEventListener("click",guarded(async()=>{
  $("loadShelf").disabled=true;
  try {const result=await api("/weread/shelf"); for(const s of result.items)if(!sourceOptions.some(x=>x.id===s.id))sourceOptions.push(s);
    fillSourceOptions(); $("shelfMessage").textContent=result.items.length?"已读取 "+result.items.length+" 个公众号，请从上方列表选择。":"书架没有返回公众号；可先在微信读书中订阅后再读取，或填写标识。";
  }finally{$("loadShelf").disabled=false;}
}));
$("searchSources").addEventListener("click",guarded(async()=>{
  const q=$("sourceSearch").value.trim();if(!q)return toast("请输入公众号名称");
  $("searchSources").disabled=true;$("sourceSearchMessage").textContent="正在搜索公众号…";
  try{const result=await api("/wechat/search?"+new URLSearchParams({q}));
    for(const item of result.items)if(!sourceOptions.some(x=>x.id===item.id))sourceOptions.push(item);
    fillSourceOptions();
    $("sourceSearchMessage").textContent=result.items.length?"找到 "+result.items.length+" 个候选，请在下方选择并核对名称。":"本次未返回匹配公众号；可改用一次性标识或从书架选择。";
    if(result.items.length===1){$("existingSource").value=result.items[0].id;$("existingSource").dispatchEvent(new Event("change"));}
  }catch(e){$("sourceSearchMessage").textContent=e.message;}finally{$("searchSources").disabled=false;}
}));
$("sourceForm").addEventListener("submit",guarded(async e=>{
  e.preventDefault();const f=e.target;
  await api("/clients/"+clientId+"/sources","POST",{name:f.elements.name.value,identifier:f.elements.identifier.value,category:f.elements.category.value,enabled:true});
  $("sourceDialog").close();await refresh();await loadArticles();toast("来源已保存，更新文章即可验证采集");
}));
$("openSettings").addEventListener("click",()=>openSettings());
$("logoutButton").addEventListener("click",guarded(async()=>{
  await api("/auth/logout","POST");
  const prefix="eason-"+state.user.id+"-chat-";
  Object.keys(sessionStorage).filter(k=>k.startsWith(prefix)).forEach(k=>sessionStorage.removeItem(k));
  window.location.replace("/workbench/login");
}));
$("settingsForm").addEventListener("submit",guarded(async e=>{
  e.preventDefault();const f=e.target;
  await api("/settings","PUT",{brand:f.elements.brand.value,model:f.elements.model.value,api_key:f.elements.api_key.value.trim(),clear_key:f.elements.clear_key.checked,weread_api_key:f.elements.weread_api_key.value.trim(),clear_weread_key:f.elements.clear_weread_key.checked,daily_time:f.elements.daily_time.value,daily_enabled:f.elements.daily_enabled.checked});
  f.elements.api_key.value=""; f.elements.weread_api_key.value=""; await refresh(); $("wereadKeyStatus").textContent=state.settings.weread_search_configured?"官方搜索密钥已保存，页面不会回显。":"尚未配置官方搜索密钥。"; $("keyStatus").textContent=state.settings.key_configured?"密钥已保存，页面不会回显。":"尚未配置密钥。"; renderMessages();toast("设置已保存");
}));
$("testModel").addEventListener("click",guarded(async()=>{
  $("testModel").disabled=true;$("modelTestResult").textContent="正在验证…";
  try{const result=await api("/model-test","POST");$("modelTestResult").textContent=result.message;}
  catch(e){$("modelTestResult").textContent=e.message;}
  finally{$("testModel").disabled=false;}
}));
$("newWechatQr").addEventListener("click",guarded(async()=>{
  $("newWechatQr").disabled=true;clearInterval(qrTimer);
  $("wechatQrArea").hidden=false;$("wechatQrImage").hidden=true;$("wechatQrStatus").textContent="正在打开公众号后台登录，请稍候…";
  try{
    const result=await api("/wechat/qr","POST");let checks=0,shown=false;
    if(result.url!=="/workbench/api/wechat/qr-image")throw new Error("二维码返回地址异常，请重试");
    qrTimer=setInterval(async()=>{try{
      const status=await api("/wechat/status");checks++;
      if(!status.running&&!status.logged_in&&!status.qr_ready){clearInterval(qrTimer);$("wechatQrStatus").textContent="二维码未能生成，请检查采集服务日志；也可使用一次性公众号标识添加来源。";return;}
      if(status.qr_ready&&!shown){$("wechatQrImage").src=result.url+"?t="+Date.now();$("wechatQrImage").hidden=false;shown=true;$("wechatQrStatus").textContent="请用公众号管理员或运营者的微信扫码并确认登录";}
      if(status.logged_in||checks>=120){clearInterval(qrTimer);await refresh();$("wechatQrStatus").textContent=status.logged_in?"公众号后台登录成功，凭据已保存。现在可按名称搜索来源。":"登录未完成，请重新获取二维码";}
    }catch{clearInterval(qrTimer);$("wechatQrStatus").textContent="登录状态读取失败，请重新获取二维码";}},2500);
  }catch(e){$("wechatQrStatus").textContent=e.message;}finally{$("newWechatQr").disabled=false;}
}));
$("newQr").addEventListener("click",guarded(async()=>{
  $("newQr").disabled=true;clearInterval(qrTimer);
  try{
    const result=await api("/weread/qr","POST");
    if(result.url!=="/workbench/api/weread/qr-image")throw new Error("二维码返回地址异常，请重试");
    $("qrImage").src=result.url+"?t="+Date.now();$("qrArea").hidden=false;$("qrStatus").textContent="请用手机微信扫码，并确认登录";
    let checks=0;
    qrTimer=setInterval(async()=>{try{const status=await api("/weread/status");checks++;$("qrStatus").textContent=status.logged_in?"登录成功，已保存凭据":status.message||"等待扫码确认";
      if(status.logged_in||checks>=60){clearInterval(qrTimer);await refresh();if(checks>=60&&!status.logged_in)$("qrStatus").textContent="二维码可能已过期，请重新获取";}
    }catch{clearInterval(qrTimer);$("qrStatus").textContent="状态读取失败，请重新获取二维码";}},2500);
  }finally{$("newQr").disabled=false;}
}));
$("settingsDialog").addEventListener("close",()=>{clearInterval(qrTimer);$("settingsForm").elements.api_key.value="";$("settingsForm").elements.weread_api_key.value="";});
$("detailForm").addEventListener("submit",guarded(async e=>{
  e.preventDefault();const f=e.target, keywords=f.elements.keywords.value.split(/[,，、;；]/).map(x=>x.trim()).filter(Boolean);
  await changeSelection(detail.id,{keywords,note:f.elements.note.value},detail.client_id);
  detail.keywords=keywords;detail.note=f.elements.note.value;$("keywordMethod").textContent="已保存人工关键词";$("detailTopics").innerHTML=keywords.slice(0,3).map(t=>'<span class="tag">'+esc(t)+'</span>').join("");toast("关键词与备注已保存");
}));
$("detailFavorite").addEventListener("click",guarded(async()=>{await changeSelection(detail.id,{favorite:!detail.favorite},detail.client_id);await openArticle(detail.id,detail.client_id);}));
$("detailHide").addEventListener("click",guarded(async()=>{const hidden=!detail.hidden;await changeSelection(detail.id,{hidden},detail.client_id);$("articleDialog").close();toast(hidden?"已对当前客户排除，可在「已排除」中恢复":"已恢复到文章库");}));
$("chatForm").addEventListener("submit",guarded(async e=>{e.preventDefault();const text=$("chatInput").value.trim();if(text)await askQuestion(text);}));
$("chatInput").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();$("chatForm").requestSubmit();}});
$("clearChat").addEventListener("click",()=>{if(chatBusy)return;messages=[];persistMessages();renderMessages();$("chatError").hidden=true;});
$("showChat").addEventListener("click",()=>{document.body.classList.add("chat-open");$("messages").scrollTop=$("messages").scrollHeight;});
$("extractKeywords").addEventListener("click",guarded(async()=>{await api("/keywords","POST",{client_id:clientId});await refresh();toast("已开始补全主题词，可以继续浏览文章");}));
$("closeChat").addEventListener("click",()=>document.body.classList.remove("chat-open"));
document.addEventListener("click",guarded(async e=>{
  const b=e.target.closest("button");if(!b)return;
  if(b.dataset.close){$(b.dataset.close).close();return;}
  if(b.dataset.view){await setView(b.dataset.view);return;}
  if(b.hasAttribute("data-new-client")){openClient();return;}
  if(b.hasAttribute("data-add-source")){openSource();return;}
  if(b.hasAttribute("data-open-settings")){openSettings();return;}
  if(b.dataset.article){await openArticle(b.dataset.article,b.dataset.owner||clientId);return;}
  if(b.dataset.favorite){await changeSelection(b.dataset.favorite,{favorite:b.dataset.value==="true"});return;}
  if(b.dataset.question){document.body.classList.add("chat-open");await askQuestion(b.dataset.question);return;}
  if(b.dataset.syncSource){await beginSync(b.dataset.syncSource);return;}
  if(b.dataset.saveSource){const row=b.closest("[data-source-row]");await api("/clients/"+clientId+"/sources/"+encodeURIComponent(b.dataset.saveSource),"PUT",{category:row.querySelector(".source-category").value,enabled:row.querySelector(".source-enabled").checked});await refresh();toast("来源设置已保存");return;}
  if(b.dataset.removeSource){if(!confirm("从当前客户移除此来源？已有原始文章不会删除，重新添加后仍可查看。"))return;await api("/clients/"+clientId+"/sources/"+encodeURIComponent(b.dataset.removeSource),"DELETE");await refresh();toast("来源已移除");return;}
  if(b.dataset.restoreClient){const c=state.clients.find(x=>x.id===b.dataset.restoreClient);await api("/clients/"+c.id,"PUT",{name:c.name,description:c.description,archived:false});await refresh();renderLogs();toast("客户已恢复");}
}));
let polling=false;
setInterval(async()=>{
  if(!state||(!state.sync_running&&!(state.keywords||{}).running)||polling)return;
  polling=true;try{const wasRunning=state.sync_running, wasKeywords=(state.keywords||{}).running;await refresh();if(wasRunning&&!state.sync_running){await loadArticles();toast("采集任务结束，请查看最新结果");}if(wasKeywords&&!state.keywords.running){await loadArticles();toast(state.keywords.message);}if($("settingsDialog").open)renderLogs();}catch{}finally{polling=false;}
},3500);
(async()=>{try{await refresh();messages=loadMessages();renderMessages();await loadArticles();}
catch(error){$("articleList").innerHTML='<div class="empty"><strong>暂时无法读取工作台</strong>'+esc(error.message)+'<br>请确认本地服务运行后刷新页面。</div>';}})();
