/**
 * The ONE hostname/path-level routing decision for OS traffic, shared by the
 * ingress worker (deployed), the app worker (local dev, where the browser
 * talks to vite directly), and the api worker (which resolves project
 * targets). Same shape as the pre-migration router: `decideIngressRoute`
 * takes url + method + headers and answers with the lane — and, for the
 * project lane, the exact url + headers to fetch onward with. Header
 * stripping at the trust boundary is a separate layer
 * (`stripInternalHeaders` in workers/ingress.ts).
 *
 * Lanes:
 *
 *   "os"       — the dashboard/app pipeline (OS host, non-engine paths)
 *   "api"      — engine path lanes on the OS host: /api/itx[...] and
 *                /__itx_e2e/...
 *   "project"  — a project worker target, resolved from:
 *                  /prj_<id>/...                      (URL rewritten)
 *                  prj_<id>.<base>, <slug>.<base>     (URL untouched)
 *                  <app>--<slug>.<base>, <app>.<slug>.<base>,
 *                  <app>__<slug>.<base>               (app rides as the
 *                                                     trusted x-iterate-app)
 *                  <custom-hostname>, <app>.<custom-hostname>
 *   "notFound" — a non-OS host that resolves to nothing
 *
 * The resolved project id always rides as `x-itx-project-id`; `x-iterate-app`
 * is ALWAYS overwritten (set or deleted) so the outside world can never pick
 * an app the host didn't select. Directory lookups are injected (`resolvers`)
 * so the decision itself is unit-testable — the real resolvers live in
 * project-directory.ts (KV in front of the auth worker).
 */
import { normalizeIngressHost } from "~/ingress/host-headers.ts";
import { parseProjectPlatformHosts } from "~/ingress/project-platform-host-routing.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";

export type IngressResolvers = {
  /** Slug (or prj_ id, passed through) -> project id. */
  projectIdBySlug(identifier: string): Promise<string | null>;
  /** Registered custom hostname (exact or `<app>.<registered>`) -> target. */
  projectByHostname(host: string): Promise<{ projectId: string; appSlug: string | null } | null>;
};

export type IngressRoute =
  | { lane: "os" }
  | { lane: "api" }
  | {
      lane: "project";
      fetch: { headers: Headers; method: string; url: string };
      resolved: { appSlug: string | null; projectId: string };
    }
  | { lane: "notFound" };

export async function decideIngressRoute(input: {
  config: { baseUrl?: string; projectHostnameBases?: readonly string[] };
  headers?: HeadersInit;
  method: string;
  resolvers: IngressResolvers;
  url: string;
}): Promise<IngressRoute> {
  const headers = new Headers(input.headers);
  const url = new URL(input.url);
  const host = requestIngressHostFrom(headers, url);
  const bases = input.config.projectHostnameBases ?? [];

  if (isOsHost({ baseUrl: input.config.baseUrl, bases, host, requestUrl: url })) {
    const [head, ...pathSegments] = url.pathname.split("/").filter(Boolean);
    if (head !== undefined && head.startsWith("prj_")) {
      // The /prj_<id>/... path lane: the project worker sees the sub-path,
      // and the stripped prefix rides along so workers can render URLs the
      // BROWSER can use (e.g. form actions) — on host lanes there is no
      // prefix and the header is absent.
      const workerUrl = new URL(input.url);
      workerUrl.pathname = pathSegments.length === 0 ? "/" : `/${pathSegments.join("/")}`;
      return projectRoute({
        appSlug: null,
        headers,
        method: input.method,
        projectId: head,
        url: workerUrl.toString(),
        urlPrefix: `/${head}`,
      });
    }
    if (isItxApiPath(url.pathname)) return { lane: "api" };
    return { lane: "os" };
  }

  for (const candidate of parseProjectPlatformHosts({ bases, host })) {
    const projectId = await input.resolvers.projectIdBySlug(candidate.projectIdentifier);
    if (!projectId) continue;
    return projectRoute({
      appSlug: candidate.appSlug,
      headers,
      method: input.method,
      projectId,
      url: input.url,
    });
  }

  const custom = await input.resolvers.projectByHostname(host);
  if (custom) {
    return projectRoute({
      appSlug: custom.appSlug,
      headers,
      method: input.method,
      projectId: custom.projectId,
      url: input.url,
    });
  }

  return { lane: "notFound" };
}

