/** Forward a browser SDK request under `proxyPrefix` to PostHog's EU region, as PostHog's Cloudflare
 *  Worker proxy does (https://posthog.com/docs/advanced/proxy/cloudflare): the SDK's assets to the
 *  asset host, everything else to ingest with the visitor's IP and without this app's cookies or
 *  credentials. The body is read whole first, the guide's fix for POSTs that never reach PostHog. */
export async function proxyPosthogRequest(options: {
  request: Request;
  proxyPrefix: string;
}): Promise<Response> {
  const apiHost = "eu.i.posthog.com";
  const assetHost = "eu-assets.i.posthog.com";
  const url = new URL(options.request.url);
  const posthogPath = url.pathname.slice(options.proxyPrefix.length);
  const isAsset = posthogPath.startsWith("/static/") || posthogPath.startsWith("/array/");
  const targetHost = isAsset ? assetHost : apiHost;
  const posthogUrl = `https://${targetHost}${posthogPath}${url.search}`;
  const headers = isAsset ? undefined : new Headers(options.request.headers);
  headers?.delete("cookie");
  headers?.delete("authorization");
  headers?.delete("connection");
  // fetch sets PostHog's own from the URL.
  headers?.delete("host");
  const clientIp = options.request.headers.get("cf-connecting-ip");
  if (headers && clientIp) headers.set("X-Forwarded-For", clientIp);

  const body =
    options.request.method === "GET" || options.request.method === "HEAD"
      ? undefined
      : await options.request.arrayBuffer();
  return fetch(posthogUrl, {
    method: options.request.method,
    headers,
    body,
    redirect: options.request.redirect,
  });
}
