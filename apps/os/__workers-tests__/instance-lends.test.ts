// __workers-tests__/instance-lends.test.ts — THE DEPLOYMENT'S OWN SECRETS: the operator (the admin
// bearer, or a platform admin) sets `global:/secrets/<name>` on `session.global` and lends it to one
// project or to every project; a project's `getSecret("<as>")` is forwarded to the instance's secret,
// which dispatches it. A lend to every project reaches the projects that exist and each one created
// after it; a project whose path holds a key of its own keeps it. A revocation ends every borrow
// (502), and nobody but the operator sets or lends one.
//
// THE UPSTREAM IS IN-PROCESS: the secret facet's terminal `fetch` is the isolate's global fetch,
// answered for `KEYED` by `serveKeyedApi` below — served after every sign-in, which restores `fetch`.
import { expect, onTestFinished, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID } from "../src/context/paths.ts";
import {
  adminSession,
  projectWithMember,
  refused,
  signedInSession,
  stub,
  until,
} from "./support.ts";

const KEYED = "https://keyed.test";

test("the operator lends the instance's key to one project: its uses run at the instance, metered with the borrower, and end with the revocation", async () => {
  const key = `instance-key-${crypto.randomUUID()}`;
  const global = await operatorGlobal();
  const name = `/secrets/instance-one-${crypto.randomUUID().slice(0, 8)}`;
  await global.secrets.set(name, key, { urls: [KEYED] });
  expect(await global.secrets.list()).toContainEqual(
    expect.objectContaining({ path: name, urls: [KEYED] }),
  );
  const project = await projectWithMember(`instance-one-${crypto.randomUUID().slice(0, 8)}`);
  const { lendId } = await global.secrets.lend(name, {
    to: project.projectId,
    as: "/secrets/keyed",
  });
  serveKeyedApi(key);
  expect(await project.itx.secrets.list()).toContainEqual(
    expect.objectContaining({
      path: "/secrets/keyed",
      borrowed: expect.objectContaining({ lendId, lender: { instance: true } }),
    }),
  );
  expect(await keyedCall(project.itx, "/secrets/keyed")).toMatchObject({ status: 200 });
  expect(await usedBy(name, project.projectId)).toMatchObject({ status: 200 });

  await global.secrets.revokeLend(name, lendId);
  expect(await keyedCall(project.itx, "/secrets/keyed")).toMatchObject({ status: 502 });
  expect((await project.itx.secrets.list()).map((row: { path: string }) => row.path)).not.toContain(
    "/secrets/keyed",
  );
});

test("a lend to every project: a project that exists and one created after it both borrow, a project with its own key keeps it, and the revocation ends every borrow", async () => {
  const key = `instance-key-${crypto.randomUUID()}`;
  const global = await operatorGlobal();
  const run = crypto.randomUUID().slice(0, 8);
  const name = `/secrets/instance-every-${run}`;
  const as = `/secrets/keyed-${run}`;
  await global.secrets.set(name, key, { urls: [KEYED] });
  const before = await projectWithMember(`instance-before-${run}`);
  const own = await projectWithMember(`instance-own-${run}`);
  await own.itx.secrets.set(as, "the project's own key", { urls: [KEYED] });

  const { lendId, everyProject } = await global.secrets.lend(name, { to: "every-project", as });
  expect(everyProject).toMatchObject({ kept: [own.projectId], failed: [] });
  expect(everyProject.borrowed).toBeGreaterThanOrEqual(1);
  expect(await global.secrets.list()).toContainEqual(
    expect.objectContaining({
      path: name,
      lends: { [lendId]: expect.objectContaining({ to: "every-project", as }) },
    }),
  );
  const after = await projectWithMember(`instance-after-${run}`);
  serveKeyedApi(key);
  for (const borrower of [before, after]) {
    expect(await keyedCall(borrower.itx, as)).toMatchObject({ status: 200 });
    expect(await borrower.itx.secrets.list()).toContainEqual(
      expect.objectContaining({ path: as, borrowed: expect.objectContaining({ lendId }) }),
    );
  }
  // the project's own key stays its own: the upstream sees it, and refuses it
  expect(await keyedCall(own.itx, as)).toMatchObject({ status: 401 });
  for (const borrower of [before, after])
    expect(await usedBy(name, borrower.projectId)).toMatchObject({ status: 200 });

  await global.secrets.revokeLend(name, lendId);
  for (const borrower of [before, after])
    expect(await keyedCall(borrower.itx, as)).toMatchObject({ status: 502 });
  expect(await keyedCall(own.itx, as)).toMatchObject({ status: 401 });
  const later = await projectWithMember(`instance-later-${run}`);
  expect((await later.itx.secrets.list()).map((row: { path: string }) => row.path)).not.toContain(
    as,
  );
});

