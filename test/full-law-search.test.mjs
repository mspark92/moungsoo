import test from 'node:test';
import assert from 'node:assert/strict';
import { searchDocuments, temporalStatus } from '../lib/search.mjs';

// Deliberately synthetic fixtures; no fixture is an official source or seed.
const law = {
  id: 'full-law-fixture', title: '법인세법', lawName: '법인세법', article: '',
  domain: 'tax', type: 'law', agency: '법제처', reviewStatus: 'published',
  bodyStatus: 'full', effectiveFrom: '2026-07-01', effectiveTo: null,
  currentAsOf: '2026-10-19', documentDate: '2026-06-01',
  body: [
    '법인세법',
    '[시행 2026. 7. 1.] [검증용 가상 자료]',
    '제1장 총칙',
    '제1조(목적) 검증용 목적 조문입니다.',
    '제19조(손금의 범위) ① 첫째 항의 검증용 문장입니다.',
    '② 둘째 항의 검증용 문장입니다.',
    '제19조의2(별도 규정) ① 가지 조문의 검증용 문장입니다.',
    '제190조(다른 조문) ① 백구십 조의 검증용 문장입니다.',
    '부칙 <검증용 가상 자료>',
    '제2조(경과조치) 부칙에만 있는 조문입니다.',
    '제19조(적용례) 부칙에 반복된 번호입니다.',
  ].join('\n'),
};
const find = (q, extra = {}, documents = [law]) => searchDocuments(documents, { q, ...extra });

test('verified current interval includes its endpoints without inventing an expiry date', () => {
  for (const date of ['2026-07-01', '2026-08-20', '2026-10-19']) {
    assert.equal(find('법인세법', { date }).total, 1, date);
    assert.equal(temporalStatus(law, date), 'current', date);
  }
  assert.equal(law.effectiveTo, null);
  assert.equal(temporalStatus(law, '2026-07-01'), 'current');
  assert.equal(temporalStatus(law, '2026-06-30'), 'future');
  assert.equal(temporalStatus(law, '2026-10-20'), 'unknown');
  const future = find('법인세법', { date: '2026-10-20' });
  assert.equal(future.total, 0);
  assert.match(future.warnings.join(' '), /확인 불가/);
});

test('an unavailable historical version never falls back to the current whole statute', () => {
  const missing = find('법인세법 제19조', { date: '2010-12-09' });
  assert.equal(missing.total, 0);
  assert.match(missing.warnings.join(' '), /현행 조문으로 대체하지 않습니다/);
  const historical = {
    ...law, id: 'history-fixture', currentAsOf: undefined,
    effectiveFrom: '2010-12-09', article: '제19조', bodyStatus: 'excerpt',
    body: '과거 조문의 검증용 문장입니다.',
  };
  const exact = find('법인세법 제19조', { date: '2010-12-09' }, [law, historical]);
  assert.deepEqual(exact.documents.map(doc => doc.id), ['history-fixture']);
  // Existing point-in-time excerpt semantics remain conservative.
  assert.equal(find('법인세법 제19조', { date: '2011-01-01' }, [law, historical]).total, 0);
});

test('article search finds the precise main heading and its real excerpt line', () => {
  const result = find('법인세법 제19조').documents[0];
  assert.ok(result);
  assert.equal(result.excerptLocation.line, 5);
  assert.equal(result.excerptLocation.article, '제19조');
  assert.match(result.excerpt, /^제19조\(손금의 범위\)/);
  assert.ok(!result.excerpt.startsWith('법인세법'));
  assert.equal('body' in result, false, 'search summaries do not ship entire statutes');
  const only190 = { ...law, body: '법인세법\n제190조(다른 조문) 검증용 내용\n부칙\n제19조(적용례) 검증용 내용' };
  assert.equal(find('법인세법 제19조', {}, [only190]).total, 0);
  assert.equal(find('법인세법 제190조', {}, [only190]).total, 1);
});

test('subarticles and paragraph numbers match exactly within their own article', () => {
  const subarticle = find('법인세법 제19조의2').documents[0];
  assert.equal(subarticle.excerptLocation.line, 7);
  assert.equal(subarticle.excerptLocation.article, '제19조의2');
  const paragraph = find('법인세법 제19조 제2항').documents[0];
  assert.equal(paragraph.excerptLocation.line, 6);
  assert.equal(paragraph.excerptLocation.article, '제19조 제2항');
  assert.match(paragraph.excerpt, /^② 둘째 항/);
  assert.equal(find('법인세법 제19조 제3항').total, 0);
  assert.equal(find('법인세법 제19조의2 제2항').total, 0);
});

test('supplementary provisions remain searchable text without becoming main articles', () => {
  assert.equal(find('법인세법 제2조').total, 0);
  const result = find('경과조치').documents[0];
  assert.ok(result);
  assert.equal(result.excerptLocation.line, 10);
  assert.equal(result.excerptLocation.article, null);
  assert.match(result.excerpt, /부칙에만 있는 조문/);
});

test('confirmed historical expiry remains separate from a current-law observation', () => {
  const expired = { ...law, effectiveTo: '2026-08-31', currentAsOf: '2026-08-15' };
  assert.equal(temporalStatus(expired, '2026-09-01'), 'past');
  assert.equal(find('법인세법', { date: '2026-08-31' }, [expired]).total, 1);
  assert.equal(find('법인세법', { date: '2026-09-01' }, [expired]).total, 0);
  const invalidCheck = { ...law, currentAsOf: '2026-02-30' };
  assert.equal(temporalStatus(invalidCheck, '2026-10-19'), 'unknown');
  assert.equal(find('법인세법', { date: '2026-10-19' }, [invalidCheck]).total, 0);
});
