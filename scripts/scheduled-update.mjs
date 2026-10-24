// Weekday update job for a self-managed host: signs the fixed update route with
// LAW_UPDATE_SIGNING_KEY (see worker/scheduler-auth.mjs) and calls the local
// server. One call checks the next batch of 16 laws and the last 30 days of cases.
//
//   node --env-file=/etc/moungsoo/env scripts/scheduled-update.mjs
import { createHash, createHmac } from 'node:crypto';

const key = process.env.LAW_UPDATE_SIGNING_KEY || '';
if (!/^[a-f\d]{64}$/i.test(key)) { console.error('LAW_UPDATE_SIGNING_KEY (64 hex) is required.'); process.exit(1); }
const port = Number(process.env.PORT || 3000), body = '{}', path = '/api/updates/laws/run';
const timestamp = String(Math.floor(Date.now() / 1000));
const digest = createHash('sha256').update(body).digest('hex');
const signature = createHmac('sha256', Buffer.from(key, 'hex')).update(`POST\n${path}\n${timestamp}\n${digest}`).digest('hex');
const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Law-Update-Timestamp': timestamp, 'X-Law-Update-Signature': signature }, body });
const result = await response.json().catch(() => ({}));
const summary = { status: response.status, state: result.state, staged: result.staged?.length ?? 0, unchanged: result.unchanged?.length ?? 0, errors: result.errors?.length ?? 0, recentCases: result.recentCases, reason: result.reason };
console.log(JSON.stringify(summary));
if (!response.ok || result.state === 'failed') process.exitCode = 2;
