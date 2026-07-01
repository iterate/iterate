/**
 * Coexistence routing for the next engine.
 *
 * While the legacy stack owns `/api/itx`, the next engine is reachable through
 * three path lanes forwarded to the next API worker (NEXT_API service
 * binding) by both the ingress worker (deployed) and the app worker (local
 * dev, where the browser talks to vite directly):
 *
 *   /api/itx-next[...]  → /api/itx[...] on the next API worker (capnweb)
 *   /__itx_e2e/...      → worker-hosted e2e fixtures
 *   /prj_<id>/...       → next-engine project ingress path lane
 *
 * At cutover the next engine takes over `/api/itx` and this module dies.
 */
export const NEXT_ITX_API_PATH = "/api/itx-next";

export function nextEngineRequest(request: Request): Request | null {
  const url = new URL(request.url);

  if (url.pathname === NEXT_ITX_API_PATH || url.pathname.startsWith(`${NEXT_ITX_API_PATH}/`)) {
    url.pathname = `/api/itx${url.pathname.slice(NEXT_ITX_API_PATH.length)}`;
    return new Request(url, request);
  }

  if (url.pathname === "/api/login-next") {
    url.pathname = "/api/login";
    return new Request(url, request);
  }

  if (url.pathname.startsWith("/__itx_e2e/")) return request;
  if (/^\/prj_[^/]/.test(url.pathname)) return request;

  return null;
}
