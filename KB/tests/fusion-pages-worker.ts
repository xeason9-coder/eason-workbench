import {libraryPage, knowledgePage} from '../lib/studio/paged-data';
export default {async fetch(req: Request, env: any) {
  const owner=req.headers.get('x-test-owner')||'client:a';
  const client={role:req.headers.get('x-test-role')||'member',grants:{documents:JSON.parse(req.headers.get('x-test-documents')||'[]')}};
  try {return Response.json(await (new URL(req.url).pathname==='/library'?libraryPage:knowledgePage)(req,env,owner,client));}
  catch(e:any){return Response.json({error:e.message},{status:e.code||500});}
}};
