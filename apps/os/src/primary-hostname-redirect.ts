// src/primary-hostname-redirect.ts — WHEN THE EDGE SENDS A VISITOR TO A PROJECT'S PRIMARY HOSTNAME
// (project/contract.ts `primaryHostname`): a browser's top-level navigation on the ingress base's own
// form of a project host — `<routingSlug>--<project>.<base>`, `<routingSlug>.<project>.<base>` or
// `<project>.<base>` — is answered with a 308 to the same routing slug, path and query on the
// primary hostname. Nothing else is: another method, a fetch, a WebSocket upgrade, the files host, a
// request already on a project's own hostname or a project wildcard, and anything under paths
// routing, which shares the platform's origin and has no custom hostnames. Pure; worker.ts reads
// the primary hostname only for a request this admits.
import { projectAddressOf, type IngressRouting } from "iterate/project-ingress";
import { FILES_ROUTING_SLUG } from "./context/file-urls.ts";

/** The routing slug (null ⇒ the apex) a request would keep on the project's primary hostname, or
 *  undefined when the edge never redirects it. */
export function primaryHostnameRedirectOf(
  request: Request,
  ingress: { routing: IngressRouting; platformOrigin: string },
): { routingSlug: string | null } | undefined {
  if (ingress.routing?.type !== "subdomains") return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  if (request.headers.get("upgrade")) return undefined;
  const mode = request.headers.get("sec-fetch-mode");
  const destination = request.headers.get("sec-fetch-dest");
  // a browser says what a request is; without Fetch Metadata, one that asks for HTML is a page
  const navigation =
    mode || destination
      ? mode === "navigate" && destination === "document"
      : (request.headers.get("accept") ?? "").includes("text/html");
  if (!navigation) return undefined;
  const url = new URL(request.url);
  if (url.origin === ingress.platformOrigin) return undefined;
  const address = projectAddressOf(ingress.routing, url, ingress.platformOrigin);
  if (!address || address.routingSlug === FILES_ROUTING_SLUG) return undefined;
  return { routingSlug: address.routingSlug };
}
