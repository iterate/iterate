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
  test("prefers the current project host when that project is ready", () => {
    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: "beta",
        preferredProjectOnboarding: false,
        projects: [project({ id: "prj_a", slug: "alpha" }), project({ id: "prj_b", slug: "beta" })],
      }),
    ).toMatchObject({
      kind: "project",
      project: { slug: "beta" },
      onboarding: false,
    });
  });

  test("checks onboarding for the most recently active project", () => {
    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: "beta",
        preferredProjectOnboarding: true,
        projects: [project({ id: "prj_a", slug: "alpha" }), project({ id: "prj_b", slug: "beta" })],
      }),
    ).toMatchObject({
      kind: "project",
      project: { slug: "beta" },
      onboarding: true,
    });
  });

  test("sends the only ready project to onboarding", () => {
    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: null,
        preferredProjectOnboarding: false,
        projects: [project({ id: "prj_a", slug: "alpha" })],
      }),
    ).toMatchObject({
      kind: "project",
      project: { slug: "alpha" },
      onboarding: true,
    });
  });

  test("sends a single auth-created missing project to onboarding", () => {
    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: null,
        preferredProjectOnboarding: false,
        projects: [project({ id: "prj_a", slug: "alpha", deploymentStatus: "missing" })],
      }),
    ).toMatchObject({
      kind: "project",
      project: { slug: "alpha" },
      onboarding: true,
    });
  });

  test("leaves ambiguous or unknown project sets on the projects page", () => {
    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: null,
        preferredProjectOnboarding: false,
        projects: [
          project({ id: "prj_a", slug: "alpha", deploymentStatus: "missing" }),
          project({ id: "prj_b", slug: "beta", deploymentStatus: "missing" }),
        ],
      }),
    ).toEqual({ kind: "projects" });

    expect(
      chooseRootProjectRedirect({
        preferredProjectSlug: null,
        preferredProjectOnboarding: false,
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
