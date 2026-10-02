/** A browser-created agent lives at `/agents/web/<moment>`. An agent is its path; there is no
 * separate name. */
export function newWebAgentPath(date: Date) {
  const slug = date
    .toISOString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `/agents/web/${slug}`;
}
