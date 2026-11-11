type R = Record<string, any>;

export function cookieValue(request: Request, name: string) {
  return request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1) || '';
}

export async function collector(request: Request, env: R, path: string, init: RequestInit = {}) {
  if (!env.FUSION_SERVICE_TOKEN || !env.FUSION_COLLECTOR_URL) throw Object.assign(Error('本地采集与账号服务尚未配置'), {code: 503});
  const base = new URL(env.FUSION_COLLECTOR_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') throw Error('本地采集服务必须使用环回地址');
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer ' + env.FUSION_SERVICE_TOKEN);
  headers.set('Cookie', request.headers.get('cookie') || '');
  const client = cookieValue(request, 'fusion_client');
  if (client) headers.set('X-Fusion-Client', client);
  try {
    const response = await fetch(new URL('/fusion/' + path, base), {...init, headers, redirect: 'manual', signal: AbortSignal.timeout(180000)});
    if (response.status >= 300 && response.status < 400) throw Error('采集服务不允许重定向');
    return response;
  } catch {
    throw Object.assign(Error('本地采集与账号服务未响应，请检查启动状态'), {code: 503});
  }
}

export async function fusionSession(request: Request, env: R) {
  const response = await collector(request, env, 'auth/session');
  const result: R = await response.json();
  if (!response.ok) throw Object.assign(Error(result.detail || result.error || '请登录知识库'), {code: response.status});
  return result;
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw Object.assign(Error('不允许跨站请求'), {code: 403});
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw Object.assign(Error('不允许跨站请求'), {code: 403});
}
