/**
 * The shared cache identity for the session's project list. Every reader uses
 * `useSessionQuery({ key: ["projects"], query: (s) => s.projects.list() })`
 * (which prefixes "itx"), and every invalidation after a create/recover targets
 * `projectsListQueryKey` — so the /projects page, the app sidebar, and the ⌘K
 * project picker all share one cache entry.
 */
export const projectsListQueryKey = ["itx", "projects"] as const;
export const projectsListStaleTime = 30_000;
