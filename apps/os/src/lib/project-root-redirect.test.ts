import { describe, expect, test } from "vitest";
import { chooseRootProjectRedirect, type RootRedirectProject } from "./project-root-redirect.ts";

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
        projects: [project({ id: "prj_a", slug: "alpha" }), project({ id: "prj_b", slug: "beta" })],
      }),
    ).toMatchObject({
      kind: "project",
      project: { slug: "beta" },
      welcome: false,
    });
  });

  test("redirects to the only ready project without welcome mode", () => {
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

  test("sends a single auth-created missing project through welcome mode", () => {
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
