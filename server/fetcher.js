// Small JSON fetch helper with an in-memory TTL cache, ETag revalidation,
// request de-duplication, timeouts and retries.

const cache = new Map(); // url -> { data, etag, expires }
const inflight = new Map();
const MAX_ENTRIES = 5000;

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
    this.body = body;
  }
}

async function fetchOnce(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(url, { headers = {}, ttlMs = 60_000, retries = 2, timeoutMs = 12_000 } = {}) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.data;
  if (inflight.has(url)) return inflight.get(url);

  const task = (async () => {
    const h = { Accept: "application/json", "User-Agent": "frc-match-predictor", ...headers };
    if (hit?.etag) h["If-None-Match"] = hit.etag;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchOnce(url, h, timeoutMs);
        if (res.status === 304 && hit) {
          hit.expires = Date.now() + ttlMs;
          return hit.data;
        }
        const text = await res.text();
        if (!res.ok) throw new HttpError(res.status, url, text.slice(0, 300));
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          throw new HttpError(502, url, "Response was not JSON");
        }
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(url, { data, etag: res.headers.get("etag"), expires: Date.now() + ttlMs });
        return data;
      } catch (err) {
        lastErr = err;
        // Don't retry client errors (bad key, missing resource).
        if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) break;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
      }
    }
    // Serve stale data rather than nothing when the upstream is down.
    if (hit) return hit.data;
    throw lastErr;
  })();

  inflight.set(url, task);
  try {
    return await task;
  } finally {
    inflight.delete(url);
  }
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
