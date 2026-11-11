import {receiveUpload, storageUsage} from '../lib/studio/uploads';
export default {async fetch(req: Request, env: any) {
  const uid = req.headers.get('x-test-owner') || 'client:a';
  try {
    if (req.method === 'GET') return Response.json(await storageUsage(env, uid));
    if (req.headers.get('x-test-fail-original')) {
      const bucket = env.BUCKET;
      env = {...env, BUCKET: {
        head: (key: string) => bucket.head(key), delete: (key: string | string[]) => bucket.delete(key),
        put: (key: string, value: any, options: any) => {if (key.endsWith('.original')) throw Error('fixture original write failure'); return bucket.put(key, value, options);}
      }};
    }
    return Response.json(await receiveUpload(await req.formData(), env, uid));
  } catch (e: any) {return Response.json({error: e.message}, {status: e.code || 500});}
}};