test("a project returning a lend to every project ends it for that project alone", async () => {
  const key = `instance-key-${crypto.randomUUID()}`;
  const global = await operatorGlobal();
  const run = crypto.randomUUID().slice(0, 8);
  const name = `/secrets/instance-return-${run}`;
  const as = `/secrets/keyed-${run}`;
  await global.secrets.set(name, key, { urls: [KEYED] });
  const { lendId } = await global.secrets.lend(name, { to: "every-project", as });
  const leaving = await projectWithMember(`instance-leaving-${run}`);
  const staying = await projectWithMember(`instance-staying-${run}`);
  serveKeyedApi(key);
  await leaving.itx.secrets.delete(as);
  expect(await keyedCall(leaving.itx, as)).toMatchObject({ status: 502 });
  expect(await keyedCall(staying.itx, as)).toMatchObject({ status: 200 });
  expect(await global.secrets.list()).toContainEqual(
    expect.objectContaining({ path: name, lends: { [lendId]: expect.anything() } }),
  );
  await global.secrets.revokeLend(name, lendId);
});

test("only the operator sets and lends the instance's secrets: a person reaches no global root, and one who forges their way to it is refused", async () => {
  const person = await signedInSession(
    `instance-stranger-${crypto.randomUUID().slice(0, 8)}@example.test`,
  );
  await expect(Promise.resolve(person.global)).rejects.toThrow(/Only a platform admin/);
  await expect(
    person.user.secrets.lend("/secrets/anything", { to: "every-project", as: "/secrets/x" }),
  ).rejects.toThrow(/not a member/);
  const root = stub(DurableObjectNameCodec.stringify({ projectId: GLOBAL_PROJECT_ID, path: "/" }));
  const stranger = { principal: { actor: "user_stranger", email: "stranger@example.test" } };
  await refused(
    () =>
      root.invoke(
        ["itx", "secrets", ["set", "/secrets/forged", "k", { urls: [KEYED] }]],
        [],
        stranger,
      ),
    "FORBIDDEN",
    /operator's/,
  );
  await refused(
    () =>
      root.invoke(
        ["itx", "secrets", ["lend", "/secrets/forged", { to: "every-project", as: "/secrets/x" }]],
        [],
        stranger,
      ),
    "FORBIDDEN",
    /operator's/,
  );
  await refused(() => root.invoke(["itx", "secrets", ["list"]], [], stranger), "FORBIDDEN");
  // a platform admin viewing an app as someone else is that person, not the operator
  await refused(
    () =>
      root.invoke(["itx", "secrets", ["list"]], [], {
        principal: {
          actor: "user_viewed",
          email: "viewed@example.test",
          impersonatedBy: { actor: "user_admin", email: "oauth-admin@example.com" },
        },
      }),
    "FORBIDDEN",
  );
  // a platform admin (wrangler.test.jsonc `APP_CONFIG_ADMINS`) is the operator
  expect(
    await root.invoke(["itx", "secrets", ["list"]], [], {
      principal: { actor: "user_admin", email: "oauth-admin@example.com" },
    }),
  ).toEqual(expect.any(Array));
});

/** `session.global` for the admin bearer, its transport disposed when the test finishes. */
async function operatorGlobal(): Promise<any> {
  const sessions: Disposable[] = [];
  onTestFinished(() => {
    for (const session of sessions) session[Symbol.dispose]();
  });
  const session: any = await adminSession(sessions);
  return session.global;
}

/** A call to the keyed API through `itx`'s egress, its bearer the secret at `path`. */
async function keyedCall(itx: any, path: string) {
  const response: Response = await itx.fetch(
    new Request(`${KEYED}/me`, { headers: { authorization: `Bearer getSecret("${path}")` } }),
  );
  return { status: response.status, body: await response.text() };
}

/** The first `secret/used` on the instance's secret's own log that names `borrower` (the facet
 *  appends it best-effort, after the answer). */
function usedBy(path: string, borrower: string) {
  const name = DurableObjectNameCodec.stringify({ projectId: GLOBAL_PROJECT_ID, path });
  return until(`secret/used by ${borrower}`, async () => {
    const { events } = (await stub(name).invoke(["itx", ["readEvents", 0, 500]])) as {
      events: StreamEvent[];
    };
    return events.find(
      (event) =>
        event.type === "events.iterate.com/secret/used" &&
        (event.payload as { borrower?: string }).borrower === borrower,
    )?.payload;
  });
}

/** The API at `KEYED` for the rest of the test, accepting `key`: `/me` answers 200 to
 *  `Authorization: Bearer <key>` and 401 to anything else. */
function serveKeyedApi(key: string) {
  const network = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== KEYED) return network(request);
    return request.headers.get("authorization") === `Bearer ${key}`
      ? Response.json({ me: "instance" })
      : new Response("invalid_key", { status: 401 });
  });
  onTestFinished(() => spy.mockRestore());
}
