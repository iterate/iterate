// __workers-tests__/lends.test.ts — a person's own Google connection, connected on their own context
// (`session.user.integrations.connect`) through the pet shop's fake, then LENT to a project: the
// project's `getSecret("<its path>")` is forwarded to the lender's secret, which dispatches it (and
// refreshes it) itself; the borrowed path holds no token. A revocation, the borrower's delete and the
// lender leaving the organization each end the lend, and the project's next use is a 502.
import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "../src/context/paths.ts";
import {
  followConsent,
  ORIGIN,
  petshopFakes,
  projectWithMember,
  signedInMember,
  stub,
} from "./support.ts";

test("a person's Google connection lent to their project: the project's uses run at the lender, refreshed there, and end with the lend", async () => {
  const lender = await projectWithMember("lend-google");
  const petshop = petshopFakes();
  const path = await personalGoogle(petshop, lender, "ada@example.test");
  const { lendId } = await lender.session.user.secrets.lend(path, {
    to: lender.projectId,
    as: "/secrets/google-ada",
  });
  // the project's catalog shows it borrowed, with whose connection it is
  expect(await lender.itx.secrets.list()).toContainEqual(
    expect.objectContaining({
      path: "/secrets/google-ada",
      borrowed: expect.objectContaining({
        lendId,
        integration: expect.objectContaining({ provider: "google", account: "ada@example.test" }),
      }),
    }),
  );
  expect(await gmailProfile(lender.itx)).toMatchObject({
    status: 200,
    body: { emailAddress: "ada@example.test" },
  });
  // an expired token is refreshed at the lender, through iterate's client
  await petshop.state.expireAccessTokens("petshop-default");
  expect(await gmailProfile(lender.itx)).toMatchObject({ status: 200 });
  const uses = (await lenderLog(lender, path)).filter(
    (event) => event.type === "events.iterate.com/secret/used",
  );
  expect(uses.at(-1)?.payload).toMatchObject({ status: 200, borrower: lender.projectId });
  await lender.session.user.secrets.revokeLend(path, lendId);
  expect(await gmailProfile(lender.itx)).toMatchObject({ status: 502 });
  expect(
    (await lender.itx.secrets.list()).map((secret: { path: string }) => secret.path),
  ).not.toContain("/secrets/google-ada");
  expect(await revocations(lender, path)).toEqual([{ lendId, reason: "lender" }]);
});

test("the borrower deleting its borrowed path revokes the lend at the lender", async () => {
  const lender = await projectWithMember("lend-deleted");
  const petshop = petshopFakes();
  const path = await personalGoogle(petshop, lender, "bea@example.test");
  const { lendId } = await lender.session.user.secrets.lend(path, {
    to: lender.projectId,
    as: "/secrets/google-bea",
  });
  await lender.itx.secrets.delete("/secrets/google-bea");
  expect(await revocations(lender, path)).toEqual([{ lendId, reason: "borrower-deleted" }]);
  const account = await lender.session.user.facets.get("account").snapshot();
  expect(account.state.secrets[path]).toMatchObject({ lends: {} });
});

test("the borrower setting its own material over its borrowed path revokes the lend at the lender, which lists it no more", async () => {
  const lender = await projectWithMember("lend-overwritten");
  const petshop = petshopFakes();
  const path = await personalGoogle(petshop, lender, "ove@example.test");
  const { lendId } = await lender.session.user.secrets.lend(path, {
    to: lender.projectId,
    as: "/secrets/google-ove",
  });
  await lender.itx.secrets.set("/secrets/google-ove", "own", { urls: ["https://google.test"] });
  expect(await revocations(lender, path)).toEqual([{ lendId, reason: "borrower-deleted" }]);
  const account = await lender.session.user.facets.get("account").snapshot();
  expect(account.state.secrets[path]).toMatchObject({ lends: {} });
});

test("a lender removed from the project's organization: the lend ends on both sides, and the project's next use is a 502", async () => {
  const owner = await projectWithMember("lend-org");
  const bob = await signedInMember("bob-lends@example.test");
  // after every sign-in: signing in restores `fetch`
  const petshop = petshopFakes();
  const [organization] = await owner.session.organizations.list();
  await owner.session.organizations.addMember(organization.id, {
    userId: "bob-lends@example.test",
  });
  const path = await personalGoogle(petshop, bob, "bob@example.test");
  const { lendId } = await bob.session.user.secrets.lend(path, {
    to: owner.projectId,
    as: "/secrets/google-bob",
  });
  expect(await gmailProfile(owner.itx, "/secrets/google-bob")).toMatchObject({ status: 200 });
  await owner.session.organizations.removeMember(organization.id, {
    userId: "bob-lends@example.test",
  });
  expect(await gmailProfile(owner.itx, "/secrets/google-bob")).toMatchObject({ status: 502 });
  expect(await revocations(bob, path)).toEqual([{ lendId, reason: "membership-ended" }]);
});

