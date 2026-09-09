// project-host.ts — PROJECT-HOST INGRESS, the pure half: which project and which app a hostname names
// ("a label is the address"). `<app>--<projectId>.<base>` serves `itx.apps.<app>` of the project's
// ROOT context; the apex `<projectId>.<base>` serves the app `default` — `itx.apps.default`, never a
// bare `itx.apps`: a row at the bare prefix would catch every label without a row of its own and hand
// the apex app a stray step. Every host is exactly one row, and the log never names a hostname: one
// rule row (`provide("itx.apps.site", …)`) serves the app on every host the project has. A project id
// is a DNS label by construction (the directory slugifies it); the in-process directory admits it
// (worker.ts). The edge half (worker.ts `laneRequestTo`) strips inbound `x-itx-*`, the platform's own
// cookie (below) and a project-token bearer, and rides the Request otherwise unchanged into the fetch
// lane, so relative links, the app's host-scoped cookies and WebSocket upgrades all work.

/** The cookie a project host holds a project token in (a browser's lane; `/.itx/session` sets it). */
const PROJECT_SESSION_COOKIE = "itx-project-session";
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

/** The cookie header with the platform's own cookie removed — what an app (loaded code) may see:
 *  the token in it would let the app act as the visitor (`authenticate({ projectToken })`). */
export function withoutProjectSessionCookie(cookieHeader: string | null): string {
  return (cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${PROJECT_SESSION_COOKIE}=`))
    .join("; ");
}

/** `next` as a path on `origin`, else "/" — a redirect never leaves the host: `//evil.example`,
 *  `/\evil.example` and an absolute URL all resolve to a foreign origin and fall back to "/". */
export function sameOriginPath(next: string, origin: string): string {
  try {
    const url = new URL(next, origin);
    return url.origin === origin ? url.pathname + url.search : "/";
  } catch {
    return "/";
  }
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

/** The app + project a host names, or null when `hostname` is not a project host under `base` (a
 *  blank `base` ⇒ no project-host ingress at all). `<app>--<projectId>.<base>` serves `itx.apps.<app>`
 *  of that project; the apex `<projectId>.<base>` serves app `default`. Pure: whether the project
 *  EXISTS is the directory's answer (worker.ts). */
export function projectHostOf(
  hostname: string,
  base: string,
): { app: string; projectId: string } | null {
  if (!base) return null;
  const host = hostname.toLowerCase().replace(/\.$/, ""); // a fully-qualified Host (`site--p.base.`) too
  const suffix = `.${base.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (label.includes(".")) return null; // ONE label under the base; a deeper name is not a project host
  const separator = label.indexOf("--");
  const app = separator === -1 ? null : label.slice(0, separator);
  const projectId = separator === -1 ? label : label.slice(separator + 2);
  if (!DNS_LABEL.test(projectId) || (app !== null && !APP_LABEL.test(app))) return null;
  return { app: app ?? "default", projectId };
}
