// vitest/os-workers/project-create-holds-no-account.test.ts — A PERSON'S FIRST PROJECT NEVER WAITS ON
// THEIR ACCOUNT (src/session.ts `publishProjectAdded`: a brand-new account can hold every answer
// while Cloudflare confirms its first write). Here the account is held with the one control a test
// has inside an object, `blockConcurrencyWhile`: the creation answers while it is held, the catalog
// lists the minted organization, and the membership's fact reaches the account once it is
// released.
import { runInDurableObject } from "cloudflare:test";
import { expect, onTestFinished, test } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import type { AccountState } from "../../../core/os/src/account/contract.ts";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "../../../core/os/src/context/paths.ts";
import { adminSession, stub, until } from "./support.ts";

/** How long the held creation may take. It answers in well under a second here; one that waits on
 *  the account waits for the release, which comes only after this. */
const ANSWER_MS = 5_000;

test("a person's first projects.create answers while their account context is held, and the minted organization's membership reaches the account's activity once it is released", async () => {
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
  using _project = await creation;
  // the catalog is the organization's truth, and holds it at once
  const [org] = await person.organizations.list();
  expect(org).toMatchObject({ name: "held-account", role: "owner", projects: 1 });

  // RELEASED: the membership's fact the creation left in the background lands
  release();
  await hold;
  const landed = await until("the membership lands on the released account", async () => {
    const { events } = (await person.user.invoke(["itx", ["readEvents", 0, 1000]])) as {
      events: StreamEvent[];
    };
    return events.find((event) => event.type === "events.iterate.com/organization/member-added");
  });
  expect(landed).toMatchObject({ payload: { orgId: org!.id, userId: actor, role: "owner" } });
});
