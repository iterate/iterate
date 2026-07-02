/**
 * Ingress routing for the next engine — the single decision both the ingress
 * worker (deployed) and the app worker (local dev, where the browser talks to
 * vite directly) run before falling through to the dashboard pipeline.
 *
 * Two lanes land on the next API worker (NEXT_API service binding):
 *
 *   Path lanes, on the OS host:
 *     /api/itx[...]   → capnweb surface (+ /api/itx/admin-cookie bridge)
 *     /__itx_e2e/...  → worker-hosted e2e fixtures
 *     /prj_<id>/...   → project ingress by id
 *
 *   Project platform hosts (`<slug>.<base>`, `<slug>.localhost:<port>`): the
 *   whole request forwards untouched; the API worker resolves slug → project
 *   id through the auth worker's directory and dispatches to the project
 *   worker (src/next/workers/api.ts).
 */
import { normalizeIngressHost } from "~/ingress/host-headers.ts";
import { parseProjectPlatformHosts } from "~/ingress/project-platform-host-routing.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";

export function isNextEnginePath(pathname: string): boolean {
  if (pathname === "/api/itx" || pathname.startsWith("/api/itx/")) return true;
  if (pathname.startsWith("/__itx_e2e/")) return true;
  if (/^\/prj_[^/]/.test(pathname)) return true;
  return false;
}

/**
 * The externally-visible host for a request: tunnels (captun) and the ingress
 * worker present the original host via forwarding headers; otherwise the
 * request URL is already the truth.
 */
export function requestIngressHost(request: Request): string {
  return normalizeIngressHost(
    request.headers.get("x-iterate-ingress-hostname") ??
      request.headers.get("x-forwarded-host")?.replace(/:\d+$/, "") ??
      new URL(request.url).hostname,
  );
}

/**
 * Classify a request against the OS host and the project platform hosts.
 *
 *   "os"      — the dashboard/app lane (or, for engine paths, NEXT_API)
 *   "project" — a project platform host; forward whole to NEXT_API
 *   null      — no lane matched (deployed ingress 404s; dev falls through
 *               to the app pipeline, which serves plain-localhost aliases)
 */
export function classifyIngressHost(input: {
  config: { baseUrl?: string; projectHostnameBases?: readonly string[] };
  request: Request;
}): "os" | "project" | null {
  const host = requestIngressHost(input.request);
  const bases = input.config.projectHostnameBases ?? [];

  // No configured baseUrl (workers.dev previews): the request's own origin is
  // the app — same fallback the legacy router used.
  const appHostname = normalizeIngressHost(
    new URL(input.config.baseUrl ?? input.request.url).hostname,
  );
  if (host === appHostname) return "os";
  // Local dev serves the app on the bare loopback base itself.
  if (isLoopbackAppHostAlias(host, bases)) return "os";

  if (parseProjectPlatformHosts({ bases, host }).length > 0) return "project";

  return null;
}

function isLoopbackAppHostAlias(requestHost: string, projectHostnameBases: readonly string[]) {
  return projectHostnameBases.some((rawBase) => {
    const base = normalizeIngressHost(normalizeProjectHostnameBase(rawBase));
    return requestHost === base && (base === "localhost" || base.endsWith(".localhost"));
  });
}

/**
 * The request to forward to the next API worker, or null for the app lane.
 * One call site shape for both the ingress worker and the app worker.
 */
export function nextEngineRequest(input: {
  config: { baseUrl?: string; projectHostnameBases?: readonly string[] };
  request: Request;
}): Request | null {
  if (classifyIngressHost(input) === "project") return input.request;
  // Engine path lanes are reserved on every host the app serves (deployed
  // workers.dev previews have no configured baseUrl, so the lane may be null).
  if (isNextEnginePath(new URL(input.request.url).pathname)) return input.request;
  return null;
}
