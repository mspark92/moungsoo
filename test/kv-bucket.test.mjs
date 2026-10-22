import test from 'node:test';
import assert from 'node:assert/strict';
import { kvBucket } from '../worker/kv-bucket.mjs';

// In-memory stand-in for a Workers KV namespace (string values only).
function fakeKV() {
  const map = new Map();
  return { map, get: async key => map.has(key) ? map.get(key) : null, put: async (key, value) => { map.set(key, String(value)); }, delete: async key => { map.delete(key); } };
}

test('KV adapter honours the R2 conditional calls the runtime relies on', async () => {
  const bucket = kvBucket(fakeKV());
  assert.equal(await bucket.get('state.json'), null);
  const first = await bucket.put('state.json', '{"a":1}', { onlyIf: { etagDoesNotMatch: '*' } });
  assert.ok(first.etag);
  assert.equal(await bucket.put('state.json', '{"a":2}', { onlyIf: { etagDoesNotMatch: '*' } }), null, 'create-only write refused when present');
  assert.equal(await bucket.put('state.json', '{"a":2}', { onlyIf: { etagMatches: 'stale' } }), null, 'stale etag refused');
  const second = await bucket.put('state.json', '{"a":2}', { onlyIf: { etagMatches: first.etag } });
  const read = await bucket.get('state.json');
  assert.equal(read.etag, second.etag); assert.deepEqual(await read.json(), { a: 2 });
  const unchanged = await bucket.get('state.json', { onlyIf: { etagDoesNotMatch: second.etag } });
  assert.equal(unchanged.etag, second.etag); assert.equal(typeof unchanged.json, 'undefined', 'no body when unchanged');
  await bucket.delete('state.json');
  assert.equal(await bucket.get('state.json'), null);
});

test('the built Worker uses KV as its store when no R2 bucket is bound', async () => {
  const { default: worker } = await import('../worker/index.js');
  const KV = fakeKV(), env = { KV, ADMIN_TOKEN: 'isolated-kv-bundle-test-token' };
  const call = async (path, init = {}) => worker.fetch(new Request('https://kv.test' + path, init), env, {});
  const status = await (await call('/api/status')).json();
  assert.equal(status.storageConfigured, true);
  const login = await call('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: env.ADMIN_TOKEN }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const created = await call('/api/admin/documents', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ title: 'KV 저장 확인용 격리 자료', domain: 'tax', type: 'guide', agency: '시험', reviewStatus: 'draft' }) });
  assert.equal(created.status, 201);
  assert.ok(KV.map.has('reference-state-v1.json') && KV.map.has('reference-state-v1.json#etag'));
  const list = await (await call('/api/admin/documents', { headers: { cookie } })).json();
  assert.ok(list.documents.some(doc => doc.title === 'KV 저장 확인용 격리 자료'));
  // A Sites-style identity header is not trusted when no allowlist is configured.
  const spoofed = await call('/api/admin/documents', { headers: { 'oai-authenticated-user-email': 'someone@example.test' } });
  assert.equal(spoofed.status, 401);
});
