import { test, expect } from "vitest";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "../sdk/cli/cli-db.ts";
import * as schema from "../backend/db/schema.ts";

const setupTestInstallation = async (now = Date.now()) => {
  const [org] = await db
    .insert(schema.organization)
    .values({ name: "testorg" + now })
    .returning();
  const [inst] = await db
    .insert(schema.installation)
    .values({ name: "testinstallation" + now, organizationId: org.id, slug: `test-${now}` })
    .returning();

  return {
    organization: org,
    installation: inst,
    now,
    [Symbol.asyncDispose]: async () => {
      await db.delete(schema.organization).where(eq(schema.organization.id, org.id));
      const leftovers = await db.query.installation.findMany({
        where: eq(schema.installation.id, inst.id),
      });
      expect(leftovers).toHaveLength(0); // delete of org should cascade
    },
  };
};

// not a test of our code, really, but there's a confusing github issue that claims drizzle *doesn't* support orderBy on nested relations.
// https://github.com/drizzle-team/drizzle-orm/issues/2650
// this proves it does.
// oh or maybe i misunderstood the issue, and the author wants to sort `installations` by the most recent source, rather than the sources themselves.
// anyway for anyone else confused, since drizzle's docs seem to be out of sync with reality, look at this. https://github.com/drizzle-team/drizzle-orm/issues/2650#issuecomment-2509792075
test.skip("drizzle", async () => {
  await using testEnv = await setupTestInstallation();
  const { installation, now } = testEnv;

  await db
    .insert(schema.iterateConfigSource)
    .values({
      installationId: installation.id,
      provider: "github",
      repoId: (now % 1_000_000_000) + 1,
      path: "testpath1" + now,
      branch: "testbranch1" + now,
      accountId: "testaccountid1" + now,
    })
    .returning();

  await db
    .insert(schema.iterateConfigSource)
    .values({
      installationId: installation.id,
      provider: "github2" as never,
      repoId: (now % 1_000_000_000) + 2,
      path: "testpath2" + now,
      branch: "testbranch2" + now,
      accountId: "testaccountid2" + now,
    })
    .returning();

  const sorted1 = await db.query.installation.findFirst({
    where: eq(schema.installation.id, installation.id),
    with: { sources: { orderBy: asc(schema.iterateConfigSource.repoId) } },
  });
  const sorted2 = await db.query.installation.findFirst({
    where: eq(schema.installation.id, installation.id),
    with: { sources: { orderBy: desc(schema.iterateConfigSource.repoId) } },
  });

  expect(sorted1?.sources.map((s) => s.repoId)).toEqual([
    (now % 1_000_000_000) + 1,
    (now % 1_000_000_000) + 2,
  ]);
  expect(sorted2?.sources.map((s) => s.repoId)).toEqual([
    (now % 1_000_000_000) + 2,
    (now % 1_000_000_000) + 1,
  ]);
});
