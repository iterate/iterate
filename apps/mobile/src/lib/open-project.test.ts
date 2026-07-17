import { expect, test } from "vitest";
import type { ProjectListEntry } from "../../../os/src/itx-api.generated.ts";
import type { ItxSession } from "./itx-core.ts";
import { backfillProjectIfMissing } from "./open-project.ts";

test("backfills a project whose OS-side bootstrap never ran", async () => {
  const calls: unknown[] = [];
  const itx = fakeItx((args) => calls.push(args));

  await backfillProjectIfMissing(itx, project({ deploymentStatus: "missing" }));

  expect(calls).toEqual([
    {
      projectId: "prj_a",
      slug: "alpha",
      waitUntilReady: false,
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

  expect(calls).toEqual([{ projectId: "prj_a", slug: "alpha", waitUntilReady: false }]);
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
      create: async (args: unknown) => {
        onCreate(args);
      },
    },
  } as unknown as ItxSession;
}
