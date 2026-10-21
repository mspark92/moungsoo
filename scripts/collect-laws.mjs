// Collects the current official text of every statute in scope into a local file
// that the admin screen stages for review ("법령 파일 올리기"). Use it when the
// hosted server is rejected by law.go.kr (its IP is not registered for the OC).
// Nothing is published by this script.
//
//   node --env-file-if-exists=.env scripts/collect-laws.mjs
//   node --env-file-if-exists=.env scripts/collect-laws.mjs --laws "지방세법,지방세법 시행령"
//
// Requires LAW_API_OC in .env. The OC is never written to the output or printed.
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLawListing, fetchLawPayload, LAW_UPDATE_SCOPE } from '../worker/law-updates.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), option = name => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
const oc = process.env.LAW_API_OC?.trim();
if (!oc) { console.error('LAW_API_OC가 없습니다. .env에 승인된 OC를 넣은 뒤 다시 실행하세요.'); process.exit(1); }
const names = option('laws') ? option('laws').split(',').map(value => value.trim()).filter(Boolean) : [...LAW_UPDATE_SCOPE];
for (const name of names) if (!LAW_UPDATE_SCOPE.includes(name)) { console.error(`수집 대상이 아닌 법령입니다: ${name}`); process.exit(1); }
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const out = resolve(root, option('out') || `exports/laws-${today}.json`);
const env = { LAW_API_FETCH: fetch }, laws = [], failures = [];
const sleep = ms => new Promise(done => setTimeout(done, ms));

console.log(`법령 ${names.length}종 수집 · 저장 ${out}`);
for (const [index, name] of names.entries()) {
  try {
    const listing = await fetchLawListing(env, oc, name);
    const payload = await fetchLawPayload(env, oc, name, listing);
    laws.push({ lawName: name, ...listing, retrievedAt: new Date().toISOString(), payload });
    console.log(`[${index + 1}/${names.length}] ${name} · 시행 ${listing.effectiveDate} · 공포 ${listing.promulgatedDate}`);
  } catch (cause) {
    failures.push(name);
    console.error(`[${index + 1}/${names.length}] ${name} 실패: ${cause.status ? cause.message : '알 수 없는 오류'}`);
  }
  await sleep(300);
}
await mkdir(dirname(out), { recursive: true });
await writeFile(out + '.tmp', JSON.stringify({ format: 'law-api-laws-v1', collectedAt: new Date().toISOString(), laws }));
await rename(out + '.tmp', out);
console.log(`완료: ${laws.length}종${failures.length ? ` · 실패 ${failures.join(', ')}` : ''}. 관리자 화면 → 법령 자동 갱신 → "법령 파일 올리기"에서 이 파일을 선택하세요. 공개는 검토 후 별도로 진행됩니다.`);
if (failures.length) process.exitCode = 2;
