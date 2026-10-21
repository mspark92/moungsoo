import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../worker/runtime.mjs';
import { parseDocket, classifyCourtCase, courtCaseBody } from '../worker/law-updates.mjs';

// Synthetic API-shaped fixtures only; these are not real judgments or credentials.
// Shapes follow the observed law.go.kr responses: 국세법령정보시스템 rows leave
// 법원명 empty and encode the court in 사건번호 ("대법원-2025-두-34754"), and their
// HTML detail is only a wrapper, so the collector never requests it.
const material = { documents: [], sources: [], baselineIds: [] };
const admin = { 'oai-authenticated-user-email': 'owner@example.test' };
function bucket() {
  const entries = new Map();
  return { entries, get: async key => entries.has(key) ? { json: async () => JSON.parse(entries.get(key).value), etag: entries.get(key).etag } : null,
    put: async (key, value, options = {}) => {
      const previous = entries.get(key);
      if (options.onlyIf?.etagMatches && previous?.etag !== options.onlyIf.etagMatches) return null;
      if (options.onlyIf?.etagDoesNotMatch === '*' && previous) return null;
      const etag = crypto.randomUUID(); entries.set(key, { value, etag }); return { etag };
    }, delete: async key => entries.delete(key) };
}
function environment() { return { BUCKET: bucket(), ADMIN_EMAIL: 'owner@example.test', ADMIN_TOKEN: 'isolated-test-encryption', LAW_API_OC: 'isolated-fixture-oc' }; }
async function request(path, env, method = 'GET', body, headers = {}, seed = material) {
  const response = await handleRequest(new Request('https://reference.test' + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env, {}, seed, {});
  return { status: response.status, data: await response.json() };
}
const run = (env, page = 1, headers = admin) => request('/api/updates/laws/run', env, 'POST', { dataset: 'nts-cases', page }, headers);
const runTrack = (env, track, extra = {}) => request('/api/updates/laws/run', env, 'POST', { dataset: 'cases', track, page: 1, from: '2024-10-22', to: '2026-10-01', ...extra }, admin);
function row(index = 1, overrides = {}) { return { 판례일련번호: String(880000 + index), 사건명: '격리 시험 쟁점 ' + index, 사건번호: '서울행정법원-2025-구합-' + (990000 + index), 선고일자: '2025.01.02', 법원명: '', 사건종류명: '세무', 데이터출처명: '국세법령정보시스템', ...overrides }; }
function courtRow(index, overrides = {}) { return { 판례일련번호: String(770000 + index), 사건명: '법인세부과처분취소', 사건번호: '2024두' + (55000 + index), 선고일자: '2025.03.04', 법원명: '대법원', 사건종류명: '세무', 데이터출처명: '대법원', ...overrides }; }
function courtDetail(r, overrides = {}) { return { PrecService: { 판례정보일련번호: r.판례일련번호, 사건번호: r.사건번호, 사건명: r.사건명, 법원명: r.법원명, 판시사항: '[1] 격리된 시험 판시사항<br/>[2] 둘째 항목', 판결요지: '격리된 시험 판결요지입니다.', 참조조문: '법인세법 제19조', 참조판례: '', 판례내용: '【원고, 상고인】 시험<br/>【주    문】<br/>상고를 기각한다.<br/>【이    유】<br/>이 문장은 격리된 시험 본문입니다.', ...overrides } }; }
function upstream(env, rows, { details = {}, onCall } = {}) {
  const calls = [];
  env.LAW_API_FETCH = async (input, options) => {
    const url = new URL(input); calls.push({ url, options }); onCall?.(url);
    assert.equal(url.origin, 'https://www.law.go.kr');
    assert.equal(url.searchParams.get('OC'), env.LAW_API_OC);
    assert.equal(url.searchParams.get('target'), 'prec');
    assert.equal(options.redirect, 'manual');
    if (url.pathname.endsWith('lawSearch.do')) {
      assert.equal(url.searchParams.get('type'), 'JSON'); assert.equal(url.searchParams.get('sort'), 'ddes');
      const source = url.searchParams.get('datSrcNm'), display = Number(url.searchParams.get('display')), page = Number(url.searchParams.get('page'));
      const matching = rows.filter(r => r.데이터출처명 === source || !['국세법령정보시스템', '대법원'].includes(r.데이터출처명));
      return Response.json({ PrecSearch: { totalCnt: String(matching.length), page: String(page), prec: matching.slice((page - 1) * display, page * display) } });
    }
    assert.equal(url.searchParams.get('type'), 'JSON');
    const match = rows.find(r => r.판례일련번호 === url.searchParams.get('ID'));
    return Response.json(details[match?.판례일련번호] ?? courtDetail(match));
  };
  return calls;
}

test('Docket parsing, case classification and detail validation follow the official fields', () => {
  assert.deepEqual(parseDocket('대법원-2025-두-34754', ''), { agency: '대법원', number: '2025두34754' });
  assert.deepEqual(parseDocket('부산고등법원(창원)-2024-나-13718', ''), { agency: '부산고등법원(창원)', number: '2024나13718' });
  assert.deepEqual(parseDocket('2025다215212', '대법원'), { agency: '대법원', number: '2025다215212' });
  assert.equal(classifyCourtCase('법인세경정거부처분취소'), 'tax');
  assert.equal(classifyCourtCase('취득세등부과처분취소'), 'local-tax');
  assert.equal(classifyCourtCase('업무상과실치사'), null);
  assert.equal(classifyCourtCase('과징금부과처분취소'), null);
  const r = courtRow(1);
  const full = courtCaseBody(courtDetail(r), r.사건번호);
  assert.equal(full.bodyStatus, 'full'); assert.match(full.body, /^【판시사항】\n\[1\] 격리된 시험 판시사항\n\[2\] 둘째 항목/); assert.match(full.body, /【전문】[\s\S]*상고를 기각한다/); assert.doesNotMatch(full.body, /<br|【참조판례】/);
  assert.equal(courtCaseBody(courtDetail(r), '2099두1'), null);
  assert.equal(courtCaseBody({ PrecService: { 사건번호: r.사건번호, 참조조문: '법인세법' } }, r.사건번호), null);
  const long = courtCaseBody(courtDetail(r, { 판례내용: '긴 본문 '.repeat(4000) }), r.사건번호);
  assert.equal(long.bodyStatus, 'excerpt'); assert.ok(long.body.length <= 16100); assert.match(long.body, /공식 원문에서 전체 확인/);
});

test('Case collection and review endpoints require server authority; missing OC never calls an upstream', async () => {
  const env = environment(); let called = false; env.LAW_API_FETCH = async () => { called = true; throw Error('must not call'); };
  assert.equal((await run(env, 1, {})).status, 401);
  for (const path of ['/api/admin/cases/pending', '/api/admin/laws/pending', '/api/admin/holidays']) assert.equal((await request(path, env)).status, 401);
  for (const path of ['/api/admin/cases/import', '/api/admin/cases/import-batch', '/api/admin/cases/discard', '/api/admin/cases/stage', '/api/admin/laws/publish']) assert.equal((await request(path, env, 'POST', { all: true, reviewConfirmed: true })).status, 401);
  delete env.LAW_API_OC;
  const result = await run(env); assert.equal(result.data.state, 'blocked'); assert.equal(result.data.ok, false); assert.equal(called, false);
  const status = (await request('/api/updates/status', env)).data;
  assert.equal(status.cases.lastRun.state, 'blocked'); assert.equal(status.lastRun, null); assert.equal(status.cases.automatic, false);
});

test('Case page, track and date-window bounds are checked before upstream calls', async () => {
  const env = environment(); let calls = 0; env.LAW_API_FETCH = async () => { calls++; throw Error(); };
  for (const page of [0, -1, 101, 1.5, '1']) assert.equal((await run(env, page)).status, 400);
  assert.equal((await request('/api/updates/laws/run', env, 'POST', { dataset: 'unknown' }, admin)).status, 400);
  assert.equal((await runTrack(env, 'everything')).status, 400);
  for (const window of [{ from: '2026-02-30' }, { from: '2026-10-02', to: '2026-10-01' }, { to: '2999-01-01' }, { from: '2010-01-01', to: '2026-01-01' }]) assert.equal((await runTrack(env, 'nts', window)).status, 400, JSON.stringify(window));
  assert.equal((await runTrack(env, 'nts', { page: 1001 })).status, 400);
  assert.equal(calls, 0);
});

test('NTS rows stage privately as link records with the court parsed from the docket and no detail requests', async () => {
  const env = environment(), rows = [row(1), row(2, { 사건번호: '대법원-2025-두-34754' }), row(3, { 선고일자: '2999.12.11' }), row(4, { 선고일자: '2025.02.30' })];
  const calls = upstream(env, rows);
  const result = (await run(env)).data;
  assert.equal(result.ok, true); assert.equal(result.fetched, 2); assert.equal(result.links, 2); assert.equal(result.excerpts, 0); assert.equal(result.skippedRows, 2); assert.equal(result.reviewPending, 2); assert.equal(result.published, 0);
  assert.equal(calls.length, 1, 'only the official list is requested');
  assert.match(result.warnings.map(w => w.message).join(' '), /오늘 이후/); assert.match(result.warnings.map(w => w.message).join(' '), /선고일 형식/);
  const [first, second] = result.documents;
  assert.equal(first.agency, '서울행정법원'); assert.equal(first.documentNumber, '2025구합990001'); assert.equal(first.documentDate, '2025-01-02');
  assert.equal(second.agency, '대법원'); assert.equal(second.documentNumber, '2025두34754');
  for (const d of result.documents) { assert.equal(d.reviewStatus, 'draft'); assert.equal(d.bodyStatus, 'link'); assert.equal(d.body, ''); assert.equal(d.allowedDownload, false); assert.equal(d.collection, 'case-api'); assert.equal(d.sourceUrl, `https://www.law.go.kr/LSW/precInfoP.do?precSeq=${d.id.split('-').at(-1)}`); assert.match(d.rights, /법제처/); }
  assert.equal((await request('/api/search', env)).data.total, 0);
  assert.equal((await request('/api/documents/' + first.id, env)).status, 404);
  const publicStatus = (await request('/api/updates/status', env)).data;
  assert.ok(!Object.hasOwn(publicStatus.cases.lastRun, 'documents')); assert.ok(!JSON.stringify(publicStatus).includes(env.LAW_API_OC));
  const pending = (await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data;
  assert.equal(pending.total, 2); assert.equal(pending.documents.length, 2); assert.deepEqual(pending.byTrack, { nts: 2 });
});

test('Court track keeps only tax and local-tax titles and stores official judgment text', async () => {
  const env = environment(), rows = [courtRow(1), courtRow(2, { 사건명: '취득세등부과처분취소', 법원명: '서울고등법원', 사건번호: '2024누1234' }), courtRow(3, { 사건명: '업무상과실치사', 사건번호: '2025고합1' }), courtRow(4, { 사건번호: '2024두99999' })];
  const calls = upstream(env, rows, { details: { [rows[3].판례일련번호]: courtDetail(rows[3], { 사건번호: '2023두1' }) } });
  const result = (await runTrack(env, 'court')).data;
  assert.equal(result.ok, true); assert.equal(result.fetched, 3); assert.equal(result.excerpts, 2); assert.equal(result.links, 1);
  assert.equal(calls.filter(c => c.url.pathname.endsWith('lawService.do')).length, 3, 'no detail call for unrelated cases');
  const list = calls[0].url.searchParams; assert.equal(list.get('datSrcNm'), '대법원'); assert.equal(list.get('prncYd'), '20241022~20261001');
  const pending = (await request('/api/admin/cases/pending?track=court&limit=10', env, 'GET', undefined, admin)).data.documents;
  const local = pending.find(d => d.documentNumber === '2024누1234');
  assert.equal(local.agency, '서울고등법원'); assert.ok(local.tags.includes('지방세')); assert.equal(local.domain, 'tax'); assert.equal(local.bodyStatus, 'full');
  assert.equal(pending.find(d => d.documentNumber === '2024두99999').bodyStatus, 'link');
  const progress = (await request('/api/updates/status', env)).data.cases.progress;
  assert.deepEqual(progress.window, { from: '2024-10-22', to: '2026-10-01' }); assert.equal(progress.tracks.court.done, true);
});

test('Subcontract track searches judgment text for 하도급 and files results under subcontracting', async () => {
  const env = environment(), rows = [courtRow(1, { 사건명: '공사대금', 사건번호: '2025다215212' })];
  const calls = upstream(env, rows);
  const result = (await runTrack(env, 'subcontract')).data;
  assert.equal(result.fetched, 1);
  const list = calls[0].url.searchParams; assert.equal(list.get('query'), '하도급'); assert.equal(list.get('search'), '2');
  const [doc] = (await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data.documents;
  assert.equal(doc.domain, 'subcontract'); assert.ok(doc.tags.includes('하도급')); assert.equal(doc.bodyStatus, 'full');
});

test('Review confirmation publishes searchable cases, and link-only records remain excluded from evidence and download', async () => {
  const env = environment(), rows = [courtRow(1), courtRow(2, { 사건번호: '2024두77777' })];
  upstream(env, rows, { details: { [rows[1].판례일련번호]: { PrecService: {} } } });
  await runTrack(env, 'court');
  const id = 'court-api-case-' + rows[0].판례일련번호, linkId = 'court-api-case-' + rows[1].판례일련번호;
  assert.equal((await request('/api/admin/cases/import', env, 'POST', { id }, admin)).status, 400);
  assert.equal((await request('/api/admin/cases/import', env, 'POST', { id: '../../law-api-connection-v1.json', reviewConfirmed: true }, admin)).status, 400);
  assert.equal((await request('/api/admin/cases/import', env, 'POST', { id, reviewConfirmed: true }, admin)).data.imported, true);
  assert.equal((await request('/api/admin/cases/import', env, 'POST', { id: linkId, reviewConfirmed: true }, admin)).data.imported, true);
  const search = await request('/api/search?' + new URLSearchParams({ q: rows[0].사건번호 }), env);
  assert.equal(search.data.total, 1); assert.equal(search.data.documents[0].id, id);
  const evidence = (await request('/api/evidence', env)).data;
  assert.equal(evidence.total, 1); assert.equal(evidence.excluded, 1); assert.equal(evidence.aiEnabled, false);
  assert.equal((await request('/api/documents/' + linkId + '/download', env)).status, 403);
  assert.equal((await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data.total, 0);
  assert.equal((await request('/api/admin/cases/import', env, 'POST', { id, reviewConfirmed: true }, admin)).status, 400);
});

test('Batch publication imports in one write, upgrades a published link record with court text, and skips duplicates', async () => {
  const env = environment();
  upstream(env, [row(1, { 사건번호: '대법원-2024-두-55001', 선고일자: '2025.03.04' }), row(2), row(3)]);
  await run(env);
  assert.equal((await request('/api/admin/cases/import-batch', env, 'POST', { all: true }, admin)).status, 400);
  const first = (await request('/api/admin/cases/import-batch', env, 'POST', { all: true, reviewConfirmed: true, max: 2 }, admin)).data;
  assert.equal(first.imported, 2); assert.equal(first.remaining, 1);
  const rest = (await request('/api/admin/cases/import-batch', env, 'POST', { track: 'nts', reviewConfirmed: true }, admin)).data;
  assert.equal(rest.imported, 1); assert.equal(rest.remaining, 0);
  const linkId = 'nts-api-case-880001';
  assert.equal((await request('/api/documents/' + linkId, env)).data.document.bodyStatus, 'link');
  // The same 대법원 judgment arrives from the court source with official text.
  upstream(env, [courtRow(1)]); const court = (await runTrack(env, 'court')).data;
  assert.equal(court.staged, 1, 'link-only published record is re-staged for a body');
  const upgrade = (await request('/api/admin/cases/import-batch', env, 'POST', { all: true, reviewConfirmed: true }, admin)).data;
  assert.equal(upgrade.upgraded, 1); assert.equal(upgrade.imported, 0);
  const doc = (await request('/api/documents/' + linkId, env)).data.document;
  assert.equal(doc.bodyStatus, 'full'); assert.match(doc.body, /판결요지/); assert.match(doc.sourceUrl, /precSeq=770001/);
  // A second identical run stages nothing: the published record already has text.
  upstream(env, [courtRow(1)]); assert.equal((await runTrack(env, 'court')).data.staged, 0);
  assert.equal((await request('/api/search', env)).data.total, 3);
});

test('Pending review supports paging, track filters and discarding without publishing', async () => {
  const env = environment(); upstream(env, Array.from({ length: 30 }, (_, i) => row(i + 1)));
  await run(env); await run(env, 2);
  const page = (await request('/api/admin/cases/pending?limit=5&offset=5', env, 'GET', undefined, admin)).data;
  assert.equal(page.total, 30); assert.equal(page.documents.length, 5); assert.equal(page.documents[0].id, 'nts-api-case-880025');
  const discard = (await request('/api/admin/cases/discard', env, 'POST', { ids: ['nts-api-case-880001', 'nts-api-case-880002'] }, admin)).data;
  assert.equal(discard.removed, 2); assert.equal(discard.remaining, 28);
  assert.equal((await request('/api/admin/cases/discard', env, 'POST', {}, admin)).status, 400);
  assert.equal((await request('/api/admin/cases/discard', env, 'POST', { track: 'nts' }, admin)).data.remaining, 0);
  assert.equal((await request('/api/search', env)).data.total, 0);
});

test('Collector files are staged only when every field matches the collector output', async () => {
  const env = environment(); upstream(env, [row(1)]);
  const valid = (await run(env)).data.documents[0];
  await request('/api/admin/cases/discard', env, 'POST', { all: true }, admin);
  const tampered = [
    { ...valid, id: 'nts-api-case-990001' },
    { ...valid, id: 'nts-api-case-990002', sourceUrl: 'https://example.test/x', caseTrack: 'nts' },
    { ...valid, id: 'nts-api-case-990003', sourceUrl: 'https://www.law.go.kr/LSW/precInfoP.do?precSeq=990003', body: '만들어낸 본문', bodyStatus: 'full' },
    { ...valid, id: 'court-api-case-990004', sourceUrl: 'https://www.law.go.kr/LSW/precInfoP.do?precSeq=990004' },
    { ...valid, id: 'nts-api-case-990005', sourceUrl: 'https://www.law.go.kr/LSW/precInfoP.do?precSeq=990005', documentDate: '2999-01-01' },
    { ...valid, id: 'nts-api-case-990006', sourceUrl: 'https://www.law.go.kr/LSW/precInfoP.do?precSeq=990006', reviewStatus: 'published' },
  ];
  assert.equal((await request('/api/admin/cases/stage', env, 'POST', { format: 'other', documents: [valid] }, admin)).status, 400);
  const staged = (await request('/api/admin/cases/stage', env, 'POST', { format: 'law-api-cases-v1', documents: [valid, ...tampered] }, admin)).data;
  assert.equal(staged.staged, 1); assert.equal(staged.rejected, 6);
  const [pending] = (await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data.documents;
  assert.equal(pending.id, valid.id); assert.equal(pending.reviewStatus, 'draft');
});

test('Repeated batches and alternate API IDs do not create duplicate public court, docket and date records', async () => {
  const env = environment(), record = row(1); upstream(env, [record]);
  await run(env); await run(env);
  assert.equal((await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data.total, 1);
  await request('/api/admin/cases/import', env, 'POST', { id: 'nts-api-case-' + record.판례일련번호, reviewConfirmed: true }, admin);
  const alternative = row(2, { 사건번호: record.사건번호 }); upstream(env, [alternative]); await run(env);
  assert.equal((await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data.total, 0, 'already published identity is not re-staged');
  assert.equal((await request('/api/search', env)).data.total, 1);
});

test('Upstream failure preserves existing corpus and review queue, never leaks OC, and a later valid run recovers', async () => {
  const env = environment(); upstream(env, [row(1)]); await run(env);
  env.LAW_API_FETCH = async () => { throw new Error('failed https://www.law.go.kr/?OC=' + env.LAW_API_OC); };
  const failed = (await run(env)).data;
  assert.equal(failed.state, 'failed'); assert.equal(failed.previousReviewPending, 1); assert.ok(!JSON.stringify(failed).includes(env.LAW_API_OC)); assert.match(failed.reason, /연결 실패/);
  env.LAW_API_FETCH = async () => new Response(null, { status: 302, headers: { location: 'https://www.law.go.kr/error?OC=' + env.LAW_API_OC } });
  const redirected = (await run(env)).data; assert.match(redirected.reason, /이동을 요청/); assert.ok(!JSON.stringify(redirected).includes(env.LAW_API_OC));
  env.LAW_API_FETCH = async () => new Response('<html>미승인 OC ' + env.LAW_API_OC + '</html>', { headers: { 'content-type': 'text/html' } });
  const html = (await run(env)).data; assert.match(html.reason, /안내 화면/); assert.ok(!JSON.stringify(html).includes(env.LAW_API_OC));
  assert.equal((await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data.total, 1);
  assert.equal((await request('/api/search', env)).data.total, 0);
  upstream(env, [row(2)]); const recovered = (await run(env)).data;
  assert.equal(recovered.state, 'review-pending'); assert.equal(recovered.reviewPending, 2);
  assert.equal((await request('/api/updates/status', env)).data.cases.lastRun.state, 'review-pending');
});

test('Wrong sources and list structures fail closed; valid zero results do not fabricate records', async () => {
  for (const payload of [
    { PrecSearch: { totalCnt: 1, prec: [row(1, { 데이터출처명: '대법원' })] } },
    { PrecSearch: { totalCnt: 1, prec: [] } },
    { other: 'unknown response' },
  ]) {
    const env = environment(); env.LAW_API_FETCH = async () => Response.json(payload);
    const result = (await run(env)).data; assert.equal(result.state, 'failed');
    assert.equal((await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data.total, 0);
    assert.equal((await request('/api/search', env)).data.total, 0);
  }
  const env = environment(); upstream(env, []);
  const empty = (await run(env)).data; assert.equal(empty.ok, true); assert.equal(empty.fetched, 0); assert.equal(empty.totalAvailable, 0); assert.equal(empty.reviewPending, 0); assert.equal(empty.done, true);
});

test('Legacy page collection is capped to twenty list rows', async () => {
  const env = environment(), rows = Array.from({ length: 25 }, (_, i) => row(i + 1));
  const calls = upstream(env, rows);
  const result = (await run(env, 2)).data;
  assert.equal(result.fetched, 5); assert.equal(result.totalAvailable, 25); assert.equal(result.totalPages, 2); assert.equal(result.done, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get('page'), '2'); assert.equal(calls[0].url.searchParams.get('display'), '20');
});

test('Admin updater alias accepts the actual admin cookie while anonymous callers remain blocked', async()=>{
 const env=environment();upstream(env,[row(1)]);
 const login=await handleRequest(new Request('https://reference.test/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:env.ADMIN_TOKEN})}),env,{},material,{});
 assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.match(login.headers.get('set-cookie'),/Path=\/api\/admin/);
 assert.equal((await request('/api/admin/updates/run',env,'POST',{dataset:'nts-cases'},{})).status,401);
 const runWithCookie=await request('/api/admin/updates/run',env,'POST',{dataset:'nts-cases'},{cookie});
 assert.equal(runWithCookie.data.ok,true);assert.equal(runWithCookie.data.fetched,1);
 assert.equal((await request('/api/admin/cases/pending',env,'GET',undefined,{cookie})).data.total,1);
});

test('Review queue uses conditional writes and retries a concurrent update without silently discarding work',async()=>{
 const env=environment();upstream(env,[row(1)]);
 const put=env.BUCKET.put;let conflicts=0;
 env.BUCKET.put=async(key,value,options={})=>{
  if(key==='updates-nts-cases-queue-v1.json'){
   assert.ok(options.onlyIf);
   if(conflicts===0){conflicts++;await put(key,JSON.stringify([{id:'already-pending',key:'updates/cases/already-pending.json'}]));return null;}
  }
  return put(key,value,options);
 };
 const result=(await run(env)).data;assert.equal(result.ok,true);assert.equal(conflicts,1);assert.equal(result.reviewPending,2);
 const queue=JSON.parse(env.BUCKET.entries.get('updates-nts-cases-queue-v1.json').value);
 assert.deepEqual(queue.map(x=>x.id),['already-pending','nts-api-case-880001']);
});

test('Reviewed real NTS court links are exactly searchable and never become body evidence',async()=>{
 const {readFile}=await import('node:fs/promises');
 const seed=JSON.parse(await readFile(new URL('../data/seed.json',import.meta.url),'utf8'));
 const links=seed.documents.filter(d=>d.id.startsWith('nts-court-link-'));
 assert.equal(links.length,8);
 for(const d of links){
  assert.equal(new URL(d.sourceUrl).hostname,'taxlaw.nts.go.kr');assert.ok(!d.sourceUrl.includes('jsessionid'));assert.equal(d.body,'');assert.equal(d.bodyStatus,'link');assert.equal(d.allowedDownload,false);
  const search=await request('/api/search?'+new URLSearchParams({q:d.documentNumber}),{},'GET',undefined,{},seed);
  assert.equal(search.data.total,1,d.documentNumber);assert.equal(search.data.documents[0].id,d.id);
  const evidence=await request('/api/evidence?'+new URLSearchParams({q:d.documentNumber}),{},'GET',undefined,{},seed);
  assert.equal(evidence.data.total,0);assert.equal(evidence.data.excluded,1);
 }
});

test('Collected cases stay out of the core list and are paged on the cases menu', async () => {
  const env = environment(); upstream(env, Array.from({ length: 12 }, (_, i) => row(i + 1, { 선고일자: `2025.01.${String(i + 1).padStart(2, '0')}` })));
  await run(env); await request('/api/admin/cases/import-batch', env, 'POST', { all: true, reviewConfirmed: true }, admin);
  assert.equal((await request('/api/search?collection=core', env)).data.total, 0);
  const first = (await request('/api/search?category=cases&limit=5', env)).data;
  assert.equal(first.total, 5); assert.equal(first.totalMatched, 12); assert.equal(first.documents[0].documentDate, '2025-01-12');
  const third = (await request('/api/search?category=cases&limit=5&offset=10', env)).data;
  assert.equal(third.total, 2); assert.equal(third.documents.at(-1).documentDate, '2025-01-01');
  assert.equal((await request('/api/search?limit=abc', env)).status, 400);
  const status = (await request('/api/status', env)).data.counts;
  assert.equal(status.cases, 12); assert.equal(status.collectedCases, 12);
});
