// The control-plane-on-contexts SHAPE, and its SECURITY REQUIREMENTS.
//
// A global context (projectId === GLOBAL_PROJECT_ID) is an ordinary context with the full itx
// surface, exactly like a project's — except that THE GLOBAL NAMESPACE IS NOT NAVIGABLE: a session
// holds a global context by IDENTITY only (`session.user`, `session.organizations.get` by
// membership), a global edge handle's `cd` is refused for everyone, and inside a global DO the
// built-in `cd` does not permit navigation between global contexts
// (src/iterate-context.ts, src/context/built-ins.ts, src/session.ts). That is the whole path mask:
// nobody can NAME another user's path. Beneath it, every project-scoped RESOURCE (`itx.kv`, the
// secrets and their catalog, the Artifacts repos) is keyed by the RESOURCE OWNER — a project, or in
// the global namespace the user's/organization's subtree (`resourceScope`, src/iterate-context.ts)
// — so a name is never shared across users. And a person can append any event type to a context
// they hold, their own account included, so an account's and an organization's facts are believed
// only when the platform wrote them: the platform stamps `source.platform` on the facts it writes
// (principal.ts `Caller.platform`), a client's claim to it is dropped, and the account and
// organization processors fold nothing else — a forged fact stays on the log, attributed to whoever
// appended it, and changes nothing.
import { runInDurableObject } from "cloudflare:test";
import type { RpcStub } from "capnweb";
import { expect, test } from "vitest";
import { AccountProcessor } from "../src/account/processor.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import { adminCredentials, openSession, refused, stub, until } from "./support.ts";

// ── shape — a global context is an ordinary context (passing) ──

test("authenticate → session.user is a context at (global, /users/<id>)", async () => {
  const s = await userSession("shape-user@sec.test");
  const me = await s.whoami();
  expect(me).toMatchObject({ email: "shape-user@sec.test" });
  expect(await s.user.whoami()).toEqual({ projectId: "global", path: `/users/${me.actor}` });
});

test("session.user has the full itx surface — append and read round-trip on your own context", async () => {
  const s = await userSession("own-rw@sec.test");
  const appended = (await s.user.invoke([
    "itx",
    ["append", { type: "note", payload: { hi: 1 } }],
  ])) as { type: string }[];
  expect(appended[0]).toMatchObject({ type: "note" });
  const page = (await s.user.invoke(["itx", ["readEvents"]])) as { events: { type: string }[] };
  expect(page.events.some((event) => event.type === "note")).toBe(true);
});

test("session.organizations.get vends the org's context at (global, /organizations/<id>) — by membership", async () => {
  const s = await userSession("org-shape@sec.test");
  const org = await s.organizations.create({ name: "org-shape" });
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
  const who = await proj.cd("/users/someone-else").whoami();
  // The hop stays in the project's own namespace; it can never spell `global`.
  expect(who).not.toMatchObject({ projectId: "global" });
});

// ── account — foundation shape (passing) ──

test("AccountProcessor folds authentication facts into the account view (kernel reducer)", () => {
  const processor = new AccountProcessor();
  const initial = processor.contract.initialState();
  const authenticated = (credential: string, operationId: string) => ({
    event: {
      type: "events.iterate.com/account/authenticated" as const,
      payload: { credential, at: 1, operationId },
      source: { platform: true },
    } as never,
  });
  const one =
    processor.reduce({ ...authenticated("from-server-cookie", "op1"), state: initial }) ?? initial;
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
  expect(fact).toMatchObject({ type: "events.iterate.com/account/authenticated" });
});

test("session.user hosts the account processor: a later authentication appears in its live view — the exact snapshot `useLiveState` reads through `liveSnapshot()`", async () => {
  const email = "acct-live@sec.test";
  const s = await userSession(email);
  await s.user.processors.enable("account", {
    consumes: ["events.iterate.com/account/authenticated"],
  });
  // A processor subscribes from now; the fact this session's own authenticate published may have
  // landed before it. A second authentication of the same user is a fact the processor must fold.
  await userSession(email);
  const view = await until("account view holds an authentication", async () => {
    const snapshot = (await s.user.invoke("itx.facets.get('account').liveSnapshot()")) as {
      state?: { authentications: { credential: string; operationId: string }[] };
    };
    return snapshot.state && snapshot.state.authentications.length > 0 ? snapshot.state : undefined;
  });
  expect(view.authentications.every((fact) => fact.credential === "admin-secret")).toBe(true);
  // No credential material rides the view — only the kind, the time and the op id.
  expect(Object.keys(view.authentications[0]!).sort()).toEqual(["at", "credential", "operationId"]);
});

