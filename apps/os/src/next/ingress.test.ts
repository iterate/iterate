import { expect, it } from "vitest";
import { decideIngressRoute, nextEngineRequest, type IngressResolvers } from "./ingress.ts";

const PREVIEW_CONFIG = {
  baseUrl: "https://os.iterate-preview-2.com",
  projectHostnameBases: ["iterate-preview-2.app"],
};

const DEV_CONFIG = {
  baseUrl: "http://localhost:56455",
  projectHostnameBases: ["localhost"],
};

it("keeps the OS host on the app lane", async () => {
  const route = await decideIngressRoute({
    config: PREVIEW_CONFIG,
    method: "GET",
    resolvers: resolversThatShouldNotBeUsed(),
    url: "https://os.iterate-preview-2.com/projects/demo",
  });

  expect(route).toMatchObject({ lane: "os" });
});

it("treats the bare localhost project-host base as an OS app-host alias", async () => {
  const route = await decideIngressRoute({
    config: DEV_CONFIG,
    method: "GET",
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/api/health",
  });

  expect(route).toMatchObject({ lane: "os" });
});

it("sends engine paths on the OS host to the api lane", async () => {
  for (const path of ["/api/itx", "/api/itx/admin-cookie", "/__itx_e2e/fixture"]) {
    const route = await decideIngressRoute({
      config: DEV_CONFIG,
      method: "GET",
      resolvers: resolversThatShouldNotBeUsed(),
      url: `http://localhost:56455${path}`,
    });
    expect(route).toMatchObject({ lane: "api" });
  }
});

it("rewrites the /prj_<id> path lane to the project sub-path", async () => {
  const route = await decideIngressRoute({
    config: DEV_CONFIG,
    method: "POST",
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/prj_123/increment",
  });

  expect(route).toMatchObject({
    lane: "project",
    resolved: { projectId: "prj_123", appSlug: null },
  });
  const fetch = (route as { fetch: { headers: Headers; url: string } }).fetch;
  expect(fetch.url).toBe("http://localhost:56455/increment");
  expect(fetch.headers.get("x-itx-project-id")).toBe("prj_123");
});

it("keeps localhost subdomains on the project lane without rewriting the URL", async () => {
  const route = await decideIngressRoute({
    config: DEV_CONFIG,
    method: "GET",
    resolvers: slugResolvers({ demo: "prj_1" }),
    url: "http://demo.localhost:56455/some/path?q=1",
  });

  expect(route).toMatchObject({
    lane: "project",
    resolved: { projectId: "prj_1", appSlug: null },
  });
  expect((route as { fetch: { url: string } }).fetch.url).toBe(
    "http://demo.localhost:56455/some/path?q=1",
  );
});

it("passes prj_ ids in hostnames straight through", async () => {
  const route = await decideIngressRoute({
    config: PREVIEW_CONFIG,
    method: "GET",
    resolvers: slugResolvers({}),
    url: "https://prj_123.iterate-preview-2.app/",
  });

  expect(route).toMatchObject({
    lane: "project",
    resolved: { projectId: "prj_123", appSlug: null },
  });
});

it("selects an app from <app>--<slug> hosts as the trusted x-iterate-app header", async () => {
  const route = await decideIngressRoute({
    config: PREVIEW_CONFIG,
    headers: { "x-iterate-app": "spoofed" },
    method: "GET",
    resolvers: slugResolvers({ demo: "prj_1" }),
    url: "https://hello--demo.iterate-preview-2.app/",
  });

  expect(route).toMatchObject({
    lane: "project",
    resolved: { projectId: "prj_1", appSlug: "hello" },
  });
  const headers = (route as { fetch: { headers: Headers } }).fetch.headers;
  expect(headers.get("x-iterate-app")).toBe("hello");
});

it("selects an app from dotted <app>.<slug> hosts", async () => {
  const route = await decideIngressRoute({
    config: PREVIEW_CONFIG,
    method: "GET",
    resolvers: slugResolvers({ demo: "prj_1" }),
    url: "https://counter.demo.iterate-preview-2.app/",
  });

  expect(route).toMatchObject({
    lane: "project",
    resolved: { projectId: "prj_1", appSlug: "counter" },
  });
});

