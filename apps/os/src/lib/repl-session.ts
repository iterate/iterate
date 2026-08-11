// REPL session streams: fresh session paths and picking up where you left
// off. A session is an ordinary capability scope at /repl/<timestamp-slug> —
// the same timestamp-slug convention web agent streams use (see
// web-agent.ts), so a session's URL suffix IS its stream path and everyone on
// that URL shares one console.

import type { StreamListItem } from "~/itx-api.generated.ts";

export const REPL_SESSION_PATH_PREFIX = "/repl/";

// Deliberately a bare expression: the default Run doubles as a demo of the
// REPL echo (a trailing expression answers with its value).
export const PROJECT_REPL_INITIAL_CODE = "await itx.__describe()";

/** A fresh session's stream path, e.g. /repl/2026-08-12t09-15-42-123z. */
export function newReplSessionPath(date: Date) {
  const slug = date
    .toISOString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${REPL_SESSION_PATH_PREFIX}${slug}`;
}

/**
 * The most recent existing session, or null when the project has none. Bare
 * /repl resumes this — a console should be where you left it; "New REPL"
 * is the explicit fresh start. Newest by creation time (the timestamp slugs
 * agree, and sorting the path breaks any tie deterministically).
 */
export function newestReplSessionPath(streams: readonly StreamListItem[]): string | null {
  const sessions = streams.filter((stream) => stream.path.startsWith(REPL_SESSION_PATH_PREFIX));
  if (sessions.length === 0) return null;
  sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.path.localeCompare(a.path));
  return sessions[0]!.path;
}

/** The URL splat for a session path: the part after /repl/. */
export function replSessionSlug(sessionPath: string): string {
  return sessionPath.slice(REPL_SESSION_PATH_PREFIX.length);
}

/**
 * The project's known-streams read the REPL routes and container share (one
 * cache entry). staleTime is load-bearing: after the first Run births a
 * session and the URL is replaced, the remounted container must see the
 * primed cache (see the run mutation in itx-scope-repl.tsx) instead of
 * racing a refetch against stream/created propagating into project state.
 */
export const KNOWN_STREAMS_QUERY = {
  key: (projectId: string) => ["repl-streams", projectId] as const,
  staleTimeMs: 30_000,
};
