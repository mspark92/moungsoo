import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../worker/runtime.mjs';
import { checkGuideLinks } from '../worker/law-updates.mjs';

// Synthetic fixtures in the observed response shapes (2026-10-26): Decc/decc +
// SpecialDeccService, Ftc/ftc + FtcService, CgmExpc/cgmExpc. Not real decisions.
const seed = { documents: [], sources: [{ id: 'tax-tribunal', name: '조세심판원', status: 'unconnected' }, { id: 'ftc', name: '공정거래위원회', status: 'unconnected' }, { id: 'nts-taxlaw', name: '국세청', status: 'unconnected' }, { id: 'courts', name: '법원', status: 'unconnected' }, { id: 'nts-filing-guides', name: '국세청 안내', status: 'unconnected' }], baselineIds: [] };
const admin = { 'oai-authenticated-user-email': 'owner@example.test' };
function bucket() { const entries = new Map(); return { entries, get: async k => entries.has(k) ? { json: async () => JSON.parse(entries.get(k).value), etag: entries.get(k).etag } : null, put: async (k, v, o = {}) => { const p = entries.get(k); if (o.onlyIf?.etagMatches && p?.etag !== o.onlyIf.etagMatches) return null; if (o.onlyIf?.etagDoesNotMatch === '*' && p) return null; const etag = crypto.randomUUID(); entries.set(k, { value: v, etag }); return { etag }; }, delete: async k => entries.delete(k) }; }
const environment = () => ({ BUCKET: bucket(), ADMIN_EMAIL: 'owner@example.test', ADMIN_TOKEN: 'isolated-test-encryption', LAW_API_OC: 'isolated-fixture-oc' });
const request = async (path, env, method = 'GET', body, headers = admin, docs = seed) => { const r = await handleRequest(new Request('https://reference.test' + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env, {}, docs, {}); return { status: r.status, data: await r.json() }; };
const run = (env, track, extra = {}) => request('/api/updates/laws/run', env, 'POST', { dataset: 'cases', track, page: 1, from: '2024-10-27', to: '2026-10-20', ...extra });

const ttRow = (id, o = {}) => ({ 특별행정심판재결례일련번호: String(id), 재결청: '조세심판원', 청구번호: `조심 2025서${id}`, 의결일자: '2026.01.26', 사건명: '', 재결구분명: '조세', ...o });
const ttDetail = (id, o = {}) => ({ SpecialDeccService: { 특별행정심판재결례일련번호: String(id), 사건명: '격리 시험 결정', 세목: '법인', 재결요지: '격리된 시험 재결요지<br/>둘째 줄', 주문: '심판청구를 기각한다.', 관련법령: '법인세법 제19조', 이유: '이유 '.repeat(2000), ...o } });
const ftcRow = (id, date, o = {}) => ({ 결정문일련번호: String(id), 사건번호: `2026하${id}`, 사건명: `격리 시험 하도급 사건 ${id}`, 결정일자: date, 문서유형: '의결서', 결정번호: '의 결  제 2026 - 1 호', ...o });
const ftcDetail = id => ({ FtcService: { 결정문일련번호: String(id), 결정요지: '격리된 시험 결정요지', 주문: '1. 시정명령', 이유: '긴 이유' } });
const ntsRow = (id, o = {}) => ({ 법령해석일련번호: String(id), 안건명: `격리 시험 해석 ${id}`, 안건번호: `기준-2026-법규-${id}`, 해석일자: '2026.03.04', 해석기관명: '국세청', 법령해석상세링크: `https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=${id}`, ...o });

function upstream(env, lists, details = {}) {
  const calls = [];
  env.LAW_API_FETCH = async (input, options) => {
    const url = new URL(input); calls.push(url);
    assert.equal(url.searchParams.get('OC'), env.LAW_API_OC); assert.equal(options.redirect, 'manual');
    const target = url.searchParams.get('target');
    if (url.pathname.endsWith('lawSearch.do')) return Response.json(lists[target]);
    return Response.json(details[target]?.(url.searchParams.get('ID')) ?? {});
  };
  return calls;
}

test('조세심판원 rulings are collected with a date filter, capped body excerpts and public links', async () => {
  const env = environment();
  const calls = upstream(env, { ttSpecialDecc: { Decc: { totalCnt: '2', decc: [ttRow(101), ttRow(102, { 재결청: '조세심판원' })] } } }, { ttSpecialDecc: id => id === '102' ? ttDetail(999) : ttDetail(id) });
  const result = (await run(env, 'tribunal')).data;
  assert.equal(result.ok, true); assert.equal(result.fetched, 2); assert.equal(result.excerpts, 1); assert.equal(result.links, 1);
  assert.equal(calls[0].searchParams.get('rslYd'), '20241027~20261020'); assert.equal(calls[0].searchParams.get('target'), 'ttSpecialDecc');
  const [doc] = (await request('/api/admin/cases/pending?track=tribunal', env)).data.documents.filter(d => d.id === 'tt-api-101');
  assert.equal(doc.type, 'decision'); assert.equal(doc.agency, '조세심판원'); assert.equal(doc.documentNumber, '조심 2025서101'); assert.equal(doc.documentDate, '2026-01-26');
  assert.equal(doc.sourceUrl, 'https://www.law.go.kr/LSW/specialDeccInfoP.do?specialDeccSeq=101&mode=3&trbClsCd=360101');
  assert.equal(doc.bodyStatus, 'excerpt'); assert.ok(doc.body.startsWith('【재결요지】\n격리된 시험 재결요지\n둘째 줄')); assert.doesNotMatch(doc.body, /【이유】/); assert.match(doc.body, /이유는 공식 원문에서 확인/); assert.ok(doc.tags.includes('조세심판원 결정'));
  assert.ok(!JSON.stringify(doc).includes(env.LAW_API_OC));
  // A row from another 재결청 fails the page instead of being stored.
  upstream(env, { ttSpecialDecc: { Decc: { totalCnt: '1', decc: [ttRow(103, { 재결청: '국민권익위원회' })] } } }, { ttSpecialDecc: id => ttDetail(id) });
  assert.equal((await run(env, 'tribunal')).data.state, 'failed');
});

test('FTC decisions stop at the window start because the list has no date filter', async () => {
  const env = environment();
  const calls = upstream(env, { ftc: { Ftc: { totalCnt: '500', ftc: [ftcRow(1, '2026.8.20.'), ftcRow(2, '2025.1.3.'), ftcRow(3, '2024.3.1.'), ftcRow(4, '2023.1.1.')] } } }, { ftc: id => ftcDetail(id) });
  const result = (await run(env, 'ftc')).data;
  assert.equal(result.fetched, 2); assert.equal(result.done, true, 'window end reached before the last page');
  assert.equal(calls[0].searchParams.get('query'), '하도급'); assert.equal(calls[0].searchParams.get('sort'), 'ddes');
  const docs = (await request('/api/admin/cases/pending?track=ftc', env)).data.documents;
  const first = docs.find(d => d.id === 'ftc-api-1');
  assert.equal(first.domain, 'subcontract'); assert.equal(first.documentDate, '2026-08-20'); assert.equal(first.bodyStatus, 'full'); assert.match(first.body, /【결정요지】[\s\S]*【주문】/);
  assert.equal(first.sourceUrl, 'https://www.law.go.kr/LSW/ftcInfoP.do?ftcSeq=1&mode=6');
});

test('국세청 interpretations are link records that keep only the official taxlaw URL', async () => {
  const env = environment();
  upstream(env, { ntsCgmExpc: { CgmExpc: { totalCnt: '3', cgmExpc: [ntsRow(11), ntsRow(12, { 법령해석상세링크: 'https://example.test/x' }), ntsRow(13)] } } });
  const result = (await run(env, 'nts-interp')).data;
  assert.equal(result.fetched, 2); assert.equal(result.links, 2); assert.equal(result.skippedRows, 1);
  const [doc] = (await request('/api/admin/cases/pending?track=nts-interp&limit=1', env)).data.documents;
  assert.equal(doc.type, 'interpretation'); assert.equal(doc.body, ''); assert.match(doc.sourceUrl, /^https:\/\/taxlaw\.nts\.go\.kr\//);
});

test('published collections switch their sources to connected, courts via the 법제처 route', async () => {
  const env = environment();
  upstream(env, { ttSpecialDecc: { Decc: { totalCnt: '1', decc: [ttRow(201)] } }, ftc: { Ftc: { totalCnt: '1', ftc: [ftcRow(5, '2026.8.1.')] } }, ntsCgmExpc: { CgmExpc: { totalCnt: '1', cgmExpc: [ntsRow(21)] } } }, { ttSpecialDecc: id => ttDetail(id), ftc: id => ftcDetail(id) });
  for (const track of ['tribunal', 'ftc', 'nts-interp']) await run(env, track);
  let sources = (await request('/api/status', env)).data.sources;
  assert.ok(sources.filter(s => ['tax-tribunal', 'ftc', 'nts-taxlaw'].includes(s.id)).every(s => s.status === 'unconnected'), 'drafts do not count');
  await request('/api/admin/cases/import-batch', env, 'POST', { all: true, reviewConfirmed: true });
  sources = (await request('/api/status', env)).data.sources;
  for (const id of ['tax-tribunal', 'ftc', 'nts-taxlaw']) assert.equal(sources.find(s => s.id === id).status, 'connected', id);
  assert.match(sources.find(s => s.id === 'tax-tribunal').integrationNote, /공개 1건/);
  assert.equal(sources.find(s => s.id === 'courts').status, 'unconnected', 'no court cases published yet');
  const cases = (await request('/api/search?category=cases&topic=' + encodeURIComponent('조세심판원 결정'), env)).data;
  assert.equal(cases.total, 1);
});

test('collector files for the new tracks are validated against their own URL rules', async () => {
  const env = environment();
  upstream(env, { ttSpecialDecc: { Decc: { totalCnt: '1', decc: [ttRow(301)] } }, ntsCgmExpc: { CgmExpc: { totalCnt: '1', cgmExpc: [ntsRow(31)] } } }, { ttSpecialDecc: id => ttDetail(id) });
  await run(env, 'tribunal'); await run(env, 'nts-interp');
  const docs = (await request('/api/admin/cases/pending?limit=10', env)).data.documents;
  await request('/api/admin/cases/discard', env, 'POST', { all: true });
  const tt = docs.find(d => d.caseTrack === 'tribunal'), nts = docs.find(d => d.caseTrack === 'nts-interp');
  const bad = [{ ...tt, id: 'tt-api-302' }, { ...tt, type: 'case' }, { ...nts, id: 'nts-interp-32', sourceUrl: 'https://evil.example/x' }, { ...nts, id: 'nts-interp-33', sourceUrl: 'https://taxlaw.nts.go.kr/qt/x?ntstDcmId=33', body: '만든 본문', bodyStatus: 'full' }];
  const staged = (await request('/api/admin/cases/stage', env, 'POST', { format: 'law-api-cases-v1', documents: [tt, nts, ...bad] })).data;
  assert.equal(staged.staged, 2); assert.equal(staged.rejected, 4);
});

test('guide link checks record failures and the guide source shows the result', async () => {
  const env = environment();
  env.GUIDE_FETCH = async url => new Response('', { status: String(url).includes('broken') ? 404 : 200 });
  const result = await checkGuideLinks(env, [{ id: 'g1', title: '안내1', sourceUrl: 'https://www.nts.go.kr/ok' }, { id: 'g2', title: '안내2', sourceUrl: 'https://www.nts.go.kr/broken' }]);
  assert.equal(result.total, 2); assert.equal(result.ok, 1); assert.equal(result.failed[0].id, 'g2');
  let guides = (await request('/api/status', env)).data.sources.find(s => s.id === 'nts-filing-guides');
  assert.equal(guides.status, 'failed'); assert.match(guides.integrationNote, /열리지 않음 1건/);
  env.GUIDE_FETCH = async () => new Response('', { status: 200 });
  await checkGuideLinks(env, [{ id: 'g1', title: '안내1', sourceUrl: 'https://www.nts.go.kr/ok' }]);
  guides = (await request('/api/status', env)).data.sources.find(s => s.id === 'nts-filing-guides');
  assert.equal(guides.status, 'link-checked'); assert.match(guides.integrationNote, /본문은 이용 허락 전까지 수록하지 않습니다/);
});

test('published decisions and interpretations are not staged again by later runs', async () => {
  const env = environment();
  const lists = { ttSpecialDecc: { Decc: { totalCnt: '1', decc: [ttRow(401)] } }, ntsCgmExpc: { CgmExpc: { totalCnt: '1', cgmExpc: [ntsRow(41)] } } };
  upstream(env, lists, { ttSpecialDecc: id => ttDetail(id) });
  await run(env, 'tribunal'); await run(env, 'nts-interp');
  await request('/api/admin/cases/import-batch', env, 'POST', { all: true, reviewConfirmed: true });
  upstream(env, lists, { ttSpecialDecc: id => ttDetail(id) });
  assert.equal((await run(env, 'tribunal')).data.staged, 0);
  assert.equal((await run(env, 'nts-interp')).data.staged, 0);
  assert.equal((await request('/api/admin/cases/pending', env)).data.total, 0);
});
