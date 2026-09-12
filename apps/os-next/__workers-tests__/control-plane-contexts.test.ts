// The control-plane-on-contexts SHAPE, and its SECURITY REQUIREMENTS captured as expected-fails.
//
// The shape is in place and INSECURE on purpose: a global context (projectId === GLOBAL_PROJECT_ID)
// is an ordinary context with the full itx surface, exactly like a project's. The path-mask access
// policy — which global paths a caller may reach, and which event types it may append — is NOT yet
// enforced. Every "naughty thing" a caller can currently do is written here as `test.fails`: the body
// asserts the SECURE outcome, so while the code is insecure the assertion fails and the expected-fail
// passes; when enforcement lands the assertion passes, the expected-fail turns into a real failure,
// and whoever wired the fix deletes the `.fails`. See apps/os-next/docs/control-plane-context-resolved-design.md.
import { beforeAll, describe, expect, test } from "vitest";
import { AccountProcessor } from "../src/account/processor.ts";
import { ACCOUNT_PROCESSOR_SOURCE } from "../src/generated/account-processor-source.ts";
import { adminCredentials, applyDirectorySchema, openSession, until } from "./support.ts";

beforeAll(applyDirectorySchema);

/** A signed-in human's session: the admin fixture with `as` upserts the user and vends their session
 *  (src/session.ts `IterateRpcTarget.authenticate`). */
async function userSession(email: string): Promise<any> {
  const root = await openSession();
  return root.authenticate({ ...adminCredentials(), as: { email } });
}

/** Assert `thunk` is REFUSED. While the code is insecure it resolves, so this throws and the
 *  enclosing `test.fails` passes; once enforcement lands it rejects, the assertion passes, and the
 *  `test.fails` turns red — whoever wires the fix deletes the `.fails`. (Explicit try/catch, not
 *  `expect().rejects`, because a capnweb stub is a custom thenable `.rejects` doesn't handle.) */
async function refuses(thunk: () => Promise<unknown>): Promise<void> {
  let refused = false;
  try {
    await thunk();
  } catch {
    refused = true;
  }
  expect(refused, "expected this to be refused, but it was allowed — still insecure").toBe(true);
}

