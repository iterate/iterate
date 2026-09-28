/**
 * `/explainers/<ref>/<name>`: `explainers/<name>.html` of iterate/iterate at `ref` (a branch, a tag or
 * a commit), read from GitHub, which serves the public repository's files. A pull request links the
 * explainer on its own branch as soon as it is pushed, and a link with a commit keeps showing that
 * version. An explainer is a standalone page: it is served as committed.
 */
export async function serveExplainer(
  request: Request,
  { fetch: fetchFromGitHub }: { fetch: typeof fetch },
) {
  const route = new URL(request.url).pathname.match(
    /^\/explainers\/(.+)\/([a-z0-9-]+)(?:\.html)?\/?$/,
  );
  if (!route) return new Response("Not found: /explainers/<ref>/<name>", { status: 404 });
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const [, ref, name] = route;
  // The URL parser has already resolved `.` and `..` segments; an encoded one is refused here.
  if (!/^[A-Za-z0-9._/-]+$/.test(ref!)) return new Response("Invalid ref", { status: 400 });
  const page = await fetchFromGitHub(
    `https://raw.githubusercontent.com/iterate/iterate/${ref}/explainers/${name}.html`,
  );
  if (page.status === 404) {
    const missing = `No explainers/${name}.html at ${ref}`;
    if (ref === "main") return new Response(missing, { status: 404 });
    // Most likely a merged pull request's branch, deleted since: its explainer is on main now. The
    // ref and name hold only the characters the checks above allow, so they need no escaping.
    return new Response(
      `<!doctype html><meta charset="utf-8" /><title>${missing}</title><p>${missing}. If its pull request has merged, it's on main: <a href="/explainers/main/${name}">explainers/${name}.html on main</a>.</p>\n`,
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  if (!page.ok) return new Response(`GitHub answered ${page.status}`, { status: 502 });
  return new Response(page.body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}
