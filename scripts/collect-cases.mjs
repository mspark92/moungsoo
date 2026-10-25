// Collects court cases from the official 법제처 판례 API into a local file that the
// admin screen can stage for review ("수집 파일 올리기"). Use it when the hosted
// server cannot reach law.go.kr. Nothing is published by this script.
//
//   node --env-file-if-exists=.env scripts/collect-cases.mjs            # last 2 years, all tracks
//   node --env-file-if-exists=.env scripts/collect-cases.mjs --from 2025-01-01 --to 2025-12-31 --tracks nts
//
// Requires LAW_API_OC (an approved 국가법령정보 공동활용 OC) in .env. The OC is never
// written to the output file or printed.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCasePage, CASE_TRACKS } from '../worker/law-updates.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]?.startsWith('--') ? 'true' : all[index + 1] ?? 'true']] : pairs, []));
const oc = process.env.LAW_API_OC?.trim();
if (!oc) { console.error('LAW_API_OC가 없습니다. .env에 승인된 OC를 넣은 뒤 다시 실행하세요.'); process.exit(1); }
const kstToday = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const to = args.to || kstToday;
const from = args.from || (() => { const d = new Date(`${to}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() - 2); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to || to > kstToday) { console.error('--from/--to 는 YYYY-MM-DD 형식이고 종료일은 오늘 이후일 수 없습니다.'); process.exit(1); }
const tracks = (args.tracks || Object.keys(CASE_TRACKS).join(',')).split(',').map(value => value.trim()).filter(Boolean);
for (const track of tracks) if (!CASE_TRACKS[track]) { console.error(`알 수 없는 범위: ${track} (가능: ${Object.keys(CASE_TRACKS).join(', ')})`); process.exit(1); }
const delay = Math.max(200, Number(args.delay) || 400);
const out = resolve(root, args.out || `exports/cases-${from}_${to}.json`);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const env = { LAW_API_FETCH: fetch };

// Resume from an earlier partial file for the same window.
let state = { format: 'law-api-cases-v1', window: { from, to }, tracks: {}, documents: [] };
try { const prior = JSON.parse(await readFile(out, 'utf8')); if (prior.format === state.format && prior.window?.from === from && prior.window?.to === to) state = prior; } catch {}
const seen = new Set(state.documents.map(doc => doc.id));
async function save() {
  state.collectedAt = new Date().toISOString();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out + '.tmp', JSON.stringify(state));
  await rename(out + '.tmp', out);
}
console.log(`판례 수집: ${from} ~ ${to} · 범위 ${tracks.join(', ')} · 저장 ${out}`);
for (const track of tracks) {
  const progress = state.tracks[track] ||= { page: 0, totalPages: null, done: false, warnings: 0 };
  while (!progress.done) {
    const page = progress.page + 1;
    let result;
    for (let attempt = 1; ; attempt++) {
      try { result = await collectCasePage(env, oc, { track, page, from, to }); break; }
      catch (cause) {
        if (attempt >= 3) { await save(); console.error(`\n[${track}] ${page}페이지 실패: ${cause.status ? cause.message : '알 수 없는 오류'}\n같은 명령을 다시 실행하면 이어서 수집합니다.`); process.exit(2); }
        await sleep(delay * 5 * attempt);
      }
    }
    for (const doc of result.documents) if (!seen.has(doc.id)) { seen.add(doc.id); state.documents.push(doc); }
    Object.assign(progress, { page, totalPages: result.totalPages, totalAvailable: result.total, done: page >= result.totalPages || result.rowsRead === 0 || Boolean(result.windowEnded), warnings: progress.warnings + result.warnings.length });
    process.stdout.write(`\r[${CASE_TRACKS[track].label}] ${page}/${result.totalPages}페이지 · 누적 ${state.documents.length}건   `);
    if (page % 5 === 0 || progress.done) await save();
    await sleep(delay);
  }
  process.stdout.write('\n');
}
await save();
const withBody = state.documents.filter(doc => doc.body).length;
console.log(`완료: ${state.documents.length}건 (본문 ${withBody} · 제목·링크 ${state.documents.length - withBody}). 관리자 화면 → 판례 수집 → "수집 파일 올리기"에서 이 파일을 선택하세요. 공개는 검토 후 별도로 진행됩니다.`);
