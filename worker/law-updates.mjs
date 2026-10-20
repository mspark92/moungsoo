// API retrieval is deliberately separate from the reviewed public document store.
export const LAW_UPDATE_SCOPE = Object.freeze([
  '국세기본법', '소득세법', '법인세법', '부가가치세법',
  '상속세 및 증여세법', '조세특례제한법',
  '하도급거래 공정화에 관한 법률', '하도급거래 공정화에 관한 법률 시행령',
]);
export const LAW_UPDATE_GUIDE = Object.freeze({
  applicationUrl: 'https://open.law.go.kr/',
  documentationUrl: 'https://open.law.go.kr/LSO/openApi/guideList.do',
  officialUrl: 'https://www.law.go.kr/',
  steps: [
    '국가법령정보 공동활용에서 회원가입 후 활용 신청과 이용 조건을 확인하세요.',
    '가입·신청 시 직접 지정한 OC 인증값과 승인 범위를 확인하세요.',
    '관리자 연결 설정에서 OC를 등록하세요. 인증값을 채팅이나 공개 자료에 기재하지 마세요.',
    '첫 수집 자료는 검토 대기로 저장됩니다. 본문과 시행일·부칙 확인 후 공개하세요.',
  ],
});
const SCHEDULE = Object.freeze({ weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], time: '09:00', timezone: 'Asia/Seoul', excludesPublicHolidays: false });
const CONNECTION_KEY = 'law-api-connection-v1.json';
const STATE_KEY = 'updates-law-state-v1.json';
const CASE_STATE_KEY = 'updates-nts-cases-state-v1.json';
const CASE_QUEUE_KEY = 'updates-nts-cases-queue-v1.json';
const CASE_SOURCE = '국세법령정보시스템';
const CASE_LIMIT = 20;
const LIMIT = 5 * 1024 * 1024;
const encoder = new TextEncoder();
const timestamp = () => new Date().toISOString();
const fail = (status, message) => Object.assign(new Error(message), { status });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const compact = value => String(value || '').replace(/\s/g, '');
const scalar = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const field = (object, names) => names.map(name => scalar(object?.[name])).find(Boolean) || '';
const legalDate = value => {
  if (!/^\d{8}$/.test(String(value))) return false;
  const iso = `${String(value).slice(0, 4)}-${String(value).slice(4, 6)}-${String(value).slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(+date) && date.toISOString().slice(0, 10) === iso;
};

async function read(bucket, key) {
  if (!bucket) return null;
  const item = await bucket.get(key);
  return item ? item.json() : null;
}
async function write(bucket, key, body) {
  await bucket.put(key, JSON.stringify(body), { httpMetadata: { contentType: 'application/json' } });
}
async function mutateCaseQueue(bucket, operation) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = await bucket.get(CASE_QUEUE_KEY), queue = stored ? await stored.json() : [];
    const next = operation(queue);
    if (next.length > 2000) throw fail(409, '검토 대기 2,000건 한도입니다. 기존 자료를 먼저 검토하세요.');
    const result = await bucket.put(CASE_QUEUE_KEY, JSON.stringify(next), { httpMetadata: { contentType: 'application/json' }, onlyIf: stored?.etag ? { etagMatches: stored.etag } : { etagDoesNotMatch: '*' } });
    if (result !== null) return next;
  }
  throw fail(409, '다른 판례 수집·검토 요청이 먼저 저장되었습니다. 다시 시도하세요.');
}
function requireStorage(env) {
  if (!env.BUCKET) throw fail(503, '자료 저장소 연결이 필요합니다.');
}
async function requireAdmin(request, helpers) {
  if (!helpers?.requireAdmin || !await helpers.requireAdmin(request)) throw fail(401, '관리자 로그인이 필요합니다.');
}
function encode(bytes) { let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte); return btoa(raw); }
function decode(value) { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
async function encryptionKey(env) {
  if (!env.ADMIN_TOKEN) throw fail(503, '서버의 관리자 암호화 키 설정이 필요합니다.');
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(env.ADMIN_TOKEN));
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encryptOC(oc, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(CONNECTION_KEY) }, await encryptionKey(env), encoder.encode(oc));
  return { version: 1, algorithm: 'AES-GCM', iv: encode(iv), ciphertext: encode(new Uint8Array(encrypted)), registeredAt: timestamp(), registrationConfirmed: true };
}
async function loadOC(env, connection) {
  if (typeof env.LAW_API_OC === 'string' && env.LAW_API_OC.trim()) return env.LAW_API_OC.trim();
  if (!connection?.ciphertext) return '';
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(connection.iv), additionalData: encoder.encode(CONNECTION_KEY) }, await encryptionKey(env), decode(connection.ciphertext));
    return new TextDecoder().decode(plaintext);
  } catch { throw fail(503, '저장된 API 연결 정보를 읽지 못했습니다. 관리자 연결 설정에서 다시 등록하세요.'); }
}
async function smallJson(request) {
  const text = await request.text();
  if (text.length > 4096) throw fail(413, '연결 설정 요청이 너무 큽니다.');
  try { const body = JSON.parse(text); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw fail(400, 'JSON 연결 설정이 필요합니다.'); }
}
async function fetchJson(url, env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const upstream = await (env.LAW_API_FETCH || fetch)(url, { signal: controller.signal, headers: { Accept: 'application/json' }, redirect: 'error' });
    if (!upstream.ok) throw fail(502, `공식 API 응답 오류 (HTTP ${upstream.status})`);
    if (Number(upstream.headers.get('content-length')) > LIMIT) throw fail(502, '공식 API 응답이 허용 크기를 초과했습니다.');
    const reader = upstream.body?.getReader(); if (!reader) throw fail(502, '공식 API 본문이 없습니다.');
    const decoder = new TextDecoder(); let size = 0, text = '';
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > LIMIT) { await reader.cancel(); throw fail(502, '공식 API 응답이 허용 크기를 초과했습니다.'); } text += decoder.decode(part.value, { stream: true }); }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw fail(502, '공식 API JSON 형식을 확인할 수 없습니다. 승인·응답 형식을 확인하세요.'); }
  } catch (cause) {
    // Never include upstream text, URLs, or exception messages containing OC.
    if (cause.status) throw cause;
    throw fail(502, '공식 API 연결 실패 또는 응답 시간 초과');
  } finally { clearTimeout(timer); }
}
async function fetchCaseHtml(url, env) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const upstream = await (env.LAW_API_FETCH || fetch)(url, { signal: controller.signal, headers: { Accept: 'text/html' }, redirect: 'error' });
    if (!upstream.ok) throw fail(502, `판례 본문 응답 오류 (HTTP ${upstream.status})`);
    if (Number(upstream.headers.get('content-length')) > LIMIT) throw fail(502, '판례 본문이 허용 크기를 초과했습니다.');
    const reader = upstream.body?.getReader(); if (!reader) throw fail(502, '판례 본문 응답이 없습니다.');
    const decoder = new TextDecoder(); let bytes = 0, html = '';
    while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > LIMIT) { await reader.cancel(); throw fail(502, '판례 본문이 허용 크기를 초과했습니다.'); } html += decoder.decode(part.value, { stream: true }); }
    return html + decoder.decode();
  } catch (cause) { throw cause.status ? cause : fail(502, '판례 본문 연결 실패 또는 응답 시간 초과'); }
  finally { clearTimeout(timer); }
}
function caseDate(value) {
  const digits = String(value || '').replace(/[.\-\s]/g, '');
  return legalDate(digits) ? `${digits.slice(0,4)}-${digits.slice(4,6)}-${digits.slice(6,8)}` : '';
}
function caseListing(payload) {
  const root = payload?.PrecSearch || payload?.precSearch;
  if (!root || !/^\d+$/.test(String(root.totalCnt))) throw fail(502, '판례 목록 응답 형식 또는 API 승인 범위를 확인하세요.');
  const rows = Array.isArray(root.prec) ? root.prec : root.prec ? [root.prec] : [];
  if (Number(root.totalCnt) > 0 && !rows.length) throw fail(502, '판례 검색 결과와 목록 구조가 일치하지 않습니다.');
  return { total: Number(root.totalCnt), rows: rows.slice(0, CASE_LIMIT) };
}
// No upstream HTML is rendered. Unrecognised layouts remain link-only. This
// conservative extractor retains only an identified judgment excerpt, never a
// navigation page, login form, script, or a generated summary.
function caseExcerpt(html, docket) {
  let text = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|iframe|form|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&#x([\da-f]+);/gi, (_, n) => { const code = Number.parseInt(n,16); return code <= 0x10ffff ? String.fromCodePoint(code) : ''; })
    .replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
  if (!compact(text).includes(compact(docket))) return '';
  const start = text.search(/(?:【\s*주\s*문\s*】|^\s*주\s*문\s*$)/m);
  if (start < 0) return '';
  text = text.slice(start).split(/(?:이전글|다음글|목록으로|저작권정책|COPYRIGHT)/i)[0].trim();
  if (text.length < 100 || !/(?:【\s*이\s*유\s*】|^\s*이\s*유\s*$)/m.test(text)) return '';
  return text.slice(0, 200000);
}
async function collectCases(env, oc, startedAt, page) {
  const search = new URL('https://www.law.go.kr/DRF/lawSearch.do');
  search.search = new URLSearchParams({ OC: oc, target: 'prec', type: 'JSON', datSrcNm: CASE_SOURCE, display: String(CASE_LIMIT), page: String(page), sort: 'ddes' });
  const listing = caseListing(await fetchJson(search, env)), documents = [], warnings = [], seen = new Set();
  for (const row of listing.rows) {
    const id = field(row, ['판례일련번호']), docket = field(row, ['사건번호']), title = field(row, ['사건명']), agency = field(row, ['법원명']), documentDate = caseDate(field(row, ['선고일자']));
    if (field(row, ['데이터출처명']) !== CASE_SOURCE || !/^\d{1,20}$/.test(id) || !docket || !title || !agency || !documentDate || documentDate > startedAt.slice(0,10)) throw fail(502, '국세법령정보시스템 출처·사건번호·법원·선고일 검증에 실패했습니다.');
    const identity = `${agency}|${docket}|${documentDate}`; if (seen.has(identity)) continue; seen.add(identity);
    let body = '';
    const detail = new URL('https://www.law.go.kr/DRF/lawService.do');
    detail.search = new URLSearchParams({ OC: oc, target: 'prec', type: 'HTML', ID: id });
    try { body = caseExcerpt(await fetchCaseHtml(detail, env), docket); if (!body) warnings.push({ id, message: '본문 구조를 검증하지 못해 제목·링크만 보관했습니다.' }); }
    catch (cause) { warnings.push({ id, message: cause.status ? cause.message : '판례 본문 확인 실패' }); }
    documents.push({ id: `nts-api-case-${id}`, title, domain: 'tax', type: 'case', agency, sourceId: 'nts-cases-law-api', sourceUrl: `https://www.law.go.kr/precInfoP.do?precSeq=${id}`, documentNumber: docket, documentDate, body, bodyStatus: body ? 'excerpt' : 'link', tags: ['국세 판례'], keywords: [CASE_SOURCE, '법제처', agency, docket], version: `${documentDate} 선고 · 법제처 판례 ID ${id}`, verifiedAt: startedAt, collectedAt: startedAt, reviewStatus: 'draft', allowedDownload: false, rights: '법제처 국가법령정보 공동활용 공식 판례 API 제공 자료. 데이터출처명: 국세법령정보시스템. 이용 안내: https://open.law.go.kr/LSO/usrJoin.do . 본문은 검증된 판결 발췌만 표시하며 첨부파일 재배포·다운로드 권한을 확대 해석하지 않음.', notes: body ? '법제처 API가 제공한 국세법령정보시스템 판례에서 주문·이유 부분을 발췌했습니다. 판결 전체 수록이 아닙니다. 동일 사건의 다른 심급·판단 변경 여부는 원문에서 확인하세요.' : '공식 API 목록의 제목·사건번호·선고일·법원·출처만 확보했습니다. 앱에 없는 본문을 요약하거나 AI 근거로 사용하지 않습니다.' });
  }
  return { documents, warnings, total: listing.total };
}
function validateSearch(payload, name) {
  const root = payload?.LawSearch || payload?.lawSearch;
  const rows = Array.isArray(root?.law) ? root.law : root?.law ? [root.law] : [];
  const matches = rows.filter(row => compact(field(row, ['법령명한글', '법령명_한글', '법령명'])) === compact(name));
  const row = matches.find(item => /^\d+$/.test(field(item, ['법령일련번호'])) && legalDate(field(item, ['시행일자'])) && legalDate(field(item, ['공포일자'])));
  if (!row) throw fail(502, '법령 목록의 이름·버전·일자 검증에 실패했습니다. 공개 자료는 변경하지 않았습니다.');
  return { mst: field(row, ['법령일련번호']), effectiveDate: field(row, ['시행일자']), promulgatedDate: field(row, ['공포일자']) };
}
function validateDetail(payload, name, listing) {
  const root = payload?.법령;
  const basic = root?.기본정보 || root?.법령기본정보;
  const units = Array.isArray(root?.조문?.조문단위) ? root.조문.조문단위 : root?.조문?.조문단위 ? [root.조문.조문단위] : [];
  if (!root || !basic || compact(field(basic, ['법령명_한글', '법령명한글', '법령명'])) !== compact(name) || field(basic, ['시행일자']) !== listing.effectiveDate || field(basic, ['공포일자']) !== listing.promulgatedDate || !units.some(unit => unit && typeof unit === 'object' && (unit.조문내용 || unit.조문제목))) throw fail(502, '법령 본문의 이름·시행일·공포일·조문 검증에 실패했습니다. 검토 전에는 공개하지 않습니다.');
  if (!units.length || !units.some(unit => Boolean(field(unit, ['조문내용']) || unit.항))) throw fail(502, '확보한 조문 본문이 없습니다. 목록만으로 수집 성공을 표시하지 않습니다.');
  const detailMst = field(root, ['법령일련번호']) || field(basic, ['법령일련번호']);
  if (detailMst && detailMst !== listing.mst) throw fail(502, '법령 본문과 목록의 버전이 일치하지 않습니다.');
  return payload;
}
async function collectLaws(env, oc, startedAt) {
  const staged = [], errors = [];
  for (const name of LAW_UPDATE_SCOPE) {
    try {
      const search = new URL('https://www.law.go.kr/DRF/lawSearch.do');
      search.search = new URLSearchParams({ OC: oc, target: 'eflaw', type: 'JSON', nw: '3', search: '1', display: '100', query: name });
      const listing = validateSearch(await fetchJson(search, env), name);
      const detail = new URL('https://www.law.go.kr/DRF/lawService.do');
      detail.search = new URLSearchParams({ OC: oc, target: 'eflaw', type: 'JSON', MST: listing.mst, efYd: listing.effectiveDate });
      const payload = validateDetail(await fetchJson(detail, env), name, listing);
      const sourceUrl = `https://www.law.go.kr/법령/${encodeURIComponent(name)}`;
      const key = `updates/laws/${startedAt.replace(/[:.]/g, '-')}/${listing.mst}-${listing.effectiveDate}.json`;
      await write(env.BUCKET, key, { reviewStatus: 'draft', validation: 'metadata-and-article-structure', retrievedAt: timestamp(), lawName: name, ...listing, sourceUrl, payload });
      staged.push({ lawName: name, mst: listing.mst, effectiveDate: listing.effectiveDate, key });
    } catch (cause) { errors.push({ lawName: name, message: cause.status ? cause.message : '자료 수집·저장에 실패했습니다.' }); }
  }
  return { staged, errors };
}

