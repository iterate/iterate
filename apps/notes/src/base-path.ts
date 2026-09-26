// base-path.ts — THE PATH NOTES IS SERVED UNDER in the browser: "" on its own origin, and
// `/projects/<project>/<routingSlug>` when a project's config worker (config-worker.ts) proxies it
// under paths ingress. There the platform's edge strips that prefix from the URL Notes sees and
// says it in `x-iterate-base-path` (iterate/project-ingress), while the browser's URLs keep it. So
// every path the page names carries it — its links, its assets (server.ts `transformAssets`), its
// server functions (start.ts) — and the router drops it on the way in (`basePathRewrite`). The
// browser adapter's `/.auth/*` and `/api` stay root paths: under paths they are the platform's own,
// on the origin the page shares with it (apps/os/src/worker.ts).
import type { LocationRewrite } from "@tanstack/react-router";
import { ITERATE_BASE_PATH_HEADER } from "iterate/project-ingress";

/** The base path a request says, or "" — plain path segments only: the header reaches Notes' own
 *  origin from anyone, and what it says is written into the page's links. */
export function basePathOf(headers: Headers): string {
  const value = headers.get(ITERATE_BASE_PATH_HEADER) || "";
  return /^(?:\/[a-z0-9-]+)+$/.test(value) ? value : "";
}

/** The base path in the browser: the server render writes it on `<html data-base-path>`
 *  (routes/__root.tsx), before any script runs. */
export function documentBasePath(): string {
  return document.documentElement.dataset.basePath || "";
}

/** The router's side of the base path: the browser's URL without it on the way in, with it on the
 *  way out. A rewrite, not TanStack's `basepath`, which Start sets from the build's Vite `base` on
 *  every request (start-server-core `createStartHandler`, start-client-core `hydrateStart`). */
export function basePathRewrite(basePath: string): LocationRewrite | undefined {
  if (!basePath) return undefined;
  return {
    input: ({ url }) => {
      if (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))
        url.pathname = url.pathname.slice(basePath.length) || "/";
      return url;
    },
    output: ({ url }) => {
      url.pathname = `${basePath}${url.pathname}`;
      return url;
    },
  };
}
