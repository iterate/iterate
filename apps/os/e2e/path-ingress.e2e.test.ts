// path-ingress.e2e.test.ts — PATH ROUTING (src/app-config.ts `urls.ingressRouting: { type: "paths" }`):
// a deployment with one hostname and no wildcard (workers.dev) reaches its projects as
// `<os>/projects/<project>/<routingSlug>/…` and the apex `<os>/projects/<project>/…`, both the
// project's config worker. The worker strips the prefix before the config worker sees the URL and
// hands it its base path. Every app runs on the platform's own origin, where its script acts as
// whoever is signed in there, so EVERY PROJECT PATH IS MEMBERS-ONLY (src/project-host-sign-in.ts
// rules 8–10): a member gets the app's answer as it was, with no sandbox; anyone else is turned away
// at the edge — a page load to sign in, a fetch 401, a signed-in non-member 403. A signed file URL
// is its own authorization. The platform's own first segments (`api`, `mcp`, `login`, …) are never
// a project. LOCAL ONLY: every row boots its own worker with the paths configuration
// (support/worker-config.ts; `await using paths = await pathsWorker()`, stopped when the row ends) —
// the shared worker routes by subdomain.
import { request } from "undici";
import { expect } from "vitest";
import { startOwnWorker, type OwnWorker } from "./support/own-worker.ts";
import { issuerCookie } from "./support/principal.ts";
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
      cookie: request.headers.get("cookie"),
    }, { headers: { "x-app-header": "kept" } });
  }
}`,
};

localOnly(
  "a member reaches a routing slug at /projects/<project>/<routingSlug>/…: the prefix stripped, the base path handed over, the answer as the app gave it (no sandbox), the platform's cookie kept from the app",
  { timeout: 120_000 },
  async () => {
    await using paths = await pathsWorker();
    const { origin, slug, member } = paths;
    const answer = await fetch(`${origin}/projects/${slug}/echo/hello?x=1`, {
      headers: { cookie: `${member}; theme=dark` },
      redirect: "manual",
    });
    expect(answer, await answer.clone().text()).toMatchObject({ status: 200 });
    expect(await answer.json()).toEqual({
      path: "/hello?x=1",
      basePath: `/projects/${slug}/echo`,
      routingSlug: "echo",
      cookie: "theme=dark",
    });
    expect(answer.headers.get("content-security-policy")).toBeNull();
    expect(answer.headers.get("x-app-header")).toBe("kept");
    // the routing slug's root, with and without a trailing slash
    const asMember = { headers: { cookie: member } };
    expect(await (await fetch(`${origin}/projects/${slug}/echo/`, asMember)).json()).toMatchObject({
      path: "/",
    });
    expect(await (await fetch(`${origin}/projects/${slug}/echo`, asMember)).json()).toMatchObject({
      path: "/",
    });
    // the apex is the config worker's too (its 404); an unknown project is 4xx
    const apex = await fetch(`${origin}/projects/${slug}/`, { ...asMember, redirect: "manual" });
    expect(apex, await apex.clone().text()).toMatchObject({ status: 404 });
    const unknown = await fetch(`${origin}/projects/${freshDnsSafeProjectSlug("nobody")}/echo/`, {
      ...asMember,
      redirect: "manual",
    });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.status).toBeLessThan(500);
  },
);

localOnly(
  "every project path is members-only: an anonymous page load goes to sign in and back, an anonymous fetch is 401, a signed-in non-member is 403 — the apex too",
  { timeout: 120_000 },
  async () => {
    await using paths = await pathsWorker();
    const { origin, slug } = paths;
    const navigate = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    for (const path of [`/projects/${slug}/echo/hello?x=1`, `/projects/${slug}/`]) {
      // a page load as the browser sends it: fetch would overwrite `Sec-Fetch-Mode` with its own
      const signIn = await request(`${origin}${path}`, { headers: navigate });
      await signIn.body.dump();
      expect(signIn, path).toMatchObject({
        statusCode: 302,
        headers: { location: `${origin}/.auth/login?${new URLSearchParams({ next: path })}` },
      });
      const fetched = await fetch(`${origin}${path}`, { redirect: "manual" });
      expect(fetched, path).toMatchObject({ status: 401 });
      expect(fetched.headers.get("www-authenticate"), path).toBe('Bearer realm="iterate"');
    }
    const stranger = await issuerCookie(`${slug}-stranger@example.com`, "/", origin);
    for (const headers of [{ cookie: stranger }, { cookie: stranger, ...navigate }]) {
      const refused = await request(`${origin}/projects/${slug}/echo/`, { headers });
      expect(refused).toMatchObject({ statusCode: 403 });
      expect(await refused.body.text()).toBe(`You are not a member of the project ${slug}.\n`);
    }
  },
);

localOnly(
  "a stored file under /projects/<project>/files/… is served to anyone holding its signed URL, no sign-in — and sandboxed, the one thing on the platform's origin a non-member reaches",
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
    const discovery = await (
      await fetch(`${origin}/.well-known/oauth-authorization-server`)
    ).json();
    expect(discovery).toMatchObject({ issuer: origin });
  },
);

/** A worker booted for one row with PATH routing, project `slug` created on it as a person — its
 *  member, whose issuer cookie is `member` — and the echo config worker published; disposing it
 *  stops the worker (and the sessions it minted). */
async function pathsWorker(): Promise<
  AsyncDisposable & { worker: OwnWorker; origin: string; slug: string; member: string }
> {
  await using stack = new AsyncDisposableStack();
  const worker = await startOwnWorker({ ingressRouting: { type: "paths" } });
  stack.defer(() => worker.stop());
  const slug = freshDnsSafeProjectSlug("paths");
  const email = `${slug}@example.com`;
  const itx = await worker.createProject(slug, { email });
  await publishConfigWorker(itx, [
    "itx",
    "workers",
    ["get", { source: SRC_ECHO_URL_CONFIG_WORKER }],
  ]);
  const member = await issuerCookie(email, "/", worker.url.origin);
  const owned = stack.move();
  return {
    worker,
    origin: worker.url.origin,
    slug,
    member,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
