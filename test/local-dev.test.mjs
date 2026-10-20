import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url));
const seed=JSON.parse(await readFile(resolve(root,'data/seed.json'),'utf8'));
const publicCount=seed.documents.filter(doc=>doc.reviewStatus==='published').length;
async function start(env){
 const child=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
 const base=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Local server did not become ready.')),10000);child.stdout.on('data',chunk=>{text+=chunk;const match=text.match(/Local: (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('exit',()=>{clearTimeout(timer);reject(Error('Local server exited before readiness.'));});child.once('error',()=>{clearTimeout(timer);reject(Error('Local server could not start.'));});});
 return{child,base};
}
async function stop(server){if(!server||server.child.exitCode!==null)return;const done=new Promise(resolve=>server.child.once('exit',resolve));server.child.kill('SIGTERM');await done;}
async function call(server,path,options={}){const response=await fetch(server.base+path,{...options,signal:AbortSignal.timeout(5000)});return{response,data:await response.json()};}
test('Loopback adapter serves the real app, blocks forged identity headers and persists private drafts across restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'legal-reference-local-'));
 const token=randomBytes(32).toString('hex'),env={PORT:'0',REFERENCE_LOCAL_DATA_DIR:dir,ADMIN_TOKEN:token,ADMIN_EMAIL:'owner@example.test',LAW_API_OC:'',LAW_UPDATE_SIGNING_KEY:''};let server;
 try{
  server=await start(env);let status=await call(server,'/api/status');assert.equal(status.response.status,200);assert.equal(status.data.counts.documents,publicCount);assert.equal(status.data.aiEnabled,false);
  const index=await fetch(server.base+'/');assert.equal(await index.text(),await readFile(resolve(root,'public/index.html'),'utf8'));
  assert.equal((await call(server,'/api/admin/documents',{headers:{'oai-authenticated-user-email':'owner@example.test'}})).response.status,401);
  const login=await call(server,'/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});assert.equal(login.response.status,200);const cookie=login.response.headers.get('set-cookie').split(';')[0];
  const draft={title:'Isolated local smoke fixture — never published',domain:'tax',type:'guide',agency:'국세청',sourceUrl:'https://www.nts.go.kr/',bodyStatus:'link',reviewStatus:'draft',rights:'isolated test fixture'};
  const saved=await call(server,'/api/admin/documents',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(draft)});assert.equal(saved.response.status,201);const id=saved.data.document.id;
  assert.equal((await call(server,'/api/search')).data.total,publicCount,'private draft is not public');
  await stop(server);server=await start(env);
  const restored=await call(server,'/api/admin/documents',{headers:{cookie}});assert.ok(restored.data.documents.some(d=>d.id===id));
  assert.equal((await call(server,'/api/admin/documents/'+id,{method:'DELETE',headers:{cookie}})).data.deleted,true);
  assert.equal((await call(server,'/api/admin/documents',{headers:{cookie}})).data.documents.length,seed.documents.length);
 }finally{await stop(server);await rm(dir,{recursive:true,force:true});}
});
