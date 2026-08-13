import { expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// The clients proof: `projects.connect` = `get` + presence, built entirely on
// the shipped capability system. A client is a capability-host scope at a
// caller-chosen path holding a LIVE capability mounted at "capabilities";
// callers invoke it through `itx.clients.get(path)` (the scope's capability
// host, behind the hibernating Provider Pager — nothing pins); the project
// processor catalogs each scope's copied provider connect/disconnect facts,
// which is what `itx.clients.list()` reads. Connected is binary per path —
// multiplicity is the caller's path construction, not a platform concept.

test("projects.connect registers a connected client whose live capability is invokable", async () => {
  const marker = crypto.randomUUID();

  using providerSession = withItxSession();
  using providerItx = providerSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await providerItx.projects.get(`clients-${marker}`).create({});
  const { projectId } = await project.__describe();

  // Before ANY client ever connected, the catalog answers empty — never a
  // refusal (the unborn project fold substitutes).
  expect(await project.clients.list()).toEqual([]);

  class BrowserTarget extends RpcTarget {
    navigate(url: string) {
      return { marker, navigated: url };
    }
    reload() {
      return { marker, reloaded: true };
    }
  }
  class ClientCapabilities extends RpcTarget {
    get browser() {
      return new BrowserTarget();
    }
  }

  using _clientProject = await providerItx.projects.connect(projectId, {
    path: "/clients/chrome",
    description: "e2e Chrome",
    capabilities: new ClientCapabilities(),
  });

  using callerSession = withItxSession();
  using callerItx = callerSession.authenticate({
    type: "impersonate",
    secret: adminSecret(),
    token: {
      principal: "alice",
      projectScopes: [projectId],
      type: "user",
    },
  });
  using callerProject = callerItx.projects.get(projectId);

  // The catalog: the provider's pager-connected fact copies to the root and
  // reduces into the project processor's clients catalog. Manual settle loop
  // instead of expect.poll — the e2e lane runs tests concurrently on CI,
  // where expect.poll loses the vitest test context.
  const chrome = await settleClient(callerProject, "/clients/chrome", (client) => client.connected);
  expect(chrome).toMatchObject({ path: "/clients/chrome", connected: true });

  // The call door: the scope's capability host invokes the live capability
  // mounted at "capabilities" — a cross-session call into the provider's
  // nested RpcTarget, riding the Provider Pager machinery.
  using host = callerProject.clients.get("/clients/chrome");
  // @ts-expect-error - dynamic capability member
  const result = await host.capabilities.browser.navigate("https://example.com");
  expect(result).toEqual({ marker, navigated: "https://example.com" });
  // @ts-expect-error - dynamic capability member
  expect(await host.capabilities.browser.reload()).toEqual({ marker, reloaded: true });
});

test("a client path is one identity: guards hold and canonicalization applies before them", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`clients-guards-${crypto.randomUUID()}`).create({});
  const { projectId } = await project.__describe();

  await expect(
    itx.projects.connect(projectId, { path: "relative", description: "nope" }),
  ).rejects.toThrow(/absolute stream path/);
  // Canonicalization runs BEFORE the guard: a spelling that only resolves to
  // the root must not slip past the exact-string check.
  await expect(
    itx.projects.connect(projectId, { path: "/x/..", description: "nope" }),
  ).rejects.toThrow(/must not be the project root/);
  await expect(
    itx.projects.connect(projectId, { path: "/clients/x", description: "  " }),
  ).rejects.toThrow(/description is required/);
});

test("disconnecting flips the catalog to connected: false; reconnecting flips it back", async () => {
  const marker = crypto.randomUUID();

  using observerSession = withItxSession();
  using observerItx = observerSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await observerItx.projects.get(`clients-lifecycle-${marker}`).create({});
  const { projectId } = await project.__describe();

  const connectRobot = (session: ReturnType<typeof withItxSession>) => {
    const itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    return itx.projects.connect(projectId, {
      path: "/clients/desk-robot",
      description: "Desk robot",
      capabilities: { servos: { wave: () => ({ marker, waved: true }) } },
    });
  };

  {
    // First life: connect in a scoped session, prove connected, then let the
    // session (and with it the provider's socket) die.
    using firstSession = withItxSession();
    using _robotProject = await connectRobot(firstSession);
    const connected = await settleClient(project, "/clients/desk-robot", (c) => c.connected);
    expect(connected).toMatchObject({ path: "/clients/desk-robot", connected: true });
  }

  // The platform journals the provider's disconnect when its socket dies —
  // the catalog must flip to connected: false without any polite goodbye.
  const gone = await settleClient(project, "/clients/desk-robot", (c) => !c.connected);
  expect(gone).toMatchObject({ path: "/clients/desk-robot", connected: false });
  expect(gone?.lastDisconnectedAt).toBeDefined();

  // Second life: the same path reconnects (the birth batch dedupes) and the
  // catalog flips back.
  using secondSession = withItxSession();
  using _reconnected = await connectRobot(secondSession);
  const back = await settleClient(project, "/clients/desk-robot", (c) => c.connected);
  expect(back).toMatchObject({ path: "/clients/desk-robot", connected: true });

  // And the capability is live again.
  using host = project.clients.get("/clients/desk-robot");
  // @ts-expect-error - dynamic capability member
  expect(await host.capabilities.servos.wave()).toEqual({ marker, waved: true });
});

/** Settle loop over the clients catalog until `accept` passes (or timeout). */
async function settleClient(
  project: { clients: { list(): Promise<{ path: string; connected: boolean }[]> } },
  path: string,
  accept: (client: { path: string; connected: boolean; lastDisconnectedAt?: string }) => boolean,
) {
  const deadline = Date.now() + 30_000;
  let latest: { path: string; connected: boolean; lastDisconnectedAt?: string } | undefined;
  while (Date.now() < deadline) {
    const list = await project.clients.list();
    latest = list.find((client) => client.path === path);
    if (latest && accept(latest)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return latest;
}