describe("shape — a global context is an ordinary context (passing)", () => {
  test("authenticate → session.user is a context at (global, /users/<id>)", async () => {
    const s = await userSession("shape-user@sec.test");
    const me = await s.whoami();
    expect(me.email).toBe("shape-user@sec.test");
    expect(await s.user.whoami()).toEqual({ projectId: "global", path: `/users/${me.actor}` });
  });

  test("session.user has the full itx surface — append and read round-trip on your own context", async () => {
    const s = await userSession("own-rw@sec.test");
    const appended = (await s.user.invoke([
      "itx",
      ["append", { type: "note", payload: { hi: 1 } }],
    ])) as { type: string }[];
    expect(appended[0]!.type).toBe("note");
    const page = (await s.user.invoke(["itx", ["readEvents"]])) as { events: { type: string }[] };
    expect(page.events.some((event) => event.type === "note")).toBe(true);
  });

  test("session.organizations.get vends the org's context at (global, /organizations/<id>)", async () => {
    const s = await userSession("org-shape@sec.test");
    expect(await s.organizations.get("org_demo").whoami()).toEqual({
      projectId: "global",
      path: "/organizations/org_demo",
    });
  });

  test("the admin credential names no human — .user is FORBIDDEN", async () => {
    const root = await openSession();
    const admin = await root.authenticate(adminCredentials());
    await expect(admin.user.whoami()).rejects.toThrow(/no `?\.?user|identifies no user|FORBIDDEN/i);
  });

  test("a project context CANNOT reach the global namespace — cd keeps the projectId (construction)", async () => {
    const s = await userSession("proj-iso@sec.test");
    using proj = await s.projects.create({ project: `prj_iso_${Date.now().toString(36)}` });
    const who = (await proj.cd("/users/someone-else").whoami()) as { projectId: string };
    // The hop stays in the project's own namespace; it can never spell `global`.
    expect(who.projectId).not.toBe("global");
  });
});

describe("account — foundation shape (passing)", () => {
  test("AccountProcessor folds authentication facts into the account view (kernel reducer)", () => {
    const processor = new AccountProcessor();
    const initial = processor.contract.initialState();
    const authenticated = (credential: string, operationId: string) => ({
      event: {
        type: "events.iterate.com/account/authenticated" as const,
        payload: { credential, at: 1, operationId },
      } as never,
    });
    const one =
      processor.reduce({ ...authenticated("from-server-cookie", "op1"), state: initial }) ??
      initial;
    const two = processor.reduce({ ...authenticated("admin-secret", "op2"), state: one }) ?? one;
    expect(two.authentications.map((a) => a.operationId)).toEqual(["op1", "op2"]);
    // An unrelated event leaves the view unchanged.
    expect(processor.reduce({ event: { type: "note" } as never, state: two })).toBeUndefined();
  });

  test("a successful authentication records a durable fact on the user's account context", async () => {
    const s = await userSession("acct-fact@sec.test");
    // Publication is best-effort/async (waitUntil), so poll the user's own log until it lands.
    const fact = await until("account/authenticated fact", async () => {
      const page = (await s.user.invoke(["itx", ["readEvents"]])) as { events: { type: string }[] };
      return page.events.find((event) => event.type === "events.iterate.com/account/authenticated");
    });
    expect(fact.type).toBe("events.iterate.com/account/authenticated");
  });

  test("session.user hosts the account processor: a token appears in its live view with a readable value, and revoke removes it", async () => {
    const s = await userSession("acct-live@sec.test");
    await s.user.processors.enable("account", {
      source: ACCOUNT_PROCESSOR_SOURCE,
      className: "AccountDurableObject",
      consumes: [
        "events.iterate.com/account/authenticated",
        "events.iterate.com/account/token-create-requested",
        "events.iterate.com/account/token-revoked",
      ],
    });
    const readTokens = () =>
      s.user.invoke("itx.facets.get('account').liveSnapshot()") as Promise<{
        state?: { tokens: { requestId: string; name: string; value: string }[] };
      }>;
    await s.user.append({
      type: "events.iterate.com/account/token-create-requested",
      payload: { requestId: "req-1", name: "CI token", value: "tok_ci", requestedAt: Date.now() },
      idempotencyKey: "token-create/req-1",
    });
    // The facet reduces the command into its live view — the exact snapshot `useLiveState`'s door reads.
    const created = await until("account view has the token", async () => {
      const snapshot = await readTokens();
      return snapshot.state?.tokens.some((token) => token.name === "CI token")
        ? snapshot.state
        : undefined;
    });
    // The token value is stored readable (insecure-first).
    expect(created.tokens.find((token) => token.name === "CI token")?.value).toBe("tok_ci");

    // Revoke is a single command; the token leaves the live view.
    await s.user.append({
      type: "events.iterate.com/account/token-revoked",
      payload: { requestId: "req-1" },
      idempotencyKey: "token-revoke/req-1",
    });
    const revoked = await until("account view drops the revoked token", async () => {
      const snapshot = await readTokens();
      return snapshot.state && !snapshot.state.tokens.some((token) => token.requestId === "req-1")
        ? snapshot.state
        : undefined;
    });
    expect(revoked.tokens.some((token) => token.requestId === "req-1")).toBe(false);
  });
});

describe("security requirements — currently INSECURE, captured as expected-fails", () => {
  test.fails("a user cannot READ another user's context", async () => {
    const a = await userSession("read-a@sec.test");
    const b = await userSession("read-b@sec.test");
    const bId = (await b.whoami()).actor;
    await refuses(() => a.user.cd(`/users/${bId}`).invoke(["itx", ["readEvents"]]));
  });

  test.fails("a user cannot APPEND to another user's context", async () => {
    const a = await userSession("write-a@sec.test");
    const b = await userSession("write-b@sec.test");
    const bId = (await b.whoami()).actor;
    await refuses(() =>
      a.user.cd(`/users/${bId}`).invoke(["itx", ["append", { type: "intrusion" }]]),
    );
  });

  test.fails("a client cannot forge a platform fact in its own user context (append type-gate)", async () => {
    const a = await userSession("forge@sec.test");
    await refuses(() =>
      a.user.invoke([
        "itx",
        ["append", { type: "events.iterate.com/account/authenticated", payload: { forged: true } }],
      ]),
    );
  });

  test.fails("a user cannot reach the global ROOT context", async () => {
    const a = await userSession("root-reach@sec.test");
    await refuses(() => a.user.cd("/").invoke(["itx", ["readEvents"]]));
  });

  test.fails("a project named 'global' must not collide with the deployment-global namespace", async () => {
    const s = await userSession("collide@sec.test");
    // With prj_-prefixed project ids (or a reserved-word guard) this create is refused; today the
    // slug IS the id, so `projects.get('global')` would address (global, "/") — the global root.
    await refuses(() => s.projects.create({ project: "global" }));
  });

  // Needs machinery from later increments, so documented as skips rather than expected-fails:
  test.skip("the account facet's processEventBatch is not client-callable (needs the privileged account facet)", () => {});
  test.skip("a user cannot SUBSCRIBE to another user's log via the pager (needs the transport-admission gate)", () => {});
});
