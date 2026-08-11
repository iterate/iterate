// REPL session streams: fresh session paths and picking up where you left
// off. A session is an ordinary capability scope at /repl/<timestamp-slug> —
// the same timestamp-slug convention web agent streams use (see
// web-agent.ts), so a session's URL suffix IS its stream path and everyone on
// that URL shares one console.

import type { StreamListItem } from "~/itx-api.generated.ts";

export const REPL_SESSION_PATH_PREFIX = "/repl/";

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
