import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {searchDocuments} from '../lib/search.mjs';
// Synthetic statute used only for parser verification, never published.
const law={id:'isolated-keyword-law',title:'국세기본법',lawName:'국세기본법',domain:'tax',type:'law',agency:'법제처',reviewStatus:'published',bodyStatus:'full',effectiveFrom:'2025-01-01',currentAsOf:'2026-10-20',body:[
'제2조(정의) 이 법의 정의는 다음과 같다.',
'1. 다른 용어',
'3. 원천징수의 정의',
'제13조(검증용 조문) ① 첫째 항은 다른 내용이다.',
'② 원천징수 문구가 있는 둘째 항이다.',
'원천징수와 같은 항의 연속된 문장이다.',
'③ 다른 항에도 원천징수가 있다.',
'제14조(다른 검증용 조문) ① 원천징수 첫째 항이다. ② 원천징수 둘째 항이다.',
'제14조의2(가지 조문) ㉑ 원천징수 스물한째 항이다.',
'제130조(혼동 방지) ① 관련 없는 조문이다.',
'부칙 <가상 검증용 자료>',
'제13조(적용례) ① 원천징수 부칙으로 본문 조문과 구분한다.',
].join('\n')};
const find=(q,params={},docs=[law])=>searchDocuments(docs,{q,...params});
test('keyword search returns all main articles with real paragraph/item numbers and no duplicate article or repeated paragraph',()=>{
 const result=find('원천징수').documents[0].articleMatches;
 assert.deepEqual(result.map(x=>x.article),['제2조','제13조','제14조','제14조의2']);
 assert.deepEqual(result[0].locations.map(x=>[x.paragraph,x.item,x.line]),[[null,3,3]]);
 assert.deepEqual(result[1].locations.map(x=>[x.paragraph,x.item,x.line]),[[2,null,5],[3,null,7]]);
 assert.deepEqual(result[2].locations.map(x=>x.paragraph),[1,2]);
 assert.equal(result[3].locations[0].paragraph,21);
 assert.ok(result.flatMap(x=>x.locations).every(x=>x.snippet.includes('원천징수')));
 assert.equal(new Set(result.map(x=>x.article)).size,result.length);
 assert.ok(result.flatMap(x=>x.locations).every(x=>x.line<11));
});
test('law name plus keyword locates the same exact articles; article and paragraph identifiers remain precise',()=>{
 assert.equal(find('국세기본법 원천징수').documents[0].articleMatches.length,4);
 const result=find('국세기본법 제13조 제2항').documents[0].articleMatches;
 assert.deepEqual(result.map(x=>x.article),['제13조']);
 assert.deepEqual(result[0].locations.map(x=>x.paragraph),[2]);
 assert.equal(find('국세기본법 제130조').documents[0].articleMatches[0].article,'제130조');
});
test('title/tag matches and link-only data never invent article locations; unavailable historical versions stay empty',()=>{
 const linked={...law,id:'linked',bodyStatus:'link',body:'원천징수',tags:['원천징수']};
 assert.deepEqual(find('원천징수',{},[linked]).documents[0].articleMatches,[]);
 const metadata={...law,id:'metadata',body:'제1조(목적) 다른 내용',tags:['원천징수']};
 assert.deepEqual(find('원천징수',{},[metadata]).documents[0].articleMatches,[]);
 assert.equal(find('원천징수',{date:'2000-01-01'}).total,0);
 assert.match(find('원천징수',{date:'2000-01-01'}).warnings.join(' '),/현행 조문으로 대체하지 않습니다/);
});
test('real imported Framework Act matches point to the obtained lines, including definitions without invented paragraph numbers',async()=>{
 const seed=JSON.parse(await readFile(new URL('../data/seed.json',import.meta.url),'utf8'));
 const source=seed.documents.find(x=>x.lawKey==='국세기본법'&&x.bodyStatus==='full');assert.ok(source);
 const result=find('원천징수',{},[source]).documents[0],lines=source.body.split('\n');
 assert.ok(result.articleMatches.length>1);
 const definition=result.articleMatches.find(x=>x.article==='제2조');assert.ok(definition);
 assert.ok(definition.locations.some(x=>x.paragraph===null&&x.item===3));
 for(const article of result.articleMatches){assert.match(lines[article.line-1],new RegExp('^'+article.article+'[（(]'));for(const location of article.locations)assert.ok(lines[location.line-1].includes('원천징수'));}
 assert.equal(new Set(result.articleMatches.map(x=>x.article)).size,result.articleMatches.length);
 assert.ok(!result.articleMatches.some(x=>['제13조','제14조'].includes(x.article)),'user examples do not become fabricated matches');
});
