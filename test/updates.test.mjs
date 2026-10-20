import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {handleRequest} from '../worker/runtime.mjs';
import {LAW_UPDATE_SCOPE} from '../worker/law-updates.mjs';
const seed=JSON.parse(await readFile(new URL('../data/seed.json',import.meta.url),'utf8'));
function bucket(){const entries=new Map();return{entries,get:async key=>entries.has(key)?{json:async()=>JSON.parse(entries.get(key).value),etag:entries.get(key).etag}:null,put:async(key,value,opts={})=>{const old=entries.get(key);if(opts.onlyIf?.etagMatches&&old?.etag!==opts.onlyIf.etagMatches)return null;if(opts.onlyIf?.etagDoesNotMatch==='*'&&old)return null;const etag=crypto.randomUUID();entries.set(key,{value,etag});return{etag}},delete:async key=>entries.delete(key)}}
const admin={'oai-authenticated-user-email':'owner@example.test'};
const envFor=()=>({BUCKET:bucket(),ADMIN_EMAIL:'owner@example.test',ADMIN_TOKEN:'isolated-encryption-test-secret',});
async function req(path,env,method='GET',body,headers={}){const res=await handleRequest(new Request('https://reference.test'+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})}),env,{},seed,{});return{res,data:await res.json()}}
test('weekday schedule is Korean time; missing OC records blocked without claiming data refresh',async()=>{
 const env=envFor();let called=false;env.LAW_API_FETCH=()=>{called=true;throw Error('must not call')};
 const status=await req('/api/updates/status',env);assert.equal(status.data.schedule.timezone,'Asia/Seoul');assert.equal(status.data.credentialConfigured,false);
 const run=await req('/api/updates/laws/run',env,'POST',{},admin);assert.equal(run.res.status,200);assert.equal(run.data.state,'blocked');assert.equal(called,false);
 assert.equal((await req('/api/updates/status',env)).data.lastRun.state,'blocked');
 assert.equal((await req('/api/status',env)).data.counts.documents,seed.documents.length);
});
test('OC registration requires admin approval and encrypts the server-stored value',async()=>{
 const env=envFor(),oc='approved-fixture-only';
 assert.equal((await req('/api/admin/law-connection',env,'POST',{oc,registrationConfirmed:true})).res.status,401);
 assert.equal((await req('/api/admin/law-connection',env,'POST',{oc},admin)).res.status,400);
 const saved=await req('/api/admin/law-connection',env,'POST',{oc,registrationConfirmed:true},admin);assert.equal(saved.res.status,200);assert.equal(JSON.stringify(saved.data).includes(oc),false);
 assert.equal([...env.BUCKET.entries.values()].some(x=>x.value.includes(oc)),false);
 const info=await req('/api/updates/status',env);assert.equal(info.data.credentialConfigured,true);assert.equal(JSON.stringify(info.data).includes(oc),false);
 await req('/api/admin/law-connection',env,'DELETE',undefined,admin);assert.equal((await req('/api/updates/status',env)).data.credentialConfigured,false);
});
test('official API-shaped fixtures stage eight law versions while preserving public corpus',async()=>{
 const env=envFor();env.LAW_API_OC='approved-fixture-only';let calls=0;
 env.LAW_API_FETCH=async input=>{calls++;const u=new URL(input);if(u.pathname.endsWith('lawSearch.do')){const name=u.searchParams.get('query'),index=LAW_UPDATE_SCOPE.indexOf(name);return Response.json({LawSearch:{law:[{법령명한글:name,법령일련번호:String(1000+index),시행일자:'20260101',공포일자:'20250101'}]}})}const name=LAW_UPDATE_SCOPE[Number(u.searchParams.get('MST'))-1000];return Response.json({법령:{기본정보:{법령명_한글:name,시행일자:'20260101',공포일자:'20250101'},조문:{조문단위:[{조문번호:'1',조문내용:'격리된 조문 검증 본문'}]}}})};
 const result=await req('/api/updates/laws/run',env,'POST',{},admin);assert.equal(result.data.state,'review-pending');assert.equal(result.data.reviewPending,8);assert.equal(result.data.published,0);assert.equal(calls,16);
 assert.equal((await req('/api/status',env)).data.counts.documents,seed.documents.length);
 assert.equal([...env.BUCKET.entries.keys()].filter(k=>k.startsWith('updates/laws/')).length,8);
});
test('bad or metadata-only upstream responses stay failed and never refresh document check dates',async()=>{
 const env=envFor();env.LAW_API_OC='approved-fixture-only';env.LAW_API_FETCH=async()=>Response.json({LawSearch:{law:[]}});
 const before=await req('/api/documents/tax-corporate-art19-20260701',env);
 const result=await req('/api/updates/laws/run',env,'POST',{},admin);assert.equal(result.data.state,'failed');assert.equal(result.data.reviewPending,0);
 const after=await req('/api/documents/tax-corporate-art19-20260701',env);assert.equal(before.data.document.verifiedAt,after.data.document.verifiedAt);
 assert.equal(JSON.stringify(result.data).includes(env.LAW_API_OC),false);
});
test('new reviewed seed cases merge into the existing store without reviving deleted original records',async()=>{
 const env=envFor();const original=seed.documents.filter(d=>seed.baselineIds.includes(d.id));
 await env.BUCKET.put('reference-state-v1.json',JSON.stringify({version:1,documents:original.filter(d=>d.id!=='tax-framework-art14-20261002'),sources:seed.sources,history:[]}));
 const result=await req('/api/status',env);assert.equal(result.data.counts.documents,seed.documents.length-1);
 assert.equal((await req('/api/documents/tax-framework-art14-20261002',env)).res.status,404);
 assert.equal((await req('/api/search?'+new URLSearchParams({q:'2007두12422'}),env)).data.total,1);
});
