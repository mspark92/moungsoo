import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {handleRequest} from '../worker/runtime.mjs';
const seed=JSON.parse(await readFile(new URL('../data/seed.json',import.meta.url),'utf8'));
const encoder=new TextEncoder();
function bucket(){const data=new Map();return{get:async key=>data.has(key)?{json:async()=>JSON.parse(data.get(key)),etag:'fixture'}:null,put:async(key,value)=>{data.set(key,value);return{etag:'fixture'}}}}
async function invoke(path,env,method='GET',body,headers={}){const response=await handleRequest(new Request('https://reference.test'+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body}:{})}),env,{},seed,{'/index.html':'기업 법무·세무 레퍼런스'});return{status:response.status,data:await response.json()}}
const hex=bytes=>[...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('');
async function sign(keyHex,body='{}'){
 const timestamp=String(Math.floor(Date.now()/1000));const digest=hex(await crypto.subtle.digest('SHA-256',encoder.encode(body)));
 const key=await crypto.subtle.importKey('raw',Uint8Array.from(keyHex.match(/../g),x=>parseInt(x,16)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=hex(await crypto.subtle.sign('HMAC',key,encoder.encode('POST\n/api/updates/laws/run\n'+timestamp+'\n'+digest)));
 return{'X-Law-Update-Timestamp':timestamp,'X-Law-Update-Signature':signature};
}
test('public users can search but cannot mutate documents, connection or update state',async()=>{
 const env={BUCKET:bucket(),ADMIN_EMAIL:'owner@example.test',UPDATES_OWNER_PRIVATE:'true',LAW_UPDATE_SIGNING_KEY:'9a'.repeat(32)};
 assert.equal((await invoke('/api/search?type=case',env)).data.total,seed.documents.filter(d=>d.type==='case'&&d.reviewStatus==='published').length);
 assert.equal((await invoke('/api/admin/documents',env)).status,401);
 assert.equal((await invoke('/api/admin/documents',env,'POST','{}')).status,401);
 assert.equal((await invoke('/api/admin/law-connection',env,'POST','{}')).status,401);
 assert.equal((await invoke('/api/updates/laws/run',env,'POST','{}')).status,401,'legacy private flag no longer bypasses auth');
});
test('scheduled signature only authorizes the fixed update route',async()=>{
 const env={BUCKET:bucket(),ADMIN_EMAIL:'owner@example.test',LAW_UPDATE_SIGNING_KEY:'9a'.repeat(32)};
 const headers=await sign(env.LAW_UPDATE_SIGNING_KEY);
 const result=await invoke('/api/updates/laws/run',env,'POST','{}',headers);assert.equal(result.status,200);assert.equal(result.data.state,'blocked','OC absence is preserved');
 assert.equal((await invoke('/api/admin/documents',env,'POST','{}',headers)).status,401);
 assert.equal((await invoke('/api/admin/law-connection',env,'POST','{}',headers)).status,401);
 assert.equal((await invoke('/api/updates/laws/run',env,'POST','{"changed":true}',headers)).status,401);
});
