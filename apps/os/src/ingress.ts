/**
 * The ONE hostname/path-level routing decision for OS traffic, made once per
 * request by the single OS worker (src/worker.ts). Same shape as the pre-migration router: `decideIngressRoute`
 * takes url + method + headers and answers with the lane — and, for the
 * project lane, the exact url + headers to fetch onward with. Header
 * stripping at the trust boundary is a separate layer
 * (`stripInternalHeaders` in src/worker.ts).
 *
 * Lanes:
 *
 *   "os"       — the dashboard/app pipeline (OS host, non-itx paths)
 *   "api"      — rpc path lanes on the OS host: /api, operator sessions, and
 *                Slack webhooks
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
import { parseProjectPlatformHost } from "~/ingress/project-platform-host-routing.ts";
import { isEventDocsHostname } from "~/lib/event-docs-host.ts";
import { normalizeProjectHostnameBase } from "~/lib/project-host-routing.ts";

export type IngressResolvers = {
  /** Slug (or prj_ id, passed through) -> project id. */
  projectIdBySlug(identifier: string): Promise<string | null>;
  /** Registered custom hostname (exact or `<app>.<registered>`) -> target. */
  projectByHostname(host: string): Promise<{ projectId: string; appSlug: string | null } | null>;
};

type IngressRoute =
  | { lane: "os"; hostKind: "dashboard" | "eventDocs" }
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

  const osHostKind = osHostKindFor({ baseUrl: input.config.baseUrl, bases, host, requestUrl: url });
  if (osHostKind) {
    if (osHostKind === "eventDocs") return { lane: "os", hostKind: osHostKind };

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
        hostKind: "path",
        method: input.method,
        projectId: head,
        url: workerUrl.toString(),
        urlPrefix: `/${head}`,
      });
    }
    if (isApiWorkerLanePath(url.pathname)) return { lane: "api" };
    return { lane: "os", hostKind: osHostKind };
  }

  const candidate = parseProjectPlatformHost({ bases, host });
  if (candidate) {
    const projectId = await input.resolvers.projectIdBySlug(candidate.projectIdentifier);
    if (projectId) {
      return projectRoute({
        appSlug: candidate.appSlug,
        headers,
        hostKind: "platform",
        method: input.method,
        projectId,
        url: input.url,
      });
    }
  }

  const custom = await input.resolvers.projectByHostname(host);
  if (custom) {
    return projectRoute({
      appSlug: custom.appSlug,
      headers,
      hostKind: "custom",
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
  hostKind: "custom" | "path" | "platform";
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
  headers.set("x-iterate-host-kind", input.hostKind);
  headers.delete("x-iterate-url-prefix");
  if (input.urlPrefix) headers.set("x-iterate-url-prefix", input.urlPrefix);
  return {
    lane: "project",
    fetch: { headers, method: input.method, url: input.url },
    resolved: { appSlug: input.appSlug, projectId: input.projectId },
  };
}

/**
 * Path lanes served by the api pipeline on the OS host: the capnweb rpc
 * endpoint at exactly `/api` (plus operator-session issuance/redemption), the Slack,
 * GitHub, and Telegram webhook ingress lanes. Deliberately exact-match —
 * except Telegram, whose webhook path carries the bot id as a segment
 * (`/api/integrations/telegram/webhook/<botId>`), so it is the one prefix.
 * Other `/api/*` paths (`/api/mcp`, `/api/health`, the OAuth callback routes
 * under `/api/integrations/...`) are app routes and stay on the "os" lane.
 */
function isApiWorkerLanePath(pathname: string): boolean {
  if (
    pathname === "/api" ||
    pathname === "/api/operator-sessions" ||
    pathname.startsWith("/api/operator-sessions/")
  ) {
    return true;
  }
  if (
    pathname === "/api/integrations/slack/webhook" ||
    pathname === "/api/integrations/slack/interactivity-webhook" ||
    pathname === "/api/integrations/github/webhook" ||
    pathname.startsWith("/api/integrations/telegram/webhook/")
  ) {
    return true;
  }
  return false;
}

/** The externally-visible host for a request. */
function requestIngressHostFrom(headers: Headers, url: URL): string {
  return normalizeIngressHost(
    headers.get("x-forwarded-host")?.replace(/:\d+$/, "") ?? url.hostname,
  );
}

function osHostKindFor(input: {
  baseUrl: string | undefined;
  bases: readonly string[];
  host: string;
  requestUrl: URL;
}): "dashboard" | "eventDocs" | null {
  // No configured baseUrl (workers.dev previews): the request's own origin is
  // the app — same fallback the pre-migration router used.
  const appHostname = normalizeIngressHost(
    new URL(input.baseUrl ?? input.requestUrl.toString()).hostname,
  );
  if (input.host === appHostname) return "dashboard";
  if (
    isEventDocsHostname({
      appBaseUrl: input.baseUrl,
      requestHostname: input.host,
    })
  ) {
    return "eventDocs";
  }
  // Local dev serves the app on the bare loopback base itself.
  const isLocalAppHost = input.bases.some((rawBase) => {
    const base = normalizeIngressHost(normalizeProjectHostnameBase(rawBase));
    if (input.host !== base || (base !== "localhost" && !base.endsWith(".localhost"))) {
      return false;
    }
    return true;
  });
  return isLocalAppHost ? "dashboard" : null;
}
