// Loader-side itx: how route loaders reach the same handle surface the React
// hooks use, on both sides of the SSR boundary (the same isomorphic shape as
// orpc/client.ts):
//
//   - server: getServerItx — an in-process handle built from the request
//     context (server.ts), imported dynamically so cloudflare:workers / the
//     db layer never enter the browser bundle even before the Start compiler
//     strips the branch;
//   - browser: the per-tab socket singleton (react/browser-client.ts) — the
//     SAME client the hooks use, so a client-side loader run reuses the open
//     WebSocket and its project-handle cache instead of dialing again.
//
// Lives outside routes/ with explicit return types on purpose: helpers used
// by route files must not let route types recurse into Start's Register
// interface (see root-auth-snapshot.ts on the routeTree.gen.ts cycle, TS7022).

import { createIsomorphicFn } from "@tanstack/react-start";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { ItxHandle } from "./react/hooks.ts";
import { getItxBrowserClient } from "./react/browser-client.ts";

/**
 * A project-narrowed itx handle for loader code. During SSR the handle is a
 * plain in-process `Itx` instance; in the browser it is a capnweb stub over
 * the tab's shared socket. Both expose the same call surface (a stub proxies
 * the RpcTarget it wraps), so one `ItxHandle`-typed queryFn serves both — the
 * server branch's cast states exactly that equivalence.
 */
export const getLoaderItx: (projectSlugOrId: string) => Promise<ItxHandle> = createIsomorphicFn()
  .server(async (projectSlugOrId: string): Promise<ItxHandle> => {
    const { getServerItx } = await import("./server.ts");
    return (await getServerItx(projectSlugOrId)) as unknown as ItxHandle;
  })
  .client((projectSlugOrId: string): Promise<ItxHandle> => {
    return getItxBrowserClient().project(projectSlugOrId);
  });

/**
 * One itx-backed query, defined once and consumed twice: spread into
 * `useItxQuery` by the component's hook and fed to `prefetchItxQuery` by the
 * route loader. Sharing the definition is what keeps loader and hook on the
 * same cache entry — key, fetcher, and staleness can never drift apart.
 */
export type ItxQueryDefinition<TData> = {
  /** The project context the queryFn's handle is narrowed to. */
  project: string;
  queryKey: QueryKey;
  queryFn: (itx: ItxHandle) => Promise<TData>;
  staleTime: number;
};

/**
 * Best-effort loader prefetch: seed the query cache so the component's
 * `useItxQuery` paints without a first-visit spinner (SSR dehydrates the
 * seeded entry; client-side navigations fill the cache before render).
 *
 * Errors are CAUGHT AND DISCARDED, deliberately. Prefetching is an
 * optimization, never a gate: an unauthenticated SSR pass, a FORBIDDEN
 * project, a flaky DO — none of these may crash the route into the generic
 * error boundary (a FORBIDDEN thrown during route loading did exactly that to
 * the streams page in prod, 2026-06). The component's own useItxQuery runs
 * the same queryFn and surfaces the same failure in its inline error states,
 * where it belongs.
 */
export async function prefetchItxQuery<TData>(input: {
  query: ItxQueryDefinition<TData>;
  queryClient: QueryClient;
}): Promise<void> {
  try {
    await input.queryClient.ensureQueryData({
      queryKey: input.query.queryKey,
      queryFn: async (): Promise<TData> =>
        await input.query.queryFn(await getLoaderItx(input.query.project)),
      staleTime: input.query.staleTime,
    });
  } catch {
    // Swallowed by design — see the doc comment above. One bit of hygiene: a
    // failed FIRST fetch leaves an errored, data-less cache entry behind, and
    // a component mounting against it flashes its error state before
    // retryOnMount refetches. Removing the empty entry means the component
    // mounts pending instead. An entry that already HAS data is kept — stale
    // data plus a background error beats no data.
    const state = input.queryClient.getQueryState(input.query.queryKey);
    if (state?.status === "error" && state.data === undefined) {
      input.queryClient.removeQueries({ exact: true, queryKey: input.query.queryKey });
    }
  }
}
