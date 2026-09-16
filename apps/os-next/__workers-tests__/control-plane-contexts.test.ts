// The control-plane-on-contexts SHAPE, and its SECURITY REQUIREMENTS.
//
// A global context (projectId === GLOBAL_PROJECT_ID) is an ordinary context with the full itx
// surface, exactly like a project's — except that THE GLOBAL NAMESPACE IS NOT NAVIGABLE: a session
// holds a global context by IDENTITY only (`session.user`, `session.organizations.get` by
// membership), a global edge handle's `cd` is refused for everyone, and inside a global DO the
// built-in `cd` admits one hop — the kernel's config funnel `itx.cd('/').worker…` under no principal
// (src/iterate-context.ts, src/context/built-ins.ts, src/session.ts). That is the whole path mask:
// nobody can NAME another user's path. Beneath it, every project-scoped RESOURCE (`itx.kv`, the
// secret cells and catalog, the Artifacts repos) is keyed by the RESOURCE OWNER — a project, or in
// the global namespace the user's/organization's subtree (`resourceScope`, src/iterate-context.ts)
// — so a name is never shared across users. What remains open is the append type-gate, still a
// `test.fails` here: the body asserts the SECURE outcome, so while the code is insecure the assertion
// fails and the expected-fail passes; whoever wires the fix deletes the `.fails`.
// See apps/os-next/docs/control-plane-context-resolved-design.md.
import { beforeAll, describe, expect, test } from "vitest";
import { AccountProcessor } from "../src/account/processor.ts";
import { ACCOUNT_PROCESSOR_SOURCE } from "../src/generated/account-processor-source.ts";
import { adminCredentials, applyDirectorySchema, openSession, stub, until } from "./support.ts";

beforeAll(applyDirectorySchema);

/** A signed-in human's session: the admin fixture with `as` upserts the user and vends their session
 *  (src/session.ts `IterateRpcTarget.authenticate`). */
async function userSession(email: string): Promise<any> {
  const root = await openSession();
  return root.authenticate({ ...adminCredentials(), as: { email } });
}

/** Assert `thunk` is REFUSED with a coded error (the code the refusal must carry, so a broken
 *  pipeline or a typo never passes as a refusal). Explicit try/catch, not `expect().rejects`,
 *  because a capnweb stub is a custom thenable `.rejects` doesn't handle. Under a `test.fails` the
 *  thunk resolving is what keeps the expected-fail passing while that gap is open. */
