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
  deploymentStatus: "created",
  ...overrides,
});

describe("chooseRootProjectRedirect", () => {
  test("opens a preferred created project at its home", () => {
    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: "beta",
        projects: [project({ id: "prj_a", slug: "alpha" }), project({ id: "prj_b", slug: "beta" })],
      }),
    ).toMatchObject({
      kind: "project",
      project: { slug: "beta" },
      welcome: false,
      ensureBirth: false,
    });
  });

  test("opens the only created project at its home", () => {
    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: null,
        projects: [project({ id: "prj_a", slug: "alpha" })],
      }),
    ).toMatchObject({
      kind: "project",
      project: { slug: "alpha" },
      welcome: false,
      ensureBirth: false,
    });
  });

  test("resumes the only creating project on its live creation checklist", () => {
    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: null,
        projects: [project({ id: "prj_a", slug: "alpha", deploymentStatus: "creating" })],
      }),
    ).toMatchObject({
      kind: "project",
      project: { slug: "alpha" },
      welcome: true,
      ensureBirth: false,
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
      ensureBirth: false,
    });
  });

  test("recovers a single project whose deployment probe failed through its welcome flow", () => {
    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: null,
        projects: [project({ id: "prj_a", slug: "alpha", deploymentStatus: "unknown" })],
      }),
    ).toMatchObject({
      kind: "project",
      project: { slug: "alpha" },
      welcome: true,
      ensureBirth: true,
    });
  });

  test("leaves ambiguous or failed project sets on the projects page", () => {
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
        projects: [project({ id: "prj_a", slug: "alpha", deploymentStatus: "failed" })],
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
    { waitUntilCreated: false },
  );
});
