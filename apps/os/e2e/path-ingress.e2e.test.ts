// path-ingress.e2e.test.ts — PATH ROUTING (src/app-config.ts `urls.ingressRouting: { type: "paths" }`):
// a deployment with one hostname and no wildcard (workers.dev) reaches its projects as
// `<os>/projects/<project>/<routingSlug>/…` and the apex `<os>/projects/<project>/…`, both the
// project's config worker. The worker strips the prefix before the config worker sees the URL and
// hands it its base path. Every app runs on the platform's own origin; public or private is the
// app's call per path, exactly as under subdomains: an app's `401 Bearer realm="iterate"` becomes
// the platform's sign-in for a page load (next: the full `/projects/…` path), and a member arrives
// stamped. An app cannot set the platform's `__Host-itx-*` cookies or `Service-Worker-Allowed`. A
// stored file is served sandboxed (anyone holding its signed URL opens it). The platform's own first
// segments (`api`, `mcp`, `login`, …) are never a project. LOCAL ONLY: every row boots its own worker with the paths configuration
// (support/worker-config.ts; `await using paths = await pathsWorker()`, stopped when the row ends) —
// the shared worker routes by subdomain.
import { request } from "undici";
import { expect } from "vitest";
import { startOwnWorker } from "./support/own-worker.ts";
import { issuerCookie } from "./support/principal.ts";
import { freshDnsSafeProjectSlug, localOnly, publishConfigWorker } from "./support/project-host.ts";

/** A config worker that answers a routing slug with what it was handed: the URL it saw, its base
 *  path, its routing slug, the cookie and principal it was given; `/private` asks for a signed-in
 *  caller (the platform's challenge) unless one is stamped; `/headers` tries to set what only the
 *  platform may; the apex is its own 404. */
const SRC_ECHO_URL_CONFIG_WORKER = {
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Echo extends WorkerEntrypoint {
  fetch(request) {
    const url = new URL(request.url);
    const routingSlug = request.headers.get("x-iterate-routing-slug");
    if (routingSlug === null) return new Response("Not found\\n", { status: 404 });
    const principal = request.headers.get("x-itx-principal");
    if (url.pathname === "/private" && !principal)
      return new Response("Sign in\\n", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="iterate"' } });
    if (url.pathname === "/headers") {
      const headers = new Headers({ "Service-Worker-Allowed": "/" });
      headers.append("Set-Cookie", "__Host-itx-session=stolen; Path=/; Secure; HttpOnly");
      headers.append("Set-Cookie", "theme=dark; Path=/");
      return new Response("ok\\n", { headers });
    }
    return Response.json({
      path: url.pathname + url.search,
      basePath: request.headers.get("x-iterate-base-path"),
      routingSlug,
      cookie: request.headers.get("cookie"),
      signedIn: principal !== null,
    }, { headers: { "x-app-header": "kept" } });
  }
}`,
};

localOnly(
  "a routing slug is reached at /projects/<project>/<routingSlug>/…, public by default: the prefix stripped, the base path handed over, the app's headers kept, the platform's own (cookies, service-worker scope) dropped",
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
      cookie: null,
      signedIn: false,
    });
    expect(answer.headers.get("content-security-policy")).toBeNull();
    expect(answer.headers.get("x-app-header")).toBe("kept");
    // what only the platform may say on its origin never reaches the visitor
    const headers = await fetch(`${origin}/projects/${slug}/echo/headers`);
    expect(headers.headers.get("service-worker-allowed")).toBeNull();
    expect(headers.headers.getSetCookie()).toEqual(["theme=dark; Path=/"]);
    // the routing slug's root, with and without a trailing slash
    expect(await (await fetch(`${origin}/projects/${slug}/echo/`)).json()).toMatchObject({
      path: "/",
    });
    expect(await (await fetch(`${origin}/projects/${slug}/echo`)).json()).toMatchObject({
      path: "/",
    });
    // the apex is the config worker's too (its 404); an unknown project is 4xx
    const apex = await fetch(`${origin}/projects/${slug}/`, { redirect: "manual" });
    expect(apex, await apex.clone().text()).toMatchObject({ status: 404 });
    const unknown = await fetch(`${origin}/projects/${freshDnsSafeProjectSlug("nobody")}/echo/`, {
      redirect: "manual",
    });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.status).toBeLessThan(500);
  },
);

localOnly(
  "a path the app keeps private: a page load goes to sign in and back to the full /projects/… path; a member arrives signed in",
  { timeout: 120_000 },
  async () => {
    await using paths = await pathsWorker();
    const { origin, slug, member } = paths;
    const path = `/projects/${slug}/echo/private?x=1`;
    // a page load as the browser sends it (fetch would overwrite `Sec-Fetch-Mode`); undici directly,
    // not navigateProjectUrl, whose local dispatcher dials the shared worker, not this one
    const signIn = await request(`${origin}${path}`, {
      headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    });
    await signIn.body.dump();
    expect(signIn).toMatchObject({
      statusCode: 302,
      headers: { location: `${origin}/.auth/login?${new URLSearchParams({ next: path })}` },
    });
    const signedIn = await fetch(`${origin}${path}`, {
      headers: { cookie: `${member}; theme=dark` },
      redirect: "manual",
    });
    expect(signedIn, await signedIn.clone().text()).toMatchObject({ status: 200 });
    expect(await signedIn.json()).toMatchObject({
      path: "/private?x=1",
      cookie: "theme=dark",
      signedIn: true,
    });
  },
);

localOnly(
  "a stored file under /projects/<project>/files/… is served to anyone holding its signed URL, sandboxed",
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
    const csp = served.headers.get("content-security-policy");
    expect(csp).toMatch(/\bsandbox\b/);
    expect(csp).not.toContain("allow-same-origin");
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
async function pathsWorker() {
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