// ── security requirements — the global namespace is not navigable ──

test("organizations.get refuses a path in place of an id — the admin reaches every org, so the id must be one segment", async () => {
  const admin = await (await openSession()).authenticate(adminCredentials());
  const b = await userSession("traverse-b@sec.test");
  const bId = (await b.whoami()).actor;
  await refused(() => admin.organizations.get(`../users/${bId}`), "FORBIDDEN");
  await refused(() => admin.organizations.get(".."), "FORBIDDEN");
  await refused(() => admin.organizations.get(`x/../users/${bId}`), "FORBIDDEN");
});

test("a user cannot READ another user's context", async () => {
  const a = await userSession("read-a@sec.test");
  const b = await userSession("read-b@sec.test");
  const bId = (await b.whoami()).actor;
  await refused(() => a.user.cd(`/users/${bId}`).invoke(["itx", ["readEvents"]]), "FORBIDDEN");
});

test("a user cannot APPEND to another user's context", async () => {
  const a = await userSession("write-a@sec.test");
  const b = await userSession("write-b@sec.test");
  const bId = (await b.whoami()).actor;
  await refused(
    () => a.user.cd(`/users/${bId}`).invoke(["itx", ["append", { type: "intrusion" }]]),
    "FORBIDDEN",
  );
});

test("a client cannot forge a platform fact in its own user context: its account folds only what the platform wrote, and a claimed `source.platform` is dropped", async () => {
  const a = await userSession("forge@sec.test");
  type AccountSnapshot = {
    state: {
      authentications: { operationId: string }[];
      personalAccessTokens: Record<string, unknown>;
      secrets: Record<string, unknown>;
    };
  };
  const account = () =>
    a.user.invoke(["itx", "facets", ["get", "account"], ["snapshot"]]) as Promise<AccountSnapshot>;
  // The platform's own fact folds: this session's authentication (session.ts `publishPlatformFacts`).
  await until("the platform's authentication fact is folded", async () =>
    (await account()).state.authentications.length > 0 ? true : undefined,
  );
  const claimed = { platform: true };
  const forged = (await a.user.invoke([
    "itx",
    [
      "append",
      {
        type: "events.iterate.com/account/authenticated",
        payload: { credential: "admin-secret", at: 1, operationId: "forged" },
        source: claimed,
      },
      {
        type: "events.iterate.com/account/grant-minted",
        payload: { grantId: "grant_forged", name: "forged", projects: [], expiresAt: 9 },
        source: claimed,
      },
      {
        type: "events.iterate.com/secret/set",
        payload: { path: "/secrets/forged", urls: ["https://evil.example.test"] },
        source: claimed,
      },
    ],
  ])) as { source?: { platform?: true; principal?: { actor: string } } }[];
  const { actor } = await a.whoami();
  expect
    .soft(forged.map((event) => event.source))
    .toEqual([
      { principal: expect.objectContaining({ actor }) },
      { principal: expect.objectContaining({ actor }) },
      { principal: expect.objectContaining({ actor }) },
    ]);
  const { state } = await account();
  expect.soft(state.authentications.map((fact) => fact.operationId)).not.toContain("forged");
  expect.soft(state.personalAccessTokens).not.toHaveProperty("grant_forged");
  expect(state.secrets).not.toHaveProperty("/secrets/forged");
});

