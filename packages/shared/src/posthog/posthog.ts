export interface ProxyPosthogRequestOptions {
  request: Request;
  proxyPrefix: string;
  apiHost?: string;
  assetHost?: string;
}

export async function proxyPosthogRequest(options: ProxyPosthogRequestOptions): Promise<Response> {
  const apiHost = options.apiHost || "eu.i.posthog.com";
  const assetHost = options.assetHost || "eu-assets.i.posthog.com";
  const url = new URL(options.request.url);
  const posthogPath = url.pathname.slice(options.proxyPrefix.length);
  const isAsset = posthogPath.startsWith("/static/") || posthogPath.startsWith("/array/");
  const targetHost = isAsset ? assetHost : apiHost;
  const posthogUrl = `https://${targetHost}${posthogPath}${url.search}`;
  const headers = isAsset ? undefined : new Headers(options.request.headers);
  headers?.delete("cookie");
  headers?.delete("connection");
  headers?.set("Host", targetHost);
  const clientIp = options.request.headers.get("cf-connecting-ip");
  if (headers && clientIp) headers.set("X-Forwarded-For", clientIp);

  const body =
    options.request.method === "GET" || options.request.method === "HEAD"
      ? undefined
      : (options.request.body ?? undefined);
  return fetch(posthogUrl, {
    method: options.request.method,
    headers,
    body,
    redirect: options.request.redirect,
    // Node's fetch requires this for stream bodies; Workers harmlessly ignore it.
    ...(body ? { duplex: "half" as const } : {}),
  });
}
