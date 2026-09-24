// __workers-tests__/project-create-holds-no-account.test.ts — A PERSON'S FIRST PROJECT NEVER WAITS ON
// THEIR ACCOUNT. On 2026-09-24 (os-latency run 91m54ckl1f, trace f8279dfb) Cloudflare took 21.9 s to
// confirm the first write of a person's brand-new account context (`/users/<id>`, born a moment
// earlier by their sign-in's fact), and its output gate held every answer meanwhile: the
// `projects.create` that awaited the minted organization's membership on that account answered 22.7 s
// late. Here the account is held with the one control a test has inside an object,
// `blockConcurrencyWhile`: the creation answers while it is held, the organization's own record
// holds the owner and the project, and the membership reaches the account once it is released.
import { runInDurableObject } from "cloudflare:test";
import { expect, onTestFinished, test } from "vitest";
import type { AccountState } from "../src/account/contract.ts";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "../src/context/paths.ts";
import type { OrganizationState } from "../src/organization/contract.ts";
import { adminSession, stub, until } from "./support.ts";

/** How long the held creation may take: it answers in well under a second here, and before the
 *  membership left the answer it waited for the release, which never came. */
const ANSWER_MS = 5_000;

test("a person's first projects.create answers while their account context is held, and the minted organization's membership reaches the account once it is released", async () => {
  const sessions: Disposable[] = [];
  onTestFinished(() => {
    for (const session of sessions) session[Symbol.dispose]();
  });
  const person = await adminSession(sessions, "held-account@directory.test");
  const { actor } = await person.whoami();
  const accountState = async () =>
    (
      (await person.user.invoke(["itx", "facets", ["get", "account"], ["snapshot"]])) as {
        state: AccountState;
      }
    ).state;
  // the account as a person's first project meets it: born by their sign-in's own fact
  await until("the sign-in's fact is folded on the account", async () =>
    (await accountState()).authentications.length > 0 ? true : undefined,
  );

  // HELD: no call reaches the account until the release (the hold's own call answers only then)
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  // (a flag, not a promise: a promise the object resolved would run the test on in its context)
  let holding = false;
  const hold = runInDurableObject(
    stub(
      DurableObjectNameCodec.stringify({ projectId: GLOBAL_PROJECT_ID, path: `/users/${actor}` }),
    ),
    (_instance, state) =>
      state.blockConcurrencyWhile(() => {
        holding = true;
        return released;
      }),
  );
  onTestFinished(async () => {
    release();
    await hold;
  });
  await until("the account is held", () => holding);
  const creation = person.projects.create({ project: "held-account-first" });
  const outcome = await Promise.race([
    creation.then(() => "answered" as const),
    new Promise<"held">((resolve) => setTimeout(() => resolve("held"), ANSWER_MS)),
  ]);
  expect(outcome, "projects.create waited on the held account").toBe("answered");
  using project = await creation;
  const { projectId } = await project.whoami();
  // the organization's own record is the creation's to land, before it answers
  const [org] = await person.organizations.list();
  expect(org).toMatchObject({ name: "held-account", role: "owner", projects: 1 });
  const record = (
    (await person.organizations
      .get(org!.id)
      .invoke(["itx", "facets", ["get", "organization"], ["snapshot"]])) as {
      state: OrganizationState;
    }
  ).state;
  expect(record).toMatchObject({
    name: "held-account",
    members: { [actor]: { role: "owner" } },
    projects: { [projectId]: { slug: "held-account-first" } },
  });

  // RELEASED: the membership the creation left in the background lands
  release();
  await hold;
  expect(
    await until(
      "the membership lands on the released account",
      async () => (await accountState()).memberships[org!.id],
    ),
  ).toEqual({ role: "owner", since: expect.any(String) });
});