export async function handleLawUpdate(request, env, ctx, helpers = {}) {
  const path = new URL(request.url).pathname;
  if (!['/api/updates/status', '/api/admin/law-connection', '/api/updates/laws/run', '/api/admin/updates/run', '/api/admin/cases/pending', '/api/admin/cases/import'].includes(path)) return null;
  try {
    if (path.startsWith('/api/admin/cases/')) {
      await requireAdmin(request, helpers); requireStorage(env);
      const queue = await read(env.BUCKET, CASE_QUEUE_KEY) || [];
      if (request.method === 'GET' && path.endsWith('/pending')) {
        const documents = [];
        for (const entry of queue.slice(-CASE_LIMIT).reverse()) { const stored = await read(env.BUCKET, entry.key); if (stored?.document) documents.push(stored.document); }
        return response({ documents, total: queue.length, limit: CASE_LIMIT });
      }
      if (request.method === 'POST' && path.endsWith('/import')) {
        const body = await smallJson(request), entry = queue.find(item=>item.id===body.id);
        if (!entry || body.reviewConfirmed !== true) throw fail(400, '검토 대기 자료와 원문·이용 조건 확인이 필요합니다.');
        const stored = await read(env.BUCKET, entry.key);
        if (!stored?.document || !helpers.importCase) throw fail(503, '검토 자료를 불러올 수 없습니다.');
        const result = await helpers.importCase(stored.document);
        await mutateCaseQueue(env.BUCKET, current=>current.filter(item=>item.id!==entry.id));
        return response(result);
      }
      return response({ error: '지원하지 않는 요청 방식입니다.' }, 405);
    }
    if (request.method === 'GET' && path === '/api/updates/status') {
      const connection = await read(env.BUCKET, CONNECTION_KEY);
      return response({ schedule: SCHEDULE, credentialConfigured: Boolean(env.LAW_API_OC || connection?.ciphertext), storageConfigured: Boolean(env.BUCKET), lastRun: await read(env.BUCKET, STATE_KEY), cases: { source: CASE_SOURCE, provider: '법제처 국가법령정보 공동활용', batchLimit: CASE_LIMIT, lastRun: await read(env.BUCKET, CASE_STATE_KEY), automatic: false }, scope: LAW_UPDATE_SCOPE, guide: LAW_UPDATE_GUIDE, publicationMode: 'review-required', sourceState: env.LAW_API_OC || connection?.ciphertext ? 'configured-unverified' : 'unconnected' });
    }
    if (path === '/api/admin/law-connection') {
      await requireAdmin(request, helpers); requireStorage(env);
      if (request.method === 'GET') { const connection = await read(env.BUCKET, CONNECTION_KEY); return response({ credentialConfigured: Boolean(env.LAW_API_OC || connection?.ciphertext), environmentConfigured: Boolean(env.LAW_API_OC), registeredAt: connection?.registeredAt || null, guide: LAW_UPDATE_GUIDE }); }
      if (request.method === 'DELETE') { await env.BUCKET.delete(CONNECTION_KEY); return response({ ok: true, credentialConfigured: Boolean(env.LAW_API_OC), message: env.LAW_API_OC ? '저장된 OC를 삭제했습니다. 서버 환경 설정의 OC는 별도로 제거해야 합니다.' : 'OC 연결 설정을 삭제했습니다.' }); }
      if (request.method === 'POST') {
        const body = await smallJson(request);
        if (body.registrationConfirmed !== true || typeof body.oc !== 'string' || !/^[A-Za-z0-9._@+-]{1,200}$/.test(body.oc.trim())) throw fail(400, '공동활용 승인 여부와 유효한 OC 인증값을 확인하세요.');
        await write(env.BUCKET, CONNECTION_KEY, await encryptOC(body.oc.trim(), env));
        return response({ ok: true, credentialConfigured: true, verified: false, message: '암호화하여 저장했습니다. 공식 API 승인·응답은 수집 실행 후 확인합니다.' });
      }
    }
    if (request.method === 'POST' && ['/api/updates/laws/run', '/api/admin/updates/run'].includes(path)) {
      if (!helpers.requireScheduler || !await helpers.requireScheduler(request)) await requireAdmin(request, helpers);
      requireStorage(env);
      const body = await smallJson(request);
      if (body.dataset && body.dataset !== 'nts-cases') throw fail(400, '지원하는 수집 범위를 선택하세요.');
      const isCases = body.dataset === 'nts-cases', stateKey = isCases ? CASE_STATE_KEY : STATE_KEY;
      const page = body.page ?? 1;
      if (isCases && (!Number.isInteger(page) || page < 1 || page > 100)) throw fail(400, '판례 페이지는 1~100 사이의 정수로 입력하세요.');
      const startedAt = timestamp(), prior = await read(env.BUCKET, stateKey);
      let oc;
      try { oc = await loadOC(env, await read(env.BUCKET, CONNECTION_KEY)); }
      catch (cause) { const lastRun = { state: 'failed', startedAt, checkedAt: timestamp(), reason: cause.message, previousReviewPending: prior?.reviewPending || 0 }; await write(env.BUCKET, stateKey, lastRun); return response({ ok: false, ...lastRun }); }
      if (!oc) {
        const lastRun = { state: 'blocked', reason: '국가법령정보 공동활용 승인 OC 미등록', startedAt, checkedAt: timestamp(), reviewPending: 0 };
        await write(env.BUCKET, stateKey, lastRun); return response({ ok: false, ...lastRun });
      }
      if (isCases) {
        try {
          const result = await collectCases(env, oc, startedAt, page);
          const entries = [];
          for (const document of result.documents) {
            const key = `updates/cases/${document.id}.json`;
            await write(env.BUCKET, key, { document, retrievedAt: startedAt });
            entries.push({ id: document.id, key });
          }
          const queue = await mutateCaseQueue(env.BUCKET, current=>[...current, ...entries.filter(entry=>!current.some(item=>item.id===entry.id))]);
          const lastRun = { state: 'review-pending', startedAt, checkedAt: timestamp(), page, totalAvailable: result.total, fetched: result.documents.length, reviewPending: queue.length, published: 0, excerpts: result.documents.filter(d=>d.body).length, links: result.documents.filter(d=>!d.body).length, warnings: result.warnings, message: '공식 API 판례를 검토 대기로 저장했습니다. 판례 검토 목록에서 확인 후 공개하세요. 전체 판례 수집이 아닙니다.' };
          await write(env.BUCKET, stateKey, lastRun);
          // Authenticated collector response only; never include bodies in public status.
          return response({ ok: true, ...lastRun, documents: result.documents });
        } catch (cause) {
          const lastRun = { state: 'failed', startedAt, checkedAt: timestamp(), reason: cause.status ? cause.message : '판례 수집·저장에 실패했습니다.', previousReviewPending: prior?.reviewPending || 0 };
          await write(env.BUCKET, stateKey, lastRun); return response({ ok: false, ...lastRun });
        }
      }
      const result = await collectLaws(env, oc, startedAt);
      const lastRun = { state: result.errors.length ? 'failed' : 'review-pending', startedAt, checkedAt: timestamp(), reviewPending: result.staged.length, published: 0, staged: result.staged, errors: result.errors, message: '검증된 수집 응답은 검토 대기로 보관합니다. 공개 자료와 마지막 확인일은 변경하지 않았습니다.' };
      await write(env.BUCKET, STATE_KEY, lastRun);
      return response({ ok: result.errors.length === 0, ...lastRun });
    }
    return response({ error: '지원하지 않는 요청 방식입니다.' }, 405);
  } catch (cause) { return response({ error: cause.status ? cause.message : '연동 설정 또는 저장소 처리에 실패했습니다.' }, cause.status || 503); }
}
