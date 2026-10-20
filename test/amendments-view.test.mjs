import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const sandbox=vm.createContext({setTimeout,clearTimeout});
vm.runInContext(source.replace(/\ninit\(\);\s*$/,''),sandbox);
const entries=docs=>JSON.parse(JSON.stringify(sandbox.amendmentEntries(docs)));
const fixture={type:'law',domain:'tax',lawName:'검증법',lawKey:'검증법',title:'검증법',documentNumber:'법률 제123호',promulgatedAt:'2026-01-01',effectiveFrom:'2026-03-01',verifiedAt:'2026-10-19',body:'확보된 검증 본문',bodyStatus:'full',article:''};

test('amendment list merges article records of one version and prefers its complete law',()=>{
  const docs=[{...fixture,id:'partial-19',title:'검증법 제19조 — 검증',article:'제19조',bodyStatus:'excerpt'}, {...fixture,id:'whole',documentNumber:'123'}, {...fixture,id:'partial-116',title:'검증법 제116조 — 검증',article:'제116조',bodyStatus:'excerpt'}, {...fixture,id:'guide',type:'guide'}];
  const result=entries(docs);
  assert.equal(result.length,1);
  assert.equal(result[0].name,'검증법');
  assert.equal(result[0].document.id,'whole');
  assert.equal(result[0].documents.length,3);
});

test('amendments use official publication dates and preserve distinct effective versions',()=>{
  const result=entries([{...fixture,id:'recently-collected-old-publication',promulgatedAt:'2024-01-01',collectedAt:'2026-10-20'}, {...fixture,id:'new-publication',promulgatedAt:'2026-02-01',collectedAt:'2026-03-01'}, {...fixture,id:'different-effective-start',promulgatedAt:'2026-02-01',effectiveFrom:'2026-04-01',collectedAt:'2026-03-01'}]);
  assert.deepEqual(result.map(entry=>entry.document.id),['different-effective-start','new-publication','recently-collected-old-publication']);
});

test('real corpus amendment entries have law names and retain a documented historical version',async()=>{
  const seed=JSON.parse(await readFile(new URL('../data/seed.json',import.meta.url),'utf8'));
  const result=entries(seed.documents);
  assert.ok(result.length>8);
  assert.ok(result.every(entry=>!/^.*제\s*\d+\s*조/.test(entry.name)));
  assert.ok(result.some(entry=>entry.document.effectiveFrom==='2010-12-09'));
  assert.equal(result.filter(entry=>entry.name==='하도급거래 공정화에 관한 법률'&&entry.document.effectiveFrom==='2026-10-02').length,1);
  assert.equal(result.find(entry=>entry.name==='국세기본법').document.bodyStatus,'full');
});
