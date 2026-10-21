import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {handleRequest} from '../worker/runtime.mjs';
import {LAW_UPDATE_SCOPE,LOCAL_TAX_LAWS,lawBody,holidayCheck} from '../worker/law-updates.mjs';
import {createHash,createHmac} from 'node:crypto';
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
test('official API-shaped fixtures stage every scoped law version, including local tax laws, while preserving public corpus',async()=>{
 const env=envFor();env.LAW_API_OC='approved-fixture-only';let calls=0;
 env.LAW_API_FETCH=async input=>{calls++;const u=new URL(input);if(u.pathname.endsWith('lawSearch.do')){const name=u.searchParams.get('query'),index=LAW_UPDATE_SCOPE.indexOf(name);return Response.json({LawSearch:{law:[{법령명한글:name,법령일련번호:String(1000+index),시행일자:'20260101',공포일자:'20250101'}]}})}const name=LAW_UPDATE_SCOPE[Number(u.searchParams.get('MST'))-1000];return Response.json({법령:{기본정보:{법령명_한글:name,시행일자:'20260101',공포일자:'20250101'},조문:{조문단위:[{조문번호:'1',조문내용:'격리된 조문 검증 본문'}]}}})};
 const result=await req('/api/updates/laws/run',env,'POST',{},admin);assert.equal(result.data.state,'review-pending');assert.equal(LAW_UPDATE_SCOPE.length,12);for(const name of LOCAL_TAX_LAWS)assert.ok(LAW_UPDATE_SCOPE.includes(name));assert.equal(result.data.reviewPending,LAW_UPDATE_SCOPE.length);assert.equal(result.data.published,0);assert.equal(calls,LAW_UPDATE_SCOPE.length*2);
 assert.equal((await req('/api/status',env)).data.counts.documents,seed.documents.length);
 assert.equal([...env.BUCKET.entries.keys()].filter(k=>k.startsWith('updates/laws/')).length,LAW_UPDATE_SCOPE.length);
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

// Synthetic statute in the eflaw JSON shape: chapter heading unit, article with
// paragraph/item/sub-item, and a supplementary block given as nested arrays.
const lawPayload=(name,overrides={})=>({법령:{기본정보:{법령명_한글:name,법령ID:'009999',공포번호:'12345',시행일자:'20270101',공포일자:'20261201'},조문:{조문단위:[{조문여부:'전문',조문내용:'제1장 총칙'},{조문번호:'1',조문여부:'조문',조문내용:'제1조(목적) 이 법은 격리된 시험 조문이다.'},{조문번호:'2',조문여부:'조문',조문내용:'제2조(정의)',항:[{항내용:'① 이 법에서 사용하는 용어의 뜻은 다음과 같다.',호:[{호내용:'1. "시험"이란 격리된 검증을 말한다.',목:[{목내용:['가. 첫째 목']}]}]},{항내용:'② 둘째 항이다.'}]}]},부칙:{부칙단위:[{부칙내용:[['부칙 <제12345호,2026.12.1>'],['이 법은 2027년 1월 1일부터 시행한다.']]}]},...overrides}});
test('statute JSON becomes the same body layout as the seeded full texts',()=>{
 const body=lawBody(lawPayload('지방세법'));
 assert.equal(body,'  제1장 총칙\n\n제1조(목적) 이 법은 격리된 시험 조문이다.\n\n제2조(정의)\n① 이 법에서 사용하는 용어의 뜻은 다음과 같다.\n1. "시험"이란 격리된 검증을 말한다.\n가. 첫째 목\n② 둘째 항이다.\n\n부칙 <제12345호,2026.12.1>\n이 법은 2027년 1월 1일부터 시행한다.');
});
test('reviewed local tax law versions publish as full text; unchanged published versions are not staged again',async()=>{
 const env=envFor();env.LAW_API_OC='approved-fixture-only';
 const seededVersions=Object.fromEntries(seed.documents.filter(d=>d.id.startsWith('api-law-')).map(d=>[d.lawKey,d]));
 env.LAW_API_FETCH=async input=>{const u=new URL(input);if(u.pathname.endsWith('lawSearch.do')){const name=u.searchParams.get('query'),known=seededVersions[name];return Response.json({LawSearch:{law:[{법령명한글:name,법령ID:'009999',법령일련번호:String(5000+LAW_UPDATE_SCOPE.indexOf(name)),시행일자:known?known.effectiveFrom.replaceAll('-',''):'20270101',공포일자:known?known.promulgatedAt.replaceAll('-',''):'20261201'}]}})}const name=LAW_UPDATE_SCOPE[Number(u.searchParams.get('MST'))-5000];return Response.json(lawPayload(name,{기본정보:{법령명_한글:name,법령ID:'009999',공포번호:'12345',시행일자:'20270101',공포일자:'20261201'}}))};
 const result=(await req('/api/updates/laws/run',env,'POST',{},admin)).data;
 assert.equal(result.unchanged.length,8,'seeded versions are recognised');assert.deepEqual(result.staged.map(x=>x.lawName),[...LOCAL_TAX_LAWS]);
 const pending=(await req('/api/admin/laws/pending',env,'GET',undefined,admin)).data;assert.equal(pending.total,4);
 const target=pending.laws.find(x=>x.lawName==='지방세법');
 assert.equal((await req('/api/admin/laws/publish',env,'POST',{id:target.id},admin)).res.status,400);
 const published=(await req('/api/admin/laws/publish',env,'POST',{id:target.id,reviewConfirmed:true},admin)).data;assert.equal(published.imported,true);
 const doc=(await req('/api/documents/'+published.documentId,env)).data.document;
 assert.equal(doc.lawKey,'지방세법');assert.equal(doc.bodyStatus,'full');assert.equal(doc.effectiveFrom,'2027-01-01');assert.equal(doc.promulgatedAt,'2026-12-01');assert.ok(doc.tags.includes('지방세'));assert.equal(decodeURI(doc.sourceUrl),'https://www.law.go.kr/법령/지방세법/(20270101,12345,20261201)');
 const search=(await req('/api/search?'+new URLSearchParams({q:'지방세법 제2조 시험',category:'laws'}),env)).data;assert.ok(search.documents.some(d=>d.id===doc.id&&d.articleMatches.some(m=>m.article==='제2조')));
 assert.equal((await req('/api/admin/laws/pending',env,'GET',undefined,admin)).data.total,3);
 assert.match((await req('/api/status',env)).data.coverage,/지방세 법령 1종은 전문/);
 const again=(await req('/api/updates/laws/run',env,'POST',{},admin)).data;assert.ok(again.unchanged.some(x=>x.lawName==='지방세법'));assert.equal((await req('/api/admin/laws/pending',env,'GET',undefined,admin)).data.total,3);
});
const signingKey=createHash('sha256').update('isolated-holiday-test-only').digest('hex');
function scheduledRequest(){const timestamp=String(Math.floor(Date.now()/1000)),digest=createHash('sha256').update('{}').digest('hex');const signature=createHmac('sha256',Buffer.from(signingKey,'hex')).update(`POST\n/api/updates/laws/run\n${timestamp}\n${digest}`).digest('hex');return new Request('https://reference.test/api/updates/laws/run',{method:'POST',headers:{'content-type':'application/json','X-Law-Update-Timestamp':timestamp,'X-Law-Update-Signature':signature},body:'{}'})}
const holidayFetch=(dates,counter)=>async input=>{counter.calls++;const u=new URL(input);assert.equal(u.hostname,'apis.data.go.kr');const month=u.searchParams.get('solMonth'),items=dates.filter(d=>d.slice(4,6)===month).map(d=>({locdate:Number(d),isHoliday:'Y',dateName:'시험 공휴일'}));return new Response(JSON.stringify({response:{header:{resultCode:'00'},body:{items:items.length?{item:items.length===1?items[0]:items}:'',totalCount:items.length}}}))};
test('scheduled runs skip official public holidays and use a cached calendar; admin runs are never skipped',async()=>{
 const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10).replaceAll('-','');
 const env=envFor();env.LAW_UPDATE_SIGNING_KEY=signingKey;env.HOLIDAY_API_KEY='isolated-holiday-key';const counter={calls:0};env.HOLIDAY_API_FETCH=holidayFetch([today],counter);
 let lawCalls=0;env.LAW_API_OC='approved-fixture-only';env.LAW_API_FETCH=async()=>{lawCalls++;return Response.json({LawSearch:{law:[]}})};
 const data=await handleRequest(scheduledRequest(),env,{},seed,{}).then(r=>r.json());
 assert.equal(data.state,'skipped-holiday');assert.equal(data.ok,true);assert.equal(lawCalls,0);assert.equal(counter.calls,12);
 assert.equal((await holidayCheck(env)).holiday,true);assert.equal(counter.calls,12,'calendar is cached in storage');
 assert.equal((await req('/api/updates/status',env)).data.schedule.excludesPublicHolidays,true);
 const manual=(await req('/api/updates/laws/run',env,'POST',{},admin)).data;assert.notEqual(manual.state,'skipped-holiday');assert.ok(lawCalls>0);
 const listed=(await req('/api/admin/holidays',env,'GET',undefined,admin)).data;assert.equal(listed.holiday,true);assert.equal(listed.holidays.length,1);
});
test('without a holiday key the weekday run proceeds and status says holidays are not excluded; API failure never skips',async()=>{
 const env=envFor();env.LAW_UPDATE_SIGNING_KEY=signingKey;
 assert.equal((await req('/api/updates/status',env)).data.schedule.excludesPublicHolidays,false);
 assert.equal((await handleRequest(scheduledRequest(),env,{},seed,{}).then(r=>r.json())).state,'blocked');
 env.HOLIDAY_API_KEY='isolated-holiday-key';env.HOLIDAY_API_FETCH=async()=>new Response('<html>error</html>');
 const check=await holidayCheck(env);assert.equal(check.holiday,false);assert.match(check.error,/특일 정보/);
 assert.equal((await handleRequest(scheduledRequest(),env,{},seed,{}).then(r=>r.json())).state,'blocked');
});
