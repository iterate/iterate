// base-path.ts — THE PATH A PROXIED APP IS SERVED UNDER in the browser (packages/notes, packages/docs-app). A
// project's config worker (the app's config-worker.ts) proxies it: on a host of its own under subdomains ingress
// (`notes--<project>.<base>`) the base path is "", and under paths ingress it is
// `/projects/<project>/<routingSlug>`. There the platform's edge strips that prefix from the URL the app sees and
// says it in `x-iterate-base-path` (iterate/project-ingress), while the browser's URLs keep it. So
// every path the page names carries it — its links, its assets (the app's server.ts `transformAssets`), its
// server functions (the app's start.ts) — and the router drops it on the way in (`basePathRewrite`). The
// browser adapter's `/.auth/*` and `/api` stay root paths: the host's, which the platform answers
// (core/os/src/worker.ts); under paths they are its own, on the origin the page shares with it.
//
// A dev server behind `iterate tunnel` under paths starts under the tunnel's base path (README):
// Vite's `base`, which its module URLs and its HMR socket carry. The page's base path takes the
// build's place in every URL the build names (`underBasePath`), and the URL the tunnel hands over,
// base path on, is served as the edge's is (`withoutBuildBasePath`). A deployed build's base is `/`.
import type { LocationRewrite } from "@tanstack/react-router";
import { ITERATE_BASE_PATH_HEADER } from "iterate/project-ingress";

/** The build's base path: Vite's `base` without its trailing slash, "" but on a dev server
 *  started under a tunnel's base path. */
export const buildBasePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/** The base path a request says, else the build's — plain path segments only: the header reaches
 *  the app's Worker from anyone who fetches it, and what it says is written into the page's links. */
export function basePathOf(headers: Headers) {
  const value = headers.get(ITERATE_BASE_PATH_HEADER) || "";
  return /^(?:\/[a-z0-9-]+)+$/.test(value) ? value : buildBasePath;
}

/** The base path in the browser: the server render writes it on `<html data-base-path>`
 *  (the app's routes/__root.tsx), before any script runs. */
export function documentBasePath() {
  return document.documentElement.dataset.basePath || "";
}

/** A URL the build names — a manifest's script or stylesheet, a `?url` import — under the page's
 *  base path in place of the build's. */
export function underBasePath(basePath: string, url: string) {
  return url.startsWith(`${buildBasePath}/`)
    ? `${basePath}${url.slice(buildBasePath.length)}`
    : url;
}

/** The request as the edge hands a proxied app over, its base path stripped: a dev server under
 *  a tunnel's base path is handed the URL the browser addressed (the tunnel puts it back). */
export function withoutBuildBasePath(request: Request) {
  if (!buildBasePath) return request;
  const url = new URL(request.url);
  url.pathname = withoutBasePath(url.pathname, buildBasePath);
  return new Request(url, request);
}

/** The router's side of the base path: the browser's URL without it on the way in, with it on the
 *  way out. A rewrite, not TanStack's `basepath`, which Start sets from its `router.basepath`
 *  (the app's vite.config.ts) on every request (start-server-core `createStartHandler`, start-client-core
 *  `hydrateStart`). */
export function basePathRewrite(basePath: string): LocationRewrite | undefined {
  if (!basePath) return undefined;
  return {
    input: ({ url }) => {
      url.pathname = withoutBasePath(url.pathname, basePath);
      return url;
    },
    output: ({ url }) => {
      url.pathname = `${basePath}${url.pathname}`;
      return url;
    },
  };
}

/** `pathname` without `basePath` in front when it is under it, else as it is. */
function withoutBasePath(pathname: string, basePath: string) {
  return pathname === basePath || pathname.startsWith(`${basePath}/`)
    ? pathname.slice(basePath.length) || "/"
    : pathname;
}
