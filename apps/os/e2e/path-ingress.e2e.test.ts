// path-ingress.e2e.test.ts — PATH ROUTING (src/app-config.ts `urls.ingressRouting: { type: "paths" }`):
// a deployment with one hostname and no wildcard (workers.dev) reaches its projects as
// `<os>/projects/<project>/<routingSlug>/…` and the apex `<os>/projects/<project>/…`, both the
// project's config worker. The worker strips the prefix before the config worker sees the URL and
// hands it its base path; every response back through this route is served
// SANDBOXED (a `Content-Security-Policy: sandbox …` header the edge adds — a site runs in an opaque
// origin, so its script cannot spend the issuer's cookie); and the platform's own first segments
// (`api`, `mcp`, `login`, …) are never a project. LOCAL ONLY: every row boots its own worker with the
// paths configuration (support/worker-config.ts; `await using paths = await pathsWorker()`, stopped
// when the row ends) — the shared worker routes by subdomain.
import { expect } from "vitest";
import { startOwnWorker, type OwnWorker } from "./support/own-worker.ts";
import { freshDnsSafeProjectSlug, localOnly, publishConfigWorker } from "./support/project-host.ts";

/** A config worker that answers a routing slug with what it was handed: the URL it saw, its base
 *  path, its routing slug; the apex is its own 404. */
const SRC_ECHO_URL_CONFIG_WORKER = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Echo extends WorkerEntrypoint {
  fetch(request) {
    const url = new URL(request.url);
    const routingSlug = request.headers.get("x-iterate-routing-slug");
    if (routingSlug === null) return new Response("Not found\\n", { status: 404 });
    return Response.json({
      path: url.pathname + url.search,
      basePath: request.headers.get("x-iterate-base-path"),
      routingSlug,
    }, { headers: { "x-app-header": "kept" } });
  }
}`,
};

localOnly(
  "a routing slug is reached at /projects/<project>/<routingSlug>/…: the prefix stripped, the base path handed over, the answer sandboxed",
  { timeout: 120_000 },
  async () => {
    await using paths = await pathsWorker();
    const { origin, slug } = paths;
    const answer = await fetch(`${origin}/projects/${slug}/echo/hello?x=1`, { redirect: "manual" });
    expect(answer, await answer.clone().text()).toMatchObject({ status: 200 });
    expect(await answer.json()).toEqual({
      path: "/hello?x=1",
      basePath: `/projects/${slug}/echo`,
      routingSlug: "echo",
    });
    // the sandbox: added by the edge on the way out, the config worker's own headers kept
    expect(answer.headers.get("content-security-policy")).toMatch(/\bsandbox\b/);
    expect(answer.headers.get("x-app-header")).toBe("kept");
    // the routing slug's root, with and without a trailing slash
    expect(await (await fetch(`${origin}/projects/${slug}/echo/`)).json()).toMatchObject({
      path: "/",
    });
    expect(await (await fetch(`${origin}/projects/${slug}/echo`)).json()).toMatchObject({
      path: "/",
    });
  },
);

localOnly(
  "the apex /projects/<project>/… is the config worker's too (its 404, sandboxed); an unknown project is 4xx",
  { timeout: 120_000 },
  async () => {
    await using paths = await pathsWorker();
    const { origin, slug } = paths;
    const apex = await fetch(`${origin}/projects/${slug}/`, { redirect: "manual" });
    expect(apex, await apex.clone().text()).toMatchObject({ status: 404 });
    expect(apex.headers.get("content-security-policy")).toMatch(/\bsandbox\b/);
    const unknown = await fetch(`${origin}/projects/${freshDnsSafeProjectSlug("nobody")}/echo/`, {
      redirect: "manual",
    });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.status).toBeLessThan(500);
  },
);

localOnly(
  "a stored file served under /projects/<project>/files/… is sandboxed too — a document on the platform's origin, whatever its type",
  { timeout: 120_000 },
  async () => {
    await using paths = await pathsWorker();
    const itx = paths.worker.itx(paths.slug);
    await itx.files.get("/page.html").put({
      // `data` is base64 (or a data: URL): the bytes of a page that would call /api if it ran unsandboxed
      data: Buffer.from("<script>fetch('/api')</script>").toString("base64"),
      contentType: "text/html",
    });
    const signed = (await itx.files.get("/page.html").url()) as { url: string };
    expect(signed.url).toContain(`/projects/${paths.slug}/files/`);
    const served = await fetch(signed.url);
    expect(served, await served.clone().text()).toMatchObject({ status: 200 });
    expect(served.headers.get("content-type")).toMatch(/text\/html/);
    expect(served.headers.get("content-security-policy")).toMatch(/\bsandbox\b/);
  },
);

localOnly(
  "the platform's own first segments are never a project: /api, /mcp, /version, /login answer as themselves",
  { timeout: 120_000 },
  async () => {
    await using paths = await pathsWorker();
    const { origin } = paths;
    expect(await fetch(`${origin}/version`)).toMatchObject({ status: 200 });
    expect(await fetch(`${origin}/api`, { method: "POST", body: "" })).toMatchObject({
      status: 401,
    });
    expect(await fetch(`${origin}/mcp`)).toMatchObject({ status: 401 });
    const login = await fetch(`${origin}/login`, { redirect: "manual" });
    expect(login.status).toBeLessThan(400);
    expect(login.headers.get("content-security-policy") ?? "").not.toMatch(/\bsandbox\b/);
    const discovery = await (
      await fetch(`${origin}/.well-known/oauth-authorization-server`)
    ).json();
    expect(discovery).toMatchObject({ issuer: origin });
  },
);

/** A worker booted for one row with PATH routing, project `slug` created on it and the echo config
 *  worker published; disposing it stops the worker (and the sessions it minted). */
async function pathsWorker(): Promise<
  AsyncDisposable & { worker: OwnWorker; origin: string; slug: string }
> {
  await using stack = new AsyncDisposableStack();
  const worker = await startOwnWorker({ ingressRouting: { type: "paths" } });
  stack.defer(() => worker.stop());
  const slug = freshDnsSafeProjectSlug("paths");
  const itx = await worker.createProject(slug);
  await publishConfigWorker(itx, [
    "itx",
    "workers",
    ["get", { source: SRC_ECHO_URL_CONFIG_WORKER }],
  ]);
  const owned = stack.move();
  return {
    worker,
    origin: worker.url.origin,
    slug,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
