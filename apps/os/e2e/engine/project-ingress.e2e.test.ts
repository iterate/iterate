import { expect, test } from "vitest";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

test("project ingress should serve a counter page backed by worker.js state", async () => {
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
  expect(pageResponse.headers.get("content-type")).toContain("text/html");
  const pageHtml = await pageResponse.text();
  expect(pageHtml).toMatch(/<form\b/i);
  expect(pageHtml).toMatch(/method=["']post["']/i);
  expect(pageHtml).toContain(`/${projectId}/increment`);
  expect(pageHtml).toMatch(/<button\b[\s\S]*increment/i);
  expect(pageHtml).toMatch(/count:\s*0/i);

  const firstIncrementPage = await fetch(buildUrl({ path: `/${projectId}/increment` }), {
    method: "POST",
  });
  expect(firstIncrementPage.status).toBe(200);
  expect(firstIncrementPage.headers.get("content-type")).toContain("text/html");
  expect(await firstIncrementPage.text()).toMatch(/count:\s*1/i);

  const secondIncrementPage = await fetch(buildUrl({ path: `/${projectId}/increment` }), {
    method: "POST",
  });
  expect(secondIncrementPage.status).toBe(200);
  expect(secondIncrementPage.headers.get("content-type")).toContain("text/html");
  expect(await secondIncrementPage.text()).toMatch(/count:\s*2/i);
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

  const fetchApp = (appHostPrefix: string, init?: RequestInit) => {
    const base = new URL(buildUrl({ path: "/" }));
    if (base.hostname === "localhost" || base.hostname.endsWith(".localhost")) {
      const headers = new Headers(init?.headers);
      headers.set("x-forwarded-host", `${appHostPrefix}.localhost`);
      return fetch(base, { ...init, headers });
    }
    // os.iterate-preview-N.com serves projects at *.iterate-preview-N.app —
    // same derivation the preview smoke uses for the MCP host.
    const previewMatch = /^os\.(iterate-preview-\d+)\.com$/.exec(base.hostname);
    const projectBase = previewMatch ? `${previewMatch[1]}.app` : base.hostname;
    return fetch(`${base.protocol}//${appHostPrefix}.${projectBase}/`, init);
  };

  // Stateless app via the `--` single-label form; a spoofed x-iterate-app
  // must not override the host's selection.
  const hello = await fetchApp(`hello--${slug}`, {
    headers: { "x-iterate-app": "counter" },
  });
  expect(hello.status).toBe(200);
  expect(await hello.json()).toMatchObject({ app: "hello", projectId });

  // Stateful app via the dotted form: state survives across requests.
  const first = await fetchApp(`counter.${slug}`, { method: "POST" });
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ app: "counter", count: 1 });

  const second = await fetchApp(`counter.${slug}`, { method: "POST" });
  expect(await second.json()).toMatchObject({ app: "counter", count: 2 });

  const read = await fetchApp(`counter.${slug}`);
  expect(await read.json()).toMatchObject({ app: "counter", count: 2 });

  // Unknown apps 404 in the router itself.
  const unknown = await fetchApp(`nope--${slug}`);
  expect(unknown.status).toBe(404);
  expect(await unknown.text()).toContain("unknown app");
});
