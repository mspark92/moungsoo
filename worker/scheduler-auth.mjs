const UPDATE_PATH = '/api/updates/laws/run';
const MAX_BODY_BYTES = 4096;
const MAX_CLOCK_SKEW_SECONDS = 300;
const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g), byte => Number.parseInt(byte, 16));

// A clone preserves the request body for the updater. Never wait for cancellation
// of a cloned/teed stream: its other branch belongs to the request handler.
async function boundedBody(request) {
  const clone = request.clone();
  if (!clone.body) return new Uint8Array();
  const reader = clone.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    reader.releaseLock();
  }
}

// The scheduler's authority is limited to this updater. It cannot authenticate
// document administration, credential settings, or an ordinary visitor session.
export async function verifySchedulerRequest(request, env) {
  try {
    if (request.method !== 'POST' || new URL(request.url).pathname !== UPDATE_PATH) return false;
    const keyHex = env?.LAW_UPDATE_SIGNING_KEY;
    const timestamp = request.headers.get('X-Law-Update-Timestamp');
    const signature = request.headers.get('X-Law-Update-Signature');
    if (typeof keyHex !== 'string' || !/^[a-f\d]{64}$/i.test(keyHex)) return false;
    if (!timestamp || !/^[1-9]\d{0,11}$/.test(timestamp)) return false;
    if (!signature || !/^[a-f\d]{64}$/i.test(signature)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) return false;
    const length = request.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return false;
    const body = await boundedBody(request);
    if (!body) return false;
    const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', body)));
    const payload = encoder.encode(`POST\n${UPDATE_PATH}\n${timestamp}\n${digest}`);
    const key = await crypto.subtle.importKey('raw', unhex(keyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, unhex(signature), payload);
  } catch {
    return false;
  }
}
