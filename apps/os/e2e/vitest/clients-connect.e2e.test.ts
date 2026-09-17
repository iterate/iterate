import { expect, test } from "vitest";
import { cloudflareWorkerVersionOverrideHeaders } from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import WebSocket from "ws";
import type { UnauthenticatedOs } from "../../src/itx-api.generated.ts";
import { SubscriptionConfiguredPayload } from "../../src/domains/streams/core-processor-contract.ts";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

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

  const clientEvents = await callerProject.streams
    .get("/clients/chrome")
    .subscriptions.get("clients-to-root")
    .describe();
  expect(clientEvents).not.toBeNull();
  const clientEventsConfiguration = SubscriptionConfiguredPayload.parse(
    clientEvents!.configuration,
  );
  expect(clientEventsConfiguration.filter?.eventTypes).toContain(
    "events.iterate.com/capability-host/capability-provided",
  );

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

test("projects.connect upgrades a legacy client subscription once and copies its new provision once", async () => {
  const marker = crypto.randomUUID();
  const path = "/clients/legacy-havpe";
  class Carrier extends RpcTarget {
    invokeCapability({ args, path }: { args: unknown[]; path: string[] }) {
      return { args, marker, path };
    }
  }
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`clients-legacy-${marker}`).create({});
  const { projectId } = await project.__describe();

  // This is the exact immutable subscription event installed before v2. A
  // current reconnect must append the replacement event, rather than trying
  // to reuse this key for a different payload.
  await project.capabilityHosts.get(path).create();
  await project.streams.get(path).append({
    type: "events.iterate.com/stream/subscription-configured",
    idempotencyKey: "stream/subscription-configured:clients-to-root",
    payload: {
      name: "clients-to-root",
      description:
        "Copies this client scope's provider connect/disconnect facts to the project root for the clients catalog (itx.clients.list()).",
      filter: {
        eventTypes: [
          "events.iterate.com/capability-host/capability-provider-pager-connected",
          "events.iterate.com/capability-host/capability-provider-pager-disconnected",
        ],
      },
      receiver: {
        action: "copy-to-stream",
        receivingStreamPath: "/",
        delivery: { start: "beginning", onFailingEvent: "halt" },
      },
    },
  });
  // This is a real historical provision. v1 does not select it, and the v2
  // replacement must start at "now" instead of retroactively copying it.
  using _legacyProvision = await project.capabilityHosts.get(path).provideCapability({
    type: "live",
    path: ["legacy"],
    capability: { marker: () => marker },
  });
  const root = project.streams.get("/");
  const rootBeforeConnect = (await root.getEvents({ afterOffset: 0 })).at(-1)?.offset ?? 0;

  using _firstConnection = await itx.projects.connect(projectId, {
    path,
    description: "Legacy HAVPE",
    capabilities: new Carrier(),
    flattenNestedPaths: true,
  });
  using host = project.clients.get(path);
  // @ts-expect-error - dynamic flattened capability member
  expect(await host.capabilities.ping("fresh")).toEqual({
    args: ["fresh"],
    marker,
    path: ["ping"],
  });
  const copiedProvision = await root.waitForEvent({
    afterOffset: rootBeforeConnect,
    eventTypes: ["events.iterate.com/capability-host/capability-provided"],
    predicate: (event) =>
      event.source?.copiedFrom?.at(-1)?.path === path &&
      event.payload?.instructions === "Legacy HAVPE",
    timeoutMs: 15_000,
  });
  const copiedSourceOffset = copiedProvision.source?.copiedFrom?.at(-1)?.offset;
  if (copiedSourceOffset === undefined)
    throw new Error("copied provision lacked its source offset");
  await project.streams.get(path).subscriptions.get("clients-to-root").waitUntilProcessed({
    offset: copiedSourceOffset,
    timeoutMs: 15_000,
  });

  // A reconnect repeats the desired bootstrap batch, but its v2 entry is
  // idempotent and does not make another provision or copy.
  using _secondConnection = await itx.projects.connect(projectId, {
    path,
    description: "Legacy HAVPE",
  });
  const subscriptionEvents = (await project.streams.get(path).getEvents({ afterOffset: 0 })).filter(
    (event) =>
      event.type === "events.iterate.com/stream/subscription-configured" &&
      event.payload?.name === "clients-to-root",
  );
  expect(subscriptionEvents.map((event) => event.idempotencyKey)).toEqual([
    "stream/subscription-configured:clients-to-root",
    "stream/subscription-configured:clients-to-root:v2",
  ]);
  expect(
    SubscriptionConfiguredPayload.parse(
      (await project.streams.get(path).subscriptions.get("clients-to-root").describe())!
        .configuration,
    ),
  ).toMatchObject({
    filter: {
      eventTypes: expect.arrayContaining([
        "events.iterate.com/capability-host/capability-provided",
      ]),
    },
    receiver: { delivery: { start: "now", onFailingEvent: "halt" } },
  });
  const copiedProvisions = (await root.getEvents({ afterOffset: rootBeforeConnect })).filter(
    (event) =>
      event.type === "events.iterate.com/capability-host/capability-provided" &&
      event.source?.copiedFrom?.at(-1)?.path === path,
  );
  expect(copiedProvisions).toEqual([copiedProvision]);
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
    // First life: connect in a scoped session, prove connected, then dispose
    // its owned project handle before the session. The raw-termination test
    // below covers ungraceful transport loss.
    using firstSession = withItxSession();
    using _robotProject = await connectRobot(firstSession);
    const connected = await settleClient(project, "/clients/desk-robot", (c) => c.connected);
    expect(connected).toMatchObject({ path: "/clients/desk-robot", connected: true });
  }

  // The platform journals the disposed provider's disconnect, so the catalog
  // must flip to connected: false.
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

