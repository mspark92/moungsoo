import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {searchDocuments} from '../lib/search.mjs';

const seed=JSON.parse(await readFile(new URL('../data/seed.json',import.meta.url),'utf8'));
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const browser=vm.createContext({setTimeout,clearTimeout});
vm.runInContext(source.replace(/\ninit\(\);\s*$/,''),browser);

test('article records are presented under a law name without changing their source or identifier',()=>{
  const article=seed.documents.find(d=>d.id==='tax-corporate-art19-20260701');
  const snapshot=structuredClone(article);
  assert.equal(browser.displayDocTitle(article),'법인세법');
  assert.equal(browser.articleSuffix(article),'');
  const caseDoc=seed.documents.find(d=>d.type==='case');
  assert.equal(browser.displayDocTitle(caseDoc),caseDoc.title);
  assert.deepEqual(article,snapshot);
});

test('integrated browsing collapses statute children and preserves cases and guides',()=>{
  const docs=searchDocuments(seed.documents).documents;
  const formal=docs.filter(d=>['law','decree','rule'].includes(d.type));
  assert.equal(formal.length,23); // 19 statute records + 4 local-tax law links
  assert.equal(browser.lawCatalogGroups(formal).length,12);
  assert.equal(browser.browseReferences(docs).length,12+docs.filter(d=>!['law','decree','rule'].includes(d.type)).length);
  assert.equal(browser.browseReferences(docs).filter(d=>['guide','form','guideline'].includes(d.type)).length,seed.documents.filter(d=>['guide','form','guideline'].includes(d.type)).length);
  assert.equal(browser.browseReferences(docs).filter(d=>d.type==='case').length,seed.documents.filter(d=>d.type==='case').length);
});

test('law-name grouping retains the actual historical article instead of choosing a newer full body',()=>{
  const result=searchDocuments(seed.documents,{q:'법인세법 제19조',date:'2010-12-09'});
  const grouped=browser.lawCatalogGroups(result.documents);
  assert.equal(grouped.length,1);
  assert.equal(grouped[0].name,'법인세법');
  assert.equal(grouped[0].representative.id,'tax-corporate-art19-20101209');
  assert.equal(grouped[0].full,undefined);
  assert.equal(grouped[0].representative.effectiveFrom,'2010-12-09');
});