it("prefers a whole-label slug over an app split when both resolve", async () => {
  // A project legitimately named "hello--demo" wins over app "hello" in
  // project "demo" — the bare label is the first candidate.
  const route = await decideIngressRoute({
    config: PREVIEW_CONFIG,
    method: "GET",
    resolvers: slugResolvers({ "hello--demo": "prj_whole", demo: "prj_1" }),
    url: "https://hello--demo.iterate-preview-2.app/",
  });

  expect(route).toMatchObject({
    lane: "project",
    resolved: { projectId: "prj_whole", appSlug: null },
  });
});

it("deletes a spoofed x-iterate-app when the host selects no app", async () => {
  const route = await decideIngressRoute({
    config: PREVIEW_CONFIG,
    headers: { "x-iterate-app": "spoofed" },
    method: "GET",
    resolvers: slugResolvers({ demo: "prj_1" }),
    url: "https://demo.iterate-preview-2.app/",
  });

  const headers = (route as { fetch: { headers: Headers } }).fetch.headers;
  expect(headers.get("x-iterate-app")).toBeNull();
});

it("resolves registered custom hostnames, with <app>. subdomains selecting an app", async () => {
  const resolvers: IngressResolvers = {
    projectIdBySlug: () => Promise.resolve(null),
    projectByHostname: (host) =>
      Promise.resolve(
        host === "bla.com"
          ? { projectId: "prj_custom", appSlug: null }
          : host === "someapp.bla.com"
            ? { projectId: "prj_custom", appSlug: "someapp" }
            : null,
      ),
  };

  const exact = await decideIngressRoute({
    config: PREVIEW_CONFIG,
    method: "GET",
    resolvers,
    url: "https://bla.com/",
  });
  expect(exact).toMatchObject({
    lane: "project",
    resolved: { projectId: "prj_custom", appSlug: null },
  });

  const app = await decideIngressRoute({
    config: PREVIEW_CONFIG,
    method: "GET",
    resolvers,
    url: "https://someapp.bla.com/",
  });
  expect(app).toMatchObject({
    lane: "project",
    resolved: { projectId: "prj_custom", appSlug: "someapp" },
  });
});

it("404s non-OS hosts that resolve to nothing", async () => {
  const route = await decideIngressRoute({
    config: PREVIEW_CONFIG,
    method: "GET",
    resolvers: slugResolvers({}),
    url: "https://nope.iterate-preview-2.app/",
  });

  expect(route).toMatchObject({ lane: "notFound" });
});

it("honors x-forwarded-host for host classification", async () => {
  const route = await decideIngressRoute({
    config: DEV_CONFIG,
    headers: { "x-forwarded-host": "demo.localhost:56455" },
    method: "GET",
    resolvers: slugResolvers({ demo: "prj_1" }),
    url: "http://localhost:56455/",
  });

  expect(route).toMatchObject({
    lane: "project",
    resolved: { projectId: "prj_1" },
  });
});

it("nextEngineRequest forwards project hosts and engine paths, keeps the app lane", () => {
  const forward = (url: string, headers?: HeadersInit) =>
    nextEngineRequest({ config: DEV_CONFIG, request: new Request(url, { headers }) });

  expect(forward("http://localhost:56455/projects/demo")).toBeNull();
  expect(forward("http://localhost:56455/api/itx")).not.toBeNull();
  expect(forward("http://localhost:56455/prj_123/x")).not.toBeNull();
  expect(forward("http://demo.localhost:56455/")).not.toBeNull();
  expect(forward("http://hello--demo.localhost:56455/")).not.toBeNull();
  expect(forward("https://unknown-host.example.com/")).not.toBeNull();
});

function resolversThatShouldNotBeUsed(): IngressResolvers {
  return {
    projectIdBySlug() {
      throw new Error("OS app-host lanes should not resolve project slugs.");
    },
    projectByHostname() {
      throw new Error("OS app-host lanes should not resolve custom hostnames.");
    },
  };
}

function slugResolvers(bySlug: Record<string, string>): IngressResolvers {
  return {
    projectIdBySlug: (identifier) =>
      Promise.resolve(identifier.startsWith("prj_") ? identifier : (bySlug[identifier] ?? null)),
    projectByHostname: () => Promise.resolve(null),
  };
}