async function refuses(
  thunk: () => Promise<unknown>,
  code: "FORBIDDEN" | "PROJECT_NAME_RESERVED" = "FORBIDDEN",
): Promise<void> {
  let refusal: unknown;
  try {
    await thunk();
  } catch (error) {
    refusal = error;
  }
  expect(refusal, "expected this to be refused, but it was allowed — still insecure").toBeDefined();
  expect((refusal as { code?: string }).code).toBe(code);
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

  test("session.organizations.get vends the org's context at (global, /organizations/<id>) — by membership", async () => {
    const s = await userSession("org-shape@sec.test");
    const org = (await s.createOrg("org-shape")) as { id: string };
    expect(await s.organizations.get(org.id).whoami()).toEqual({
      projectId: "global",
      path: `/organizations/${org.id}`,
    });
    // The admin reaches every organization.
    const root = await openSession();
    const admin = await root.authenticate(adminCredentials());
    expect(await admin.organizations.get(org.id).whoami()).toEqual({
      projectId: "global",
      path: `/organizations/${org.id}`,
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

  test("session.user hosts the account processor: a later authentication appears in its live view — the exact snapshot `useLiveState` reads through `liveSnapshot()`", async () => {
    const email = "acct-live@sec.test";
    const s = await userSession(email);
    await s.user.processors.enable("account", {
      source: ACCOUNT_PROCESSOR_SOURCE,
      className: "AccountDurableObject",
      consumes: ["events.iterate.com/account/authenticated"],
    });
    // A processor subscribes from now; the fact this session's own authenticate published may have
    // landed before it. A second authentication of the same user is a fact the processor must fold.
    await userSession(email);
    const view = await until("account view holds an authentication", async () => {
      const snapshot = (await s.user.invoke("itx.facets.get('account').liveSnapshot()")) as {
        state?: { authentications: { credential: string; operationId: string }[] };
      };
      return snapshot.state && snapshot.state.authentications.length > 0
        ? snapshot.state
        : undefined;
    });
    expect(view.authentications.every((fact) => fact.credential === "admin-secret")).toBe(true);
    // No credential material rides the view — only the kind, the time and the op id.
    expect(Object.keys(view.authentications[0]!).sort()).toEqual([
      "at",
      "credential",
      "operationId",
    ]);
  });
});

describe("security requirements — the global namespace is not navigable", () => {
  test("organizations.get refuses a path in place of an id — the admin reaches every org, so the id must be one segment", async () => {
    const admin = await (await openSession()).authenticate(adminCredentials());
    const b = await userSession("traverse-b@sec.test");
    const bId = (await b.whoami()).actor;
    await refuses(() => admin.organizations.get(`../users/${bId}`));
    await refuses(() => admin.organizations.get(".."));
    await refuses(() => admin.organizations.get(`x/../users/${bId}`));
  });

  test("a user cannot READ another user's context", async () => {
    const a = await userSession("read-a@sec.test");
    const b = await userSession("read-b@sec.test");
    const bId = (await b.whoami()).actor;
    await refuses(() => a.user.cd(`/users/${bId}`).invoke(["itx", ["readEvents"]]));
  });

  test("a user cannot APPEND to another user's context", async () => {
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

  test("a user cannot reach the global ROOT context — not by cd, not through the project catalog", async () => {
    const a = await userSession("root-reach@sec.test");
    await refuses(() => a.user.cd("/").invoke(["itx", ["readEvents"]]));
    await refuses(() => a.projects.get("global").invoke(["itx", ["readEvents"]]));
    // The admin's catalog is every project — but the global namespace is no project.
    const root = await openSession();
    const admin = await root.authenticate(adminCredentials());
    await refuses(() => admin.projects.get("global").invoke(["itx", ["readEvents"]]));
  });

  test("a project named 'global' must not collide with the deployment-global namespace", async () => {
    const s = await userSession("collide@sec.test");
    // The slug IS the id, so the word is reserved at the catalog: `Global` slugs to it too.
    await refuses(() => s.projects.create({ project: "Global" }), "PROJECT_NAME_RESERVED");
  });

  test("a user cannot reach an organization they do not belong to", async () => {
    const a = await userSession("org-a@sec.test");
    const b = await userSession("org-b@sec.test");
    const org = (await a.createOrg("a's org")) as { id: string };
    await refuses(() => b.organizations.get(org.id).invoke(["itx", ["readEvents"]]));
  });

  test("a rule written into your own context cannot navigate for you: `itx.spy ⇒ itx.cd('/users/<other>').readEvents` is refused inside the DO", async () => {
    const a = await userSession("spy-a@sec.test");
    const b = await userSession("spy-b@sec.test");
    const bId = (await b.whoami()).actor;
    using _spy = await a.user.provide("itx.spy", `itx.cd('/users/${bId}').readEvents`);
    await refuses(() => a.user.invoke("itx.spy()"));
    // The same rule aimed at the root is refused too — a person's hop, whatever the target.
    using _rootSpy = await a.user.provide("itx.rootSpy", "itx.cd('/').readEvents");
    await refuses(() => a.user.invoke("itx.rootSpy()"));
  });

  test("a subscription written into your own context cannot append into another user's: the kernel's delivery runs under no principal, but its one hop is the config funnel — the row HALTS", async () => {
    const a = await userSession("launder-a@sec.test");
    const b = await userSession("launder-b@sec.test");
    const bId = (await b.whoami()).actor;
    using _launder = await a.user.subscribe({
      name: "launder",
      target: `itx.cd('/users/${bId}').append`,
      consumes: ["smuggled"],
    });
    await a.user.invoke(["itx", ["append", { type: "smuggled" }]]);
    const row = await until("the launder row is halted", async () => {
      const rows = (await a.user.invoke("itx.subscriptions.list()")) as {
        name: string;
        halted?: unknown;
      }[];
      const launderRow = rows.find((entry) => entry.name === "launder");
      return launderRow?.halted ? launderRow : undefined;
    });
    expect(row.halted).toBeDefined();
    const bPage = (await b.user.invoke(["itx", ["readEvents"]])) as { events: { type: string }[] };
    expect(bPage.events.some((event) => event.type === "smuggled")).toBe(false);
  });

  test("the kernel's config funnel still delivers a user context's commits to the global root: the `config` row's cursor confirms past the append", async () => {
    const a = await userSession("funnel@sec.test");
    const [mark] = (await a.user.invoke(["itx", ["append", { type: "funnel-mark" }]])) as {
      offset: number;
    }[];
    const config = await until("config cursor past the mark", async () => {
      const rows = (await a.user.invoke("itx.subscriptions.list()")) as {
        name: string;
        halted?: unknown;
        cursor?: { confirmedOffset: number; attempt: number };
      }[];
      const configRow = rows.find((entry) => entry.name === "config");
      return configRow?.cursor && configRow.cursor.confirmedOffset >= mark.offset
        ? configRow
        : undefined;
    });
    expect(config.halted).toBeUndefined();
    expect(config.cursor!.attempt).toBe(0);
  });

  // The RESOURCE OWNER beneath the mask (`resourceScope`): a user's kv, secrets and repos are keyed
  // by their own subtree, so a name is never another user's nor the global root's. The global root
  // and a context BELOW a user are reached through the lane's raw DO door (`stub`): no session can
  // navigate there — `session.user.cd` is refused, `projects.get('global')` too.

  test("a user's kv is their own: A's put is A's get, not B's, not the global root's — and a context below A reads A's", async () => {
    const a = await userSession("kv-a@sec.test");
    const b = await userSession("kv-b@sec.test");
    const aId = (await a.whoami()).actor;
    await a.user.kv.put("k", "a");
    expect(await a.user.kv.get("k")).toBe("a");
    expect(await b.user.kv.get("k")).toBeNull();
    expect(await stub("global").invoke(["itx", "kv", ["get", "k"]])).toBeNull();
    expect(
      await stub(`global.iterate/users/${aId}/notes`).invoke(["itx", "kv", ["get", "k"]]),
    ).toBe("a");
    expect((await b.user.kv.list()).keys).toEqual([]);
  });

  test("a user's secrets are their own: A's set is in A's catalog (A's context IS its secrets root), not B's, not the global root's — a context below A shares A's catalog", async () => {
    const a = await userSession("secret-a@sec.test");
    const b = await userSession("secret-b@sec.test");
    const aId = (await a.whoami()).actor;
    await a.user.secrets.set("x", "value-a", { urls: ["https://example.test"] });
    expect(await a.user.secrets.list()).toEqual([{ name: "x", urls: ["https://example.test"] }]);
    expect(await b.user.secrets.list()).toEqual([]);
    expect(await stub("global").invoke(["itx", "secrets", ["list"]])).toEqual([]);
    expect(
      await stub(`global.iterate/users/${aId}/notes`).invoke(["itx", "secrets", ["list"]]),
    ).toEqual([{ name: "x", urls: ["https://example.test"] }]);
    // The catalog fact landed in A's own log, attributed to A — not in the global root's.
    const aPage = (await a.user.invoke(["itx", ["readEvents"]])) as {
      events: { type: string; payload?: { name?: string } }[];
    };
    expect(
      aPage.events.some(
        (event) =>
          event.type === "events.iterate.com/secrets/changed" && event.payload?.name === "x",
      ),
    ).toBe(true);
    // B setting the same NAME is B's own row, and leaves A's untouched.
    await b.user.secrets.set("x", "value-b", { urls: ["https://b.example.test"] });
    expect(await b.user.secrets.list()).toEqual([{ name: "x", urls: ["https://b.example.test"] }]);
    expect(await a.user.secrets.list()).toEqual([{ name: "x", urls: ["https://example.test"] }]);
  });

  // parked: these need machinery from later increments (the privileged account facet and the
  // transport-admission gate — the deferred path-mask enforcement pass, item B2), so they are
  // documented as skips rather than expected-fails — revisit by 2026-11-15
  test.skip("the account facet's processEventBatch is not client-callable (needs the privileged account facet)", () => {});
  test.skip("a user cannot SUBSCRIBE to another user's log via the pager (needs the transport-admission gate)", () => {});
});
