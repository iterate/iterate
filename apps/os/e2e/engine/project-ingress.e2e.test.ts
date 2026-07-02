import { expect, test } from "vitest";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

test("project ingress serves the static seeded homepage at the root", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug: `project-ingress-${marker}` });
  const { projectId } = await project.describe();

  const pageResponse = await fetch(buildUrl({ path: `/${projectId}` }));
  expect(pageResponse.status).toBe(200);
  const homepage = await pageResponse.text();
  expect(homepage).toContain("Hello from your Iterate project worker");
  // The homepage links to each seeded app on its own host: the current host
  // prefixed with "<app>--".
  const requestHost = new URL(buildUrl({ path: "/" })).host;
  expect(homepage).toContain(`hello--${requestHost}`);
  expect(homepage).toContain(`counter--${requestHost}`);
});

// Multi-app routing: the seeded root worker.js is a router over the project's
// apps (repo-backed dynamic workers), selected by ingress from the host —
// hello--<slug>.<base> (stateless WorkerEntrypoint) and counter.<slug>.<base>
// (stateful Durable Object whose state survives across requests). Locally
// Node cannot resolve *.localhost, so the host rides on x-forwarded-host
// (which dev ingress honors); against a deployed preview the real wildcard
// hostnames are used.
test("routes seeded apps by host: stateless hello and stateful counter", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  const slug = `multi-app-${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = itx.projects.create({ slug });
  const { projectId } = await project.describe();

  const fetchApp = (appHostPrefix: string, init?: RequestInit & { path?: string }) => {
    const path = init?.path ?? "/";
    const base = new URL(buildUrl({ path }));
    if (base.hostname === "localhost" || base.hostname.endsWith(".localhost")) {
      const headers = new Headers(init?.headers);
      headers.set("x-forwarded-host", `${appHostPrefix}.localhost`);
      return fetch(base, { ...init, headers });
    }
    // os.iterate-preview-N.com serves projects at *.iterate-preview-N.app —
    // same derivation the preview smoke uses for the MCP host.
    const previewMatch = /^os\.(iterate-preview-\d+)\.com$/.exec(base.hostname);
    const projectBase = previewMatch ? `${previewMatch[1]}.app` : base.hostname;
    return fetch(`${base.protocol}//${appHostPrefix}.${projectBase}${path}`, init);
  };

  // Stateless app via the `--` single-label form; a spoofed x-iterate-app
  // must not override the host's selection.
  const hello = await fetchApp(`hello--${slug}`, {
    headers: { "x-iterate-app": "counter" },
  });
  expect(hello.status).toBe(200);
  expect(await hello.json()).toMatchObject({ app: "hello", projectId });

  // Stateful app: an HTML counter page whose increment REDIRECTS back to /
  // so the browser URL never sticks, with Durable Object state surviving
  // across requests. (The single-label `--` form is the one platform
  // wildcard certs can serve — dotted `<app>.<slug>.<base>` needs a second
  // wildcard level and is exercised in the unit tests + reserved for custom
  // hostnames.)
  const page = await fetchApp(`counter--${slug}`);
  expect(page.status).toBe(200);
  expect(await page.text()).toMatch(/count:\s*0/i);

  const increment = await fetchApp(`counter--${slug}`, {
    method: "POST",
    path: "/increment",
    redirect: "manual",
  });
  expect(increment.status).toBe(303);
  expect(increment.headers.get("location")).toBe("/");

  await fetchApp(`counter--${slug}`, { method: "POST", path: "/increment" });
  const read = await fetchApp(`counter--${slug}`);
  expect(await read.text()).toMatch(/count:\s*2/i);

  // The seeded repo is readable through the engine's repo capability.
  const workerSource = await project.repo.readFile({ path: "worker.js" });
  expect(workerSource?.content).toContain("const APPS");
  const tree = await project.repo.listFiles();
  expect(tree.paths).toEqual(
    expect.arrayContaining(["worker.js", "apps/hello/worker.js", "apps/counter/worker.js"]),
  );
  expect(await project.repo.readFile({ path: "nope.md" })).toBeNull();

  // Unknown apps 404 in the router itself.
  const unknown = await fetchApp(`nope--${slug}`);
  expect(unknown.status).toBe(404);
  expect(await unknown.text()).toContain("unknown app");
});
