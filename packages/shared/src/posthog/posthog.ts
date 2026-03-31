export interface ProxyPosthogRequestOptions {
  request: Request;
  proxyPrefix: string;
  apiHost?: string;
  assetHost?: string;
}

function isNullBodyStatus(status: number) {
  return status === 101 || status === 103 || status === 204 || status === 205 || status === 304;
}

function upstreamRequestBody(request: Request): ReadableStream<Uint8Array> | undefined {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  // Stream the body through instead of buffering (same idea as forwarding `c.req.raw.body` in Workers).
  return request.body ?? undefined;
}

export async function proxyPosthogRequest(options: ProxyPosthogRequestOptions): Promise<Response> {
  const apiHost = options.apiHost ?? "eu.i.posthog.com";
  const assetHost = options.assetHost ?? "eu-assets.i.posthog.com";
  const url = new URL(options.request.url);
  const posthogPath = url.pathname.replace(new RegExp(`^${options.proxyPrefix}`), "");
  // PostHog serves the JS bundle and related assets from a separate host; only the ingest API lives on `apiHost`.
  const targetHost = posthogPath.startsWith("/static/") ? assetHost : apiHost;
  const posthogUrl = `https://${targetHost}${posthogPath}${url.search}`;
  const headers = new Headers(options.request.headers);
  headers.set("Host", targetHost);
  headers.set("X-Forwarded-Host", url.hostname);
  headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
  // Cloudflare sets the end-user IP here; PostHog uses X-Forwarded-For for geo/session features.
  const clientIp = options.request.headers.get("cf-connecting-ip");
  if (clientIp) {
    headers.set("X-Forwarded-For", clientIp);
  }
  // Do not forward site cookies to PostHog’s origin (first-party session leakage).
  headers.delete("cookie");
  // Hop-by-hop header; fetch will set Connection as needed for the upstream request.
  headers.delete("connection");

  const forwardBody = upstreamRequestBody(options.request);
  const upstreamResponse = await fetch(posthogUrl, {
    method: options.request.method,
    headers,
    body: forwardBody,
    // Undici (Node) requires `duplex` when forwarding a stream body; Workers accept it (types omit it).
    ...(forwardBody ? { duplex: "half" as const } : {}),
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  // We materialize the body below; drop encoding headers so clients do not try to decode twice.
  if (responseHeaders.has("content-encoding")) {
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
  }

  const body = isNullBodyStatus(upstreamResponse.status)
    ? null
    : await upstreamResponse.arrayBuffer();

  return new Response(body, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}
