/**
 * A fetch wrapper for typm's CDN traffic: dedupes concurrent requests
 * in memory and persists successful responses to the Cache API (available in
 * both windows and workers) so the same package@version is never downloaded
 * twice across sessions.
 *
 * Only pass `shouldCache: true` URLs that are immutable — exact-versioned
 * jsdelivr listings and file contents. Range-resolution URLs must stay
 * uncached (new releases change their answers). Environments without a
 * usable Cache API degrade to in-memory-only silently.
 */
export function createCachedFetch(input: {
  fetch: (url: string) => Promise<Response>;
  cacheName: string;
  shouldCache: (url: string) => boolean;
}): (url: string) => Promise<Response> {
  const inFlight = new Map<string, Promise<{ status: number; body: string }>>();

  const load = async (url: string): Promise<{ status: number; body: string }> => {
    const cache = await openCache(input.cacheName);
    if (cache) {
      const hit = await cache.match(url).catch(() => undefined);
      if (hit) return { status: hit.status, body: await hit.text() };
    }
    const response = await input.fetch(url);
    const body = await response.text();
    if (cache && response.ok) {
      await cache
        .put(url, new Response(body, { status: response.status, headers: response.headers }))
        .catch(() => {});
    }
    return { status: response.status, body };
  };

  return async (url: string): Promise<Response> => {
    if (!input.shouldCache(url)) return input.fetch(url);
    let pending = inFlight.get(url);
    if (!pending) {
      pending = load(url);
      // Never memoize failures: a flaky 502 shouldn't poison the session.
      pending = pending.then((result) => {
        if (result.status < 200 || result.status >= 300) inFlight.delete(url);
        return result;
      });
      pending.catch(() => inFlight.delete(url));
      inFlight.set(url, pending);
    }
    const { status, body } = await pending;
    return new Response(body, { status });
  };
}

async function openCache(cacheName: string): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(cacheName);
  } catch {
    return null;
  }
}
