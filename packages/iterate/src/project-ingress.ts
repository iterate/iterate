// project-ingress.ts — HOW PROJECTS ARE REACHED OVER HTTP, both directions in ONE pure file. A
// deployment's `urls.ingressRouting` (apps/os app-config.ts) names the mechanism; `projectAddressOf`
// parses a request's URL into the project and app it names, `projectUrlOf` composes the URL of an
// app in a project. The platform's edge parses; the platform, the dash and an app compose — one
// implementation, table-tested to round-trip (project-ingress.test.ts). No imports.
//
//   subdomains  `<app>--<project>.<hostname>`, `<app>.<project>.<hostname>`, the apex `<project>.<hostname>`
//               — every app its own origin, under one wildcard on `hostname`.
//   paths       `<platformOrigin>/projects/<project>/<app>/…`, the apex `<platformOrigin>/projects/<project>/`
//               — one origin (workers.dev has no wildcard), every project under `/projects/` so the
//               platform's own paths (`/api`, `/mcp`, `/login`, …) need no reserved list; the edge
//               sandboxes what an app serves.

/** How projects are reached over HTTP; null ⇒ no ingress (`/api` and `/mcp` still answer). */
export type IngressRouting = { type: "subdomains"; hostname: string } | { type: "paths" } | null;

/** What a request names: the project (its slug, as written — whether it EXISTS is the directory's
 *  answer), the app (null ⇒ the apex: the project's config worker answers), and the path prefix the
 *  edge strips before the app sees the URL ("" under subdomains; "/projects/<project>" or
 *  "/projects/<project>/<app>" under paths). */
export type ProjectAddress = { project: string; app: string | null; basePath: string };

/** A DNS label: lowercase letters and digits, single hyphens inside. */
const DNS_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** An app label: a DNS label that is also an itx identifier (it becomes a step, `itx.apps.<label>`). */
const APP_LABEL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The labels `host` has under `hostname` — `site--p.iterate.app` ⇒ `["site--p"]` — lowercased, a
 *  trailing dot (a fully-qualified Host, `site--p.base.`) dropped; null when `host` is not under
 *  `hostname` at all. */
function labelsUnder(host: string, hostname: string): string[] | null {
  const name = host.toLowerCase().replace(/\.$/, "");
  const suffix = `.${hostname.toLowerCase()}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length).split(".") : null;
}

/** The project + app `url` names under `routing`, or null when it names none. Pure. */
export function projectAddressOf(
  routing: IngressRouting,
  url: URL,
  platformOrigin: string,
): ProjectAddress | null {
  if (!routing) return null;
  if (routing.type === "subdomains") {
    const labels = labelsUnder(url.hostname, routing.hostname);
    if (!labels || labels.length > 2) return null; // deeper than `<app>.<project>` is not a project host
    const [first, second] = labels as [string, string?];
    const separator = first.startsWith("xn--") ? -1 : first.indexOf("--"); // `xn--…` is an IDN label (punycode), never `<app>--<project>`
    const [app, project] =
      // oxlint-disable-next-line iterate/simple-truthiness-check -- a PRESENT-but-empty second label (`<app>..<base>`) is the `<app>.<project>` shape (rejected below by DNS_LABEL), not the single-label `<project>` shape a truthiness check would route it to
      second !== undefined
        ? [first, second] // `<app>.<project>`
        : separator === -1
          ? [null, first] // the apex, `<project>`
          : [first.slice(0, separator), first.slice(separator + 2)]; // `<app>--<project>`
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty app label (`--<project>.<base>`) must still be rejected by APP_LABEL; truthiness would skip the check and admit it
    if (!DNS_LABEL.test(project) || (app !== null && !APP_LABEL.test(app))) return null;
    return { app, project, basePath: "" };
  }
  if (url.origin !== new URL(platformOrigin).origin) return null;
  const [, prefix, project = "", app] = url.pathname.split("/");
  if (prefix !== "projects" || !DNS_LABEL.test(project)) return null;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- `/projects/<project>` and `/projects/<project>/` are both the apex; a present-but-empty next segment is not an app
  if (app === undefined || app === "")
    return { app: null, project, basePath: `/projects/${project}` };
  if (!APP_LABEL.test(app)) return null;
  return { app, project, basePath: `/projects/${project}/${app}` };
}

/** A PROJECT WILDCARD — an owned zone served as one project's apex (apps/os
 *  `urls.projectWildcard`, `{ hostname: "iterate.com", project: "iterate" }`): the zone's apex and
 *  every first-level name under it but the excluded ones, in the apex shape, `app: null`, so the
 *  project's config worker `fetch` answers exactly as it does on `<project>.<hostname>`. Null for
 *  anything else. Case and a trailing dot are forgiven. Pure. */
export function projectWildcardHostOf(
  hostname: string,
  wildcard: { hostname: string; project: string; excludedHostnames?: string[] } | undefined,
): { app: null; project: string } | null {
  if (!wildcard) return null;
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (wildcard.excludedHostnames?.includes(normalized)) return null;
  const suffix = `.${wildcard.hostname}`;
  const label = normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : null;
  return normalized === wildcard.hostname || (label && !label.includes("."))
    ? { app: null, project: wildcard.project }
    : null;
}

/** A PROJECT'S OWN HOSTNAME — `iterate.example.com`, added by the project (apps/os
 *  project/custom-hostnames.ts) — is that project's apex, and one label under it names an app:
 *  `notes.iterate.example.com` is the `notes` app, as `notes--<project>.<hostname>` is. The hostnames
 *  a request's host could be a project's own hostname for, most specific first: the host itself (the
 *  apex), then its parent with the first label as the app — which must be an app label. The caller
 *  looks them up in that order; the first a project holds wins. Case and a trailing dot are
 *  forgiven. Pure. */
export function customHostnameCandidatesOf(
  host: string,
): { hostname: string; app: string | null }[] {
  const hostname = host.toLowerCase().replace(/\.$/, "");
  const dot = hostname.indexOf(".");
  const [app, parent] = [hostname.slice(0, dot), hostname.slice(dot + 1)];
  return [
    { hostname, app: null },
    ...(dot > 0 && parent.includes(".") && APP_LABEL.test(app) ? [{ hostname: parent, app }] : []),
  ];
}

/** The URL of `app` (null ⇒ the apex, the config worker) in `project` under `routing`, at `path`
 *  (default "/", must start with "/"). Null when there is no ingress, or when the result would not
 *  parse back to the same address (a bad label; a `path` that climbs out of its app). subdomains:
 *  the protocol and port are `platformOrigin`'s (local dev is `http://localhost:8788`, so
 *  `http://<app>--<project>.localhost:8788/…`); paths: `<platformOrigin>/projects/<project>[/<app>]<path>`. Pure. */
export function projectUrlOf(
  routing: IngressRouting,
  platformOrigin: string,
  target: { project: string; app?: string | null; path?: string },
): URL | null {
  if (!routing) return null;
  const path = target.path || "/";
  if (!path.startsWith("/")) throw new Error(`projectUrlOf: path must start with "/": ${path}`);
  const app = target.app || null;
  const origin = new URL(platformOrigin);
  const url =
    routing.type === "subdomains"
      ? new URL(
          path,
          `${origin.protocol}//${app ? `${app}--` : ""}${target.project}.${routing.hostname}${origin.port ? `:${origin.port}` : ""}`,
        )
      : new URL(`/projects/${target.project}${app ? `/${app}` : ""}${path}`, origin.origin);
  const parsed = projectAddressOf(routing, url, platformOrigin);
  return parsed && parsed.project === target.project && parsed.app === app ? url : null;
}
