import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../worker/runtime.mjs';

// Synthetic API-shaped fixtures only; these are not real judgments or credentials.
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
function row(index = 1, overrides = {}) { return { 판례일련번호: String(880000 + index), 사건명: '격리 시험 판결 ' + index, 사건번호: '2025구합' + (990000 + index), 선고일자: '2025.01.02', 법원명: '격리시험법원', 데이터출처명: '국세법령정보시스템', ...overrides }; }
function judgment(docket) { return `<html><body><nav>제외할 탐색 메뉴</nav><h1>${docket}</h1><section><div>【주문】</div><p>이 문장은 수집기 검증을 위한 격리된 시험 주문이며 실제 법원의 판단이 아닙니다.</p><script>EXECUTION_MARKER</script><div>【이유】</div><p>${'이 문장은 격리된 시험 본문으로 검색 및 발췌 형식만 검증합니다. '.repeat(6)}</p></section><footer>제외할 하단 메뉴</footer></body></html>`; }
function upstream(env, rows, html = r => judgment(r.사건번호)) {
  const calls = [];
  env.LAW_API_FETCH = async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    assert.equal(url.origin, 'https://www.law.go.kr');
    assert.equal(url.searchParams.get('OC'), env.LAW_API_OC);
    assert.equal(url.searchParams.get('target'), 'prec');
    assert.equal(options.redirect, 'error');
    if (url.pathname.endsWith('lawSearch.do')) {
      assert.equal(url.searchParams.get('type'), 'JSON');
      assert.equal(url.searchParams.get('datSrcNm'), '국세법령정보시스템');
      assert.equal(url.searchParams.get('sort'), 'ddes');
      return Response.json({ PrecSearch: { totalCnt: rows.length, prec: rows } });
    }
    assert.equal(url.searchParams.get('type'), 'HTML');
    const match = rows.find(r => r.판례일련번호 === url.searchParams.get('ID'));
    return new Response(html(match), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  };
  return calls;
}

test('Case collection and review endpoints require server authority; missing OC never calls an upstream', async () => {
  const env = environment(); let called = false; env.LAW_API_FETCH = async () => { called = true; throw Error('must not call'); };
  assert.equal((await run(env, 1, {})).status, 401);
  assert.equal((await request('/api/admin/cases/pending', env)).status, 401);
  assert.equal((await request('/api/admin/cases/import', env, 'POST', { id: 'nts-api-case-880001', reviewConfirmed: true })).status, 401);
  delete env.LAW_API_OC;
  const result = await run(env); assert.equal(result.data.state, 'blocked'); assert.equal(result.data.ok, false); assert.equal(called, false);
  const status = (await request('/api/updates/status', env)).data;
  assert.equal(status.cases.lastRun.state, 'blocked'); assert.equal(status.lastRun, null); assert.equal(status.cases.automatic, false);
});

test('Case page bounds are checked before upstream calls', async () => {
  const env = environment(); let calls = 0; env.LAW_API_FETCH = async () => { calls++; throw Error(); };
  for (const page of [0, -1, 101, 1.5, '1']) assert.equal((await run(env, page)).status, 400);
  assert.equal((await request('/api/updates/laws/run', env, 'POST', { dataset: 'unknown' }, admin)).status, 400);
  assert.equal(calls, 0);
});

