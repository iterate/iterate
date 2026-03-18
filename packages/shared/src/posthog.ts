export interface ProxyPosthogRequestOptions {
  request: Request;
  proxyPrefix: string;
  apiHost?: string;
  assetHost?: string;
}

export async function proxyPosthogRequest(options: ProxyPosthogRequestOptions): Promise<Response> {
  const apiHost = options.apiHost ?? "eu.i.posthog.com";
  const assetHost = options.assetHost ?? "eu-assets.i.posthog.com";
  const url = new URL(options.request.url);
  const posthogPath = url.pathname.replace(new RegExp(`^${options.proxyPrefix}`), "");
  const targetHost = posthogPath.startsWith("/static/") ? assetHost : apiHost;
  const posthogUrl = `https://${targetHost}${posthogPath}${url.search}`;
  const headers = new Headers(options.request.headers);
  headers.set("Host", targetHost);
  headers.set("X-Forwarded-Host", url.hostname);
  headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
  headers.delete("cookie");
  headers.delete("connection");

  const upstreamResponse = await fetch(posthogUrl, {
    method: options.request.method,
    headers,
    body:
      options.request.method !== "GET" && options.request.method !== "HEAD"
        ? await options.request.arrayBuffer()
        : undefined,
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  if (responseHeaders.has("content-encoding")) {
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
  }

  return new Response(await upstreamResponse.arrayBuffer(), {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}
