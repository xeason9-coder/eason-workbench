'use client';
import {useEffect, useState} from 'react';
type R = Record<string, any>;

export async function fusionRequest(path: string, body?: R, method?: string) {
  const response = await fetch('/api/fusion/' + path, {method: method || (body ? 'POST' : 'GET'), headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  const result: R = await response.json();
  if (!response.ok) throw Object.assign(Error(result.error || '请求失败'), {status: response.status});
  return result;
}

export function FusionShell({render}: {render: (session: R) => React.ReactNode}) {
  const [session, setSession] = useState<R | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(false);
  async function load() {
    try { setSession(await fusionRequest('auth/session')); setError(''); }
    catch (e: any) { setSession(null); if (e.status !== 401) setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  async function login(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await fusionRequest('auth/login', {username, password}); setPassword(''); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function select(id: string) {
    setBusy(true);
    try { await fusionRequest('select', {id}); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  if (loading) return <div className="login-panel"><h1>正在打开知识库</h1><p>检查本地服务与登录状态</p></div>;
  if (!session) return <div className="fusion-login"><form className="panel" onSubmit={login}><span className="nav-label">本地试运行</span><h1>客户知识与内容工作台</h1><p>管理资料与知识，跟踪信源，协作策划和写作。</p>{error && <p className="banner error" role="alert">{error}</p>}<label className="field"><span>账号</span><input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required maxLength={32}/></label><label className="field"><span>密码</span><input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required maxLength={72}/></label><button className="primary" disabled={busy}>{busy ? '正在登录…' : '登录工作台'}</button><p className="subtle">使用管理员分配的账号；沿用已有采集工作台账号。</p></form></div>;
  const context = {...session, changeClient: select, reloadSession: load, logout: async () => {await fusionRequest('auth/logout', {}); setSession(null);}, busy};
  return <>{error && <p className="banner error" role="alert">{error}</p>}{session.client ? render(context) : <div className="fusion-login"><section className="panel"><h1>选择客户空间</h1><p>当前账号：{session.user.username}</p>{session.clients.map((c: R) => <button className="fusion-client-card" disabled={busy} key={c.id} onClick={() => select(c.id)}><b>{c.name}</b><span>{c.description || '进入此客户的资料、监测与内容工作台'}</span></button>)}{!session.clients.length && <p>还没有客户空间。在下方创建自己的空间，即可开始整理资料与知识。</p>}<ClientSpaces session={context}/><button onClick={context.logout}>退出登录</button></section></div>}</>;
}


export function ClientSpaces({session}: {session: R}) {
  const [clients,setClients]=useState<R[]>([]),[editing,setEditing]=useState<R|null>(null);
  const [name,setName]=useState(''),[description,setDescription]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  async function load(){setClients((await fusionRequest('clients?include_archived=true')).items.filter((client: R) => session.user.role === 'admin' || client.owned));}
  useEffect(()=>{load().catch(e=>setError(e.message));},[]);
  async function save(client?:R){
    setBusy(true);setError('');setNotice('');
    try{
      const values=client?{name:client.name,description:client.description||'',archived:!!client.archived}:{name,description,archived:false};
      const saved = await fusionRequest(client?'clients/'+encodeURIComponent(client.id):'clients',values,client?'PUT':'POST');
      if(!client){setName('');setDescription('');}setEditing(null);
      await load();if(client)await session.reloadSession();else await session.changeClient(saved.id);setNotice(client?.archived?'空间已归档，资料与历史记录保留。':'空间信息已保存。');
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  return <section className="fusion-settings"><h3>客户空间管理</h3><p className="subtle">每个账号可创建两个未归档空间；普通账号之间互不可见，需单独授权才能协作。归档保留资料与历史记录，恢复后可继续使用。</p>{error&&<p className="banner error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <form onSubmit={e=>{e.preventDefault();save();}}><h4>新增客户空间</h4><label className="field"><span>客户名称</span><input required maxLength={80} value={name} disabled={busy} onChange={e=>setName(e.target.value)}/></label><label className="field"><span>客户定位与空间说明</span><textarea maxLength={300} rows={3} value={description} disabled={busy} onChange={e=>setDescription(e.target.value)}/></label><button disabled={busy||!name.trim()}>创建空间</button></form>
    <h4>已有空间（含归档）</h4>{clients.map(client=><section key={client.id} className="panel fusion-topic"><h4>{client.name} · {client.archived?'已归档':'使用中'}</h4>{client.description&&<p>{client.description}</p>}
      {editing&&editing.id===client.id?<form onSubmit={e=>{e.preventDefault();save(editing);}}><label className="field"><span>客户名称</span><input required maxLength={80} value={editing.name} disabled={busy} onChange={e=>setEditing({...editing,name:e.target.value})}/></label><label className="field"><span>客户定位与空间说明</span><textarea rows={3} maxLength={300} value={editing.description||''} disabled={busy} onChange={e=>setEditing({...editing,description:e.target.value})}/></label><div className="actions"><button disabled={busy||!editing.name.trim()}>保存空间信息</button><button type="button" disabled={busy} onClick={()=>setEditing(null)}>取消</button></div></form>:<div className="actions"><button disabled={busy} onClick={()=>setEditing({...client})}>编辑空间信息</button><button disabled={busy} onClick={()=>save({...client,archived:!client.archived})}>{client.archived?'恢复空间':'归档空间（保留数据）'}</button></div>}
    </section>)}
  </section>;
}

export function AccessSettings({session}: {session: R}) {
  const [users, setUsers] = useState<R[]>([]), [members, setMembers] = useState<R[]>([]), [catalog, setCatalog] = useState<R>({documents: [], tasks: [], articles: []});
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [account, setAccount] = useState({username: '', password: '', role: 'user'});
  const [member, setMember] = useState<R>({user_id: '', role: 'member', grants: {documents: [], tasks: [], articles: []}});
  async function load() {
    const [u, m, c, a] = await Promise.all([fusionRequest('admin/users'), fusionRequest(`clients/${session.client.id}/members`), fetch('/api/studio/accessCatalog').then(r => r.json() as Promise<R>), fusionRequest(`monitor/articles?client_id=${session.client.id}&days=0&view=all&limit=100`)]);
    setUsers(u.items); setMembers(m.items); setCatalog({...c, articles: a.items});
  }
  useEffect(() => { load().catch(e => setError(e.message)); }, [session.client.id]);
  async function run(fn: () => Promise<void>) {setBusy(true); setError(''); setNotice(''); try {await fn(); await load(); setNotice('已保存');} catch (e: any) {setError(e.message);} finally {setBusy(false);}}
  const toggle = (kind: string, id: string) => setMember({...member, grants: {...member.grants, [kind]: member.grants[kind].includes(id) ? member.grants[kind].filter((x: string) => x !== id) : [...member.grants[kind], id]}});
  return <section className="panel fusion-settings"><h2>客户与成员权限</h2><ClientSpaces session={session}/>{error && <p className="banner error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}<p>当前空间：{session.client.name}。外部账号默认不能阅读原件；“允许对外引用”由知识审核单独控制。</p><div className="fusion-columns"><form onSubmit={e => {e.preventDefault(); run(async () => {await fusionRequest('admin/users', account); setAccount({...account, password: '', username: ''});});}}><h3>新增登录账号</h3><label className="field"><span>用户名</span><input required value={account.username} onChange={e => setAccount({...account, username: e.target.value})} pattern="[a-zA-Z0-9_.-]{3,32}"/></label><label className="field"><span>初始密码（12–72 字节）</span><input type="password" autoComplete="new-password" required minLength={12} value={account.password} onChange={e => setAccount({...account, password: e.target.value})}/></label><label className="field"><span>账号角色</span><select value={account.role} onChange={e => setAccount({...account, role: e.target.value})}><option value="user">普通账号</option><option value="admin">系统管理员</option></select></label><button disabled={busy}>创建账号</button></form></div><form onSubmit={e => {e.preventDefault(); run(async () => {await fusionRequest(`clients/${session.client.id}/members`, member, 'PUT');});}}><h3>分配当前客户的成员</h3><div className="actions"><label className="field"><span>账号</span><select required value={member.user_id} onChange={e => {const old = members.find(m => m.user_id === e.target.value); setMember(old ? {user_id: old.user_id, role: old.role, grants: old.grants} : {user_id: e.target.value, role: 'member', grants: {documents: [], tasks: [], articles: []}});}}><option value="">选择账号</option>{users.map(u => <option key={u.id} value={u.id}>{u.username}{!u.active ? '（已停用）' : ''}</option>)}</select></label><label className="field"><span>客户角色</span><select value={member.role} onChange={e => setMember({...member, role: e.target.value})}><option value="member">内部成员（共享读写）</option><option value="manager">客户管理员</option><option value="external">外部成员（明确授权的内容）</option></select></label></div>{member.role === 'external' && <div className="fusion-columns">{[['documents', '可阅读的原件与知识'], ['tasks', '可阅读的文章任务'], ['articles', '可阅读的监测文章']].map(([kind, label]) => <fieldset key={kind}><legend>{label}</legend><div className="fusion-grants">{(catalog[kind] || []).map((item: R) => <label className="check-label" key={item.id}><input type="checkbox" checked={member.grants[kind].includes(item.id)} onChange={() => toggle(kind, item.id)}/>{item.name || item.title}</label>)}{!catalog[kind]?.length && <p className="subtle">当前没有内容可授权</p>}</div></fieldset>)}</div>}<button className="primary" disabled={busy || !member.user_id}>保存客户授权</button></form><div className="table-wrap"><table><thead><tr><th>成员</th><th>角色</th><th>授权数量</th><th>操作</th></tr></thead><tbody>{members.map(m => <tr key={m.user_id}><td>{m.username}</td><td>{m.role}</td><td>资料 {m.grants.documents.length} / 任务 {m.grants.tasks.length} / 文章 {m.grants.articles.length}</td><td><button onClick={() => run(async () => {await fusionRequest(`clients/${session.client.id}/members/${m.user_id}`, undefined, 'DELETE');})}>撤销空间授权</button></td></tr>)}</tbody></table></div><details><summary>账号启用状态</summary>{users.map(u => <p key={u.id}>{u.username} · {u.role} · {u.active ? '已启用' : '已停用'} <button disabled={busy || u.id === session.user.id} onClick={() => run(async () => {await fusionRequest(`admin/users/${u.id}`, {active: !u.active}, 'PUT');})}>{u.active ? '停用账号' : '恢复账号'}</button></p>)}</details></section>;
}
