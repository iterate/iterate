import { describe, expect, test, vi } from "vitest";
import {
  chooseRootProjectRedirect,
  createMissingRootRedirectProject,
  type RootRedirectProject,
} from "./project-root-redirect.ts";

const project = (
  overrides: Partial<RootRedirectProject> & Pick<RootRedirectProject, "id" | "slug">,
): RootRedirectProject => ({
  organizationId: "org_1",
  deploymentStatus: "ready",
  ...overrides,
});

describe("chooseRootProjectRedirect", () => {
  test("opens a preferred ready project at its home", () => {
    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: "beta",
        projects: [project({ id: "prj_a", slug: "alpha" }), project({ id: "prj_b", slug: "beta" })],
      }),
    ).toMatchObject({
      kind: "project",
      project: { slug: "beta" },
      welcome: false,
    });
  });

  test("opens the only ready project at its home", () => {
    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: null,
        projects: [project({ id: "prj_a", slug: "alpha" })],
      }),
    ).toMatchObject({
      kind: "project",
      project: { slug: "alpha" },
      welcome: false,
    });
  });

  test("welcomes a single auth-created missing project through its creation flow", () => {
    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: null,
        projects: [project({ id: "prj_a", slug: "alpha", deploymentStatus: "missing" })],
      }),
    ).toMatchObject({
      kind: "project",
      project: { slug: "alpha" },
      welcome: true,
    });
  });

  test("leaves ambiguous or unknown project sets on the projects page", () => {
    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: null,
        projects: [
          project({ id: "prj_a", slug: "alpha", deploymentStatus: "missing" }),
          project({ id: "prj_b", slug: "beta", deploymentStatus: "missing" }),
        ],
      }),
    ).toEqual({ kind: "projects" });

    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: null,
        projects: [project({ id: "prj_a", slug: "alpha", deploymentStatus: "unknown" })],
      }),
    ).toEqual({ kind: "projects" });
  });
});

test("the missing-project SSR bootstrap does not wait for project readiness", async () => {
  const create = vi.fn(async () => ({}) as never);

  await createMissingRootRedirectProject(
    { create },
    { organizationSlug: "acme", projectId: "prj_missing" },
  );

  expect(create).toHaveBeenCalledWith(
    { organizationSlug: "acme", projectId: "prj_missing" },
    { waitUntilReady: false },
  );
});
