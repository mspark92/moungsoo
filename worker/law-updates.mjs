// API retrieval is deliberately separate from the reviewed public document store.
export const LOCAL_TAX_LAWS = Object.freeze(['지방세기본법', '지방세법', '지방세특례제한법', '지방세징수법']);
export const BASE_TAX_LAWS = Object.freeze(['국세기본법', '소득세법', '법인세법', '부가가치세법', '상속세 및 증여세법', '조세특례제한법', ...LOCAL_TAX_LAWS]);
// 2026-10-21: every base tax law has both a 시행령 and a 시행규칙 in the official
// list. 하도급법 has a 시행령 only (no 시행규칙 exists).
export const LAW_UPDATE_SCOPE = Object.freeze([
  '국세기본법', '소득세법', '법인세법', '부가가치세법',
  '상속세 및 증여세법', '조세특례제한법',
  '하도급거래 공정화에 관한 법률', '하도급거래 공정화에 관한 법률 시행령',
  ...LOCAL_TAX_LAWS,
  ...BASE_TAX_LAWS.flatMap(name => [`${name} 시행령`, `${name} 시행규칙`]),
]);
const LAW_BATCH = 16;
const isLocalTax = name => LOCAL_TAX_LAWS.some(base => name === base || name.startsWith(`${base} `));
export const LAW_UPDATE_GUIDE = Object.freeze({
  applicationUrl: 'https://open.law.go.kr/',
  documentationUrl: 'https://open.law.go.kr/LSO/openApi/guideList.do',
  officialUrl: 'https://www.law.go.kr/',
  steps: [
    '국가법령정보 공동활용에서 회원가입 후 활용 신청과 이용 조건을 확인하세요.',
    '가입·신청 시 직접 지정한 OC 인증값과 승인 범위(법령·판례)를 확인하세요.',
    '관리자 연결 설정에서 OC를 등록하세요. 인증값을 채팅이나 공개 자료에 기재하지 마세요.',
    '첫 수집 자료는 검토 대기로 저장됩니다. 본문과 시행일·부칙 확인 후 공개하세요.',
  ],
});
const CONNECTION_KEY = 'law-api-connection-v1.json';
const STATE_KEY = 'updates-law-state-v1.json';
const LAW_CURSOR_KEY = 'updates-law-cursor-v1.json';
const LAW_QUEUE_KEY = 'updates-laws-queue-v1.json';
const CASE_STATE_KEY = 'updates-nts-cases-state-v1.json';
const CASE_QUEUE_KEY = 'updates-nts-cases-queue-v1.json';
const CASE_PROGRESS_KEY = 'updates-cases-progress-v1.json';
export const GUIDE_CHECK_KEY = 'guide-links-check-v1.json';
const HOLIDAY_KEY = year => `holidays-kr-${year}-v1.json`;
const CASE_SOURCE = '국세법령정보시스템';
const CASE_LIMIT = 20;
const CASE_QUEUE_LIMIT = 15000;
const CASE_BODY_LIMIT = 16000;
const LIMIT = 5 * 1024 * 1024;
// Statute detail responses embed 별표 (tables/forms); enforcement rules reach ~12MB.
const LAW_DETAIL_LIMIT = 24 * 1024 * 1024;
const PROVIDER = '법제처 국가법령정보 공동활용';
// Each track is one official list query. Bodies come only from the official
// JSON detail service; 국세법령정보시스템 bodies are HTML-only and the API
// returns a wrapper that leads to the NTS site, so those stay link records.
export const CASE_TRACKS = Object.freeze({
  nts: { label: '국세법령정보시스템 판례', datSrcNm: CASE_SOURCE, display: 100, detail: 'none' },
  court: { label: '대법원 출처 세법·지방세 판례', datSrcNm: '대법원', display: 50, detail: 'classified' },
  subcontract: { label: '하도급 관련 판례', datSrcNm: '대법원', display: 50, detail: 'all', search: '2', query: '하도급', domain: 'subcontract' },
  tribunal: { label: '조세심판원 결정례', target: 'ttSpecialDecc', listRoot: 'Decc', listRows: 'decc', detailRoot: 'SpecialDeccService', idField: '특별행정심판재결례일련번호', dateField: '의결일자', dateParam: 'rslYd', display: 50, domain: 'tax', sourceId: 'tax-tribunal' },
  ftc: { label: '공정위 하도급 의결서', target: 'ftc', listRoot: 'Ftc', listRows: 'ftc', detailRoot: 'FtcService', idField: '결정문일련번호', dateField: '결정일자', query: '하도급', display: 50, domain: 'subcontract', sourceId: 'ftc' },
  'nts-interp': { label: '국세청 해석례', target: 'ntsCgmExpc', listRoot: 'CgmExpc', listRows: 'cgmExpc', idField: '법령해석일련번호', dateField: '해석일자', dateParam: 'explYd', display: 100, domain: 'tax', sourceId: 'nts-taxlaw' },
});
const LOCAL_TAX_TERMS = /지방세|취득세|재산세|등록면허세|지방소득세|주민세|자동차세|지방교육세|담배소비세|레저세|지역자원시설세/;
const NATIONAL_TAX_TERMS = /법인세|부가가치세|소득세|증여세|상속세|원천징수|종합부동산세|개별소비세|교통[ㆍ·.\s]*에너지[ㆍ·.\s]*환경세|교육세|농어촌특별세|증권거래세|인지세|주세|관세|가산세|국세|조세|세무|경정청구|경정거부|과세처분|세액/;
const encoder = new TextEncoder();
const timestamp = () => new Date().toISOString();
const kstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const fail = (status, message) => Object.assign(new Error(message), { status });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const compact = value => String(value || '').replace(/\s/g, '');
const scalar = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const field = (object, names) => names.map(name => scalar(object?.[name])).find(Boolean) || '';
const listOf = value => Array.isArray(value) ? value : value ? [value] : [];
const legalDate = value => {
  if (!/^\d{8}$/.test(String(value))) return false;
  const iso = `${String(value).slice(0, 4)}-${String(value).slice(4, 6)}-${String(value).slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(+date) && date.toISOString().slice(0, 10) === iso;
};
const isoDate = digits => `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
const validIso = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && legalDate(String(value).replaceAll('-', ''));

async function read(bucket, key) {
  if (!bucket) return null;
  const item = await bucket.get(key);
  return item ? item.json() : null;
}
async function write(bucket, key, body) {
  await bucket.put(key, JSON.stringify(body), { httpMetadata: { contentType: 'application/json' } });
}
async function mutateQueue(bucket, key, limit, operation, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = await bucket.get(key), queue = stored ? await stored.json() : [];
    const next = operation(queue);
    if (next.length > limit) throw fail(409, message);
    const result = await bucket.put(key, JSON.stringify(next), { httpMetadata: { contentType: 'application/json' }, onlyIf: stored?.etag ? { etagMatches: stored.etag } : { etagDoesNotMatch: '*' } });
    if (result !== null) return next;
  }
  throw fail(409, '다른 수집·검토 요청이 먼저 저장되었습니다. 다시 시도하세요.');
}
const mutateCaseQueue = (bucket, operation) => mutateQueue(bucket, CASE_QUEUE_KEY, CASE_QUEUE_LIMIT, operation, `검토 대기 ${CASE_QUEUE_LIMIT.toLocaleString('ko-KR')}건 한도입니다. 기존 자료를 먼저 검토하세요.`);
const mutateLawQueue = (bucket, operation) => mutateQueue(bucket, LAW_QUEUE_KEY, 200, operation, '법령 검토 대기 200건 한도입니다. 기존 수집본을 먼저 검토하세요.');
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
async function boundedJson(request, maxBytes, message) {
  const text = await request.text();
  if (text.length > maxBytes) throw fail(413, message);
  try { const body = JSON.parse(text); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw fail(400, 'JSON 요청 형식을 확인하세요.'); }
}
const smallJson = request => boundedJson(request, 4096, '연결 설정 요청이 너무 큽니다.');

