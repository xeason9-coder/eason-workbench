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

export function publicOrigin(env: R) {
  if (!env.FUSION_PUBLIC_ORIGIN) return '';
  try {
    const url = new URL(env.FUSION_PUBLIC_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error();
    return url.origin;
  } catch { throw Object.assign(Error('FUSION_PUBLIC_ORIGIN 必须是无路径的 HTTPS 站点地址'), {code: 503}); }
}

export function requireSameOrigin(request: Request, env: R) {
  const url = new URL(request.url), configured = publicOrigin(env);
  const host = (request.headers.get('host') || url.host).toLowerCase();
  const origin = request.headers.get('origin');
  // The background endpoint still requires its service token inside fusionApi.
  const internalTick = url.pathname === '/api/fusion/background/tick' && !origin &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && host === url.host;
  const expected = configured && !internalTick ? configured : url.origin;
  if (configured && !internalTick && (host !== new URL(configured).host ||
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !origin)) {
    throw Object.assign(Error('不允许的访问地址或缺少同源标识'), {code: 403});
  }
  if (origin && origin !== expected) throw Object.assign(Error('不允许跨站请求'), {code: 403});
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw Object.assign(Error('不允许跨站请求'), {code: 403});
}
