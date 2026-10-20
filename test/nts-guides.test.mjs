import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {searchDocuments} from '../lib/search.mjs';
import {handleRequest} from '../worker/runtime.mjs';

const seed=JSON.parse(await readFile(new URL('../data/seed.json',import.meta.url),'utf8'));
const guideTypes=new Set(['guide','form','guideline']);
const fixture={domain:'tax',agency:'국세청',reviewStatus:'published',bodyStatus:'link',body:'',sourceUrl:'https://www.nts.go.kr/',verifiedAt:'2026-10-20',documentDate:null,tags:['신고 방법'],allowedDownload:false};
function bucket(){const entries=new Map();return{entries,get:async key=>entries.has(key)?{json:async()=>JSON.parse(entries.get(key)),etag:'fixture'}:null,put:async(key,value)=>{entries.set(key,value);return{etag:'fixture'}}};}
async function invoke(path,env={},material=seed){const response=await handleRequest(new Request('https://reference.test'+path),env,{},material,{});return{status:response.status,data:await response.json()};}

test('Practical Materials filters guide/form/guideline before the result limit and preserves conflicting filters',()=>{
  const cases=Array.from({length:310},(_,i)=>({...fixture,id:'case-'+i,type:'case',title:'신고 방법 사례 '+i}));
  const docs=[...cases,...['guide','form','guideline'].map(type=>({...fixture,id:type,type,title:'종합소득세 신고 방법 '+type})),{...fixture,id:'sub-guide',domain:'subcontract',type:'guide',title:'위탁 안내'},{...fixture,id:'draft',type:'guide',reviewStatus:'draft',title:'비공개'}];
  const result=searchDocuments(docs,{category:'guides'});
  assert.equal(result.total,4);
  assert.ok(result.documents.every(d=>guideTypes.has(d.type)));
  assert.equal(result.groups.cases.length,0);
  assert.equal(result.groups.laws.length,0);
  assert.equal(searchDocuments(docs,{category:'guides',domain:'tax'}).total,3);
  assert.equal(searchDocuments(docs,{category:'guides',type:'case'}).total,0);
  assert.equal(searchDocuments(docs,{category:'guides',type:'form'}).total,1);
});

test('Undated official links stay unavailable for date/year inference and cannot supply evidence',async()=>{
  const docs=[{...fixture,id:'nts-fixture-undated',type:'guide',title:'종합소득세 신고 방법'},{...fixture,id:'nts-fixture-dated',type:'guide',title:'연말정산 안내',documentDate:'2026-03-01'}];
  const material={documents:docs,sources:[]};
  const result=await invoke('/api/search?category=guides',{},material);
  assert.equal(result.data.total,2);
  assert.ok(result.data.documents.every(d=>!d.hasBody&&d.bodyStatus==='link'&&!d.allowedDownload));
  const date=searchDocuments(docs,{category:'guides',date:'2026-10-20'});
  assert.deepEqual(date.documents.map(d=>d.id),['nts-fixture-dated']);
  assert.match(date.warnings.join(' '),/확인 불가/);
  assert.equal(searchDocuments(docs,{category:'guides',year:'2026'}).total,0);
  const evidence=await invoke('/api/evidence?category=guides',{},material);
  assert.equal(evidence.data.total,0);
  assert.equal(evidence.data.excluded,2);
  assert.equal((await invoke('/api/documents/nts-fixture-undated/download',{},material)).status,403);
  assert.equal((await invoke('/api/admin/documents',{},material)).status,401);
});

test('Real NTS guide records retain official origins and all link-only materials are excluded from evidence',async()=>{
  const guides=seed.documents.filter(d=>guideTypes.has(d.type)&&d.reviewStatus==='published');
  const result=await invoke('/api/search?category=guides&domain=tax');
  assert.equal(result.data.total,guides.filter(d=>d.domain==='tax').length);
  assert.ok(result.data.documents.every(d=>guideTypes.has(d.type)));
  const nts=guides.filter(d=>d.agency==='국세청');
  assert.ok(nts.length>0);
  for(const d of nts){assert.match(new URL(d.sourceUrl).hostname,/(^|\.)nts\.go\.kr$/);if(d.bodyStatus==='link'){assert.ok(!d.body);assert.equal(d.allowedDownload,false);}}
  const evidence=await invoke('/api/evidence?category=guides');
  assert.equal(evidence.data.total,guides.filter(d=>['full','excerpt'].includes(d.bodyStatus)&&d.body).length);
  assert.ok(!evidence.data.documents.some(d=>d.bodyStatus==='link'));
});

test('New seed source definitions merge into existing R2 state without overwriting edits or reviving deleted documents',async()=>{
  const storage=bucket();
  const deletedId=seed.baselineIds[0];
  const existingSource={...seed.sources.find(s=>s.id==='nts-taxlaw'),status:'failed',lastError:'이전 관리 확인 오류',integrationNote:'관리자가 작성한 연결 메모'};
  const originalDocs=seed.documents.filter(d=>seed.baselineIds.includes(d.id)&&d.id!==deletedId);
  await storage.put('reference-state-v1.json',JSON.stringify({version:1,documents:originalDocs,sources:[existingSource],history:[]}));
  const source={id:'nts-filing-guides',name:'국세청 신고·납부 안내',status:'unconnected',lastChecked:'2026-10-20',integrationNote:'수동 확인 · 자동 수집 미연동'};
  const material={...seed,sources:[...seed.sources.filter(s=>s.id!==source.id),source]};
  const status=await invoke('/api/status',{BUCKET:storage},material);
  assert.equal(status.status,200);
  assert.deepEqual(status.data.sources.find(s=>s.id==='nts-taxlaw'),existingSource);
  assert.deepEqual(status.data.sources.find(s=>s.id==='nts-filing-guides'),source);
  assert.equal(status.data.sources.filter(s=>s.id==='nts-filing-guides').length,1);
  assert.equal((await invoke('/api/documents/'+deletedId,{BUCKET:storage},material)).status,404);
  const expected=seed.documents.length-1;
  assert.equal(status.data.counts.documents,expected);
});
