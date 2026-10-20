import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {handleRequest} from '../worker/runtime.mjs';
const seed=JSON.parse(await readFile(new URL('../data/seed.json',import.meta.url),'utf8'));
const browser=vm.createContext({URL,setTimeout,clearTimeout});
vm.runInContext((await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\ninit\(\);\s*$/,''),browser);
function bucket(state){return{get:async key=>key==='reference-state-v1.json'?{json:async()=>structuredClone(state),etag:'test-state'}:null};}
async function detail(id,env={}){const response=await handleRequest(new Request('https://reference.test/api/documents/'+id),env,{},seed,{});assert.equal(response.status,200);return(await response.json()).document;}
test('Eight whole-law links use documented dated addresses or an observed version URL without changing the source version',async()=>{
 assert.equal(seed.lawSourceLinkFixes.length,8);
 for(const fix of seed.lawSourceLinkFixes){
  const doc=seed.documents.find(d=>d.id===fix.id);const url=new URL(fix.sourceUrl);const path=decodeURIComponent(url.pathname);
  assert.equal(url.origin,'https://www.law.go.kr');
  if(doc.id==='api-law-001571-20251001-20260102'){assert.equal(url.pathname,'/LSW/lsInfoP.do');assert.equal(url.searchParams.get('lsiSeq'),'276117');assert.equal(url.searchParams.get('efYd'),'20260102');}else assert.ok(path.endsWith('/('+doc.effectiveFrom.replaceAll('-','')+','+doc.documentNumber+','+doc.promulgatedAt.replaceAll('-','')+')'));
  const fetched=await detail(doc.id);assert.equal(fetched.sourceUrl,fix.sourceUrl);assert.equal(fetched.body,doc.body);assert.equal(fetched.effectiveFrom,doc.effectiveFrom);
  assert.equal(browser.officialSourceUrl({...doc,sourceUrl:fix.previousUrl}),fix.sourceUrl,'saved legacy snapshots also repair their outgoing link');
 }
});
test('Known old R2 URLs are repaired while bodies, historical dates and administrator-chosen URLs are preserved',async()=>{
 const [first,second]=seed.lawSourceLinkFixes;const docs=structuredClone(seed.documents);
 const original=docs.find(d=>d.id===first.id);original.sourceUrl=first.previousUrl;original.notes='Preserve the administrator note';
 const edited=docs.find(d=>d.id===second.id);edited.sourceUrl='https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=280405';
 const env={BUCKET:bucket({version:1,seedIds:seed.documents.map(d=>d.id),documents:docs,sources:seed.sources,history:[]})};
 const repaired=await detail(first.id,env);assert.equal(repaired.sourceUrl,first.sourceUrl);assert.equal(repaired.body,original.body);assert.equal(repaired.notes,original.notes);assert.equal(repaired.promulgatedAt,original.promulgatedAt);
 assert.equal((await detail(second.id,env)).sourceUrl,edited.sourceUrl);
 const old=await detail('tax-corporate-art19-20101209',env);assert.equal(old.effectiveFrom,'2010-12-09');assert.equal(old.sourceUrl,docs.find(d=>d.id===old.id).sourceUrl);
});
test('Client repair does not guess missing version data or rewrite other official materials',()=>{
 const fix=seed.lawSourceLinkFixes[0],doc=seed.documents.find(d=>d.id===fix.id);
 for(const override of [{type:'case'},{promulgatedAt:null},{effectiveFrom:'2000-01-01'},{documentNumber:'99999'},{sourceUrl:fix.previousUrl.replace('www.law.go.kr','www.law.go.kr.invalid')},{sourceUrl:fix.sourceUrl}]){
  const input={...doc,sourceUrl:fix.previousUrl,...override};assert.equal(browser.officialSourceUrl(input),input.sourceUrl);
 }
});
