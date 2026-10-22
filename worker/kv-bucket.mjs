// R2-shaped adapter over Workers KV for the Cloudflare free plan (R2 needs a
// payment method on the account). Only the calls the runtime makes are covered:
// get(key, { onlyIf: { etagDoesNotMatch } }), put(key, value, { onlyIf }), delete.
// Each object keeps its etag in a small sibling key so an unchanged store can be
// detected without downloading the full value.
//
// KV has no atomic compare-and-swap and is eventually consistent between
// locations, so the conditional checks below protect one administrator working
// at a time, not concurrent writers. KV values are limited to 25 MB.
export function kvBucket(kv) {
  const tagKey = key => `${key}#etag`;
  return {
    async get(key, options) {
      const etag = await kv.get(tagKey(key));
      if (etag === null) return null;
      if (options?.onlyIf?.etagDoesNotMatch && options.onlyIf.etagDoesNotMatch === etag) return { etag };
      const text = await kv.get(key);
      if (text === null) return null;
      return { etag, json: async () => JSON.parse(text) };
    },
    async put(key, value, options = {}) {
      const current = await kv.get(tagKey(key));
      if (options.onlyIf?.etagMatches && current !== options.onlyIf.etagMatches) return null;
      if (options.onlyIf?.etagDoesNotMatch === '*' && current !== null) return null;
      const etag = crypto.randomUUID();
      await kv.put(key, typeof value === 'string' ? value : JSON.stringify(value));
      await kv.put(tagKey(key), etag);
      return { etag };
    },
    async delete(key) {
      await kv.delete(key);
      await kv.delete(tagKey(key));
    },
  };
}
