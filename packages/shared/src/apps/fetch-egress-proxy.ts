/**
 * Build the `fetch` override used by app-style Workers when
 * `BaseAppConfig.externalEgressProxy` is set.
 *
 * This is the concrete runtime behavior behind the shared app config in
 * `packages/shared/src/apps/config.ts`, and is installed at the worker boundary
 * in files like `apps/agents/src/entry.workerd.ts`.
 *
 * We intentionally forward requests using the same `x-forwarded-host` and
 * `x-forwarded-proto` contract that `packages/mock-http-proxy` already consumes
 * in `src/server/proxy-request-transform.ts`, so the app-side egress feature
 * and the repo's mock/replay tooling agree on how the original destination is
 * represented.
 *
 * We construct `new Request(proxyUrl, request)` because Cloudflare Workers
 * requests are immutable and the first-party docs recommend cloning when you
 * need to rewrite URL/header state:
 * https://developers.cloudflare.com/workers/runtime-apis/request
 */
export function createExternalEgressProxyFetch(options: {
  fetch: typeof globalThis.fetch;
  externalEgressProxy: string;
}) {
  const nativeFetch = options.fetch;
  const externalEgressProxy = new URL(options.externalEgressProxy);

  return (input: Request | URL | string, init?: RequestInit) => {
    const request = new Request(input, init);
    const requestUrl = new URL(request.url);

    if (shouldBypassProxy(requestUrl, externalEgressProxy)) {
      return nativeFetch(request);
    }

    const proxyUrl = new URL(externalEgressProxy);
    proxyUrl.pathname = joinProxyPath(proxyUrl.pathname, requestUrl.pathname);
    proxyUrl.search = requestUrl.search;

    const proxyRequest = new Request(proxyUrl, request);
    proxyRequest.headers.set("host", proxyUrl.host);
    proxyRequest.headers.set("x-forwarded-host", requestUrl.host);
    proxyRequest.headers.set("x-forwarded-proto", requestUrl.protocol.replace(/:$/, ""));

    return nativeFetch(proxyRequest);
  };
}

function shouldBypassProxy(requestUrl: URL, proxyBaseUrl: URL) {
  if (!isHttpRequest(requestUrl)) {
    return true;
  }

  return requestUrl.origin === proxyBaseUrl.origin;
}

function isHttpRequest(url: URL) {
  return url.protocol === "http:" || url.protocol === "https:";
}

function joinProxyPath(proxyBasePathname: string, requestPathname: string) {
  const normalizedBasePathname =
    proxyBasePathname === "/" ? "" : proxyBasePathname.replace(/\/+$/, "");
  return `${normalizedBasePathname}${requestPathname}`;
}
