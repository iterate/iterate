import { expect, it } from "vitest";
import { decideIngressRoute } from "./router.ts";

it("keeps deployed MCP routes on the app lane", async () => {
  const route = await decideIngressRoute({
    config: { baseUrl: "https://os.iterate.com", projectHostnameBases: ["iterate.app"] },
    db: {} as D1Database,
    method: "GET",
    url: "https://demo.iterate.app/api/mcp",
  });

  expect(route).toMatchObject({ lane: "os" });
});

it("keeps local MCP routes on the app lane", async () => {
  const route = await decideIngressRoute({
    config: { baseUrl: "http://localhost:5176", projectHostnameBases: ["localhost"] },
    db: {} as D1Database,
    method: "GET",
    url: "http://127.0.0.1:5176/api/mcp/.well-known/oauth-protected-resource",
  });

  expect(route).toMatchObject({ lane: "os" });
});

it("treats the bare localhost project-host base as an OS app-host alias", async () => {
  const route = await decideIngressRoute({
    config: {
      baseUrl: "https://os.iterate-dev-misha.com",
      projectHostnameBases: ["localhost"],
    },
    db: dbThatShouldNotBeUsed(),
    method: "GET",
    url: "http://localhost:62555/api/health",
  });

  expect(route).toMatchObject({ lane: "os" });
});

it("keeps localhost subdomains on the project-host lane", async () => {
  const route = await decideIngressRoute({
    config: {
      baseUrl: "https://os.iterate-dev-misha.com",
      projectHostnameBases: ["localhost"],
    },
    db: projectLookupDb({ id: "project-1", slug: "demo" }),
    method: "GET",
    url: "http://demo.localhost:62555/",
  });

  expect(route).toMatchObject({
    lane: "project",
    resolved: { target: "project", projectId: "project-1", appSlug: null },
  });
});

function dbThatShouldNotBeUsed() {
  return {
    prepare() {
      throw new Error("OS app-host alias should not query project routing tables.");
    },
  } as any;
}

function projectLookupDb(project: { id: string; slug: string }) {
  return {
    prepare() {
      return {
        bind() {
          return { first: async () => project };
        },
      };
    },
  } as any;
}
