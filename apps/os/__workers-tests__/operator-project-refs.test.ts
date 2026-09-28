// What the operator's `projects.get` resolves (control-plane/edge.ts `projectIdOf`): a slug the
// catalog holds names its project; a slug it does not hold — never created, or deleted — is refused,
// never taken as a project id (prd once minted contexts named by a slug that way); a `prj_…` id the
// catalog never heard of is still the operator's to address (the e2e suite's fresh contexts).
import { expect, test } from "vitest";
import { adminCredentials, openSession, refused } from "./support.ts";

test("the operator reaches a project by its slug or its id, a made-up prj_ id too, and never a slug nobody holds", async () => {
  const admin = (await openSession()).authenticate(adminCredentials());
  const slug = `refs-${crypto.randomUUID().slice(0, 8)}`;
  const created = await admin.projects.create({ project: slug });
  const { projectId } = (await created.whoami()) as { projectId: string };
  expect(await (await admin.projects.get(slug)).whoami()).toMatchObject({ projectId });

  await refused(() => admin.projects.get(`no-such-${slug}`), "FORBIDDEN", /outside/);

  const madeUp = `prj_madeup_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  expect(await (await admin.projects.get(madeUp)).whoami()).toMatchObject({ projectId: madeUp });

  // a deleted project's slug names nothing any more
  await admin.projects.delete(slug);
  await refused(() => admin.projects.get(slug), "FORBIDDEN", /outside/);
});
