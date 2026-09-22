/** Where a new agent made from this page lives: `/agents/web/<moment>` — the path apps/os gives an
 *  agent born in the browser (apps/os-next/src/lib/web-agent.ts), so the two shells name the same thing
 *  the same way. An agent is its path; there is no separate name. */
export function newWebAgentPath(date: Date) {
  const slug = date
    .toISOString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `/agents/web/${slug}`;
}