test("only a person lends, only to a project they reach, and a project's own secret is never overwritten by a lend", async () => {
  const lender = await projectWithMember("lend-refusals");
  const stranger = await projectWithMember("lend-strangers");
  const petshop = petshopFakes();
  const path = await personalGoogle(petshop, lender, "cy@example.test");
  await expect(
    lender.session.user.secrets.lend(path, { to: stranger.projectId, as: "/secrets/g" }),
  ).rejects.toThrow(/not a member/);
  await lender.itx.secrets.set("/secrets/taken", "own", { urls: ["https://google.test"] });
  await expect(
    lender.session.user.secrets.lend(path, { to: lender.projectId, as: "/secrets/taken" }),
  ).rejects.toThrow(/a secret of its own/);
  await expect(
    lender.itx.secrets.lend("/secrets/taken", { to: lender.projectId, as: "/secrets/x" }),
  ).rejects.toThrow(/a person lends their own secrets/);
  // one lend per path: a second would leave the first live at its lender
  await lender.session.user.secrets.lend(path, { to: lender.projectId, as: "/secrets/lent" });
  await expect(
    lender.session.user.secrets.lend(path, { to: lender.projectId, as: "/secrets/lent" }),
  ).rejects.toThrow(/borrows another lend already/);
  await expect(
    lender.itx.secrets.acceptLend("/secrets/forged", {
      lendId: "lend_x",
      lender: { userId: "user_x" },
      lenderContext: "x",
      lenderPath: "/secrets/x",
      urls: ["https://google.test"],
    }),
  ).rejects.toThrow(/the platform's own/);
  // the refused lends left none behind: only the one to /secrets/lent stands
  const account = await lender.session.user.facets.get("account").snapshot();
  expect(Object.values(account.state.secrets[path].lends)).toEqual([
    expect.objectContaining({ as: "/secrets/lent" }),
  ]);
});

type Member = { session: any; cookie: string };

/** The person's own Google connection, connected on their context through the fake: its secret's
 *  path under their root. */
async function personalGoogle(
  petshop: ReturnType<typeof petshopFakes>,
  member: Member,
  email: string,
): Promise<string> {
  const { authorizationUrl, connection } = await member.session.user.integrations.connect(
    "google",
    { next: `${ORIGIN}/` },
  );
  const back = await followConsent(petshop, `${authorizationUrl}&email=${email}`, member.cookie);
  expect(back, await back.clone().text()).toMatchObject({ status: 303 });
  const account = await member.session.user.facets.get("account").snapshot();
  expect(account.state.integrations[`/integrations/google/${connection}`]).toMatchObject({
    account: email,
  });
  return `/secrets/google-${connection}`;
}

async function gmailProfile(itx: any, path = "/secrets/google-ada") {
  const response: Response = await itx.fetch(
    new Request("https://google.test/gmail/v1/users/me/profile", {
      headers: { authorization: `Bearer getSecret("${path}", { field: "accessToken" })` },
    }),
  );
  const text = await response.text();
  return { status: response.status, body: response.ok ? JSON.parse(text) : text };
}

/** The lender's secret's own log. */
async function lenderLog(member: Member, path: string): Promise<StreamEvent[]> {
  const { actor } = await member.session.whoami();
  const name = DurableObjectNameCodec.stringify({
    projectId: GLOBAL_PROJECT_ID,
    path: `/users/${actor}${path}`,
  });
  return ((await stub(name).invoke(["itx", ["readEvents", 0, 500]])) as { events: StreamEvent[] })
    .events;
}

/** The lend's ends the lender's secret recorded. */
async function revocations(member: Member, path: string) {
  return (await lenderLog(member, path))
    .filter((event) => event.type === "events.iterate.com/secret/lend-revoked")
    .map((event) => {
      const { lendId, reason } = event.payload as { lendId: string; reason: string };
      return { lendId, reason };
    });
}
