import { expect, test } from "vitest";
import type { ProjectListEntry } from "iterate/react";
import type { ItxSession } from "./itx.ts";
import { backfillProjectIfMissing, rememberedProjectInScope } from "./open-project.ts";

test("keeps a remembered project only while the current auth context can access it", () => {
  const remembered = { id: "prj_a", slug: "stale-alpha" };

  expect(rememberedProjectInScope(remembered, [project({ id: "prj_a", slug: "alpha" })])).toEqual({
    id: "prj_a",
    slug: "alpha",
  });
  expect(rememberedProjectInScope(remembered, [project({ id: "prj_b" })])).toBeNull();
});

test("backfills a project whose OS-side bootstrap never ran", async () => {
  const calls: unknown[] = [];
  const itx = fakeItx((args) => calls.push(args));

  await backfillProjectIfMissing(itx, project({ deploymentStatus: "missing" }));

  expect(calls).toEqual([
    {
      projectId: "prj_a",
      slug: "alpha",
      organizationSlug: "acme",
    },
  ]);
});

test("omits organizationSlug when the project has none", async () => {
  const calls: unknown[] = [];
  const itx = fakeItx((args) => calls.push(args));

  await backfillProjectIfMissing(
    itx,
    project({ deploymentStatus: "missing", organizationSlug: null }),
  );

  expect(calls).toEqual([{ projectId: "prj_a", slug: "alpha" }]);
});

test.each(["ready", "unknown"] as const)(
  "does nothing when deploymentStatus is %s",
  async (deploymentStatus) => {
    const calls: unknown[] = [];
    const itx = fakeItx((args) => calls.push(args));

    await backfillProjectIfMissing(itx, project({ deploymentStatus }));

    expect(calls).toEqual([]);
  },
);

function project(overrides: Partial<ProjectListEntry>): ProjectListEntry {
  return {
    id: "prj_a",
    slug: "alpha",
    organizationId: "org_a",
    organizationName: "Acme",
    organizationSlug: "acme",
    deploymentStatus: "ready",
    ...overrides,
  };
}

function fakeItx(onCreate: (args: unknown) => void): ItxSession {
  return {
    projects: {
      get: (slug: string) => ({
        create: async (args: unknown) => {
          onCreate({ slug, ...(args as object) });
        },
      }),
    },
  } as unknown as ItxSession;
}