test("an abruptly terminated client transport still durably disconnects its live capability", async () => {
  const marker = crypto.randomUUID();
  using observerSession = withItxSession();
  using observerItx = observerSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await observerItx.projects.get(`clients-abrupt-disconnect-${marker}`).create({});
  const { projectId } = await project.__describe();

  // This uses the public /api WebSocket directly so terminate() simulates an
  // ungraceful transport loss, rather than a local stub disposal.
  const socket = new WebSocket(buildUrl({ path: "/api", protocol: "ws" }), {
    handshakeTimeout: 15_000,
    headers: cloudflareWorkerVersionOverrideHeaders(process.env),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    // ws implements the same WebSocket transport expected by Cap'n Web; its
    // package types are Node-specific while Cap'n Web accepts the browser form.
    using providerSession = newWebSocketRpcSession<UnauthenticatedOs>(
      socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
    );
    using providerItx = providerSession.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    using _providerProject = await providerItx.projects.connect(projectId, {
      path: "/clients/abrupt",
      description: "Abruptly disconnected e2e client",
      capabilities: { marker: () => marker },
    });

    const connected = await settleClient(project, "/clients/abrupt", (client) => client.connected);
    expect(connected).toMatchObject({ path: "/clients/abrupt", connected: true });

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.terminate();
    await closed;

    const disconnected = await settleClient(
      project,
      "/clients/abrupt",
      (client) => !client.connected,
    );
    expect(disconnected).toMatchObject({ path: "/clients/abrupt", connected: false });
    expect(disconnected?.lastDisconnectedAt).toBeDefined();

    using recoveredSession = withItxSession();
    using recoveredItx = recoveredSession.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    using _recoveredProject = await recoveredItx.projects.connect(projectId, {
      path: "/clients/abrupt",
      description: "Recovered e2e client",
      capabilities: { marker: () => ({ marker, recovered: true }) },
    });
    const recovered = await settleClient(project, "/clients/abrupt", (client) => client.connected);
    expect(recovered).toMatchObject({ path: "/clients/abrupt", connected: true });

    using host = project.clients.get("/clients/abrupt");
    // @ts-expect-error - dynamic capability member
    expect(await host.capabilities.marker()).toEqual({ marker, recovered: true });
  } finally {
    if (socket.readyState < WebSocket.CLOSING) socket.terminate();
  }
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
    if (latest !== undefined && accept(latest)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return latest;
}
