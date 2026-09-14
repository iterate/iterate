/** Only content-addressed filter data is public; the rest of STATE_BUCKET
 * holds private install/channel state. JavaScript stays in the app bundle. */
export async function handleFilterAssetRequest(request: Request, bucket: R2Bucket) {
  const headers = new Headers({
    // Expo DOM components use a file:// origin in release builds. Anonymous
    // CORS also keeps remotely drawn images from tainting captured canvases.
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  const path = new URL(request.url).pathname;
  // New names have readable prefixes; keep hash-only URLs for older apps.
  const match =
    /^\/filter-assets\/(?:[a-z0-9]+-)*([a-f0-9]{64})\.(png|jpeg|wasm\.gz|task\.gz)$/.exec(path);
  if (!match) return new Response("not found", { status: 404, headers });
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("allow", "GET, HEAD");
    return new Response("method not allowed", { status: 405, headers });
  }
  const object = await bucket.get(path.slice(1));
  if (!object) return new Response("not found", { status: 404, headers });
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set(
    "content-type",
    match[2] === "png" ? "image/png" : match[2] === "jpeg" ? "image/jpeg" : "application/gzip",
  );
  // Gzip files deliberately have no Content-Encoding: the client unpacks
  // the fetched bytes explicitly, including in WKWebView on file://.
  if (request.headers.get("if-none-match") === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}