test("a member cannot forge their organization's facts: it folds only what the platform wrote", async () => {
  const s = await userSession("forge-org@sec.test");
  const org = await s.organizations.create({ name: "the real name" });
  const organization = s.organizations.get(org.id);
  type OrganizationSnapshot = {
    state: {
      name: string | null;
      deletedAt: string | null;
      members: Record<string, unknown>;
      projects: Record<string, unknown>;
    };
  };
  const snapshot = () =>
    organization.invoke([
      "itx",
      "facets",
      ["get", "organization"],
      ["snapshot"],
    ]) as Promise<OrganizationSnapshot>;
  // The platform's own fact folds: the organization's creation (session.ts `foldPlatformFacts`).
  await until("the platform's creation fact is folded", async () =>
    (await snapshot()).state.name === "the real name" ? true : undefined,
  );
  await organization.invoke([
    "itx",
    [
      "append",
      { type: "events.iterate.com/organization/renamed", payload: { name: "forged" } },
      { type: "events.iterate.com/organization/deleted", payload: {} },
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: org.id, userId: "user_forged", role: "owner" },
      },
      {
        type: "events.iterate.com/organization/project-created",
        payload: { projectId: "prj_forged", slug: "forged" },
        source: { platform: true },
      },
    ],
  ]);
  const { state } = await snapshot();
  expect(state).toMatchObject({ name: "the real name", deletedAt: null, projects: {} });
  expect(state.members).not.toHaveProperty("user_forged");
});

test("a user cannot reach the global ROOT context — not by cd, not through the project catalog", async () => {
  const a = await userSession("root-reach@sec.test");
  await refused(() => a.user.cd("/").invoke(["itx", ["readEvents"]]), "FORBIDDEN");
  await refused(() => a.projects.get("global").invoke(["itx", ["readEvents"]]), "FORBIDDEN");
  // The admin's catalog is every project — but the global namespace is no project.
  const root = await openSession();
  const admin = await root.authenticate(adminCredentials());
  await refused(() => admin.projects.get("global").invoke(["itx", ["readEvents"]]), "FORBIDDEN");
});

test("a project named 'global' cannot collide with the deployment-global namespace: its id is minted, only its slug is the word — and `projects.get('global')` stays refused", async () => {
  const s = await userSession("collide@sec.test");
  // A project's id is minted (`prj_<hex>`), never its name — so `Global` (slug `global`) is an
  // ordinary project whose context is nowhere near `(global, "/")`.
  using named = await s.projects.create({ project: "Global" });
  const who = await named.whoami();
  expect(who).toEqual({
    projectId: expect.stringMatching(/^prj_[0-9a-f]{32}$/),
    path: "/",
    projectSlug: "global",
    projectUrl: "https://global.projects.test/",
  });
  const listed = await s.projects.list();
  expect(listed.map(({ id, slug }) => ({ id, slug }))).toEqual([
    { id: who.projectId, slug: "global" },
  ]);
  // The word itself still names no project at the catalog.
  await refused(() => s.projects.get("global").invoke(["itx", ["readEvents"]]), "FORBIDDEN");
  // And a context that IS the project reads its own log, not the global root's.
  const [mark] = (await named.invoke(["itx", ["append", { type: "collide-mark" }]])) as {
    type: string;
  }[];
  expect(mark).toMatchObject({ type: "collide-mark" });
  const rootPage = (await stub("global").invoke(["itx", ["readEvents"]])) as {
    events: { type: string }[];
  };
  expect(rootPage.events.some((event) => event.type === "collide-mark")).toBe(false);
});

test("a user cannot reach an organization they do not belong to", async () => {
  const a = await userSession("org-a@sec.test");
  const b = await userSession("org-b@sec.test");
  const org = await a.organizations.create({ name: "a's org" });
  await refused(() => b.organizations.get(org.id).invoke(["itx", ["readEvents"]]), "FORBIDDEN");
});

test("a rule written into your own context cannot navigate for you: `itx.spy ⇒ itx.cd('/users/<other>').readEvents` is refused inside the DO", async () => {
  const a = await userSession("spy-a@sec.test");
  const b = await userSession("spy-b@sec.test");
  const bId = (await b.whoami()).actor;
  using _spy = await a.user.provide("itx.spy", `itx.cd('/users/${bId}').readEvents`);
  await refused(() => a.user.invoke("itx.spy()"), "FORBIDDEN");
  // The same rule aimed at the root is refused too — a person's hop, whatever the target.
  using _rootSpy = await a.user.provide("itx.rootSpy", "itx.cd('/').readEvents");
  await refused(() => a.user.invoke("itx.rootSpy()"), "FORBIDDEN");
});