function projectRoute(input: {
  appSlug: string | null;
  headers: Headers;
  method: string;
  projectId: string;
  url: string;
  urlPrefix?: string;
}): IngressRoute {
  const headers = new Headers(input.headers);
  headers.set("x-itx-project-id", input.projectId);
  // Trusted headers: always overwritten, never pass-through — the outside
  // world cannot pick an app or fake a path prefix the lane didn't produce.
  headers.delete("x-iterate-app");
  if (input.appSlug) headers.set("x-iterate-app", input.appSlug);
  headers.delete("x-iterate-url-prefix");
  if (input.urlPrefix) headers.set("x-iterate-url-prefix", input.urlPrefix);
  return {
    lane: "project",
    fetch: { headers, method: input.method, url: input.url },
    resolved: { appSlug: input.appSlug, projectId: input.projectId },
  };
}

/** Engine path lanes served by the api worker on the OS host. */
export function isItxApiPath(pathname: string): boolean {
  if (pathname === "/api/itx" || pathname.startsWith("/api/itx/")) return true;
  if (pathname.startsWith("/__itx_e2e/")) return true;
  return false;
}

/**
 * The externally-visible host for a request: tunnels (captun) and the ingress
 * worker present the original host via forwarding headers; otherwise the
 * request URL is already the truth.
 */
export function requestIngressHost(request: Request): string {
  return requestIngressHostFrom(request.headers, new URL(request.url));
}

function requestIngressHostFrom(headers: Headers, url: URL): string {
  return normalizeIngressHost(
    headers.get("x-iterate-ingress-hostname") ??
      headers.get("x-forwarded-host")?.replace(/:\d+$/, "") ??
      url.hostname,
  );
}

function isOsHost(input: {
  baseUrl: string | undefined;
  bases: readonly string[];
  host: string;
  requestUrl: URL;
}): boolean {
  // No configured baseUrl (workers.dev previews): the request's own origin is
  // the app — same fallback the pre-migration router used.
  const appHostname = normalizeIngressHost(
    new URL(input.baseUrl ?? input.requestUrl.toString()).hostname,
  );
  if (input.host === appHostname) return true;
  // Local dev serves the app on the bare loopback base itself.
  return input.bases.some((rawBase) => {
    const base = normalizeIngressHost(normalizeProjectHostnameBase(rawBase));
    return input.host === base && (base === "localhost" || base.endsWith(".localhost"));
  });
}

/**
 * Thin forwarding predicate for the ingress and app workers, which hold no
 * directory resolvers: anything that is not the OS host (project platform
 * hosts and custom-hostname candidates alike), plus the engine path lanes and
 * the /prj_ path lane on the OS host, forwards whole to the api worker — it
 * runs the full `decideIngressRoute` and owns the 404 for hosts that resolve
 * to nothing.
 */
export function apiWorkerRequest(input: {
  config: { baseUrl?: string; projectHostnameBases?: readonly string[] };
  request: Request;
}): Request | null {
  const url = new URL(input.request.url);
  const host = requestIngressHost(input.request);
  const bases = input.config.projectHostnameBases ?? [];
  if (!isOsHost({ baseUrl: input.config.baseUrl, bases, host, requestUrl: url })) {
    return input.request;
  }
  if (isItxApiPath(url.pathname)) return input.request;
  if (/^\/prj_[^/]/.test(url.pathname)) return input.request;
  return null;
}
