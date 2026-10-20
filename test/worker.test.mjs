import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleRequest } from '../worker/runtime.mjs';
const seed=JSON.parse(await readFile(new URL('../data/seed.json',import.meta.url),'utf8'));
const ASSETS={'/index.html':'기업 법무·세무 레퍼런스','/app.js':'','/styles.css':''};
function bucket(){let state=null,etag=null;return {get:async()=>state?{json:async()=>JSON.parse(state),etag}:null,put:async(key,value,options)=>{if(options.onlyIf.etagMatches&&options.onlyIf.etagMatches!==etag)return null;if(options.onlyIf.etagDoesNotMatch==='*'&&state)return null;state=value;etag=crypto.randomUUID();return{etag}}}}
async function request(path,env={},method='GET',data,headers={}){const res=await handleRequest(new Request('https://reference.test'+path,{method,headers:{...(data?{'content-type':'application/json'}:{}),...headers},...(data?{body:JSON.stringify(data)}:{})}),env,{},seed,ASSETS);return{res,data:await res.json()}}
test('hosted corpus, exact statute and combined docket searches',async()=>{
 const status=await request('/api/status');assert.equal(status.data.counts.documents,seed.documents.length);assert.equal(status.data.counts.fullText,seed.documents.filter(d=>d.bodyStatus!=='link').length);
 for(const[q,n]of[['법인세법 제19조',3],['법인세법 제3조',1],['2023두45736',1],['2025다209942',1]])assert.equal((await request('/api/search?'+new URLSearchParams({q}))).data.total,n);
 const e=await request('/api/evidence');assert.equal(e.data.total,seed.documents.filter(d=>d.bodyStatus!=='link').length);assert.ok(e.data.documents.every(d=>['excerpt','full'].includes(d.bodyStatus)&&d.body));
});
test('anonymous access and unconfigured storage cannot perform administration',async()=>{
 assert.equal((await request('/api/admin/documents')).res.status,401);
 assert.equal((await request('/api/admin/documents',{ADMIN_EMAIL:'owner@example.test'},'POST',{}, {'oai-authenticated-user-email':'owner@example.test'})).res.status,503);
 const env={BUCKET:bucket(),ADMIN_EMAIL:'owner@example.test'};
 assert.equal((await request('/api/admin/session',env)).data.authenticated,false);
 assert.equal((await request('/api/admin/session',env,'GET',null,{'oai-authenticated-user-email':'other@example.test'})).data.authenticated,false);
 const owner=await request('/api/admin/session',env,'GET',null,{'oai-authenticated-user-email':'owner@example.test'});assert.equal(owner.data.authMethod,'platform');assert.equal(owner.data.authenticated,true);
});
test('HMAC token session is secure and rejects tampering and foreign origins',async()=>{
 const env={BUCKET:bucket(),ADMIN_TOKEN:'isolated-test-token-with-no-production-value'};
 const login=await request('/api/admin/login',env,'POST',{token:env.ADMIN_TOKEN});assert.equal(login.res.status,200);
 const cookie=login.res.headers.get('set-cookie');assert.match(cookie,/Secure/);assert.match(cookie,/HttpOnly/);
 assert.equal((await request('/api/admin/documents',env,'GET',null,{cookie:cookie.split(';')[0]})).res.status,200);
 assert.equal((await request('/api/admin/documents',env,'GET',null,{cookie:cookie.split(';')[0]+'x'})).res.status,401);
 assert.equal((await request('/api/admin/documents',env,'POST',{}, {cookie:cookie.split(';')[0],origin:'https://attacker.invalid'})).res.status,403);
});
test('R2 changes persist across requests and drafts stay unavailable to public search',async()=>{
 const env={BUCKET:bucket(),ADMIN_EMAIL:'owner@example.test'},headers={'oai-authenticated-user-email':'owner@example.test'};
 const metadata={title:'격리된 저장 검증 자료',domain:'tax',type:'guide',agency:'검증 기관',sourceUrl:'https://www.nts.go.kr/',body:'격리검증고유본문',bodyStatus:'excerpt',rights:'격리 테스트 전용',reviewStatus:'draft'};
 const created=await request('/api/admin/documents',env,'POST',metadata,headers);assert.equal(created.res.status,201);
 const id=created.data.document.id;assert.equal((await request('/api/documents/'+id,env)).res.status,404);
 await request('/api/admin/documents/'+id,env,'PATCH',{reviewStatus:'published'},headers);
 assert.equal((await request('/api/search?'+new URLSearchParams({q:'격리검증고유본문'}),env)).data.total,1);
 assert.equal((await request('/api/documents/'+id,env)).data.document.bodyStatus,'excerpt');
 await request('/api/admin/documents/'+id,env,'DELETE',undefined,headers);assert.equal((await request('/api/documents/'+id,env)).res.status,404);
 assert.equal((await request('/api/status',env)).data.counts.documents,seed.documents.length);
});
test('incomplete historical intervals, invalid dates and AI disconnection remain explicit',async()=>{
 assert.equal((await request('/api/search?'+new URLSearchParams({q:'법인세법 제19조',date:'2010-12-09'}))).data.total,1);
 const unknown=await request('/api/search?'+new URLSearchParams({q:'법인세법 제19조',date:'2011-01-01'}));assert.equal(unknown.data.total,0);assert.match(unknown.data.warnings.join(' '),/확인 불가/);
 assert.equal((await request('/api/search?date=2024-02-30')).res.status,400);
 assert.equal((await request('/api/ai',{},'POST',{})).res.status,503);
});