test('Validated source metadata and sanitized judgment excerpts stage privately; unknown bodies stay link-only', async () => {
  const env = environment(), rows = [row(1), row(2), row(3)];
  const calls = upstream(env, rows, r => r.판례일련번호 === rows[0].판례일련번호 ? judgment(r.사건번호) : r.판례일련번호 === rows[1].판례일련번호 ? judgment('different-docket') : '<html>메뉴와 로그인 화면뿐입니다.</html>');
  const result = (await run(env)).data;
  assert.equal(result.ok, true); assert.equal(result.fetched, 3); assert.equal(result.excerpts, 1); assert.equal(result.links, 2); assert.equal(result.reviewPending, 3); assert.equal(result.published, 0);
  assert.equal(calls.length, 4);
  assert.equal(result.documents[0].documentDate, '2025-01-02'); assert.equal(result.documents[0].bodyStatus, 'excerpt');
  assert.ok(result.documents[0].body.startsWith('【주문】')); assert.match(result.documents[0].body, /【이유】/);
  assert.doesNotMatch(result.documents[0].body, /EXECUTION_MARKER|<script|탐색 메뉴|하단 메뉴/);
  for (const d of result.documents) { assert.equal(d.reviewStatus, 'draft'); assert.equal(d.allowedDownload, false); assert.ok(!d.sourceUrl.includes('OC=')); assert.match(d.rights, /법제처/); }
  for (const d of result.documents.slice(1)) { assert.equal(d.bodyStatus, 'link'); assert.equal(d.body, ''); }
  assert.equal((await request('/api/search', env)).data.total, 0);
  assert.equal((await request('/api/evidence', env)).data.total, 0);
  assert.equal((await request('/api/documents/' + result.documents[0].id, env)).status, 404);
  const publicStatus = (await request('/api/updates/status', env)).data;
  assert.ok(!Object.hasOwn(publicStatus.cases.lastRun, 'documents')); assert.ok(!JSON.stringify(publicStatus).includes(env.LAW_API_OC));
  const pending = (await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data;
  assert.equal(pending.total, 3); assert.equal(pending.documents.length, 3);
});

test('Review confirmation publishes searchable cases, and link-only records remain excluded from evidence and download', async () => {
  const env = environment(), rows = [row(1), row(2)]; upstream(env, rows, r => r.판례일련번호 === rows[0].판례일련번호 ? judgment(r.사건번호) : '<html>본문 미확보</html>');
  const collected = (await run(env)).data;
  const id = collected.documents[0].id;
  assert.equal((await request('/api/admin/cases/import', env, 'POST', { id }, admin)).status, 400);
  assert.equal((await request('/api/admin/cases/import', env, 'POST', { id: '../../law-api-connection-v1.json', reviewConfirmed: true }, admin)).status, 400);
  assert.equal((await request('/api/admin/cases/import', env, 'POST', { id, reviewConfirmed: true }, admin)).data.imported, true);
  const linkId = collected.documents[1].id;
  assert.equal((await request('/api/admin/cases/import', env, 'POST', { id: linkId, reviewConfirmed: true }, admin)).data.imported, true);
  const search = await request('/api/search?' + new URLSearchParams({ q: rows[0].사건번호 }), env);
  assert.equal(search.data.total, 1); assert.equal(search.data.documents[0].id, id);
  const evidence = (await request('/api/evidence', env)).data;
  assert.equal(evidence.total, 1); assert.equal(evidence.excluded, 1); assert.equal(evidence.aiEnabled, false);
  assert.equal((await request('/api/documents/' + linkId + '/download', env)).status, 403);
  assert.equal((await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data.total, 0);
  assert.equal((await request('/api/admin/cases/import', env, 'POST', { id, reviewConfirmed: true }, admin)).status, 400);
});

test('Repeated batches and alternate API IDs do not create duplicate public court, docket and date records', async () => {
  const env = environment(), record = row(1); upstream(env, [record]);
  await run(env); await run(env);
  assert.equal((await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data.total, 1);
  await request('/api/admin/cases/import', env, 'POST', { id: 'nts-api-case-' + record.판례일련번호, reviewConfirmed: true }, admin);
  const alternative = row(2, { 사건번호: record.사건번호 }); upstream(env, [alternative]); await run(env);
  const duplicate = (await request('/api/admin/cases/import', env, 'POST', { id: 'nts-api-case-' + alternative.판례일련번호, reviewConfirmed: true }, admin)).data;
  assert.equal(duplicate.imported, false); assert.equal(duplicate.duplicateId, 'nts-api-case-' + record.판례일련번호);
  assert.equal((await request('/api/search', env)).data.total, 1);
  assert.equal((await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data.total, 0);
});

test('Upstream failure preserves existing corpus and review queue, never leaks OC, and a later valid run recovers', async () => {
  const env = environment(); upstream(env, [row(1)]); await run(env);
  env.LAW_API_FETCH = async () => { throw new Error('failed https://www.law.go.kr/?OC=' + env.LAW_API_OC); };
  const failed = (await run(env)).data;
  assert.equal(failed.state, 'failed'); assert.equal(failed.previousReviewPending, 1); assert.ok(!JSON.stringify(failed).includes(env.LAW_API_OC));
  assert.equal((await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data.total, 1);
  assert.equal((await request('/api/search', env)).data.total, 0);
  upstream(env, [row(2)]); const recovered = (await run(env)).data;
  assert.equal(recovered.state, 'review-pending'); assert.equal(recovered.reviewPending, 2);
  assert.equal((await request('/api/updates/status', env)).data.cases.lastRun.state, 'review-pending');
});

test('Malformed source, dates and list structures fail closed; valid zero results do not fabricate records', async () => {
  for (const payload of [
    { PrecSearch: { totalCnt: 1, prec: [row(1, { 데이터출처명: '대법원' })] } },
    { PrecSearch: { totalCnt: 1, prec: [row(1, { 선고일자: '2025-02-30' })] } },
    { PrecSearch: { totalCnt: 1, prec: [row(1, { 선고일자: '2999-01-01' })] } },
    { PrecSearch: { totalCnt: 1, prec: [] } },
    { other: 'unknown response' },
  ]) {
    const env = environment(); env.LAW_API_FETCH = async () => Response.json(payload);
    const result = (await run(env)).data; assert.equal(result.state, 'failed');
    assert.equal((await request('/api/admin/cases/pending', env, 'GET', undefined, admin)).data.total, 0);
    assert.equal((await request('/api/search', env)).data.total, 0);
  }
  const env = environment(); upstream(env, []);
  const empty = (await run(env)).data; assert.equal(empty.ok, true); assert.equal(empty.fetched, 0); assert.equal(empty.totalAvailable, 0); assert.equal(empty.reviewPending, 0);
});

test('Metadata collection is capped to twenty rows and oversized or failed HTML bodies become links', async () => {
  const env = environment(), rows = Array.from({ length: 25 }, (_, i) => row(i + 1));
  const calls = upstream(env, rows);
  const result = (await run(env, 3)).data;
  assert.equal(result.fetched, 20); assert.equal(result.totalAvailable, 25); assert.equal(calls.length, 21); assert.equal(calls[0].url.searchParams.get('page'), '3');
  const other = environment();
  other.LAW_API_FETCH = async input => new URL(input).pathname.endsWith('lawSearch.do') ? Response.json({ PrecSearch: { totalCnt: 1, prec: row(1) } }) : new Response('oversized response fixture', { headers: { 'content-length': String(6 * 1024 * 1024) } });
  const bounded = (await run(other)).data; assert.equal(bounded.ok, true); assert.equal(bounded.links, 1); assert.equal(bounded.documents[0].body, ''); assert.equal(bounded.warnings.length, 1);
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
