// path-ingress.e2e.test.ts — PATH ROUTING (src/app-config.ts `urls.ingressRouting: { type: "paths" }`):
// a deployment with one hostname and no wildcard (workers.dev) reaches its projects as
// `<os>/projects/<project>/<app>/…` and the apex `<os>/projects/<project>/…`. The worker strips the prefix before the
// app sees the URL and hands the app its base path; every response back through this door is served
// SANDBOXED (a `Content-Security-Policy: sandbox …` header the edge adds — an app runs in an opaque
// origin, so its script cannot spend the issuer's cookie); and the platform's own first segments
// (`api`, `mcp`, `login`, …) are never a project. LOCAL ONLY: every row boots its own worker with the
// paths configuration (support/worker-config.ts; `await using paths = await pathsWorker()`, stopped
// when the row ends) — the shared worker routes by subdomain.
import { expect } from "vitest";
import { startOwnWorker, type OwnWorker } from "./support/own-worker.ts";
import { freshDnsSafeProjectSlug, localOnly } from "./support/project-host.ts";

/** An app that answers with what it was handed: the URL it saw, its base path, its app label. */
const SRC_ECHO_URL_APP = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Echo extends WorkerEntrypoint {
  fetch(request) {
    const url = new URL(request.url);
    return Response.json({
      path: url.pathname + url.search,
      basePath: request.headers.get("x-iterate-base-path"),
      app: request.headers.get("x-iterate-app"),
    }, { headers: { "x-app-header": "kept" } });
  }
}`,
};

localOnly(
  "an app is reached at /projects/<project>/<app>/…: the prefix stripped, the base path handed over, the answer sandboxed",
  { timeout: 120_000 },
  async () => {
    await using paths = await pathsWorker();
    const { origin, slug } = paths;
    const answer = await fetch(`${origin}/projects/${slug}/echo/hello?x=1`, { redirect: "manual" });
    expect(answer, await answer.clone().text()).toMatchObject({ status: 200 });
    expect(await answer.json()).toEqual({
      path: "/hello?x=1",
      basePath: `/projects/${slug}/echo`,
      app: "echo",
    });
    // the sandbox: added by the edge on the way out, the app's own headers kept
    expect(answer.headers.get("content-security-policy")).toMatch(/\bsandbox\b/);
    expect(answer.headers.get("x-app-header")).toBe("kept");
    // the app's root, with and without a trailing slash
    expect(await (await fetch(`${origin}/projects/${slug}/echo/`)).json()).toMatchObject({
      path: "/",
    });
    expect(await (await fetch(`${origin}/projects/${slug}/echo`)).json()).toMatchObject({
      path: "/",
    });
  },
);

localOnly(
  "the apex /<project>/… is the config worker's (nothing configured ⇒ 404, never a 500); an unknown project is 404",
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

/** A worker booted for one row with PATH routing, project `slug` created on it and the echo app
 *  provided at `itx.apps.echo`; disposing it stops the worker (and the sessions it minted). */
async function pathsWorker(): Promise<
  AsyncDisposable & { worker: OwnWorker; origin: string; slug: string }
> {
  await using stack = new AsyncDisposableStack();
  const worker = await startOwnWorker({ ingressRouting: { type: "paths" } });
  stack.defer(() => worker.stop());
  const slug = freshDnsSafeProjectSlug("paths");
  const itx = await worker.createProject(slug);
  await itx.provide("itx.apps.echo", ["itx", "workers", ["get", { source: SRC_ECHO_URL_APP }]]);
  const owned = stack.move();
  return {
    worker,
    origin: worker.url.origin,
    slug,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
