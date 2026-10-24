// Production Node server for a self-managed host (e.g. an Oracle Cloud VM behind
// Caddy). Same request handler as the Worker; storage is a local directory with
// the same conditional-write semantics as scripts/dev.mjs.
//
//   HOST=127.0.0.1 PORT=3000 PUBLIC_HOSTS=example.sslip.io DATA_DIR=/var/lib/moungsoo node scripts/server.mjs
//
// Listen on loopback only and let the reverse proxy terminate HTTPS: the admin
// session cookie is Secure. Identity headers from clients are never trusted.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { handleRequest } from '../worker/runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const storeRoot = resolve(process.env.DATA_DIR || resolve(root, '.local-data'));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT must be an integer between 1 and 65535.');
const token = process.env.ADMIN_TOKEN?.trim() || '';
if (token && token.length < 24) throw Error('Use at least 24 characters for ADMIN_TOKEN. Its value is never printed.');
// Host headers accepted: the public names served by the proxy plus loopback (for
// the scheduled update job on the same machine).
const allowedHosts = new Set([...(process.env.PUBLIC_HOSTS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean), `127.0.0.1:${port}`, `localhost:${port}`]);

const hash = value => createHash('sha256').update(value).digest('hex');
function objectPath(key) { const path = resolve(storeRoot, key); if (!path.startsWith(storeRoot + sep) || key.includes('\0')) throw Error('Invalid storage key.'); return path; }
async function load(key) { try { return await readFile(objectPath(key), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
let storageQueue = Promise.resolve();
function exclusive(operation) { const next = storageQueue.then(operation); storageQueue = next.catch(() => {}); return next; }
// Etags are cached per key so unchanged reads do not hash the whole object again.
const etags = new Map();
const bucket = {
  async get(key, options) {
    const value = await load(key);
    if (value === null) { etags.delete(key); return null; }
    const etag = hash(value); etags.set(key, etag);
    if (options?.onlyIf?.etagDoesNotMatch && options.onlyIf.etagDoesNotMatch === etag) return { etag };
    return { etag, json: async () => JSON.parse(value) };
  },
  put(key, value, options = {}) {
    return exclusive(async () => {
      const prior = await load(key);
      if (options.onlyIf?.etagMatches && (prior === null || hash(prior) !== options.onlyIf.etagMatches)) return null;
      if (options.onlyIf?.etagDoesNotMatch === '*' && prior !== null) return null;
      const path = objectPath(key), temp = `${path}.${randomUUID()}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temp, value, { mode: 0o600 });
      await rename(temp, path);
      const etag = hash(value); etags.set(key, etag);
      return { etag };
    });
  },
  delete(key) { return exclusive(async () => { etags.delete(key); try { await unlink(objectPath(key)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }); },
};

const env = { BUCKET: bucket, ADMIN_TOKEN: token };
for (const name of ['LAW_API_OC', 'LAW_UPDATE_SIGNING_KEY', 'HOLIDAY_API_KEY']) if (process.env[name]) env[name] = process.env[name];

// Seed data and static assets are read once; restart the service after an update.
const seed = JSON.parse(await readFile(resolve(root, 'data/seed.json'), 'utf8')), assets = {};
for (const file of ['index.html', 'app.js', 'styles.css', 'favicon.svg']) assets['/' + file] = await readFile(resolve(root, 'public', file), 'utf8');

const server = createServer(async (incoming, outgoing) => {
  try {
    const requestHost = String(incoming.headers.host || '').toLowerCase();
    if (!allowedHosts.has(requestHost)) { outgoing.writeHead(421); outgoing.end('Unknown host.'); return; }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (/^oai-|^x-forwarded-|^cf-|^x-real-ip$/i.test(name) || value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(',') : value);
    }
    const chunks = []; let size = 0;
    for await (const chunk of incoming) { size += chunk.length; if (size > 32 * 1024 * 1024) { outgoing.writeHead(413); outgoing.end('Request body exceeds 32 MB.'); return; } chunks.push(chunk); }
    const body = Buffer.concat(chunks), method = incoming.method || 'GET';
    const scheme = requestHost.startsWith('127.0.0.1') || requestHost.startsWith('localhost') ? 'http' : 'https';
    const request = new Request(`${scheme}://${requestHost}${incoming.url || '/'}`, { method, headers, ...(body.length && !['GET', 'HEAD'].includes(method) ? { body } : {}) });
    const response = await handleRequest(request, env, { waitUntil: promise => promise.catch(() => {}) }, seed, assets);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    outgoing.end('Server error. No credentials are logged.');
  }
});
server.listen(port, host, () => console.log(`Listening on ${host}:${port} · hosts: ${[...allowedHosts].join(', ')} · admin token: ${token ? 'configured' : 'not configured'} · data: ${storeRoot}`));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Port in use.' : 'Could not start the server.'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
