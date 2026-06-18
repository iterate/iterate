import { expect, it } from "vitest";
import { decideIngressRoute } from "./router.ts";

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
