import { connectItxBrowser } from "~/itx/itx-react.tsx";
import type { ProjectListEntry } from "~/types.ts";

/**
 * The ONE client-side cache entry for `session.projects.list()` — the itx
 * session is the projects API (no server functions). The key matches what
 * `useItxQuery({ key: ["projects"], ... })` produces (it prefixes "itx"), so
 * the /projects page (suspense read), the app sidebar (plain useQuery), and
 * every invalidation after a create/recover all hit the same entry.
 */
export const projectsListQueryKey = ["itx", "projects"] as const;
export const projectsListStaleTime = 30_000;

/** Fetch the session's project list — browser-only (dials the itx socket). */
export async function fetchProjectsList(): Promise<ProjectListEntry[]> {
  const itx = await connectItxBrowser();
  return await itx.projects.list();
}
