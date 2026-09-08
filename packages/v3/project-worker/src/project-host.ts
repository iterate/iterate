// project-host.ts — PROJECT-HOST INGRESS, the pure half: which project and which app a hostname names
// (docs/plan-one-fetch-rules.md D1, "a label is the address"). `<label>--<projectId>.<base>` serves
// `itx.apps.<label>` of the project's ROOT context; the apex `<projectId>.<base>` serves the label
// `default` — `itx.apps.default`, never a bare `itx.apps`: a row at the bare prefix would catch every
// label without a row of its own and hand the apex app a stray step. Every host is exactly one row.
// The log never names a hostname: one rule row (`provide("itx.apps.site", …)`) serves the label on
// every host the project has. Only a project id that is itself a DNS label (lowercase letters, digits,
// single hyphens) is a host by convention; a pretty slug or a custom domain is a directory row — the
// control plane's, later. The edge half (worker.ts) strips inbound `x-itx-*` and rides the Request
// verbatim into the fetch lane, so relative links, host-scoped cookies and WebSocket upgrades all work.

/** The cookie a project host holds a project token in (a browser's lane; `/.itx/session` sets it). */
export const PROJECT_SESSION_COOKIE = "itx-project-session";
/** The one path the platform answers on a project host — `?token=<projectToken>&next=<path>` sets
 *  the cookie and redirects to `next`; `?logout` clears it. Everything else is the app's. */
export const PROJECT_SESSION_PATH = "/.itx/session";

/** The project token a request's cookie carries, or null. */
export function projectSessionCookieOf(cookieHeader: string | null): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === PROJECT_SESSION_COOKIE && value.length) return value.join("=");
  }
  return null;
}

/** The `Set-Cookie` value that stores `token` for `maxAgeSeconds` (≤ 0 clears it): host-scoped,
 *  HttpOnly, Secure (a browser exempts localhost), SameSite=Lax so a top-level navigation from the
 *  control plane's login carries it. */
export const projectSessionSetCookie = (token: string, maxAgeSeconds: number): string =>
  `${PROJECT_SESSION_COOKIE}=${maxAgeSeconds > 0 ? token : ""}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;

/** A DNS label: lowercase letters and digits, single hyphens inside. */
const DNS_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** An app label: a DNS label that is also an itx identifier (it becomes a step, `itx.apps.<label>`). */
const APP_LABEL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The app + slug a project host names, or null when `hostname` is not a project host under `base` (a
 *  blank `base` ⇒ no project-host ingress at all). `<app>--<slug>.<base>` serves `itx.apps.<app>` of the
 *  project whose slug is `<slug>`; the apex `<slug>.<base>` serves app `default`. The slug is resolved
 *  to the project's id (the DO name) by the in-process directory (worker.ts) — a pure DNS label here. */
export function projectHostOf(
  hostname: string,
  base: string,
): { app: string; slug: string } | null {
  if (!base) return null;
  // A fully-qualified Host (`site--p.base.`) and a wildcard spelling (`*.base`) name the same thing.
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\*\./, "");
  const suffix = `.${base.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (label.includes(".")) return null; // ONE label under the base; a deeper name is not a project host
  const separator = label.indexOf("--");
  const app = separator === -1 ? null : label.slice(0, separator);
  const slug = separator === -1 ? label : label.slice(separator + 2);
  if (!DNS_LABEL.test(slug) || (app !== null && !APP_LABEL.test(app))) return null;
  return { app: app ?? "default", slug };
}
