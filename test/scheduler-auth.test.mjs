import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { verifySchedulerRequest } from '../worker/scheduler-auth.mjs';

// Isolated fixture, unrelated to any deployed credential.
const key = createHash('sha256').update('isolated-scheduler-auth-test-only').digest('hex');
const env = { LAW_UPDATE_SIGNING_KEY: key };
const path = '/api/updates/laws/run';
const now = 1792291200;
function signed({ body = '{}', signedBody = body, timestamp = String(now), signature, route = path, method = 'POST', headers = {} } = {}) {
  const digest = createHash('sha256').update(signedBody).digest('hex');
  const message = `POST\n${path}\n${timestamp}\n${digest}`;
  return new Request(`https://reference.test${route}`, {
    method,
    headers: {
      'X-Law-Update-Timestamp': timestamp,
      'X-Law-Update-Signature': signature ?? createHmac('sha256', Buffer.from(key, 'hex')).update(message).digest('hex'),
      ...headers,
    },
    ...(!['GET', 'HEAD'].includes(method) ? { body } : {}),
  });
}
const fixedTime = (t, fn) => { t.mock.method(Date, 'now', () => now * 1000); return fn(); };

test('scheduler accepts a current signature and preserves the original body', t => fixedTime(t, async () => {
  const request = signed({ body: '{"source":"법령"}' });
  assert.equal(await verifySchedulerRequest(request, env), true);
  assert.equal(request.bodyUsed, false);
  assert.equal(await request.text(), '{"source":"법령"}');
}));

test('scheduler accepts the clock-skew boundaries but rejects stale or future signatures', t => fixedTime(t, async () => {
  for (const delta of [-300, 0, 300]) assert.equal(await verifySchedulerRequest(signed({ timestamp: String(now + delta) }), env), true);
  for (const delta of [-301, 301]) assert.equal(await verifySchedulerRequest(signed({ timestamp: String(now + delta) }), env), false);
}));

test('scheduler rejects altered bodies, signatures, and unconfigured or malformed keys', t => fixedTime(t, async () => {
  assert.equal(await verifySchedulerRequest(signed({ body: '{"changed":true}', signedBody: '{}' }), env), false);
  assert.equal(await verifySchedulerRequest(signed({ signature: '0'.repeat(64) }), env), false);
  for (const badEnv of [{}, { LAW_UPDATE_SIGNING_KEY: 'short' }, { LAW_UPDATE_SIGNING_KEY: 'g'.repeat(64) }]) {
    assert.equal(await verifySchedulerRequest(signed(), badEnv), false);
  }
}));

test('scheduler authority is restricted to POST on the fixed updater route', t => fixedTime(t, async () => {
  for (const route of ['/api/admin/documents', '/api/admin/law-connection', '/api/updates/laws/run/', '/api/updates/status']) {
    assert.equal(await verifySchedulerRequest(signed({ route }), env), false);
  }
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal(await verifySchedulerRequest(signed({ method }), env), false);
}));

test('missing and malformed headers fail before the body is read', t => fixedTime(t, async () => {
  for (const [name, value] of [
    ['X-Law-Update-Timestamp', ''], ['X-Law-Update-Timestamp', '1.2'],
    ['X-Law-Update-Timestamp', '0' + now], ['X-Law-Update-Timestamp', String(now - 301)],
    ['X-Law-Update-Signature', ''], ['X-Law-Update-Signature', 'g'.repeat(64)],
    ['content-length', '4097'], ['content-length', 'bad'],
  ]) {
    const request = signed({ headers: { [name]: value } });
    let cloned = false;
    request.clone = () => { cloned = true; throw new Error('body must not be read'); };
    assert.equal(await verifySchedulerRequest(request, env), false);
    assert.equal(cloned, false);
    assert.equal(request.bodyUsed, false);
  }
}));

test('scheduler caps the body at 4096 bytes independently of content-length', t => fixedTime(t, async () => {
  assert.equal(await verifySchedulerRequest(signed({ body: 'x'.repeat(4096) }), env), true);
  assert.equal(await verifySchedulerRequest(signed({ body: 'x'.repeat(4097) }), env), false);
  assert.equal(await verifySchedulerRequest(signed({ body: '가'.repeat(1366) }), env), false);
  assert.equal(await verifySchedulerRequest(signed({ body: 'x'.repeat(4097), headers: { 'content-length': '2' } }), env), false);
}));

test('scheduler fails closed on unreadable bodies', t => fixedTime(t, async () => {
  const request = signed();
  await request.text();
  assert.equal(await verifySchedulerRequest(request, env), false);
}));
