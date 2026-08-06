import { expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// The clients/connections proof: projects.connect = get + presence. Sessions
// connect as clients carrying live capabilities RpcTargets; other sessions
// drive them through itx.clients — fan-out over all open connections,
// single-target via getConnection(key), platform-side kick via close(), and
// maxConnections cap enforcement (default 1; null = unlimited).

test("projects.connect registers a client whose capabilities fan out over its open connections", async () => {
  const marker = crypto.randomUUID();

  using providerSession = withItxSession();
  using providerItx = providerSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await providerItx.projects.get(`clients-${marker}`).create({});
  const { projectId } = await project.__describe();

  class BrowserTarget extends RpcTarget {
    navigate(url: string) {
      return { marker, navigated: url };
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

  // The live view: the connection is in the client stream's runtime table.
  const connections = await callerProject.clients.get("/clients/chrome").connections();
  expect(connections).toHaveLength(1);
  expect(connections[0]).toMatchObject({ description: "e2e Chrome", hasCapabilities: true });

  // The fan-out door: dotted path replays into the provider's process on
  // every open connection; results come back as one array (Promise.all).
  const results = await callerProject.clients
    .get("/clients/chrome")
    // @ts-expect-error - dynamic capability root
    .capabilities.browser.navigate("https://example.com");
  expect(results).toEqual([{ marker, navigated: "https://example.com" }]);

  // A client nobody connected has no open doors: the fan-out resolves [].
  const silence = await callerProject.clients
    .get("/clients/ghost")
    // @ts-expect-error - dynamic capability root
    .capabilities.browser.navigate("https://example.com");
  expect(silence).toEqual([]);

  // The roster: copied facts reduce into the collection projection.
  await expect
    .poll(
      async () => {
        const list = await callerProject.clients.list();
        return list.find((client) => client.path === "/clients/chrome");
      },
      { interval: 500, timeout: 30_000 },
    )
    .toMatchObject({
      path: "/clients/chrome",
      description: "e2e Chrome",
      connections: 1,
      hasCapabilities: true,
    });
});

test("maxConnections defaults to 1: a reconnect evicts the previous connection as replaced", async () => {
  const marker = crypto.randomUUID();

  using adminSession = withItxSession();
  using adminItx = adminSession.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await adminItx.projects.get(`clients-cap-${marker}`).create({});
  const { projectId } = await project.__describe();

  using firstSession = withItxSession();
  using firstItx = firstSession.authenticate({ type: "admin-secret", secret: adminSecret() });
  using _first = await firstItx.projects.connect(projectId, {
    path: "/clients/desk-robot",
    description: "boot one",
    capabilities: makeTab("boot one").capabilities,
  });

  using secondSession = withItxSession();
  using secondItx = secondSession.authenticate({ type: "admin-secret", secret: adminSecret() });
  using _second = await secondItx.projects.connect(projectId, {
    path: "/clients/desk-robot",
    description: "boot two",
    capabilities: makeTab("boot two").capabilities,
  });

  // Cap enforcement is atomic with the open: after the second connect
  // resolves, exactly one connection remains, and it is the newer one.
  const connections = await project.clients.get("/clients/desk-robot").connections();
  expect(connections).toHaveLength(1);
  expect(connections[0]).toMatchObject({ description: "boot two" });
});

test("maxConnections: null allows many tabs; fan-out reaches all, getConnection targets one, close kicks one", async () => {
  const marker = crypto.randomUUID();

  using adminSession = withItxSession();
  using adminItx = adminSession.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await adminItx.projects.get(`clients-tabs-${marker}`).create({});
  const { projectId } = await project.__describe();

  // Two "browser tabs": separate sessions connecting the SAME client path.
  const tabA = makeTab("tab A");
  using tabASession = withItxSession();
  using tabAItx = tabASession.authenticate({ type: "admin-secret", secret: adminSecret() });
  using _tabA = await tabAItx.projects.connect(projectId, {
    path: "/clients/browser",
    description: "tab A",
    capabilities: tabA.capabilities,
    maxConnections: null,
    connectionKey: "tab-a",
  });

  const tabB = makeTab("tab B");
  using tabBSession = withItxSession();
  using tabBItx = tabBSession.authenticate({ type: "admin-secret", secret: adminSecret() });
  using _tabB = await tabBItx.projects.connect(projectId, {
    path: "/clients/browser",
    description: "tab B",
    capabilities: tabB.capabilities,
    maxConnections: null,
    connectionKey: "tab-b",
  });

  using client = project.clients.get("/clients/browser");

  const connections = await client.connections();
  expect(connections).toHaveLength(2);

  // Fan-out: one dotted call navigates BOTH tabs at the same time.
  // @ts-expect-error - dynamic capability root
  const navigated = await client.capabilities.browser.navigate("https://both.example");
  expect(navigated).toHaveLength(2);
  expect(new Set(navigated.map((result: { label: string }) => result.label))).toEqual(
    new Set(["tab A", "tab B"]),
  );
  expect(tabA.navigations).toContain("https://both.example");
  expect(tabB.navigations).toContain("https://both.example");

  // Fan-out reload reaches both tabs too.
  // @ts-expect-error - dynamic capability root
  const reloaded = await client.capabilities.browser.reload();
  expect(reloaded).toHaveLength(2);
  expect(tabA.reloadCount()).toBe(1);
  expect(tabB.reloadCount()).toBe(1);

  // The caller-chosen connectionKeys are the connections' stable identities.
  expect(new Set(connections.map((connection) => connection.connectionKey))).toEqual(
    new Set(["tab-a", "tab-b"]),
  );

  // Single-target: address tab A by its KNOWN key — no listing required —
  // and navigate ONLY it.
  const only = await client
    .getConnection("tab-a")
    // @ts-expect-error - dynamic capability root
    .capabilities.browser.navigate("https://only-a.example");
  expect(only).toEqual({ label: "tab A", navigated: "https://only-a.example" });
  expect(tabA.navigations).toContain("https://only-a.example");
  expect(tabB.navigations).not.toContain("https://only-a.example");

  // Platform-side kick: close tab B's connection from our end.
  await client.getConnection("tab-b").close();
  const remaining = await client.connections();
  expect(remaining).toHaveLength(1);
  expect(remaining[0]).toMatchObject({ description: "tab A" });

  // The fan-out now reaches only the surviving tab.
  // @ts-expect-error - dynamic capability root
  const afterKick = await client.capabilities.browser.navigate("https://after-kick.example");
  expect(afterKick).toEqual([{ label: "tab A", navigated: "https://after-kick.example" }]);
  expect(tabB.navigations).not.toContain("https://after-kick.example");
});

/** One simulated browser tab: a recorder capability with navigate + reload. */
function makeTab(label: string) {
  const navigations: string[] = [];
  let reloads = 0;
  class BrowserTarget extends RpcTarget {
    navigate(url: string) {
      navigations.push(url);
      return { label, navigated: url };
    }
    reload() {
      reloads += 1;
      return { label, reloaded: true };
    }
  }
  class TabCapabilities extends RpcTarget {
    get browser() {
      return new BrowserTarget();
    }
  }
  return {
    label,
    navigations,
    reloadCount: () => reloads,
    capabilities: new TabCapabilities(),
  };
}