test("a subscription written into your own context cannot append into another user's: the kernel's delivery runs under no principal, so the append is refused — the row HALTS", async () => {
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

test("a user's builtins cd('/') is refused", async () => {
  const a = await userSession("funnel@sec.test");
  await expect(a.user.invoke("itx.builtins.cd('/').kv.list()")).rejects.toThrow("never by path");
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
  expect(await stub(`global.iterate/users/${aId}/notes`).invoke(["itx", "kv", ["get", "k"]])).toBe(
    "a",
  );
  expect(await b.user.kv.list()).toMatchObject({ keys: [] });
});

test("a user's secrets are their own: A's set lives at /users/<a>/secrets/x and is in A's catalog (the account facet on A's root), not B's, not the global root's (which owns none) — a context below A shares A's catalog", async () => {
  const a = await userSession("secret-a@sec.test");
  const b = await userSession("secret-b@sec.test");
  const aId = (await a.whoami()).actor;
  expect(
    await a.user.secrets.set("/secrets/x", "value-a", { urls: ["https://example.test"] }),
  ).toEqual({
    path: "/secrets/x",
  });
  const aRow = {
    path: "/secrets/x",
    urls: ["https://example.test"],
    createdAt: expect.any(String),
  };
  expect(await a.user.secrets.list()).toEqual([aRow]);
  expect(await b.user.secrets.list()).toEqual([]);
  // Refused INSIDE the object (runInDurableObject): a rejected RPC promise crossing to the test
  // is reported as unhandled in the object whatever the caller does with it.
  expect(
    await runInDurableObject(stub("global"), async (instance: unknown) => {
      try {
        await (instance as { invoke(call: unknown): Promise<unknown> }).invoke([
          "itx",
          "secrets",
          ["list"],
        ]);
        return null;
      } catch (error) {
        return String(error);
      }
    }),
  ).toMatch(/the global root owns no secrets/);
  expect(
    await stub(`global.iterate/users/${aId}/notes`).invoke(["itx", "secrets", ["list"]]),
  ).toEqual([aRow]);
  // The fact landed on the secret's own context under A's root, attributed to A, and was
  // cross-posted to A's root (the catalog) — never to the global root's log.
  const factOf = (page: unknown) =>
    (page as { events: { type: string; payload?: { path?: string } }[] }).events.filter(
      (event) =>
        event.type === "events.iterate.com/secret/set" && event.payload?.path === "/secrets/x",
    );
  expect(factOf(await a.user.invoke(["itx", ["readEvents"]]))).toHaveLength(1);
  expect(
    factOf(await stub(`global.iterate/users/${aId}/secrets/x`).invoke(["itx", ["readEvents"]])),
  ).toHaveLength(1);
  expect(factOf(await stub("global").invoke(["itx", ["readEvents"]]))).toHaveLength(0);
  // B setting the same PATH is B's own secret, and leaves A's untouched.
  await b.user.secrets.set("/secrets/x", "value-b", { urls: ["https://b.example.test"] });
  expect(await b.user.secrets.list()).toEqual([
    { path: "/secrets/x", urls: ["https://b.example.test"], createdAt: expect.any(String) },
  ]);
  expect(await a.user.secrets.list()).toEqual([aRow]);
});

// parked: these need machinery from later increments (the privileged account facet and the
// transport-admission gate — the deferred path-mask enforcement pass), so they are
// documented as skips rather than expected-fails — revisit by 2026-11-15
test.skip("the account facet's processEventBatch is not client-callable (needs the privileged account facet)", () => {});
test.skip("a user cannot SUBSCRIBE to another user's log via the pager (needs the transport-admission gate)", () => {});

/** A signed-in human's session: the admin fixture with `as` upserts the user and vends their session
 *  (src/session.ts `IterateRpcTarget.authenticate`). The bare `openSession()` door is `any` (it also
 *  lends live stubs); a read helper names the real root type, so the session it vends is fully typed —
 *  `.organizations.create(...)` is an `OrganizationRecord`, `.projects.list()` a `ProjectRecord[]`. */
async function userSession(email: string) {
  const root: RpcStub<IterateRpcTarget> = await openSession();
  return root.authenticate({ ...adminCredentials(), as: { email } });
}
