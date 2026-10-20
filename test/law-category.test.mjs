import test from 'node:test';
import assert from 'node:assert/strict';
import { searchDocuments } from '../lib/search.mjs';

// Isolated fixtures. These records are not official materials or production seeds.
const base = {
  domain: 'tax', agency: '검증 기관', reviewStatus: 'published',
  bodyStatus: 'excerpt', body: '검증용 내용', documentDate: '2026-06-01',
  effectiveFrom: '2026-07-01', currentAsOf: '2026-10-19',
};
const documents = [
  { ...base, id: 'law', type: 'law', title: '국세기본법 제14조 — 검증', lawKey: '국세기본법', article: '제14조' },
  { ...base, id: 'decree', type: 'decree', title: '소득세법 시행령', lawKey: '소득세법 시행령' },
  { ...base, id: 'rule', type: 'rule', title: '소득세법 시행규칙', lawKey: '소득세법 시행규칙' },
  { ...base, id: 'sub-law', type: 'law', domain: 'subcontract', title: '하도급거래 공정화에 관한 법률', lawKey: '하도급거래 공정화에 관한 법률' },
  { ...base, id: 'sub-decree', type: 'decree', domain: 'subcontract', title: '하도급거래 공정화에 관한 법률 시행령', lawKey: '하도급거래 공정화에 관한 법률 시행령' },
  { ...base, id: 'notice', type: 'notice', title: '국세기본법 관련 고시' },
  { ...base, id: 'case', type: 'case', title: '국세기본법 관련 판례' },
  { ...base, id: 'interpretation', type: 'interpretation', title: '국세기본법 관련 해석례' },
  { ...base, id: 'guide', type: 'guide', title: '국세기본법 관련 안내서' },
  { ...base, id: 'form', type: 'form', title: '공식 서식' },
  { ...base, id: 'draft', type: 'law', title: '비공개 법령', reviewStatus: 'draft' },
];
const ids = result => result.documents.map(doc => doc.id);

test('Related Laws category contains formal laws only with consistent groups and totals', () => {
  const result = searchDocuments(documents, { category: 'laws', domain: 'all' });
  assert.deepEqual(ids(result), ['law', 'decree', 'rule', 'sub-law', 'sub-decree']);
  assert.equal(result.total, 5);
  assert.equal(result.groups.laws.length, 5);
  assert.equal(result.groups.cases.length, 0);
  assert.equal(result.groups.guides.length, 0);
  assert.ok(result.documents.every(doc => ['law', 'decree', 'rule'].includes(doc.type)));
  assert.equal(searchDocuments(documents).total, 10, 'integrated search retains other public material types');
});

test('Related Laws preserves domain and law-type filters without widening conflicting types', () => {
  assert.deepEqual(ids(searchDocuments(documents, { category: 'laws', domain: 'tax' })), ['law', 'decree', 'rule']);
  assert.deepEqual(ids(searchDocuments(documents, { category: 'laws', domain: 'subcontract' })), ['sub-law', 'sub-decree']);
  assert.deepEqual(ids(searchDocuments(documents, { category: 'laws', type: 'decree' })), ['decree', 'sub-decree']);
  for (const type of ['notice', 'case', 'interpretation', 'guide', 'form']) {
    const result = searchDocuments(documents, { category: 'laws', type });
    assert.equal(result.total, 0, type);
    assert.equal(result.groups.laws.length, 0, type);
    assert.equal(result.groups.cases.length, 0, type);
    assert.equal(result.groups.guides.length, 0, type);
  }
});

test('category restriction applies before ranking and result limits', () => {
  const cases = Array.from({ length: 350 }, (_, n) => ({ ...base, id: 'case-' + n, type: 'case', title: '사례 ' + n }));
  const result = searchDocuments([...cases, ...documents], { category: 'laws' });
  assert.equal(result.total, 5);
  assert.ok(ids(result).includes('law'));
});

test('article queries return matching raw statute records for the law-name catalogue', () => {
  const result = searchDocuments(documents, { category: 'laws', q: '국세기본법 제14조' });
  assert.deepEqual(ids(result), ['law']);
  assert.equal(result.documents[0].lawKey, '국세기본법');
  assert.equal(result.documents[0].article, '제14조');
  assert.equal('body' in result.documents[0], false);
});

test('Related Laws date constraints retain exact history and do not substitute a current version', () => {
  const historical = { ...documents[0], id: 'history', effectiveFrom: '2010-12-09', currentAsOf: undefined };
  const corpus = [...documents, historical];
  assert.deepEqual(ids(searchDocuments(corpus, { category: 'laws', q: '국세기본법 제14조', date: '2010-12-09' })), ['history']);
  const missing = searchDocuments(corpus, { category: 'laws', q: '국세기본법 제14조', date: '2011-01-01' });
  assert.equal(missing.total, 0);
  assert.match(missing.warnings.join(' '), /현행 조문으로 대체하지 않습니다/);
});
