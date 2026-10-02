/** "Stream ↗": from a page to the context its data lives on, in the dash's Contexts page
 *  (packages/dash `/projects/<slug>/contexts/<path>`): the context's events, its processors and their
 *  live state. The convention for a page that is one context's events (a doc, an agent): this one
 *  quiet link, beside the page's path. It goes through the dash's `/.auth/connect` for the page's
 *  platform, as Agents' link to the config repo does: straight through for the dash's own, a
 *  confirmation for another. Nothing when the deployment names no dash (`APP_CONFIG urls.dash`). */
export function StreamLink({
  dashOrigin,
  platformOrigin,
  project,
  path,
}: {
  dashOrigin: string | null;
  platformOrigin: string;
  /** the project's slug */
  project: string;
  /** the context's path, `/` for the project's root */
  path: string;
}) {
  if (!dashOrigin) return null;
  const next = `/projects/${project}/contexts${path.split("/").map(encodeURIComponent).join("/")}`;
  return (
    <a
      href={`${dashOrigin}/.auth/connect?${new URLSearchParams({ issuer: platformOrigin, next })}`}
      target="_blank"
      rel="noreferrer"
      title={`${path}: its events and processors, in the dash`}
      className="text-xs text-muted-foreground hover:text-foreground"
    >
      Stream ↗
    </a>
  );
}
