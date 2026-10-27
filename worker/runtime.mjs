import { verifySchedulerRequest } from './scheduler-auth.mjs';
import { handleLawUpdate } from './law-updates.mjs';
import { searchDocuments, validateSearch, validDate } from '../lib/search.mjs';

const STATE_KEY = 'reference-state-v1.json';
const GUIDE_LINKS_KEY = 'guide-links-check-v1.json';
const MAX_BODY = 2 * 1024 * 1024;
const TYPES = new Set(['law', 'decree', 'rule', 'case', 'guide', 'notice', 'interpretation', 'decision', 'ruling', 'form', 'guideline']);
const DATE_FIELDS = ['promulgatedAt', 'effectiveFrom', 'effectiveTo', 'documentDate'];
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://chat.openai.com https://*.chatgpt.com https://*.chatgpt.site",
};
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', json: 'application/json; charset=utf-8' };
const failures = new Map();
let writeQueue = Promise.resolve();
const now = () => new Date().toISOString();
const error = (status, message) => Object.assign(new Error(message), { status });
const officialHost = host => /(^|\.)(law\.go\.kr|nts\.go\.kr|tt\.go\.kr|ftc\.go\.kr|scourt\.go\.kr|mois\.go\.kr|wetax\.go\.kr|g2b\.go\.kr|korea\.kr|data\.go\.kr|open\.go\.kr)$/.test(host);
function safeUrl(value, official = false) {
  if (!value) return '';
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (!official || officialHost(url.hostname)) ? url.href : null; } catch { return null; }
}
function reply(value, status = 200, headers = {}) { return new Response(JSON.stringify(value), { status, headers: { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } }); }
function scrubDocument(input) {
  const doc = { ...input };
  if (!['full', 'excerpt'].includes(doc.bodyStatus) || !doc.body) { doc.body = ''; doc.bodyStatus = 'link'; doc.allowedDownload = false; }
  if (!safeUrl(doc.sourceUrl, true)) doc.sourceUrl = '';
  return doc;
}
function duplicateVersion(a, b) {
  if (['law', 'decree', 'rule'].includes(b.type)) return Boolean(a.type === b.type && (a.lawKey || a.documentNumber) && (a.lawKey || a.documentNumber) === (b.lawKey || b.documentNumber) && a.article === b.article && a.version === b.version);
  return Boolean(a.documentNumber && a.documentNumber === b.documentNumber && a.agency === b.agency && (a.version || '') === (b.version || ''));
}
function sanitizeDocument(input, prior = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error(400, '문서 메타데이터를 확인하세요.');
  const allowed = ['title', 'domain', 'type', 'agency', 'sourceUrl', 'documentNumber', 'article', 'body', 'bodyStatus', 'promulgatedAt', 'effectiveFrom', 'effectiveTo', 'documentDate', 'tags', 'keywords', 'rights', 'version', 'transitional', 'reviewStatus', 'allowedDownload', 'lawKey', 'lawName', 'status', 'taxYears', 'taxYear', 'relatedIds', 'notes', 'applicability', 'sourceId', 'verifiedAt', 'lastChecked', 'collection', 'caseTrack', 'caseKind'];
  const doc = { ...prior };
  for (const key of allowed) if (Object.hasOwn(input, key)) doc[key] = input[key];
  for (const key of ['title', 'domain', 'type', 'agency', 'sourceUrl', 'documentNumber', 'article', 'body', 'bodyStatus', 'rights', 'version', 'transitional', 'reviewStatus', 'lawKey', 'lawName', 'status', 'notes', 'applicability', 'sourceId', 'collection', 'caseTrack', 'caseKind']) if (doc[key] !== undefined && typeof doc[key] !== 'string') throw error(400, `${key} 값은 문자열이어야 합니다.`);
  if (!doc.title?.trim() || !['tax', 'subcontract'].includes(doc.domain) || !TYPES.has(doc.type) || !doc.agency?.trim()) throw error(400, '제목, 분야, 자료 유형, 발행기관을 입력하세요.');
  if (doc.title.length > 500 || (doc.body || '').length > MAX_BODY / 2) throw error(400, '제목 또는 본문이 허용 크기를 초과했습니다.');
  for (const key of DATE_FIELDS) if (doc[key] && !validDate(doc[key])) throw error(400, `${key} 날짜를 확인하세요.`);
  for (const key of ['verifiedAt', 'lastChecked']) if (doc[key] && (typeof doc[key] !== 'string' || Number.isNaN(Date.parse(doc[key])))) throw error(400, `${key} 확인 일시를 확인하세요.`);
  if (doc.effectiveFrom && doc.effectiveTo && doc.effectiveFrom > doc.effectiveTo) throw error(400, '시행 종료일은 시행 시작일보다 앞설 수 없습니다.');
  if (doc.sourceUrl && !safeUrl(doc.sourceUrl, true)) throw error(400, '허용된 공식 기관의 HTTPS 원문 주소를 입력하세요.');
  if (!['draft', 'reviewed', 'published'].includes(doc.reviewStatus || 'draft')) throw error(400, '검토 상태를 확인하세요.');
  for (const key of ['tags', 'keywords', 'relatedIds', 'taxYears']) if (doc[key] !== undefined && (!Array.isArray(doc[key]) || doc[key].length > 100 || !doc[key].every(item => ['string', 'number'].includes(typeof item)))) throw error(400, `${key} 목록을 확인하세요.`);
  if (doc.taxYear !== undefined && !/^\d{4}$/.test(String(doc.taxYear))) throw error(400, '귀속연도를 확인하세요.');
  if (doc.bodyStatus && !['full', 'excerpt', 'link'].includes(doc.bodyStatus)) throw error(400, '본문 확보 상태를 확인하세요.');
  doc.body = doc.body || '';
  doc.bodyStatus = doc.body && ['full', 'excerpt'].includes(doc.bodyStatus) ? doc.bodyStatus : 'link';
  if (doc.bodyStatus === 'link') doc.body = '';
  doc.tags = doc.tags || [];
  doc.reviewStatus = doc.reviewStatus || 'draft';
  doc.allowedDownload = doc.allowedDownload === true && ['full', 'excerpt'].includes(doc.bodyStatus) && Boolean(doc.rights?.trim());
  if (doc.reviewStatus === 'published' && ['full', 'excerpt'].includes(doc.bodyStatus) && !doc.rights?.trim()) throw error(400, '본문 공개 전 이용 조건·재게시 권한 확인 내용을 기록하세요.');
  if (doc.reviewStatus === 'published' && !doc.sourceUrl) throw error(400, '공개 전 공식 원문 주소를 입력하세요.');
  doc.updatedAt = now(); doc.collectedAt ||= now(); doc.verifiedAt ||= now();
  return doc;
}
function sections(body) {
  if (!body) return [];
  const result = []; let current;
  String(body).split('\n').forEach((text, index) => {
    if (!current || /^\s*(제\s*\d+\s*조|부칙|제\s*\d+\s*장)/.test(text)) { current = { id: `line-${index + 1}`, label: text.trim().slice(0, 100) || '본문', line: index + 1, text: '' }; result.push(current); }
    current.text += `${current.text ? '\n' : ''}${text}`;
  });
  return result;
}
async function jsonBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw error(413, '업로드는 2MB까지 지원합니다.');
  const reader = request.body?.getReader(); if (!reader) throw error(400, '유효한 JSON 요청이 필요합니다.');
  const decoder = new TextDecoder(); let bytes = 0, text = '';
  try {
    while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > MAX_BODY) { await reader.cancel(); throw error(413, '업로드는 2MB까지 지원합니다.'); } text += decoder.decode(part.value, { stream: true }); }
    text += decoder.decode();
    const body = JSON.parse(text); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body;
  } catch (cause) { if (cause.status) throw cause; throw error(400, '유효한 JSON 요청이 필요합니다.'); }
}
function initialState(seed) {
  return { version: 1, seedIds: (seed.documents || []).map(doc=>doc.id), documents: (seed.documents || []).filter(doc => doc.id).map(input => ({ body: '', bodyStatus: 'link', tags: [], reviewStatus: 'published', ...input, verifiedAt: input.verifiedAt || input.lastChecked || input.collectedAt || null })), sources: (seed.sources || []).filter(source => source.id).map(source => ({ status: 'unconnected', ...source })), history: [] };
}
// Read-only requests reuse the parsed store while its R2 etag is unchanged. The
// cached object is never handed to mutate(), which always reads a fresh copy.
let stateCache = null;
const publicCache = new WeakMap();
function publicDocuments(state) {
  if (!publicCache.has(state)) publicCache.set(state, state.documents.map(scrubDocument));
  return publicCache.get(state);
}
async function readState(env, seed, { cached = false } = {}) {
  if (!env.BUCKET) {
    if (!cached) return initialState(seed);
    if (stateCache?.seed !== seed || stateCache.etag !== null) stateCache = { seed, etag: null, state: initialState(seed) };
    return stateCache.state;
  }
  try {
    const reuse = cached && stateCache?.seed === seed && stateCache.etag;
    const object = await env.BUCKET.get(STATE_KEY, reuse ? { onlyIf: { etagDoesNotMatch: stateCache.etag } } : undefined);
    if (reuse && object && typeof object.json !== 'function') return stateCache.state;
    if (!object) return initialState(seed);
    if (reuse && object.etag === stateCache.etag) return stateCache.state;
    const state = await object.json();
    if (state.version !== 1 || !Array.isArray(state.documents) || !Array.isArray(state.sources) || !Array.isArray(state.history)) throw new Error('invalid-state');
    const knownSeedIds = new Set(state.seedIds || seed.baselineIds || []);
    for (const doc of seed.documents || []) if (!knownSeedIds.has(doc.id) && !state.documents.some(item=>item.id===doc.id)) state.documents.push(structuredClone(doc));
    // Repair only the known malformed seeded links. Keep administrator edits,
    // version dates and acquired bodies intact, including older R2 records.
    for (const fix of seed.lawSourceLinkFixes || []) {
      const doc = state.documents.find(item=>item.id===fix.id);
      if (doc && doc.sourceUrl===fix.previousUrl) doc.sourceUrl=fix.sourceUrl;
    }
    state.seedIds = [...new Set([...knownSeedIds,...(seed.documents||[]).map(doc=>doc.id)])];
    // Add newly reviewed source definitions without replacing administrator state
    // or connection/check results for an existing source.
    for (const source of seed.sources || []) if (source.id && !state.sources.some(item=>item.id===source.id)) state.sources.push(structuredClone(source));
    if(seed.apiLawImportAt && (!state.apiLawImportAt || state.apiLawImportAt < seed.apiLawImportAt)){for(const source of seed.sources.filter(x=>x.id==='law-open-data')){const index=state.sources.findIndex(x=>x.id===source.id);if(index>=0)state.sources[index]={...state.sources[index],...source};}state.apiLawImportAt=seed.apiLawImportAt;}
    Object.defineProperty(state, '_storageEtag', { value: object.etag, enumerable: false });
    if (cached) stateCache = { seed, etag: object.etag, state };
    return state;
  } catch { throw error(503, '자료 저장소를 읽지 못했습니다. 관리자에게 연결 상태를 확인하세요.'); }
}
function history(state, action, detail) { state.history.unshift({ id: crypto.randomUUID(), createdAt: now(), action, ...detail }); state.history = state.history.slice(0, 1000); }
async function mutate(env, seed, operation) {
  if (!env.BUCKET) throw error(503, '자료 저장소가 미설정입니다. R2 BUCKET을 연결한 뒤 관리자 변경 기능을 이용하세요.');
  const pending = writeQueue.then(async () => {
    const state = await readState(env, seed); const result = await operation(state);
    try {
      const saved = await env.BUCKET.put(STATE_KEY, JSON.stringify(state), { httpMetadata: { contentType: 'application/json' }, onlyIf: state._storageEtag ? { etagMatches: state._storageEtag } : { etagDoesNotMatch: '*' } });
      stateCache = null;
      if (saved === null) throw error(409, '다른 관리 요청이 먼저 저장되었습니다. 자료를 다시 확인한 뒤 시도하세요.');
    } catch (cause) { if (cause.status) throw cause; throw error(503, '자료 저장에 실패했습니다. 변경 내용은 저장되지 않았습니다. 다시 시도하세요.'); }
    return result;
  });
  writeQueue = pending.catch(() => {}); return pending;
}
const encoder = new TextEncoder();
function b64(bytes) { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64(value) { try { const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, char => char.charCodeAt(0)); } catch { return new Uint8Array(); } }
async function hmacKey(secret) { return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function createCookie(secret) {
  const payload = `${Date.now()}.${crypto.randomUUID()}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${b64(new Uint8Array(signature))}`;
}
async function cookieAuthenticated(request, secret) {
  if (!secret) return false;
  const cookie = request.headers.get('cookie')?.split(';').map(item => item.trim()).find(item => item.startsWith('legal_admin='))?.slice(12);
  const match = cookie?.match(/^(\d{13})\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/); if (!match) return false;
  const age = Date.now() - Number(match[1]); if (age < 0 || age > 28800000) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64(match[3]), encoder.encode(`${match[1]}.${match[2]}`));
}
async function tokenEqual(supplied, expected) {
  const values = await Promise.all([supplied, expected].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const a = new Uint8Array(values[0]), b = new Uint8Array(values[1]); let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0;
}
function platformAuthenticated(request, env) {
  // The hosting gateway must replace this header. Do not accept a general signed-in user as an administrator.
  return Boolean((env.ADMIN_USER_ID && request.headers.get('oai-authenticated-user-id') === env.ADMIN_USER_ID) ||
    (env.ADMIN_EMAIL && request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase() === String(env.ADMIN_EMAIL).trim().toLowerCase()));
}
async function authState(request, env) {
  const configured = Boolean(env.ADMIN_TOKEN || env.ADMIN_USER_ID || env.ADMIN_EMAIL);
  const authMethod = !env.BUCKET ? null : platformAuthenticated(request, env) ? 'platform' : await cookieAuthenticated(request, env.ADMIN_TOKEN) ? 'token' : null;
  return { authenticated: Boolean(authMethod), configured, storageConfigured: Boolean(env.BUCKET), authMethod };
}
const hasBody = doc => ['full', 'excerpt'].includes(doc.bodyStatus) && Boolean(doc.body);
// Batch publication of reviewed cases in one store write. A full-text court
// version upgrades an existing link-only record of the same court, docket and
// date; anything else with that identity is reported as a duplicate.
function importCases(state, inputs) {
  const results = [], summary = { imported: 0, upgraded: 0, duplicates: 0, rejected: 0 };
  const byIdentity = new Map(), byId = new Map(state.documents.map(item => [item.id, item]));
  for (const item of state.documents) if (item.type === 'case') byIdentity.set(`${item.agency}|${item.documentNumber}|${item.documentDate}`, item);
  for (const input of inputs) {
    let doc;
    try { doc = sanitizeDocument({ ...input, reviewStatus: 'published' }); doc.id = input.id; }
    catch (cause) { summary.rejected++; results.push({ imported: false, id: input?.id || null, message: cause.message }); continue; }
    const identity = `${doc.agency}|${doc.documentNumber}|${doc.documentDate}`, duplicate = byId.get(doc.id) || byIdentity.get(identity);
    if (duplicate && !hasBody(duplicate) && hasBody(doc)) {
      Object.assign(duplicate, { body: doc.body, bodyStatus: doc.bodyStatus, sourceUrl: doc.sourceUrl, rights: doc.rights, notes: doc.notes, version: doc.version, updatedAt: doc.updatedAt, keywords: [...new Set([...(duplicate.keywords || []), ...(doc.keywords || [])])].slice(0, 100), tags: [...new Set([...(duplicate.tags || []), ...(doc.tags || [])])].slice(0, 100) });
      summary.upgraded++; results.push({ imported: true, upgraded: true, documentId: duplicate.id, message: '기존 링크 자료에 공식 판결문 본문을 보강했습니다.' }); continue;
    }
    if (duplicate) { summary.duplicates++; results.push({ imported: false, duplicateId: duplicate.id, message: '같은 법원·사건번호·선고일의 자료가 이미 있습니다. 기존 자료를 확인하세요.' }); continue; }
    state.documents.push(doc); byId.set(doc.id, doc); byIdentity.set(identity, doc);
    summary.imported++; results.push({ imported: true, documentId: doc.id, message: '검토한 판례를 공개 자료에 등록했습니다.' });
  }
  if (summary.imported || summary.upgraded) history(state, 'case-import', inputs.length === 1 ? { documentId: results[0].documentId, title: inputs[0].title, reviewStatus: 'published' } : { count: summary.imported, upgraded: summary.upgraded, duplicates: summary.duplicates, reviewStatus: 'published' });
  return { results, summary };
}
const sessionCookie = (value, maxAge = 28800) => `legal_admin=${value}; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=${maxAge}`;

export async function handleRequest(request, env, ctx, SEED, ASSETS) {
  try {
    const url = new URL(request.url); let path;
    try { path = decodeURIComponent(url.pathname); } catch { throw error(400, '주소 형식을 확인하세요.'); }
    const method = request.method;
    const changing = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    if (path.startsWith('/api/') && changing) {
      const origin = request.headers.get('origin');
      if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== url.origin)) throw error(403, '다른 사이트에서 보낸 변경 요청은 허용하지 않습니다.');
      const contentType = request.headers.get('content-type');
      if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) throw error(415, 'JSON 요청만 지원합니다.');
    }
    if (method === 'GET' && path === '/api/updates/instructions') return reply({
      revision: 'weekday-9-kst-signed-v3', scope: '등록된 주요 세법 6종·지방세법 4종과 하도급법·시행령, 최근 30일 판례 목록(공휴일 제외는 특일 정보 키 등록 시 적용)',
      requirements: ['Sites get_site에서 current_user_role이 owner 또는 editor인지 확인하고 현재 siwc_bypass_bearer_token을 메모리로만 취득한다. 공개 여부와 관계없이 업데이트 요청에는 별도 서명이 필요하다.', 'get_site의 Site id와 서비스 토큰으로 SHA256 UTF-8(legal-updates-v1\\n + project_id + \\n + token)을 계산한다. 여기서 \\n은 실제 줄바꿈이며 결과 hex를 32바이트 키로 복호화한다. 키를 파일·프롬프트·로그에 저장하지 않는다.', '현재 Unix 초를 timestamp로 하고 전송할 본문은 정확히 {} UTF-8 2바이트로 한다. canonical = POST\\n/api/updates/laws/run\\n<timestamp>\\n<본문 SHA256 hex> 로 구성하고 줄바꿈은 실제 LF를 사용한다.', 'HMAC-SHA256(파생 키 bytes, canonical UTF-8)의 hex를 X-Law-Update-Signature, timestamp를 X-Law-Update-Timestamp 헤더로 넣어 POST한다. 원본 서비스 토큰은 같은 Site의 OAI-Sites-Authorization 헤더로만 전달한다.', '401이면 서명 또는 서버 연결 설정이 맞지 않는 상태이다. 인증을 우회하거나 임의 키로 재설정하지 않고 중지한다. /api/updates/status로 저장 결과를 확인한다.', 'OC 미등록 blocked는 연동 대기이며 성공으로 보고하지 않는다. 새 자료는 검토 대기로 유지하고 기존 자료·확인일을 보존한다. 반복 일정에서는 재배포하지 않는다.'],
      signing: { context: 'legal-updates-v1', keyDerivation: 'SHA256(context + LF + project_id + LF + service_token)', canonical: 'POST + LF + /api/updates/laws/run + LF + unix_seconds + LF + SHA256(body_utf8).hex', headers: ['X-Law-Update-Timestamp','X-Law-Update-Signature'], maxAgeSeconds: 300 },
      writer: '/api/updates/laws/run', status: '/api/updates/status', timezone: 'Asia/Seoul', schedule: '월~금 09:00',
    });
    const updateResponse = await handleLawUpdate(request,env,ctx,{
      requireAdmin: async req => (await authState(req,env)).authenticated,
      requireScheduler: async req => verifySchedulerRequest(req,env),
      importCases: async inputs => mutate(env, SEED, state => importCases(state, inputs)),
      importLaw: async input => mutate(env, SEED, state => {
        const doc = sanitizeDocument({ ...input, reviewStatus: 'published' }); doc.id = input.id;
        const duplicate = state.documents.find(item => item.id === doc.id || (item.type === doc.type && (item.lawKey || item.lawName) === doc.lawKey && item.effectiveFrom === doc.effectiveFrom && item.promulgatedAt === doc.promulgatedAt && item.bodyStatus === 'full' && !item.article));
        // A re-fetched copy of an already published version replaces its text after
        // review (the seeded text can differ from the current official response).
        if (duplicate && duplicate.body === doc.body) return { imported: false, duplicateId: duplicate.id, message: '같은 법령·시행일·공포일의 전문이 이미 있고 본문도 같습니다.' };
        if (duplicate) {
          Object.assign(duplicate, { body: doc.body, bodyStatus: 'full', sourceUrl: doc.sourceUrl, documentNumber: doc.documentNumber || duplicate.documentNumber, verifiedAt: doc.verifiedAt, lastChecked: doc.lastChecked, collectedAt: doc.collectedAt, updatedAt: doc.updatedAt, notes: `${doc.notes} ${doc.verifiedAt?.slice(0, 10)} 공식 API 응답으로 같은 버전의 본문을 교체.` });
          history(state, 'law-refresh', { documentId: duplicate.id, title: duplicate.title, reviewStatus: duplicate.reviewStatus });
          return { imported: true, replaced: true, documentId: duplicate.id, message: `${doc.lawKey} 시행 ${doc.effectiveFrom} 본문을 공식 API 최신 응답으로 교체했습니다.` };
        }
        state.documents.push(doc); history(state, 'law-import', { documentId: doc.id, title: doc.title, reviewStatus: doc.reviewStatus });
        return { imported: true, documentId: doc.id, message: `${doc.lawKey} 시행 ${doc.effectiveFrom} 전문을 공개했습니다.` };
      }),
      publishedCaseIndex: async () => {
        const state = await readState(env, SEED, { cached: true }), index = new Map();
        // Every collected record counts, not only court cases: 조세심판원 decisions and
        // 국세청 interpretations would otherwise be re-staged on each daily run.
        for (const doc of state.documents) if (doc.type === 'case' || doc.collection === 'case-api') { const entry = { id: doc.id, hasBody: hasBody(doc) }; index.set(`${doc.agency}|${doc.documentNumber}|${doc.documentDate}`, entry); index.set(doc.id, entry); }
        return index;
      },
      guideDocuments: async () => (await readState(env, SEED, { cached: true })).documents.filter(doc => doc.reviewStatus === 'published' && ['guide', 'form', 'guideline'].includes(doc.type) && doc.agency === '국세청' && doc.sourceUrl).map(doc => ({ id: doc.id, title: doc.title, sourceUrl: doc.sourceUrl })),
      publishedLawVersions: async () => new Set((await readState(env, SEED, { cached: true })).documents.filter(doc => ['law', 'decree', 'rule'].includes(doc.type) && doc.bodyStatus === 'full' && !doc.article).map(doc => `${doc.lawKey || doc.lawName}|${doc.effectiveFrom}|${doc.promulgatedAt}`)),
    });
    if (updateResponse) return updateResponse;
    if (method === 'GET' && path === '/api/admin/session') return reply(await authState(request, env));
    if (method === 'POST' && path === '/api/admin/login') {
      if (!env.ADMIN_TOKEN) throw error(503, '관리자 토큰 인증이 미설정입니다. 서버의 ADMIN_TOKEN을 설정하거나 허용된 관리자 계정으로 접속하세요.');
      const address = request.headers.get('cf-connecting-ip') || 'unknown'; const failed = failures.get(address);
      if (failed?.until > Date.now() && failed.count >= 6) throw error(429, '로그인 시도가 많습니다. 잠시 후 다시 시도하세요.');
      const body = await jsonBody(request);
      if (!await tokenEqual(String(body.token || ''), String(env.ADMIN_TOKEN))) {
        if (failures.size > 1000) failures.delete(failures.keys().next().value);
        failures.set(address, { count: failed?.until > Date.now() ? failed.count + 1 : 1, until: Date.now() + 60000 });
        throw error(401, '관리자 인증에 실패했습니다.');
      }
      failures.delete(address);
      return reply({ authenticated: Boolean(env.BUCKET), configured: true, storageConfigured: Boolean(env.BUCKET), authMethod: env.BUCKET ? 'token' : null }, 200, { 'Set-Cookie': sessionCookie(await createCookie(env.ADMIN_TOKEN)) });
    }
    if (method === 'POST' && path === '/api/admin/logout') return reply({ authenticated: false }, 200, { 'Set-Cookie': sessionCookie('', 0) });
    if (path.startsWith('/api/admin/')) {
      if (changing && !env.BUCKET) throw error(503, '자료 저장소가 미설정입니다. R2 BUCKET 연결이 필요합니다.');
      if (!(await authState(request, env)).authenticated) throw error(401, '관리자 로그인이 필요합니다.');
      // Bulk-collected cases are reviewed and removed from the case queue panel; listing
      // thousands of judgment bodies here would make the admin screen unusable.
      if (method === 'GET' && path === '/api/admin/documents') { const state = await readState(env, SEED); return reply({ documents: state.documents.filter(doc => doc.collection !== 'case-api').map(scrubDocument), collectedCases: state.documents.filter(doc => doc.collection === 'case-api').length }); }
      if (method === 'GET' && path === '/api/admin/history') { const state = await readState(env, SEED); return reply({ history: state.history.slice(0, 200) }); }
      if (method === 'POST' && (path === '/api/admin/documents' || path === '/api/admin/upload')) {
        const payload = await jsonBody(request); let input = payload;
        if (path.endsWith('/upload')) {
          if (!/\.(txt|json)$/i.test(payload.filename || '') || typeof payload.text !== 'string') throw error(400, 'UTF-8 TXT 또는 JSON 파일의 텍스트와 메타데이터가 필요합니다. PDF는 원문 링크 방식으로 등록하세요.');
          if (/\.json$/i.test(payload.filename)) { try { const parsed = JSON.parse(payload.text); input = { ...(parsed.document || parsed), ...(payload.metadata || {}) }; } catch { throw error(400, '자료 JSON의 구문을 확인하세요.'); } }
          else input = { ...(payload.metadata || {}), body: payload.text, bodyStatus: payload.metadata?.bodyStatus === 'excerpt' ? 'excerpt' : 'full' };
        }
        const doc = sanitizeDocument(input); doc.id = crypto.randomUUID();
        return await mutate(env, SEED, state => {
          const duplicate = state.documents.find(item => duplicateVersion(item, doc)); if (duplicate) throw error(409, `같은 식별자·버전의 자료가 있습니다. 기존 자료를 수정하세요. (${duplicate.id})`);
          state.documents.push(doc); history(state, path.endsWith('/upload') ? 'upload' : 'create', { documentId: doc.id, title: doc.title, reviewStatus: doc.reviewStatus });
          return reply({ document: scrubDocument(doc) }, 201);
        });
      }
      const adminDocument = path.match(/^\/api\/admin\/documents\/([^/]+)$/);
      if (adminDocument && ['PATCH', 'DELETE'].includes(method)) {
        const payload = method === 'PATCH' ? await jsonBody(request) : null;
        return await mutate(env, SEED, state => {
          const index = state.documents.findIndex(doc => doc.id === adminDocument[1]); if (index < 0) throw error(404, '자료를 찾을 수 없습니다.');
          const prior = state.documents[index];
          if (method === 'DELETE') { state.documents.splice(index, 1); history(state, 'delete', { documentId: prior.id, title: prior.title }); return reply({ deleted: true }); }
          const doc = sanitizeDocument(payload, prior);
          if (state.documents.some(item => item.id !== doc.id && duplicateVersion(item, doc))) throw error(409, '같은 식별자·조문·버전의 자료가 이미 있습니다.');
          state.documents[index] = doc; history(state, 'update', { documentId: doc.id, title: doc.title, reviewStatus: doc.reviewStatus }); return reply({ document: scrubDocument(doc) });
        });
      }
      const sourceCheck = path.match(/^\/api\/admin\/sources\/([^/]+)\/check$/);
      if (method === 'POST' && sourceCheck) return await mutate(env, SEED, async state => {
        const source = state.sources.find(item => item.id === sourceCheck[1]); if (!source) throw error(404, '등록된 자료원이 없습니다.');
        if (!safeUrl(source.url, true)) throw error(400, '허용된 공식 기관 주소만 확인할 수 있습니다.');
        const checkedAt = now();
        try {
          const response = await fetch(source.url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'LegalReference/1.0 (official-source availability check; no crawling)' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          source.status = 'unconnected'; source.lastConnectionStatus = 'connected'; source.lastError = null; source.lastSuccess = checkedAt;
        } catch (cause) { source.status = 'failed'; source.lastConnectionStatus = 'failed'; source.lastError = /^HTTP \d+$/.test(cause.message) ? cause.message : '연결 확인 실패 · 네트워크 또는 접근 정책을 확인하세요.'; }
        source.lastChecked = checkedAt; source.checkScope = '공식 사이트 접근 가능 여부만 확인. 문서 수집·최신성 검증은 수행하지 않습니다.';
        history(state, 'source-check', { sourceId: source.id, status: source.status, error: source.lastError }); return reply({ source });
      });
      throw error(404, '지원하지 않는 관리자 요청입니다.');
    }
    if (method === 'GET' && (path === '/api/search' || path === '/api/evidence')) {
      const params = Object.fromEntries(url.searchParams); const errors = validateSearch(params); if (errors.length) throw error(400, errors.join(' '));
      const state = await readState(env, SEED, { cached: true }), documents = publicDocuments(state); const result = searchDocuments(documents, params);
      if (path === '/api/evidence') {
        const eligible = result.documents.filter(doc => ['full', 'excerpt'].includes(doc.bodyStatus)).map(summary => { const full = documents.find(doc => doc.id === summary.id); return { ...summary, body: full.body, sections: sections(full.body) }; });
        return reply({ documents: eligible, total: eligible.length, excluded: result.documents.length - eligible.length, conditions: result.conditions, warnings: result.warnings, mode: 'evidence', aiEnabled: false, notice: '확보한 공식 본문만 근거 후보로 제공합니다. 생성형 답변 기능은 연결되지 않았습니다.' });
      }
      return reply(result);
    }
    if (method === 'POST' && path === '/api/ai') return reply({ error: 'AI 미연동입니다. 유료 서비스 연결 없이 근거 검색을 이용할 수 있습니다.', aiEnabled: false }, 503);
    if (method === 'GET' && path === '/api/status') {
      const state = await readState(env, SEED, { cached: true }), sources = structuredClone(state.sources); const docs = state.documents.filter(doc => doc.reviewStatus === 'published'); const checked = [...docs.map(doc => doc.verifiedAt), ...sources.map(source => source.lastChecked)].filter(Boolean).sort();
      const guideSource = sources.find(item=>item.id==='nts-filing-guides');
      if (typeof guideSource?.scope==='string') guideSource.scope = guideSource.scope.replace(/공식 링크 \d+건/, `공식 링크 ${docs.filter(d=>['guide','form','guideline'].includes(d.type)&&d.agency==='국세청').length}건`);
      // A source counts as connected when documents collected from it through the
      // official API are published; the note says how many and how recent.
      const collected = new Map();
      for (const doc of docs) if (doc.collection === 'case-api' && doc.sourceId) { const entry = collected.get(doc.sourceId) || { count: 0, latest: '' }; entry.count++; if ((doc.documentDate || '') > entry.latest) entry.latest = doc.documentDate; collected.set(doc.sourceId, entry); }
      const routeNotes = { 'nts-cases-law-api': '법제처 판례 API(데이터출처: 국세법령정보시스템)', 'court-cases-law-api': '법제처 판례 API(데이터출처: 대법원)', 'tax-tribunal': '법제처 특별행정심판재결례 API(조세심판원)', ftc: '법제처 공정거래위원회 결정문 API(하도급)', 'nts-taxlaw': '법제처 국세청 법령해석 API(목록·링크)' };
      for (const [id, note] of Object.entries(routeNotes)) {
        const source = sources.find(item => item.id === id), entry = collected.get(id);
        if (source && entry) { source.status = 'connected'; source.integrationNote = `${note}로 수집 · 공개 ${entry.count.toLocaleString('ko-KR')}건 · 최근 문서일 ${entry.latest || '미확인'}. 새 자료는 평일 갱신 후 검토 대기에서 공개합니다.`; }
      }
      const courtEntry = collected.get('court-cases-law-api'), courts = sources.find(item => item.id === 'courts');
      if (courts && courtEntry) { courts.status = 'connected'; courts.integrationNote = `법원 직접 오픈API는 아직 제공되지 않아 법제처 판례 API(데이터출처: 대법원)로 연동 · 공개 ${courtEntry.count.toLocaleString('ko-KR')}건 · 최근 선고일 ${courtEntry.latest || '미확인'}.`; }
      const guideCheck = await (async () => { try { const item = await env.BUCKET?.get(GUIDE_LINKS_KEY); return item ? await item.json() : null; } catch { return null; } })();
      const guides = sources.find(item => item.id === 'nts-filing-guides');
      if (guides && guideCheck?.total) {
        guides.status = guideCheck.failed?.length ? 'failed' : 'link-checked'; guides.lastChecked = guideCheck.checkedAt;
        guides.integrationNote = `공식 링크 ${guideCheck.total}건 자동 확인 · 정상 ${guideCheck.ok}건${guideCheck.failed?.length ? ` · 열리지 않음 ${guideCheck.failed.length}건` : ''}. 국세청 공공누리 표시가 없어 본문은 이용 허락 전까지 수록하지 않습니다.`;
      }
      const localLaws = docs.filter(doc => ['law', 'decree', 'rule'].includes(doc.type) && (doc.tags || []).includes('지방세')), localFull = new Set(localLaws.filter(hasBody).map(doc => doc.lawKey || doc.lawName));
      const localSource = sources.find(item => item.id === 'local-tax');
      if (localSource && localFull.size) { localSource.status = 'connected'; localSource.integrationNote = `지방세 법령·시행령·시행규칙 ${localFull.size}건 전문 수록(법제처 API 수집 후 검토·공개). 지방세 해석·결정례는 미수집.`; }
      return reply({ sources, counts: { documents: docs.length, fullText: docs.filter(hasBody).length, links: docs.filter(doc => !hasBody(doc)).length, tax: docs.filter(doc => doc.domain === 'tax').length, subcontract: docs.filter(doc => doc.domain === 'subcontract').length, cases: docs.filter(doc => doc.type === 'case').length, collectedCases: docs.filter(doc => doc.collection === 'case-api').length, localTax: localLaws.length }, lastChecked: checked.at(-1) || null, aiEnabled: false, adminConfigured: Boolean(env.ADMIN_TOKEN || env.ADMIN_USER_ID || env.ADMIN_EMAIL), storageConfigured: Boolean(env.BUCKET), libraryMode: 'local', coverage: `검토 후 공개한 자료만 검색합니다. 공식 사이트 전체 수집 또는 최신성 보장은 지원하지 않습니다. ${localFull.size ? `지방세 법령·시행령·시행규칙 ${localFull.size}건은 전문, 지방세 해석·결정례는 미수집입니다.` : '지방세는 법령 공식 원문 링크만 수록했습니다.'}` });
    }
    const documentPath = path.match(/^\/api\/documents\/([^/]+)(\/download)?$/);
    if (method === 'GET' && documentPath) {
      const state = await readState(env, SEED, { cached: true }); const original = state.documents.find(doc => doc.id === documentPath[1]); if (!original || original.reviewStatus !== 'published') throw error(404, '공개된 자료를 찾을 수 없습니다.');
      const doc = scrubDocument(original);
      if (documentPath[2]) {
        if (!doc.allowedDownload || !['full', 'excerpt'].includes(doc.bodyStatus) || !doc.rights) throw error(403, '이 자료의 본문 다운로드 권한은 확인되지 않았습니다. 공식 원문을 이용하세요.');
        return new Response(`${doc.title}\n본문 범위: ${doc.bodyStatus === 'excerpt' ? '확보한 발췌' : '전체 본문'}\n공식 원문: ${doc.sourceUrl}\n자료 확인일: ${doc.verifiedAt || '미확인'}\n이용 조건: ${doc.rights}\n\n${doc.body}`, { headers: { ...SECURITY, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="reference.txt"; filename*=UTF-8''${encodeURIComponent(doc.title.slice(0, 100))}.txt`, 'Cache-Control': 'no-store' } });
      }
      const all = state.documents.filter(item => item.reviewStatus === 'published');
      doc.sections = sections(doc.body);
      doc.relatedDocuments = all.filter(item => (doc.relatedIds || []).includes(item.id)).map(item => ({ id: item.id, title: item.title, type: item.type, relation: '관리자 확인 연결' }));
      doc.versions = doc.lawKey ? all.filter(item => item.lawKey === doc.lawKey && item.article === doc.article).map(item => ({ id: item.id, title: item.title, version: item.version, effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo, verifiedAt: item.verifiedAt, status: item.status })) : [];
      return reply({ document: doc });
    }
    if (path.startsWith('/api/')) throw error(404, '요청한 API를 찾을 수 없습니다.');
    if (method !== 'GET' && method !== 'HEAD') throw error(405, '허용되지 않는 요청입니다.');
    if (path.includes('\0') || path.split('/').some(part => part === '..')) throw error(403, '허용되지 않는 경로입니다.');
    let assetPath = path === '/' ? '/index.html' : path;
    const getAsset = key => ASSETS instanceof Map ? ASSETS.get(key) : ASSETS[key];
    let content = getAsset(assetPath);
    if (content === undefined && !/\.[^/]+$/.test(path)) { assetPath = '/index.html'; content = getAsset(assetPath); }
    if (content === undefined) throw error(404, '파일을 찾을 수 없습니다.');
    return new Response(method === 'HEAD' ? null : content, { headers: { ...SECURITY, 'Content-Type': MIME[assetPath.split('.').at(-1)] || 'application/octet-stream', 'Cache-Control': assetPath.endsWith('.html') ? 'no-cache' : 'public, max-age=300' } });
  } catch (cause) { return reply({ error: cause.status ? cause.message : '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.' }, cause.status || 500); }
}