// Upstream text, URLs and exception messages may contain the OC; never echo them.
async function fetchText(url, env, accept, label, limit = LIMIT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const upstream = await (env.LAW_API_FETCH || fetch)(url, { signal: controller.signal, headers: { Accept: accept }, redirect: 'manual' });
    if (upstream.status >= 300 && upstream.status < 400) throw fail(502, `${label}가 다른 주소로 이동을 요청했습니다 (HTTP ${upstream.status}). OC 승인 범위와 신청 시 등록한 도메인·IP를 확인하세요.`);
    if (!upstream.ok) throw fail(502, `${label} 응답 오류 (HTTP ${upstream.status})`);
    if (Number(upstream.headers.get('content-length')) > limit) throw fail(502, `${label} 응답이 허용 크기를 초과했습니다.`);
    const reader = upstream.body?.getReader(); if (!reader) throw fail(502, `${label} 본문이 없습니다.`);
    const decoder = new TextDecoder(); let size = 0, text = '';
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); throw fail(502, `${label} 응답이 허용 크기를 초과했습니다.`); } text += decoder.decode(part.value, { stream: true }); }
    return text + decoder.decode();
  } catch (cause) {
    if (cause.status) throw cause;
    if (cause?.name === 'AbortError') throw fail(502, `${label} 응답 시간 초과 (20초)`);
    throw fail(502, `${label} 연결 실패 · 서버에서 law.go.kr에 접속하지 못했습니다. 네트워크 차단 여부를 확인하세요.`);
  } finally { clearTimeout(timer); }
}
async function fetchJson(url, env, limit = LIMIT) {
  const text = await fetchText(url, env, 'application/json', '공식 API', limit);
  let payload;
  try { payload = JSON.parse(text); } catch {
    // law.go.kr answers unapproved OCs and unregistered servers with an HTML page.
    throw fail(502, /<html|<!doctype/i.test(text) ? '공식 API가 JSON 대신 안내 화면을 반환했습니다. OC 승인 여부와 신청 시 등록한 도메인·IP를 확인하세요.' : '공식 API JSON 형식을 확인할 수 없습니다. 승인·응답 형식을 확인하세요.');
  }
  // Rejections arrive as {"result": ..., "msg": ...}; e.g. a server whose IP is
  // not registered for the OC. Show the official wording, never the OC itself.
  if (payload && typeof payload.result === 'string' && typeof payload.msg === 'string' && !payload.PrecSearch && !payload.LawSearch && !payload.법령 && !payload.PrecService) {
    const clean = value => value.replace(/OC=[^&\s"]*/gi, 'OC=…').slice(0, 200);
    throw fail(502, `법제처 응답: ${clean(payload.result)} ${clean(payload.msg)}${/IP|도메인|사용자 정보/.test(payload.result + payload.msg) ? ' · 이 서버의 IP가 OC에 등록되지 않았습니다. 내 PC에서 수집한 파일을 올리세요.' : ''}`);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Public holidays: 한국천문연구원 특일 정보 (공공데이터포털). Without a key the
// weekday schedule runs as before and the status says so.
async function holidayCalendar(env, year) {
  if (!env.HOLIDAY_API_KEY) return null;
  const cached = await read(env.BUCKET, HOLIDAY_KEY(year));
  if (cached?.dates && Date.now() - Date.parse(cached.fetchedAt) < 7 * 86400000) return cached;
  const dates = {};
  for (let month = 1; month <= 12; month++) {
    const url = new URL('https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo');
    url.search = new URLSearchParams({ serviceKey: env.HOLIDAY_API_KEY, solYear: String(year), solMonth: String(month).padStart(2, '0'), numOfRows: '50', _type: 'json' });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    let payload;
    try {
      const upstream = await (env.HOLIDAY_API_FETCH || fetch)(url, { signal: controller.signal, headers: { Accept: 'application/json' }, redirect: 'manual' });
      if (!upstream.ok) throw new Error();
      payload = JSON.parse(await upstream.text());
    } catch { throw fail(502, '특일 정보 API 연결 또는 인증 실패'); }
    finally { clearTimeout(timer); }
    const root = payload?.response;
    if (root?.header?.resultCode !== '00') throw fail(502, '특일 정보 API 인증 또는 응답 형식을 확인하세요.');
    for (const item of listOf(root.body?.items?.item)) {
      const day = String(item.locdate || '');
      if (item.isHoliday === 'Y' && legalDate(day)) dates[isoDate(day)] = String(item.dateName || '공휴일').slice(0, 50);
    }
  }
  const calendar = { year, fetchedAt: timestamp(), source: '한국천문연구원 특일 정보(공공데이터포털)', dates };
  await write(env.BUCKET, HOLIDAY_KEY(year), calendar);
  return calendar;
}
export async function holidayCheck(env, day = kstToday()) {
  if (!env.HOLIDAY_API_KEY) return { configured: false, date: day, holiday: false };
  try {
    const calendar = await holidayCalendar(env, Number(day.slice(0, 4)));
    return { configured: true, date: day, holiday: Boolean(calendar.dates[day]), name: calendar.dates[day] || null, fetchedAt: calendar.fetchedAt };
  } catch (cause) { return { configured: true, date: day, holiday: false, error: cause.status ? cause.message : '특일 정보 확인 실패' }; }
}

// ---------------------------------------------------------------------------
// Court cases
function caseDate(value) {
  const digits = String(value || '').replace(/[.\-\s]/g, '');
  return legalDate(digits) ? isoDate(digits) : '';
}
// 국세법령정보시스템 rows leave 법원명 empty and encode the court in the docket,
// e.g. "대법원-2025-두-34754" or "부산고등법원(창원)-2024-나-13718".
export function parseDocket(raw, court = '') {
  const value = String(raw || '').trim();
  const match = value.match(/^(.+?)-(\d{4})-([가-힣]{1,8})-(\d{1,8})$/);
  if (match) return { agency: court.trim() || match[1].trim(), number: `${match[2]}${match[3]}${match[4]}` };
  return { agency: court.trim(), number: value.replace(/\s+/g, '') };
}
export function classifyCourtCase(title) {
  const value = String(title || '');
  if (LOCAL_TAX_TERMS.test(value)) return 'local-tax';
  if (NATIONAL_TAX_TERMS.test(value)) return 'tax';
  return null;
}
function caseListing(payload, display) {
  const root = payload?.PrecSearch || payload?.precSearch;
  if (!root || !/^\d+$/.test(String(root.totalCnt))) throw fail(502, '판례 목록 응답 형식 또는 API 승인 범위를 확인하세요.');
  const rows = listOf(root.prec);
  if (Number(root.totalCnt) > 0 && !rows.length && Number(root.page || 1) === 1) throw fail(502, '판례 검색 결과와 목록 구조가 일치하지 않습니다.');
  return { total: Number(root.totalCnt), rows: rows.slice(0, display) };
}
const cleanHtmlText = value => listOf(value).map(String).join('\n')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li|tr)>/gi, '\n').replace(/<[^>]*>/g, '')
  .replace(/&#x([\da-f]+);/gi, (_, n) => { const code = Number.parseInt(n, 16); return code <= 0x10ffff ? String.fromCodePoint(code) : ''; })
  .replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
// Only the official JSON detail is used. The docket must match the listing.
export function courtCaseBody(payload, docket) {
  const root = payload?.PrecService || payload?.precService;
  if (!root || compact(field(root, ['사건번호'])) !== compact(docket)) return null;
  const parts = [['판시사항', root.판시사항], ['판결요지', root.판결요지], ['참조조문', root.참조조문], ['참조판례', root.참조판례], ['전문', root.판례내용]]
    .map(([label, value]) => [label, cleanHtmlText(value)]).filter(([, value]) => value);
  if (!parts.some(([label]) => label === '전문' || label === '판결요지')) return null;
  const body = parts.map(([label, value]) => `【${label}】\n${value}`).join('\n\n');
  return body.length <= CASE_BODY_LIMIT ? { body, bodyStatus: 'full' } : { body: body.slice(0, CASE_BODY_LIMIT).replace(/\s+\S*$/, '') + '\n…(이하 생략 · 공식 원문에서 전체 확인)', bodyStatus: 'excerpt' };
}
const CASE_RIGHTS = {
  nts: `법제처 국가법령정보 공동활용 판례 목록 API 제공 메타데이터(사건명·사건번호·선고일·출처). 데이터출처명: ${CASE_SOURCE}. 본문은 공식 원문에서 확인하며 앱에 수록하지 않음. 이용 안내: https://open.law.go.kr/LSO/usrJoin.do`,
  court: '법제처 국가법령정보 공동활용 판례 API(데이터출처: 대법원)가 제공한 공개 판결문. 판결은 저작권법 제7조의 보호 대상이 아닌 저작물이나 법제처·법원 출처 표시를 유지함. 비실명 처리된 공개본만 수록하며 다운로드·재배포 권한을 확대 해석하지 않음.',
};
function caseDocument(row, track, startedAt, detail) {
  const id = field(row, ['판례일련번호']), title = field(row, ['사건명']).trim(), date = caseDate(field(row, ['선고일자']));
  const { agency, number } = parseDocket(field(row, ['사건번호']), field(row, ['법원명']));
  const kind = field(row, ['사건종류명']), fromNts = track === 'nts';
  const scope = track === 'subcontract' ? 'subcontract' : fromNts ? 'tax' : classifyCourtCase(title);
  const tags = [...new Set([fromNts ? '국세 판례' : '판례', scope === 'local-tax' ? '지방세' : scope === 'subcontract' ? '하도급' : '국세', kind].filter(Boolean))];
  return {
    id: `${fromNts ? 'nts-api-case' : 'court-api-case'}-${id}`, title, domain: scope === 'subcontract' ? 'subcontract' : 'tax', type: 'case', agency: agency || '법원명 미표기',
    sourceId: fromNts ? 'nts-cases-law-api' : 'court-cases-law-api', collection: 'case-api', caseTrack: track, caseKind: kind,
    sourceUrl: `https://www.law.go.kr/LSW/precInfoP.do?precSeq=${id}`, documentNumber: number, documentDate: date,
    body: detail?.body || '', bodyStatus: detail?.bodyStatus || 'link', tags,
    keywords: [fromNts ? CASE_SOURCE : '대법원 판례', '법제처', agency, number, field(row, ['사건번호'])].filter(Boolean),
    version: `${date} 선고 · 법제처 판례 ID ${id}`, verifiedAt: startedAt, collectedAt: startedAt, reviewStatus: 'draft', allowedDownload: false,
    rights: fromNts ? CASE_RIGHTS.nts : CASE_RIGHTS.court,
    notes: detail?.body ? '법제처 API(데이터출처: 대법원)가 제공한 판시사항·판결요지·전문입니다. 앱에서 요약하거나 결론을 덧붙이지 않았습니다. 동일 사건의 다른 심급·판단 변경 여부는 원문에서 확인하세요.'
      : '공식 API 목록의 사건명·사건번호·선고일·출처만 확보했습니다. 앱에 없는 본문을 요약하거나 AI 근거로 사용하지 않습니다.',
  };
}
// One page of one track. Row problems are reported and skipped; a response that
// does not match the requested source or list structure fails the page.
export async function collectCasePage(env, oc, { track = 'nts', page = 1, from = '', to = '', display, startedAt = timestamp(), today = kstToday() } = {}) {
  const spec = CASE_TRACKS[track]; if (!spec) throw fail(400, '지원하는 판례 수집 범위를 선택하세요.');
  const size = display || spec.display;
  if (spec.target) return collectDecisionPage(env, oc, track, spec, { page, from, to, size, startedAt, today });
  const search = new URL('https://www.law.go.kr/DRF/lawSearch.do');
  const params = { OC: oc, target: 'prec', type: 'JSON', datSrcNm: spec.datSrcNm, display: String(size), page: String(page), sort: 'ddes' };
  if (spec.query) Object.assign(params, { query: spec.query, search: spec.search || '1' });
  if (from && to) params.prncYd = `${from.replaceAll('-', '')}~${to.replaceAll('-', '')}`;
  search.search = new URLSearchParams(params);
  const listing = caseListing(await fetchJson(search, env), size), documents = [], warnings = [], seen = new Set();
  let skipped = 0;
  for (const row of listing.rows) {
    const id = field(row, ['판례일련번호']), docket = field(row, ['사건번호']), title = field(row, ['사건명']), date = caseDate(field(row, ['선고일자']));
    if (field(row, ['데이터출처명']) !== spec.datSrcNm) throw fail(502, `${spec.datSrcNm} 출처 검증에 실패했습니다. 다른 출처의 자료는 저장하지 않았습니다.`);
    if (!/^\d{1,20}$/.test(id) || !docket || !title.trim()) { skipped++; warnings.push({ id: id || null, message: '판례 ID·사건번호·사건명이 비어 있어 제외했습니다.' }); continue; }
    if (!date) { skipped++; warnings.push({ id, message: '선고일 형식이 올바르지 않아 제외했습니다.' }); continue; }
    if (date > today) { skipped++; warnings.push({ id, message: `선고일(${date})이 오늘 이후로 표기되어 제외했습니다. 공식 원문에서 확인하세요.` }); continue; }
    const { agency, number } = parseDocket(docket, field(row, ['법원명']));
    const identity = `${agency}|${number}|${date}`; if (seen.has(identity)) continue; seen.add(identity);
    if (spec.detail === 'classified' && !classifyCourtCase(title)) continue;
    let detail = null;
    if (spec.detail !== 'none') {
      const url = new URL('https://www.law.go.kr/DRF/lawService.do');
      url.search = new URLSearchParams({ OC: oc, target: 'prec', type: 'JSON', ID: id });
      try { detail = courtCaseBody(await fetchJson(url, env), docket); if (!detail) warnings.push({ id, message: '판결 본문의 사건번호·구조를 확인하지 못해 제목·링크만 보관했습니다.' }); }
      catch (cause) { warnings.push({ id, message: cause.status ? cause.message : '판례 본문 확인 실패' }); }
    }
    documents.push(caseDocument(row, track, startedAt, detail));
  }
  return { documents, warnings, skipped, total: listing.total, totalPages: Math.max(1, Math.ceil(listing.total / size)), rowsRead: listing.rows.length };
}
// ---------------------------------------------------------------------------
// Tribunal rulings, FTC decisions and NTS interpretations: other official
// targets of the same 법제처 service. Bodies are capped excerpts (요지·주문 first).
const DECISION_BODY_LIMIT = 4000;
const looseDate = value => {
  const text = String(value || '').trim(), match = text.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})/) || text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return '';
  const digits = `${match[1]}${match[2].padStart(2, '0')}${match[3].padStart(2, '0')}`;
  return legalDate(digits) ? isoDate(digits) : '';
};
const DECISION_RIGHTS = {
  tribunal: '법제처 국가법령정보 공동활용 특별행정심판재결례 API(재결청: 조세심판원) 제공. 행정심판 재결은 저작권법 제7조의 보호 대상이 아닌 저작물이나 출처 표시를 유지함. 재결요지·주문·관련법령과 이유 앞부분만 수록.',
  ftc: '법제처 국가법령정보 공동활용 공정거래위원회 결정문 API 제공. 심판·의결은 저작권법 제7조의 보호 대상이 아닌 저작물이나 출처 표시를 유지함. 결정요지·주문과 이유 앞부분만 수록.',
  'nts-interp': '법제처 국가법령정보 공동활용 국세청 법령해석 목록 API 제공 메타데이터(안건명·안건번호·해석일·링크). 본문은 국세법령정보시스템 원문에서 확인하며 앱에 수록하지 않음.',
};
export const DECISION_URL = {
  tribunal: id => `https://www.law.go.kr/LSW/specialDeccInfoP.do?specialDeccSeq=${id}&mode=3&trbClsCd=360101`,
  ftc: id => `https://www.law.go.kr/LSW/ftcInfoP.do?ftcSeq=${id}&mode=6`,
};
const officialNtsLink = value => { try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'taxlaw.nts.go.kr' && !url.username && !url.password ? url.href : ''; } catch { return ''; } };
function sectionBody(parts) {
  const cleaned = parts.map(([label, value]) => [label, cleanHtmlText(value)]).filter(([, value]) => value);
  if (!cleaned.length) return null;
  const body = cleaned.map(([label, value]) => `【${label}】\n${value}`).join('\n\n');
  return body.length <= DECISION_BODY_LIMIT ? { body, bodyStatus: 'full' } : { body: body.slice(0, DECISION_BODY_LIMIT).replace(/\s+\S*$/, '') + '\n…(이하 생략 · 공식 원문에서 전체 확인)', bodyStatus: 'excerpt' };
}
async function decisionDetail(env, oc, spec, id) {
  const url = new URL('https://www.law.go.kr/DRF/lawService.do');
  url.search = new URLSearchParams({ OC: oc, target: spec.target, type: 'JSON', ID: id });
  return (await fetchJson(url, env))?.[spec.detailRoot] || null;
}
async function collectDecisionPage(env, oc, track, spec, { page, from, to, size, startedAt, today }) {
  const search = new URL('https://www.law.go.kr/DRF/lawSearch.do');
  const params = { OC: oc, target: spec.target, type: 'JSON', display: String(size), page: String(page), sort: 'ddes' };
  if (spec.query) Object.assign(params, { query: spec.query, search: spec.search || '1' });
  if (spec.dateParam && from && to) params[spec.dateParam] = `${from.replaceAll('-', '')}~${to.replaceAll('-', '')}`;
  search.search = new URLSearchParams(params);
  const root = (await fetchJson(search, env))?.[spec.listRoot];
  if (!root || !/^\d+$/.test(String(root.totalCnt))) throw fail(502, `${spec.label} 목록 응답 형식 또는 API 승인 범위를 확인하세요.`);
  const rows = listOf(root[spec.listRows]).slice(0, size), documents = [], warnings = [], seen = new Set();
  let skipped = 0, windowEnded = false;
  for (const row of rows) {
    const id = field(row, [spec.idField]), date = looseDate(field(row, [spec.dateField]));
    if (!/^\d{1,20}$/.test(id)) { skipped++; warnings.push({ id: null, message: '일련번호가 없어 제외했습니다.' }); continue; }
    if (!date) { skipped++; warnings.push({ id, message: '문서일 형식이 올바르지 않아 제외했습니다.' }); continue; }
    if (date > today) { skipped++; warnings.push({ id, message: `문서일(${date})이 오늘 이후로 표기되어 제외했습니다.` }); continue; }
    // The FTC list has no date filter; it is newest first, so stop at the window start.
    if (!spec.dateParam && from && date < from) { windowEnded = true; break; }
    if (!spec.dateParam && to && date > to) continue;
    if (seen.has(id)) continue; seen.add(id);
    let doc;
    if (track === 'nts-interp') {
      if (field(row, ['해석기관명']) !== '국세청') throw fail(502, '국세청 해석례 출처 검증에 실패했습니다.');
      const title = field(row, ['안건명']).trim(), number = field(row, ['안건번호']).trim(), link = officialNtsLink(field(row, ['법령해석상세링크']));
      if (!title || !number || !link) { skipped++; warnings.push({ id, message: '안건명·안건번호·공식 링크가 없어 제외했습니다.' }); continue; }
      doc = { id: `nts-interp-${id}`, title, type: 'interpretation', agency: '국세청', documentNumber: number, sourceUrl: link, body: '', bodyStatus: 'link', tags: ['국세청 해석례', '국세'], keywords: ['국세청', '해석례', number] };
    } else {
      let detail = null;
      try { detail = await decisionDetail(env, oc, spec, id); } catch (cause) { warnings.push({ id, message: cause.status ? cause.message : '본문 확인 실패' }); }
      if (track === 'tribunal') {
        if (field(row, ['재결청']) !== '조세심판원') throw fail(502, '조세심판원 출처 검증에 실패했습니다.');
        const number = field(row, ['청구번호']).trim() || field(detail, ['청구번호']).trim();
        if (!number) { skipped++; warnings.push({ id, message: '청구번호가 없어 제외했습니다.' }); continue; }
        const body = detail && compact(field(detail, ['특별행정심판재결례일련번호'])) === id ? sectionBody([['재결요지', detail.재결요지], ['주문', detail.주문], ['관련법령', detail.관련법령], ['이유', detail.이유]]) : null;
        if (!body) warnings.push({ id, message: '재결 본문을 확인하지 못해 제목·링크만 보관했습니다.' });
        const tax = field(detail, ['세목']).trim();
        const title = field(detail, ['사건명']).trim() || field(row, ['사건명']).trim() || `조세심판원 ${number} 결정${tax ? ` (${tax})` : ''}`;
        doc = { id: `tt-api-${id}`, title, type: 'decision', agency: '조세심판원', documentNumber: number, sourceUrl: DECISION_URL.tribunal(id), body: body?.body || '', bodyStatus: body?.bodyStatus || 'link', tags: ['조세심판원 결정', ...(tax ? [tax] : [])], keywords: ['조세심판원', '심판결정', number, compact(number)] };
      } else {
        const number = field(row, ['사건번호']).trim(), title = field(row, ['사건명']).trim();
        if (!number || !title) { skipped++; warnings.push({ id, message: '사건번호·사건명이 없어 제외했습니다.' }); continue; }
        const body = detail && compact(field(detail, ['결정문일련번호'])) === id ? sectionBody([['결정요지', detail.결정요지], ['주문', detail.주문], ['이유', detail.이유]]) : null;
        if (!body) warnings.push({ id, message: '결정문 본문을 확인하지 못해 제목·링크만 보관했습니다.' });
        doc = { id: `ftc-api-${id}`, title, type: 'decision', agency: '공정거래위원회', documentNumber: number, sourceUrl: DECISION_URL.ftc(id), body: body?.body || '', bodyStatus: body?.bodyStatus || 'link', tags: ['공정위 의결', '하도급', field(row, ['문서유형'])].filter(Boolean), keywords: ['공정거래위원회', number, field(row, ['결정번호']).replace(/\s+/g, '')].filter(Boolean) };
      }
    }
    documents.push({ ...doc, domain: spec.domain, sourceId: spec.sourceId, collection: 'case-api', caseTrack: track, documentDate: date, version: `${date} · 법제처 ${spec.label} ID ${id}`, verifiedAt: startedAt, collectedAt: startedAt, reviewStatus: 'draft', allowedDownload: false, rights: DECISION_RIGHTS[track], notes: doc.body ? `법제처 API가 제공한 ${spec.label} 본문 중 요지·주문 등 앞부분입니다. 앱에서 요약하거나 결론을 덧붙이지 않았습니다. 전체 내용은 공식 원문에서 확인하세요.` : '공식 API 목록의 제목·번호·날짜·출처만 확보했습니다. 앱에 없는 본문을 요약하거나 AI 근거로 사용하지 않습니다.' });
  }
  return { documents, warnings, skipped, total: Number(root.totalCnt), totalPages: Math.max(1, Math.ceil(Number(root.totalCnt) / size)), rowsRead: rows.length, windowEnded };
}
const rightsFor = doc => doc.caseTrack === 'nts' ? CASE_RIGHTS.nts : ['court', 'subcontract'].includes(doc.caseTrack) ? CASE_RIGHTS.court : DECISION_RIGHTS[doc.caseTrack];
const STAGE_PREFIX = { nts: 'nts-api-case', court: 'court-api-case', subcontract: 'court-api-case', tribunal: 'tt-api', ftc: 'ftc-api', 'nts-interp': 'nts-interp' };
const STAGE_TYPE = { tribunal: 'decision', ftc: 'decision', 'nts-interp': 'interpretation' };
// Guide links have no API and no reuse permission; their availability is checked.
export async function checkGuideLinks(env, documents) {
  const failed = [];
  for (const doc of documents) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try { const res = await (env.GUIDE_FETCH || fetch)(doc.sourceUrl, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'LegalReference/1.0 (official link availability check; no crawling)' } }); if (!res.ok) failed.push({ id: doc.id, title: doc.title, status: res.status }); await res.body?.cancel?.(); }
    catch { failed.push({ id: doc.id, title: doc.title, status: 'connection' }); }
    finally { clearTimeout(timer); }
  }
  const result = { checkedAt: timestamp(), total: documents.length, ok: documents.length - failed.length, failed };
  if (env.BUCKET) await write(env.BUCKET, GUIDE_CHECK_KEY, result);
  return result;
}
function caseWindow(body) {
  const to = body.to ?? kstToday();
  let from = body.from;
  if (from === undefined) { const end = new Date(`${to}T00:00:00Z`); end.setUTCFullYear(end.getUTCFullYear() - 2); end.setUTCDate(end.getUTCDate() + 1); from = end.toISOString().slice(0, 10); }
  if (!validIso(from) || !validIso(to) || from > to || to > kstToday()) throw fail(400, '판례 선고일 범위(YYYY-MM-DD)를 확인하세요. 종료일은 오늘 이후일 수 없습니다.');
  if (Date.parse(to) - Date.parse(from) > 5 * 366 * 86400000) throw fail(400, '판례 선고일 범위는 5년 이내로 지정하세요.');
  return { from, to };
}
async function stageCaseDocuments(env, documents, key, retrievedAt, helpers) {
  const known = helpers.publishedCaseIndex ? await helpers.publishedCaseIndex() : null;
  const fresh = documents.filter(doc => {
    const existing = known?.get(`${doc.agency}|${doc.documentNumber}|${doc.documentDate}`) || known?.get(doc.id);
    // Re-stage a published link record only when the new version carries a body.
    return !existing || (!existing.hasBody && Boolean(doc.body));
  });
  if (fresh.length) await write(env.BUCKET, key, { documents: fresh, retrievedAt });
  const entries = fresh.map((doc, index) => ({ id: doc.id, key, index, track: doc.caseTrack || 'nts' }));
  const queue = await mutateCaseQueue(env.BUCKET, current => { const ids = new Set(current.map(item => item.id)); return [...current, ...entries.filter(entry => !ids.has(entry.id))]; });
  return { staged: fresh.length, skippedExisting: documents.length - fresh.length, reviewPending: queue.length };
}
async function readQueuedDocument(env, entry, cache) {
  if (!cache.has(entry.key)) cache.set(entry.key, await read(env.BUCKET, entry.key));
  const stored = cache.get(entry.key);
  return Number.isInteger(entry.index) ? stored?.documents?.[entry.index] : stored?.document;
}
// Uploaded files (from scripts/collect-cases.mjs) are checked against the same
// shape the collector produces; anything else is rejected, not repaired.
function validStagedCase(doc) {
  if (!doc || typeof doc !== 'object' || doc.collection !== 'case-api' || doc.reviewStatus !== 'draft') return false;
  const track = doc.caseTrack, spec = CASE_TRACKS[track];
  const id = String(doc.id || '').match(/^(.+)-(\d{1,20})$/);
  if (!spec || !id || id[1] !== STAGE_PREFIX[track] || doc.type !== (STAGE_TYPE[track] || 'case')) return false;
  const expectedUrl = !spec.target ? `https://www.law.go.kr/LSW/precInfoP.do?precSeq=${id[2]}` : DECISION_URL[track] ? DECISION_URL[track](id[2]) : officialNtsLink(doc.sourceUrl);
  if (!expectedUrl || doc.sourceUrl !== expectedUrl) return false;
  if (!['tax', 'subcontract'].includes(doc.domain)) return false;
  if (typeof doc.title !== 'string' || !doc.title.trim() || doc.title.length > 500 || typeof doc.agency !== 'string' || !doc.agency.trim() || typeof doc.documentNumber !== 'string' || !doc.documentNumber) return false;
  if (!validIso(doc.documentDate) || doc.documentDate > kstToday()) return false;
  if (['nts', 'nts-interp'].includes(track) ? (doc.body || doc.bodyStatus !== 'link') : !['full', 'excerpt', 'link'].includes(doc.bodyStatus)) return false;
  if (typeof (doc.body || '') !== 'string' || (doc.body || '').length > CASE_BODY_LIMIT + 100) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Statutes
function validateSearch(payload, name) {
  const root = payload?.LawSearch || payload?.lawSearch;
  const rows = listOf(root?.law);
  const matches = rows.filter(row => compact(field(row, ['법령명한글', '법령명_한글', '법령명'])) === compact(name));
  const row = matches.find(item => /^\d+$/.test(field(item, ['법령일련번호'])) && legalDate(field(item, ['시행일자'])) && legalDate(field(item, ['공포일자'])));
  if (!row) throw fail(502, '법령 목록의 이름·버전·일자 검증에 실패했습니다. 공개 자료는 변경하지 않았습니다.');
  return { mst: field(row, ['법령일련번호']), lawId: field(row, ['법령ID']), effectiveDate: field(row, ['시행일자']), promulgatedDate: field(row, ['공포일자']), promulgationNumber: field(row, ['공포번호']) };
}
function validateDetail(payload, name, listing) {
  const root = payload?.법령;
  const basic = root?.기본정보 || root?.법령기본정보;
  const units = listOf(root?.조문?.조문단위);
  if (!root || !basic || compact(field(basic, ['법령명_한글', '법령명한글', '법령명'])) !== compact(name) || field(basic, ['시행일자']) !== listing.effectiveDate || field(basic, ['공포일자']) !== listing.promulgatedDate || !units.some(unit => unit && typeof unit === 'object' && (unit.조문내용 || unit.조문제목))) throw fail(502, '법령 본문의 이름·시행일·공포일·조문 검증에 실패했습니다. 검토 전에는 공개하지 않습니다.');
  if (!units.length || !units.some(unit => Boolean(field(unit, ['조문내용']) || unit.항))) throw fail(502, '확보한 조문 본문이 없습니다. 목록만으로 수집 성공을 표시하지 않습니다.');
  const detailMst = field(root, ['법령일련번호']) || field(basic, ['법령일련번호']);
  if (detailMst && detailMst !== listing.mst) throw fail(502, '법령 본문과 목록의 버전이 일치하지 않습니다.');
  return payload;
}
const textLines = value => value == null ? [] : Array.isArray(value) ? value.flatMap(textLines) : typeof value === 'object' ? [] : String(value).split(/\r?\n/);
const trimmed = value => textLines(value).map(line => line.trim()).filter(Boolean);
// Mirrors the seeded statute bodies: indented chapter headings, one blank line
// between articles, paragraphs/items on their own lines, then 부칙 blocks.
export function lawBody(payload) {
  const root = payload?.법령, out = [];
  for (const unit of listOf(root?.조문?.조문단위)) {
    if (!unit || typeof unit !== 'object') continue;
    if (unit.조문여부 === '전문') { const heading = textLines(unit.조문내용).map(line => line.trimEnd()).filter(line => line.trim()); if (heading.length) out.push('', ...heading); continue; }
    out.push('', ...trimmed(unit.조문내용));
    for (const paragraph of listOf(unit.항)) {
      out.push(...trimmed(paragraph?.항내용));
      for (const item of listOf(paragraph?.호)) {
        out.push(...trimmed(item?.호내용));
        for (const sub of listOf(item?.목)) out.push(...trimmed(sub?.목내용));
      }
    }
  }
  for (const block of listOf(root?.부칙?.부칙단위)) { const lines = trimmed(block?.부칙내용); if (lines.length) out.push('', ...lines); }
  return out.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}
export function lawDocument(staged) {
  const basic = staged.payload?.법령?.기본정보 || staged.payload?.법령?.법령기본정보 || {};
  const name = staged.lawName, number = field(basic, ['공포번호']) || staged.promulgationNumber || '';
  const effective = isoDate(staged.effectiveDate), promulgated = isoDate(staged.promulgatedDate), local = isLocalTax(name);
  const type = /시행규칙$/.test(name) ? 'rule' : /시행령$/.test(name) ? 'decree' : 'law';
  const body = lawBody(staged.payload);
  if (!body || !/제\s*1\s*조/.test(body)) throw fail(502, '수집본에서 조문 본문을 만들지 못했습니다. 공개하지 않았습니다.');
  const lawId = field(basic, ['법령ID']) || staged.lawId || staged.mst;
  return {
    id: `api-law-${lawId}-${staged.promulgatedDate}-${staged.effectiveDate}`, title: `${name} — 조문·부칙`, domain: /하도급/.test(name) ? 'subcontract' : 'tax', type,
    agency: '법제처 국가법령정보센터', sourceUrl: number ? `https://www.law.go.kr/법령/${name}/(${staged.effectiveDate},${number},${staged.promulgatedDate})` : `https://www.law.go.kr/법령/${name}`,
    documentNumber: number, article: '', body, bodyStatus: 'full', promulgatedAt: promulgated, effectiveFrom: effective, effectiveTo: null, documentDate: null,
    collectedAt: staged.retrievedAt, verifiedAt: staged.retrievedAt, lastChecked: staged.retrievedAt,
    tags: [name, 'API 원문', '조문', '부칙', ...(local ? ['지방세'] : [])], lawKey: name, lawName: name,
    rights: '국가법령정보센터 OPEN API에서 수집한 법령 조문·부칙. 법령 원문 출처 표시. 별표·서식 파일은 공식 원문 참조.',
    version: `시행 ${effective} / 공포 ${number || '번호 미확인'}`, transitional: '부칙 포함. 조문별 시행일 및 개별 거래 적용례는 공식 원문과 함께 확인하세요.',
    allowedDownload: true, notes: 'API 원문 수집 후 관리자가 법령명·시행일·조문 구조를 검토하여 공개. 별표·서식 파일은 미포함.',
  };
}
// `force` re-stages versions already published so their text can be compared
// with the current official response and replaced after review.
export async function fetchLawListing(env, oc, name) {
  const search = new URL('https://www.law.go.kr/DRF/lawSearch.do');
  search.search = new URLSearchParams({ OC: oc, target: 'eflaw', type: 'JSON', nw: '3', search: '1', display: '100', query: name });
  return validateSearch(await fetchJson(search, env), name);
}
// Keep only what the body is built from; 별표 stay on the official site.
export async function fetchLawPayload(env, oc, name, listing) {
  const detail = new URL('https://www.law.go.kr/DRF/lawService.do');
  detail.search = new URLSearchParams({ OC: oc, target: 'eflaw', type: 'JSON', MST: listing.mst, efYd: listing.effectiveDate });
  const full = validateDetail(await fetchJson(detail, env, LAW_DETAIL_LIMIT), name, listing);
  return { 법령: { 기본정보: full.법령.기본정보 || full.법령.법령기본정보, 조문: full.법령.조문, 부칙: full.법령.부칙 } };
}
async function stageLaws(env, entries, startedAt) {
  const staged = [];
  for (const { lawName, listing, payload, retrievedAt } of entries) {
    const key = `updates/laws/${startedAt.replace(/[:.]/g, '-')}/${listing.mst}-${listing.effectiveDate}.json`;
    await write(env.BUCKET, key, { reviewStatus: 'draft', validation: 'metadata-and-article-structure', retrievedAt: retrievedAt || timestamp(), lawName, ...listing, sourceUrl: `https://www.law.go.kr/법령/${encodeURIComponent(lawName)}`, payload });
    staged.push({ lawName, mst: listing.mst, effectiveDate: listing.effectiveDate, promulgatedDate: listing.promulgatedDate, key });
  }
  if (staged.length) await mutateLawQueue(env.BUCKET, current => [...current.filter(item => !staged.some(entry => entry.lawName === item.lawName && entry.effectiveDate === item.effectiveDate && entry.promulgatedDate === item.promulgatedDate)), ...staged]);
  return staged;
}
// `force` re-stages versions already published so their text can be compared
// with the current official response and replaced after review.
async function collectLaws(env, oc, startedAt, helpers, { names = LAW_UPDATE_SCOPE, force = false } = {}) {
  const fetched = [], unchanged = [], errors = [];
  const published = helpers.publishedLawVersions ? await helpers.publishedLawVersions() : new Set();
  for (const name of names) {
    try {
      const listing = await fetchLawListing(env, oc, name);
      if (!force && published.has(`${name}|${isoDate(listing.effectiveDate)}|${isoDate(listing.promulgatedDate)}`)) { unchanged.push({ lawName: name, effectiveDate: listing.effectiveDate }); continue; }
      fetched.push({ lawName: name, listing, payload: await fetchLawPayload(env, oc, name, listing) });
    } catch (cause) { errors.push({ lawName: name, message: cause.status ? cause.message : '자료 수집·저장에 실패했습니다.' }); }
  }
  return { staged: await stageLaws(env, fetched, startedAt), unchanged, errors };
}

// ---------------------------------------------------------------------------
async function runCaseCollection(env, oc, body, startedAt, helpers, prior, { recordProgress = true } = {}) {
  const legacy = body.dataset === 'nts-cases';
  const track = legacy ? 'nts' : body.track;
  if (!CASE_TRACKS[track]) throw fail(400, '지원하는 판례 수집 범위를 선택하세요.');
  const window = legacy ? { from: '', to: '' } : caseWindow(body);
  const result = await collectCasePage(env, oc, { track, page: body.page ?? 1, ...window, display: legacy ? CASE_LIMIT : undefined, startedAt });
  const key = `updates/cases/pages/${track}/${window.from || 'all'}_${window.to || 'all'}/p${body.page ?? 1}-${startedAt.replace(/[:.]/g, '-')}.json`;
  const stage = await stageCaseDocuments(env, result.documents, key, startedAt, helpers);
  const page = body.page ?? 1, done = page >= result.totalPages || result.rowsRead === 0 || Boolean(result.windowEnded);
  const lastRun = { state: 'review-pending', startedAt, checkedAt: timestamp(), track, trackLabel: CASE_TRACKS[track].label, window, page, totalPages: result.totalPages, totalAvailable: result.total, fetched: result.documents.length, staged: stage.staged, skippedExisting: stage.skippedExisting, skippedRows: result.skipped, reviewPending: stage.reviewPending, published: 0, excerpts: result.documents.filter(d => d.body).length, links: result.documents.filter(d => !d.body).length, warnings: result.warnings.slice(0, 30), warningCount: result.warnings.length, done, message: '공식 API 판례를 검토 대기로 저장했습니다. 판례 검토 목록에서 확인 후 공개하세요.' };
  await write(env.BUCKET, CASE_STATE_KEY, lastRun);
  if (!legacy && recordProgress) {
    const progress = await read(env.BUCKET, CASE_PROGRESS_KEY) || {};
    const sameWindow = progress.window?.from === window.from && progress.window?.to === window.to;
    const tracks = sameWindow ? { ...progress.tracks } : {};
    tracks[track] = { page, totalPages: result.totalPages, totalAvailable: result.total, done, checkedAt: lastRun.checkedAt };
    await write(env.BUCKET, CASE_PROGRESS_KEY, { window, tracks, updatedAt: lastRun.checkedAt, previousReviewPending: prior?.reviewPending || 0 });
  }
  return { ok: true, ...lastRun, ...(legacy ? { documents: result.documents } : {}) };
}

export async function handleLawUpdate(request, env, ctx, helpers = {}) {
  const path = new URL(request.url).pathname;
  const routes = ['/api/updates/status', '/api/admin/law-connection', '/api/updates/laws/run', '/api/admin/updates/run', '/api/admin/cases/pending', '/api/admin/cases/import', '/api/admin/cases/import-batch', '/api/admin/cases/discard', '/api/admin/cases/stage', '/api/admin/laws/pending', '/api/admin/laws/publish', '/api/admin/laws/stage', '/api/admin/holidays'];
  if (!routes.includes(path)) return null;
  try {
    if (path.startsWith('/api/admin/cases/')) {
      await requireAdmin(request, helpers); requireStorage(env);
      const queue = await read(env.BUCKET, CASE_QUEUE_KEY) || [];
      if (request.method === 'GET' && path.endsWith('/pending')) {
        const params = new URL(request.url).searchParams;
        const track = params.get('track') || '', limit = Math.min(100, Math.max(1, Number.parseInt(params.get('limit') || String(CASE_LIMIT), 10) || CASE_LIMIT)), offset = Math.max(0, Number.parseInt(params.get('offset') || '0', 10) || 0);
        const matching = (track ? queue.filter(entry => (entry.track || 'nts') === track) : queue).slice().reverse();
        const documents = [], cache = new Map();
        for (const entry of matching.slice(offset, offset + limit)) { const doc = await readQueuedDocument(env, entry, cache); if (doc) documents.push(doc); }
        const byTrack = {}; for (const entry of queue) byTrack[entry.track || 'nts'] = (byTrack[entry.track || 'nts'] || 0) + 1;
        return response({ documents, total: queue.length, matching: matching.length, offset, limit, byTrack });
      }
      if (request.method === 'POST' && path.endsWith('/import')) {
        const body = await smallJson(request), entry = queue.find(item => item.id === body.id);
        if (!entry || body.reviewConfirmed !== true) throw fail(400, '검토 대기 자료와 원문·이용 조건 확인이 필요합니다.');
        const doc = await readQueuedDocument(env, entry, new Map());
        if (!doc || !helpers.importCases) throw fail(503, '검토 자료를 불러올 수 없습니다.');
        const [result] = (await helpers.importCases([doc])).results;
        await mutateCaseQueue(env.BUCKET, current => current.filter(item => item.id !== entry.id));
        return response(result);
      }
      if (request.method === 'POST' && path.endsWith('/import-batch')) {
        const body = await smallJson(request);
        if (body.reviewConfirmed !== true) throw fail(400, '검토 대기 자료의 원문·이용 조건 확인이 필요합니다.');
        const max = Math.min(300, Math.max(1, Number(body.max) || 200));
        const selected = (Array.isArray(body.ids) ? queue.filter(entry => body.ids.includes(entry.id)) : body.track ? queue.filter(entry => (entry.track || 'nts') === body.track) : body.all === true ? queue : []).slice(0, max);
        if (!selected.length) return response({ imported: 0, duplicates: 0, upgraded: 0, remaining: queue.length, message: '공개할 검토 대기 자료가 없습니다.' });
        const cache = new Map(), documents = [];
        for (const entry of selected) { const doc = await readQueuedDocument(env, entry, cache); if (doc) documents.push(doc); }
        if (!helpers.importCases) throw fail(503, '검토 자료를 불러올 수 없습니다.');
        const result = await helpers.importCases(documents);
        const done = new Set(selected.map(entry => entry.id));
        const next = await mutateCaseQueue(env.BUCKET, current => current.filter(item => !done.has(item.id)));
        return response({ ...result.summary, remaining: next.length, message: `${result.summary.imported}건 공개 · ${result.summary.upgraded}건 본문 보강 · 중복 ${result.summary.duplicates}건 제외` });
      }
      if (request.method === 'POST' && path.endsWith('/discard')) {
        const body = await smallJson(request);
        const ids = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null;
        if (!ids && !body.track && body.all !== true) throw fail(400, '삭제할 검토 대기 자료를 선택하세요.');
        const next = await mutateCaseQueue(env.BUCKET, current => current.filter(item => ids ? !ids.has(item.id) : body.all === true ? false : (item.track || 'nts') !== body.track));
        return response({ removed: queue.length - next.length, remaining: next.length, message: '선택한 검토 대기 자료를 공개하지 않고 목록에서 제외했습니다.' });
      }
      if (request.method === 'POST' && path.endsWith('/stage')) {
        const body = await boundedJson(request, 1900000, '한 번에 올릴 수 있는 수집 파일 조각은 1.9MB까지입니다.');
        if (body.format !== 'law-api-cases-v1' || !Array.isArray(body.documents) || body.documents.length > 1000) throw fail(400, 'scripts/collect-cases.mjs로 만든 수집 파일 형식이 아닙니다.');
        const rejected = body.documents.filter(doc => !validStagedCase(doc)).length;
        const documents = body.documents.filter(validStagedCase).map(doc => ({ ...doc, collectedAt: typeof doc.collectedAt === 'string' && !Number.isNaN(Date.parse(doc.collectedAt)) ? doc.collectedAt : timestamp(), verifiedAt: typeof doc.verifiedAt === 'string' && !Number.isNaN(Date.parse(doc.verifiedAt)) ? doc.verifiedAt : timestamp(), allowedDownload: false, rights: rightsFor(doc), reviewStatus: 'draft' }));
        const stage = documents.length ? await stageCaseDocuments(env, documents, `updates/cases/uploads/${crypto.randomUUID()}.json`, timestamp(), helpers) : { staged: 0, skippedExisting: 0, reviewPending: queue.length };
        return response({ ...stage, rejected, message: `${stage.staged}건을 검토 대기로 올렸습니다.${rejected ? ` 형식이 맞지 않는 ${rejected}건은 제외했습니다.` : ''}` });
      }
      return response({ error: '지원하지 않는 요청 방식입니다.' }, 405);
    }
    if (path.startsWith('/api/admin/laws/')) {
      await requireAdmin(request, helpers); requireStorage(env);
      const queue = await read(env.BUCKET, LAW_QUEUE_KEY) || [];
      if (request.method === 'GET' && path.endsWith('/pending')) return response({ laws: queue.map(({ key, ...entry }) => ({ ...entry, id: key })), total: queue.length });
      // One law per request from scripts/collect-laws.mjs. The payload is checked
      // exactly as a live collection is, so a file cannot stage anything else.
      if (request.method === 'POST' && path.endsWith('/stage')) {
        const body = await boundedJson(request, 24 * 1024 * 1024, '법령 수집 파일 한 건이 너무 큽니다.');
        const law = body.law;
        if (body.format !== 'law-api-laws-v1' || !law || typeof law !== 'object' || !LAW_UPDATE_SCOPE.includes(law.lawName)) throw fail(400, 'scripts/collect-laws.mjs로 만든 법령 수집 파일이 아닙니다.');
        const listing = { mst: String(law.mst || ''), lawId: String(law.lawId || ''), effectiveDate: String(law.effectiveDate || ''), promulgatedDate: String(law.promulgatedDate || ''), promulgationNumber: String(law.promulgationNumber || '') };
        if (!/^\d+$/.test(listing.mst) || !legalDate(listing.effectiveDate) || !legalDate(listing.promulgatedDate)) throw fail(400, '법령 일련번호·시행일·공포일을 확인하세요.');
        const payload = validateDetail(law.payload, law.lawName, listing);
        lawDocument({ lawName: law.lawName, ...listing, retrievedAt: timestamp(), payload });
        const retrievedAt = typeof law.retrievedAt === 'string' && !Number.isNaN(Date.parse(law.retrievedAt)) ? law.retrievedAt : timestamp();
        const [staged] = await stageLaws(env, [{ lawName: law.lawName, listing, payload: { 법령: { 기본정보: payload.법령.기본정보 || payload.법령.법령기본정보, 조문: payload.법령.조문, 부칙: payload.법령.부칙 } }, retrievedAt }], timestamp());
        return response({ staged: true, lawName: staged.lawName, effectiveDate: staged.effectiveDate, message: `${staged.lawName}(시행 ${isoDate(staged.effectiveDate)})을 검토 대기로 올렸습니다.` });
      }
      if (request.method === 'POST' && path.endsWith('/publish')) {
        const body = await smallJson(request), entry = queue.find(item => item.key === body.id);
        if (!entry || body.reviewConfirmed !== true) throw fail(400, '검토 대기 법령과 시행일·부칙 확인이 필요합니다.');
        const staged = await read(env.BUCKET, entry.key);
        if (!staged?.payload || !helpers.importLaw) throw fail(503, '수집본을 불러올 수 없습니다.');
        const result = await helpers.importLaw(lawDocument(staged));
        await mutateLawQueue(env.BUCKET, current => current.filter(item => item.key !== entry.key));
        return response(result);
      }
      return response({ error: '지원하지 않는 요청 방식입니다.' }, 405);
    }
    if (path === '/api/admin/holidays') {
      await requireAdmin(request, helpers); requireStorage(env);
      if (request.method !== 'GET') return response({ error: '지원하지 않는 요청 방식입니다.' }, 405);
      const check = await holidayCheck(env);
      const calendar = env.HOLIDAY_API_KEY && !check.error ? await read(env.BUCKET, HOLIDAY_KEY(Number(check.date.slice(0, 4)))) : null;
      return response({ ...check, holidays: calendar ? Object.entries(calendar.dates).map(([day, name]) => ({ date: day, name })) : [] });
    }
    if (request.method === 'GET' && path === '/api/updates/status') {
      const connection = await read(env.BUCKET, CONNECTION_KEY), lawQueue = await read(env.BUCKET, LAW_QUEUE_KEY) || [];
      const schedule = { weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], time: '09:00', timezone: 'Asia/Seoul', excludesPublicHolidays: Boolean(env.HOLIDAY_API_KEY), holidaySource: env.HOLIDAY_API_KEY ? '한국천문연구원 특일 정보(공공데이터포털)' : null, includesRecentCases: true };
      return response({ schedule, credentialConfigured: Boolean(env.LAW_API_OC || connection?.ciphertext), storageConfigured: Boolean(env.BUCKET), lastRun: await read(env.BUCKET, STATE_KEY), lawReviewPending: lawQueue.length, cases: { source: CASE_SOURCE, provider: PROVIDER, batchLimit: CASE_LIMIT, tracks: Object.fromEntries(Object.entries(CASE_TRACKS).map(([key, spec]) => [key, spec.label])), lastRun: await read(env.BUCKET, CASE_STATE_KEY), progress: await read(env.BUCKET, CASE_PROGRESS_KEY), automatic: Boolean(env.LAW_UPDATE_SIGNING_KEY) }, scope: LAW_UPDATE_SCOPE, guide: LAW_UPDATE_GUIDE, publicationMode: 'review-required', sourceState: env.LAW_API_OC || connection?.ciphertext ? 'configured-unverified' : 'unconnected' });
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
      const scheduled = Boolean(helpers.requireScheduler && await helpers.requireScheduler(request));
      if (!scheduled) await requireAdmin(request, helpers);
      requireStorage(env);
      const body = await smallJson(request);
      if (body.batch !== undefined && (!Number.isInteger(body.batch) || body.batch < 0 || body.batch * LAW_BATCH >= LAW_UPDATE_SCOPE.length)) throw fail(400, '법령 확인 묶음 번호를 확인하세요.');
      if (body.dataset && !['nts-cases', 'cases'].includes(body.dataset)) throw fail(400, '지원하는 수집 범위를 선택하세요.');
      const isCases = Boolean(body.dataset), stateKey = isCases ? CASE_STATE_KEY : STATE_KEY;
      const page = body.page ?? 1;
      if (isCases && (!Number.isInteger(page) || page < 1 || page > (body.dataset === 'cases' ? 1000 : 100))) throw fail(400, `판례 페이지는 1~${body.dataset === 'cases' ? 1000 : 100} 사이의 정수로 입력하세요.`);
      if (body.dataset === 'cases') { if (!CASE_TRACKS[body.track]) throw fail(400, '지원하는 판례 수집 범위를 선택하세요.'); caseWindow(body); }
      const startedAt = timestamp(), prior = await read(env.BUCKET, stateKey);
      if (scheduled && !isCases) {
        const holiday = await holidayCheck(env);
        if (holiday.holiday) {
          const lastRun = { state: 'skipped-holiday', startedAt, checkedAt: timestamp(), reason: `${holiday.date} ${holiday.name} · 공휴일이라 정기 갱신을 건너뛰었습니다.`, reviewPending: prior?.reviewPending || 0, holiday };
          await write(env.BUCKET, STATE_KEY, lastRun); return response({ ok: true, ...lastRun });
        }
      }
      let oc;
      try { oc = await loadOC(env, await read(env.BUCKET, CONNECTION_KEY)); }
      catch (cause) { const lastRun = { state: 'failed', startedAt, checkedAt: timestamp(), reason: cause.message, previousReviewPending: prior?.reviewPending || 0 }; await write(env.BUCKET, stateKey, lastRun); return response({ ok: false, ...lastRun }); }
      if (!oc) {
        const lastRun = { state: 'blocked', reason: '국가법령정보 공동활용 승인 OC 미등록', startedAt, checkedAt: timestamp(), reviewPending: 0 };
        await write(env.BUCKET, stateKey, lastRun); return response({ ok: false, ...lastRun });
      }
      if (isCases) {
        try { return response(await runCaseCollection(env, oc, body, startedAt, helpers, prior)); }
        catch (cause) {
          const lastRun = { state: 'failed', startedAt, checkedAt: timestamp(), track: body.dataset === 'nts-cases' ? 'nts' : body.track, page, reason: cause.status ? cause.message : '판례 수집·저장에 실패했습니다.', previousReviewPending: prior?.reviewPending || 0 };
          await write(env.BUCKET, stateKey, lastRun); return response({ ok: false, ...lastRun });
        }
      }
      // Laws are checked in batches so one request stays within the host's
      // subrequest budget: the scheduler advances a stored cursor each weekday,
      // and the admin screen walks the batches with an explicit `batch` index.
      let names = LAW_UPDATE_SCOPE, batch = null;
      if (scheduled) { const cursor = await read(env.BUCKET, LAW_CURSOR_KEY); batch = Number.isInteger(cursor?.next) && cursor.next < LAW_UPDATE_SCOPE.length ? cursor.next : 0; }
      else if (Number.isInteger(body.batch)) batch = body.batch * LAW_BATCH;
      if (batch !== null) names = LAW_UPDATE_SCOPE.slice(batch, batch + LAW_BATCH);
      const result = await collectLaws(env, oc, startedAt, helpers, { names, force: !scheduled && body.force === true });
      const following = batch !== null && batch + LAW_BATCH < LAW_UPDATE_SCOPE.length ? batch + LAW_BATCH : null;
      if (scheduled) await write(env.BUCKET, LAW_CURSOR_KEY, { next: following ?? 0, updatedAt: timestamp() });
      const lawQueue = await read(env.BUCKET, LAW_QUEUE_KEY) || [];
      const lastRun = { state: result.errors.length ? 'failed' : 'review-pending', startedAt, checkedAt: timestamp(), reviewPending: lawQueue.length, published: 0, checkedLaws: names.length, totalLaws: LAW_UPDATE_SCOPE.length, nextBatch: following === null ? null : following / LAW_BATCH, staged: result.staged, unchanged: result.unchanged, errors: result.errors, message: result.staged.length ? '새 버전 또는 다시 받은 본문을 검토 대기로 보관했습니다. 자료 관리에서 확인 후 공개하세요. 공개 자료와 마지막 확인일은 변경하지 않았습니다.' : '확보한 버전과 같은 법령은 다시 저장하지 않았습니다.' };
      if (scheduled) {
        // Daily pass over the most recent cases; the 2-year backfill runs from the admin screen.
        const recent = { from: new Date(Date.now() + 9 * 3600000 - 30 * 86400000).toISOString().slice(0, 10), to: kstToday() }, cases = [];
        for (const track of Object.keys(CASE_TRACKS)) {
          try { const run = await runCaseCollection(env, oc, { dataset: 'cases', track, page: 1, ...recent }, startedAt, helpers, null, { recordProgress: false }); cases.push({ track, staged: run.staged, fetched: run.fetched }); }
          catch (cause) { cases.push({ track, error: cause.status ? cause.message : '판례 수집 실패' }); }
        }
        lastRun.recentCases = cases;
        if (helpers.guideDocuments) { try { const check = await checkGuideLinks(env, await helpers.guideDocuments()); lastRun.guideLinks = { total: check.total, ok: check.ok }; } catch { lastRun.guideLinks = { error: '링크 확인 실패' }; } }
      }
      await write(env.BUCKET, STATE_KEY, lastRun);
      return response({ ok: result.errors.length === 0, ...lastRun });
    }
    return response({ error: '지원하지 않는 요청 방식입니다.' }, 405);
  } catch (cause) { return response({ error: cause.status ? cause.message : '연동 설정 또는 저장소 처리에 실패했습니다.' }, cause.status || 503); }
}
