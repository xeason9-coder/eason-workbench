import {fusionApi, fusionStudio} from '../lib/fusion';

// The fixture routes through the same authenticated bridge as the local Worker.
export default {
  fetch(request: Request, env: any) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/fusion/')) return fusionApi(request, env);
    if (path.startsWith('/api/studio/')) return fusionStudio(request, env);
    return new Response('Not found', {status: 404});
  },
};
