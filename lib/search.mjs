const LAW_TYPES = new Set(['law', 'decree', 'rule', 'notice']);
const FORMAL_LAW_TYPES = new Set(['law', 'decree', 'rule']);
const GUIDE_TYPES = new Set(['guide', 'form', 'guideline']);
const CASE_TYPES = new Set(['case', 'interpretation', 'decision', 'ruling']);
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s·ㆍ\-_,.:;()[\]{}「」『』\/]/g, '');
const aliases = [
  [/하도급법|외주|협력업체|위탁|수탁/g, '하도급'],
  [/증빙|경비|비용|영수증/g, '비용 증빙 법인세 소득세'],
  [/부가세/g, '부가가치세'], [/원천세/g, '원천징수'],
  [/돈|미지급|지급|대금/g, '대금 지급'], [/세금계산서/g, '부가가치세'],
  [/상속세|증여세/g, '상속 증여'], [/시행령/g, '시행령'],
];
export function temporalStatus(doc, today=new Date().toISOString().slice(0,10)) {
  if (!LAW_TYPES.has(doc.type)) return doc.status || 'unknown';
  if (doc.status === 'proposal') return 'proposal';
  if (doc.effectiveFrom && doc.effectiveFrom > today) return 'future';
  if (doc.effectiveTo && doc.effectiveTo < today) return 'past';
  if (doc.effectiveFrom && doc.effectiveTo && doc.effectiveFrom <= today && doc.effectiveTo >= today) return 'current';
  const confirmedThrough = confirmedCurrentThrough(doc);
  if (confirmedThrough && doc.effectiveFrom <= today && today <= confirmedThrough) return 'current';
  return 'unknown';
}
function confirmedCurrentThrough(doc) {
  // A current-law check establishes an observed range, not an expiry date.
  return doc.effectiveFrom && validDate(doc.currentAsOf) && doc.currentAsOf >= doc.effectiveFrom ? doc.currentAsOf : null;
}
export function validateSearch(params) {
  const errors = [];
  if (params.date && !validDate(params.date)) errors.push('기준일은 YYYY-MM-DD 형식의 실제 날짜로 입력하세요.');
  if (params.from && !validDate(params.from)) errors.push('문서 시작일을 확인하세요.');
  if (params.to && !validDate(params.to)) errors.push('문서 종료일을 확인하세요.');
  if (params.year && !/^\d{4}$/.test(params.year)) errors.push('귀속연도는 네 자리 연도로 입력하세요.');
  if (params.q && params.q.length > 500) errors.push('검색어는 500자까지 입력할 수 있습니다.');
  if (params.limit !== undefined && !/^\d{1,3}$/.test(params.limit)) errors.push('표시 개수는 1~300 사이의 숫자로 입력하세요.');
  if (params.offset !== undefined && !/^\d{1,6}$/.test(params.offset)) errors.push('표시 시작 위치를 확인하세요.');
  return errors;
}
export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(+date) && date.toISOString().slice(0, 10) === value;
}
export function groupFor(type) { return LAW_TYPES.has(type) ? 'laws' : CASE_TYPES.has(type) ? 'cases' : 'guides'; }
export function buildConditions(q, domain) {
  const conditions = [];
  const isSub = domain === 'subcontract' || /하도급|도급|외주|협력업체|위탁|대금|납품|기술자료|부당특약/.test(q);
  const isTax = domain === 'tax' || /세금|세무|세법|소득|법인|부가|원천|연말|상속|증여|배당|비용|증빙/.test(q);
  if (isTax) {
    conditions.push({ key: 'taxpayer', label: '납세자 유형', options: ['개인', '개인사업자', '법인', '아직 모름'] });
    conditions.push({ key: 'taxYear', label: '귀속연도 또는 거래일', options: [] });
    if (/국외|해외|수출|수입|외국/.test(q)) conditions.push({ key: 'location', label: '거래 당사자와 거래 장소의 국내·국외 여부', options: ['국내', '국외 포함', '확인 필요'] });
  }
  if (isSub) {
    conditions.push({ key: 'transaction', label: '위탁 거래 유형', options: ['제조', '수리', '건설', '용역', '확인 필요'] });
    conditions.push({ key: 'parties', label: '위탁자·수탁자의 업종과 규모 확인', options: ['관련 자료 있음', '확인 필요'] });
    if (/지급|대금|납품|변경|추가|계약|서면/.test(q)) conditions.push({ key: 'transactionDates', label: '위탁·납품·지급 시점 및 계약·발주서 유무', options: [] });
  }
  return conditions;
}
// Documents are stable objects between requests when the store is unchanged,
// so normalised text is cached per object and recomputed if the body changes.
const searchableCache = new WeakMap();
function searchable(doc, full) {
  let cached = searchableCache.get(doc);
  if (!cached || cached.body !== doc.body || cached.title !== doc.title) {
    cached = { body: doc.body, title: doc.title };
    searchableCache.set(doc, cached);
  }
  const key = full ? 'full' : 'meta';
  if (cached[key] === undefined) {
    const values = [doc.title, doc.lawName, doc.lawKey, doc.documentNumber, doc.article, doc.agency, ...(doc.tags || []), ...(doc.keywords || [])];
    if (full && ['full','excerpt'].includes(doc.bodyStatus)) values.push(doc.body);
    cached[key] = normalize(values.join(' '));
  }
  return cached[key];
}
function queryParts(q) {
  const compact = normalize(q);
  const lawNames=(q.match(/(?:하도급거래\s*공정화에\s*관한\s*법률|하도급법|국세기본법|소득세법|법인세법|부가가치세법|상속세\s*및\s*증여세법|조세특례제한법|지방세기본법|지방세특례제한법|지방세징수법|지방세법)(?:\s*시행령|\s*시행규칙)?/g)||[]).map(v=>normalize(v.replace('하도급법','하도급거래 공정화에 관한 법률')));
  const lawNumbers=(q.match(/(?:법률|대통령령|총리령|부령)\s*제?\s*\d+\s*호/g)||[]).map(normalize);
  const identifier = q.match(/(?:\d{4}[가-힣]{1,8}\d+)|(?:[가-힣A-Za-z]+[-－]\d+[-－]?\d*)/g) || [];
  const article = q.match(/제?\s*\d+\s*조(?:\s*의\s*\d+)?(?:\s*제?\d+\s*항)?/g) || [];
  const words = q.replace(/[?？!.,]/g, ' ').split(/\s+/).filter(x => x.length >= 2 && !/^(어떻게|알려줘|알려주세요|관련|대한|있나요|있을까요|확인|합니다|해주세요|어떤|언제|하려면|상황|경우|받을|해야|하는|있어|있습니다|궁금해요|검색)$/.test(x));
  const expansions = [];
  for (const [pattern, expansion] of aliases) { pattern.lastIndex = 0; if (pattern.test(q)) expansions.push(...expansion.split(' ')); }
  return { compact, lawNames, lawNumbers, identifier: identifier.map(normalize), article: article.map(normalize), words: [...new Set(words.map(normalize).filter(Boolean))], expansions: [...new Set(expansions.map(normalize))] };
}
function articleIdentifiers(value) {
  return [...String(value || '').matchAll(/제?\s*(\d+)\s*조(?:\s*의\s*(\d+))?(?:\s*제?\s*(\d+)\s*항)?/g)].map(match => `${Number(match[1])}:${match[2] || ''}:${match[3] || ''}`);
}
const mainArticleCache = new WeakMap();
function mainArticleIndex(doc) {
  const cached = mainArticleCache.get(doc);
  if (cached && cached.body === doc.body) return cached;
  const lines = String(doc.body || '').split('\n'), articles = [];
  let active = null, mainEnd = lines.length;
  for (let line = 0; line < lines.length; line++) {
    const value = lines[line];
    // Supplementary provisions have their own article numbering. They must
    // never satisfy a query for an absent article in the main statute.
    if (/^\s*부\s*칙(?:\s|[<〈(（]|$)/.test(value)) { mainEnd = line; break; }
    const heading = value.match(/^\s*제\s*(\d+)\s*조(?:\s*의\s*(\d+))?(?=\s|[（(]|$)/);
    if (heading) {
      if (active) active.endLine = line;
      const article = `제${Number(heading[1])}조${heading[2] ? `의${Number(heading[2])}` : ''}`;
      active = { key: `${Number(heading[1])}:${heading[2] || ''}`, article, line, endLine: lines.length, paragraphs: new Map() };
      articles.push(active);
    }
    if (active) {
      // Official paragraphs use circled numerals, including paragraphs 21–50.
      // On a heading line the first marker follows the article title.
      const paragraph = value.match(heading ? /[①-⑳㉑-㉟㊱-㊿]/ : /^\s*([①-⑳㉑-㉟㊱-㊿])/);
      if (paragraph) {
        const marker = (paragraph[1] || paragraph[0]).trim();
        const code = marker.codePointAt(0);
        const number = code >= 0x32b1 ? code - 0x32b1 + 36 : code >= 0x3251 ? code - 0x3251 + 21 : code - 0x2460 + 1;
        if (!active.paragraphs.has(String(number))) active.paragraphs.set(String(number), line);
      }
    }
  }
  if (active) active.endLine = mainEnd;
  const index = { body: doc.body, lines, articles };
  mainArticleCache.set(doc, index);
  return index;
}
function matchingMainArticle(doc, identifier) {
  const [number, subnumber, paragraph] = identifier.split(':');
  return mainArticleIndex(doc).articles.find(article => article.key === `${number}:${subnumber}` && (!paragraph || article.paragraphs.has(paragraph)));
}
function identifierMatch(haystack, needle) {
  let start = haystack.indexOf(needle);
  while (start !== -1) {
    if (!/[0-9]/.test(haystack[start + needle.length] || '') && !(/^[0-9]/.test(needle) && /[0-9]/.test(haystack[start - 1] || ''))) return true;
    start = haystack.indexOf(needle, start + 1);
  }
  return false;
}
function documentIdentifiers(doc) {
  const raw = String(doc.documentNumber || '');
  const values = [normalize(raw), ...raw.split(/[,，\s/()[\]]+/).map(normalize)];
  for (const match of raw.matchAll(/(\d{4}[가-힣]{1,8})(\d+(?:\s*[,，]\s*\d+)*)/g)) {
    for (const n of match[2].split(/\s*[,，]\s*/)) values.push(normalize(match[1] + n));
  }
  return values;
}
function score(doc, parts) {
  if (!parts.compact) return 1;
  const metadata = searchable(doc, false), title = normalize(doc.title);
  if(parts.lawNumbers?.length && !parts.lawNumbers.every(n=>normalize(doc.documentNumber)===n)) return 0;
  if(parts.lawNames?.length){
    const name=normalize(doc.lawName || doc.title.split(/\s*제\s*\d+\s*조/)[0]);
    if(!parts.lawNames.every(n=>LAW_TYPES.has(doc.type)?(name===n || (name.startsWith(n)&&!name.slice(n.length).startsWith('시행'))):searchable(doc,true).includes(n))) return 0;
  }
  if (parts.identifier.length && !parts.identifier.every(id => documentIdentifiers(doc).some(value => identifierMatch(value, id)))) return 0;
  if (parts.article.length) {
    const required = parts.article.flatMap(articleIdentifiers);
    if (!doc.article && ['full','excerpt'].includes(doc.bodyStatus)) {
      if (!required.every(identifier => matchingMainArticle(doc, identifier))) return 0;
    } else {
      const available = articleIdentifiers(doc.article);
      if (!required.every(a => available.some(b => b === a || (!a.split(':')[2] && b.split(':').slice(0, 2).join(':') === a.split(':').slice(0, 2).join(':'))))) return 0;
    }
  }
  const all = searchable(doc, true);
  let result = all.includes(parts.compact) ? 30 : 0;
  for (const word of parts.words) {
    if (title.includes(word)) result += 10;
    else if (metadata.includes(word)) result += 6;
    else if (all.includes(word)) result += 2;
  }
  for (const expansion of parts.expansions) if (all.includes(expansion)) result += 2;
  if (parts.identifier.length) result += 100;
  if (parts.article.length) result += 50;
  return result;
}
function excerpt(doc, q) {
  if (!['full','excerpt'].includes(doc.bodyStatus) || !doc.body) return { excerpt: '본문 미확보 · 제목·식별자·태그만 검색됩니다. 공식 원문에서 내용을 확인하세요.', excerptLocation: null };
  const parts = queryParts(q), index = mainArticleIndex(doc), { lines } = index;
  const requested = parts.article.flatMap(articleIdentifiers)[0];
  const exactArticle = !doc.article && requested ? matchingMainArticle(doc, requested) : null;
  const paragraph = requested?.split(':')[2];
  let line = exactArticle ? (paragraph ? exactArticle.paragraphs.get(paragraph) : exactArticle.line) : lines.findIndex(value => parts.words.some(term => normalize(value).includes(term)));
  if (line < 0) line = 0;
  let sample = lines.slice(line, line + 4).join('\n').trim();
  if (!sample) sample = doc.body.trim();
  const containingArticle = exactArticle || index.articles.find(article => line >= article.line && line < article.endLine);
  return { excerpt: sample.slice(0, 400) + (sample.length > 400 ? '…' : ''), excerptLocation: { line: line + 1, article: doc.article || (containingArticle ? containingArticle.article + (exactArticle && paragraph ? ` 제${paragraph}항` : '') : null) }, excerptLabel: '확보한 본문 발췌' };
}
function paragraphNumber(marker) {
  const code = marker.codePointAt(0);
  return code >= 0x32b1 ? code - 0x32b1 + 36 : code >= 0x3251 ? code - 0x3251 + 21 : code - 0x2460 + 1;
}
function matchedArticles(doc, parts) {
  if (!FORMAL_LAW_TYPES.has(doc.type) || !['full','excerpt'].includes(doc.bodyStatus) || !doc.body || !parts.compact) return [];
  const terms = parts.words.filter(term=>!parts.lawNames.includes(term) && !parts.identifier.includes(term) && !parts.article.includes(term) && !/^(?:제?\d+조(?:의\d+)?|제?\d+항)$/.test(term));
  const requested = parts.article.flatMap(articleIdentifiers);
  if (!terms.length && !requested.length) return [];
  const { lines, articles } = mainArticleIndex(doc);
  const units = articles.length ? articles : doc.article ? [{ article: doc.article.replace(/\s*제\d+항.*$/, ''), key: articleIdentifiers(doc.article)[0]?.split(':').slice(0,2).join(':'), line: 0, endLine: lines.length }] : [];
  const matches = [];
  for (const unit of units) {
    if (requested.length && !requested.some(value=>value.split(':').slice(0,2).join(':')===unit.key)) continue;
    const title = (lines[unit.line] || '').match(/^\s*제\s*\d+\s*조(?:\s*의\s*\d+)?\s*[(（]([^）)]+)[）)]/)?.[1] || '';
    const locations = new Map(); let paragraph = null, item = null;
    for (let line = unit.line; line < unit.endLine; line++) {
      const value = lines[line], markers = [...value.matchAll(/[①-⑳㉑-㉟㊱-㊿]/g)];
      const chunks = markers.length ? [{ start: 0, end: markers[0].index, marker: null }, ...markers.map((marker,i)=>({ start: marker.index, end: markers[i+1]?.index ?? value.length, marker: marker[0] }))] : [{ start: 0, end: value.length, marker: null }];
      for (const chunk of chunks) {
        if (chunk.marker) { paragraph = paragraphNumber(chunk.marker); item = null; }
        const text = value.slice(chunk.start,chunk.end).trim(); if (!text) continue;
        const numbered = text.match(/^(\d+)\s*[.)]\s*/); if (numbered) item = Number(numbered[1]);
        const requiredParagraphs = requested.filter(value=>value.split(':').slice(0,2).join(':')===unit.key).map(value=>value.split(':')[2]).filter(Boolean);
        if (requiredParagraphs.length && !requiredParagraphs.includes(String(paragraph))) continue;
        const normalized = normalize(text), literalHit = terms.some(term=>normalized.includes(term));
        if (terms.length ? !literalHit : !requested.length) continue;
        const key = `${paragraph ?? ''}:${item ?? ''}`;
        if (locations.has(key)) continue;
        let offset = terms.map(term=>text.toLowerCase().indexOf(term)).filter(index=>index>=0).sort((a,b)=>a-b)[0] || 0;
        offset = Math.max(0,offset-65);
        locations.set(key, { paragraph, item, line: line+1, snippet: (offset?'…':'')+text.slice(offset,offset+320)+(text.length>offset+320?'…':'') });
      }
    }
    if (locations.size) matches.push({ article: unit.article, title, line: unit.line+1, locations: [...locations.values()] });
  }
  return matches;
}
export function searchDocuments(documents, params = {}) {
  const q = String(params.q || '').trim();
  const parts = queryParts(q);
  const warnings = [];
  const publicDocs = documents.filter(doc => doc.reviewStatus === 'published');
  let incompleteTime = 0, unknownYear = 0;
  const filtered = publicDocs.filter(doc => {
    // The Related Laws menu is narrower than integrated statutory materials:
    // only statutes, enforcement decrees and enforcement rules belong here.
    if (params.category === 'laws' && !FORMAL_LAW_TYPES.has(doc.type)) return false;
    if (params.category === 'guides' && !GUIDE_TYPES.has(doc.type)) return false;
    if (params.category === 'cases' && !CASE_TYPES.has(doc.type)) return false;
    // Bulk API case records are searched on demand but kept out of the core list.
    if (params.collection === 'core' && doc.collection === 'case-api') return false;
    if (params.domain && params.domain !== 'all' && doc.domain !== params.domain) return false;
    if (params.type && params.type !== 'all' && doc.type !== params.type) return false;
    if (params.agency && params.agency !== 'all' && !normalize(doc.agency).includes(normalize(params.agency))) return false;
    if (params.topic && params.topic !== 'all' && !(doc.tags || []).includes(params.topic)) return false;
    if (params.status && params.status !== 'all' && temporalStatus(doc) !== params.status) return false;
    if (params.from && (!(doc.documentDate || doc.promulgatedAt) || (doc.documentDate || doc.promulgatedAt) < params.from)) return false;
    if (params.to && (!(doc.documentDate || doc.promulgatedAt) || (doc.documentDate || doc.promulgatedAt) > params.to)) return false;
    if (params.date) {
      if (LAW_TYPES.has(doc.type)) {
        const start=doc.effectiveFrom;
        const end=doc.effectiveTo || confirmedCurrentThrough(doc);
        if (!start) { incompleteTime++; return false; }
        if (params.date < start) return false;
        // Without an expiry date, a verified current-law check establishes the
        // interval through that check only. Never extrapolate beyond it.
        if ((!end && params.date !== start) || (!doc.effectiveTo && end && params.date > end)) { incompleteTime++; return false; }
        if (end && params.date > end) return false;
      } else if (!doc.documentDate || doc.documentDate > params.date) {
        if (!doc.documentDate) incompleteTime++;
        return false;
      }
    }
    if (params.year) {
      const years = doc.taxYears || (doc.taxYear ? [String(doc.taxYear)] : []);
      if (!years.map(String).includes(String(params.year))) { unknownYear++; return false; }
    }
    return true;
  });
  const ranked = filtered.map(doc => ({ doc, score: score(doc, parts) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score || String(b.doc.documentDate || '').localeCompare(String(a.doc.documentDate || '')));
  const limit = Math.min(300, Math.max(1, Number(params.limit) || 300)), offset = Math.max(0, Number(params.offset) || 0);
  const results = ranked.slice(offset, offset + limit).map(({ doc }) => { const { body, ...summary } = doc; return { ...summary, ...excerpt(doc, q), articleMatches: matchedArticles(doc, parts), hasBody: ['full','excerpt'].includes(doc.bodyStatus), group: groupFor(doc.type) }; });
  if (params.status) warnings.push('시행 상태는 확인된 시행 구간으로 분류합니다. 종료일·현행 확인이 부족한 버전은 시점 미확인입니다.');
  if (params.date) warnings.push('법령은 확보된 시행 구간, 공식 현행 확인일까지의 구간 또는 확인된 시행 시작일에 한해서, 판례·안내서는 문서일자가 기준일 이전인 자료만 조회합니다. 부칙·적용례·경과조치는 별도로 확인해야 합니다. 해당 시점 자료가 없으면 현행 조문으로 대체하지 않습니다.');
  if (incompleteTime) warnings.push(`시점 정보가 부족한 자료 ${incompleteTime}건은 기준일 검색에서 제외했습니다. 해당 시점은 확인 불가입니다.`);
  if (unknownYear) warnings.push(`귀속연도 적용 정보가 확인되지 않은 자료 ${unknownYear}건을 제외했습니다. 날짜만으로 귀속연도를 추정하지 않습니다.`);
  if (params.date && results.length === 0) warnings.push('해당 기준일에 확인된 버전을 확보하지 못했습니다. 기준일을 해제하거나 공식 원문의 연혁을 확인하세요.');
  if (results.length === 0) warnings.push('현재 확보한 자료에서 결과가 없습니다. 검색어를 줄이거나 분야·자료 유형·시점 조건을 변경하세요.');
  const linkCount = results.filter(doc => !doc.hasBody).length;
  if (linkCount) warnings.push(`본문 미확보 자료 ${linkCount}건은 제목·식별자·태그 검색만 지원하며 답변 근거에서 제외됩니다.`);
  const conditions = buildConditions(q, params.domain);
  if (conditions.length) warnings.push('표시된 조건은 추가로 확인할 사실관계입니다. 현재 정보만으로 세무 처리나 하도급법 적용 여부를 판단하지 않습니다.');
  return { documents: results, total: results.length, totalMatched: ranked.length, offset, limit, groups: { laws: results.filter(d => d.group === 'laws'), cases: results.filter(d => d.group === 'cases'), guides: results.filter(d => d.group === 'guides') },
    coverage: { total: publicDocs.length, fullText: publicDocs.filter(d => ['full','excerpt'].includes(d.bodyStatus)).length, links: publicDocs.filter(d => !['full','excerpt'].includes(d.bodyStatus)).length, scope: '검토·공개된 확보 자료만 검색합니다. 전체 법령·사례를 망라하지 않습니다.' }, warnings, conditions, mode: 'evidence', aiEnabled: false };
}
