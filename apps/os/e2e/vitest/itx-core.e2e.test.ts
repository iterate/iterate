import { expect, test } from "vitest";
// oxlint-disable-next-line iterate/no-capnweb-http-batch -- this regression test intentionally proves the one-shot HTTP batch shape.
import { newHttpBatchRpcSession } from "capnweb";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { RepoArtifactNameCodec } from "../../src/domains/repos/utils.ts";
import type { UnauthenticatedOs } from "../../src/itx-api.generated.ts";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";
import type { ItxWebSocketMessage } from "./test-helpers.ts";

// These are hand written tests - they MUST pass
test("Unauthenticated itx can't do anything", async () => {
  using session = withItxSession();
  await expect((<any>session).projects).rejects.toThrow();
});

test("Authenticated session __describe returns principal", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "impersonate",
    secret: adminSecret(),
    token: {
      principal: "alice",
      projectScopes: ["prj_alice", "prj_ref"],
      type: "user",
    },
  });

  const projects = itx.projects;

  expect(await itx.__describe()).toMatchObject({ principal: "alice" });
  // list() enriches each scope: an impersonated principal's scopes have no
  // directory record, so the id doubles as the slug and the org is unknown.
  const list = await projects.list();
  expect(list.map((project) => project.id)).toEqual(["prj_alice", "prj_ref"]);
  expect(list[0]).toMatchObject({
    id: "prj_alice",
    slug: "prj_alice",
    organizationId: null,
    organizationName: null,
  });
  expect(["ready", "missing", "unknown"]).toContain(list[0]?.deploymentStatus);
});

test("Authenticated internal auth itx can create project and append to stream", async () => {
  const messages: ItxWebSocketMessage[] = [];
  using session = withItxSession({
    onWebSocketMessage: (message) => {
      messages.push(message);
    },
  });
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  const projectSlug = `alice-project-${crypto.randomUUID().slice(0, 8)}`;
  using project = await itx.projects.get(projectSlug).create({});
  const description = await project.__describe();
  expect(description.projectId).toMatch(/prj_[0-9a-f-]+$/);
  expect(description.name).toMatch(/prj_[0-9a-f-]+\.iterate\/$/);

  // projects.get accepts a slug OR a prj_ id — both resolve the SAME project
  // (the browser addresses by the URL slug; ids still work). An unknown slug is
  // a genuine miss and fails loudly instead of minting a phantom namespace.
  expect(await itx.projects.get(projectSlug).__describe()).toMatchObject({
    projectId: description.projectId,
  });
  expect(await itx.projects.get(description.projectId).__describe()).toMatchObject({
    projectId: description.projectId,
  });
  await expect(itx.projects.get("no-such-project-xyz").__describe()).rejects.toThrow(
    /does not exist/,
  );
  // Explicit creation is two pipelined operations: pure addressing on the
  // collection, followed by create on the returned project handle.
  expect(messages).toEqual(
    expect.arrayContaining([
      [
        expect.any(Number),
        "out",
        ["push", ["pipeline", expect.any(Number), ["projects", "get"], [projectSlug]]],
      ],
      [expect.any(Number), "out", ["push", ["pipeline", expect.any(Number), ["create"], [{}]]]],
    ]),
  );

  using stream = project.streams.get("/");

  const events = await stream.getEvents();

  // We don't care about ordering, just that the stream contains each of these
  // event types. Mapping to types + arrayContaining is the concise idiomatic way.
  // The repo/* events arrive through a stream relationship: the config repo
  // commits its facts on its own stream (/repos/config), then its subscription
  // delivers them here for the creation saga.
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      "events.iterate.com/stream/created",
      "events.iterate.com/stream/woken",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/project/created",
      "events.iterate.com/repos/created",
      "events.iterate.com/project/ready",
      "events.iterate.com/stream/connection-closed",
    ]),
  );

  const repoCreated = events.find((event) => event.type === "events.iterate.com/repos/created");
  const projectCreated = events.find(
    (event) => event.type === "events.iterate.com/project/created",
  );
  const projectReady = events.find((event) => event.type === "events.iterate.com/project/ready");
  expect(repoCreated).toMatchObject({
    payload: {
      request: { type: "empty" },
      artifactName: RepoArtifactNameCodec.stringify({
        path: "/repos/config",
        projectId: description.projectId,
      }),
    },
    // Provenance: the copy names its source coordinate on the config repo's
    // own stream.
    source: {
      copiedFrom: [
        expect.objectContaining({
          path: "/repos/config",
          projectId: description.projectId,
          subscriptionKey: "project-config-to-root",
          type: "events.iterate.com/repos/created",
        }),
      ],
    },
  });
  expect(projectCreated).toBeTruthy();
  expect(projectReady).toBeTruthy();
  expect(projectCreated!.offset).toBeLessThan(repoCreated!.offset);
  expect(repoCreated!.offset).toBeLessThan(projectReady!.offset);

  // First-hand on the config repo's own stream: the same facts, no
  // provenance chain, plus the repo processor and stream subscriptions.
  const configRepoEvents = await project.streams.get("/repos/config").getEvents();
  const firstHandRepoCreated = configRepoEvents.find(
    (event) => event.type === "events.iterate.com/repos/created",
  );
  expect(firstHandRepoCreated).toMatchObject({
    payload: { request: { type: "empty" } },
  });
  expect(firstHandRepoCreated!.source?.copiedFrom).toBeUndefined();
  expect(
    configRepoEvents.some(
      (event) =>
        event.type === "events.iterate.com/stream/subscription-configured" &&
        (event.payload as { subscriptionKey?: string }).subscriptionKey ===
          "project-config-to-root",
    ),
  ).toBe(true);

  // The relationship stays live after bootstrap: a fresh append on the config
  // repo's stream shows up on `/` with source-stream provenance.
  const [configRepoFact] = await project.streams.get("/repos/config").append({
    type: "events.iterate.test/config-repo-fact",
    payload: { marker: description.projectId },
  });
  await stream.waitForEvent({
    // Replay from the start: the copy may land before this waiter attaches.
    afterOffset: 0,
    eventTypes: ["events.iterate.test/config-repo-fact"],
    predicate: (event) =>
      (event.payload as { marker?: string }).marker === description.projectId &&
      event.source?.copiedFrom?.[0]?.path === "/repos/config" &&
      event.source.copiedFrom[0].offset === configRepoFact!.offset,
    timeoutMs: 30_000,
  });

  expect(await project.repo.whoami()).toBe(`repo ${description.projectId}:/repos/config`);
  expect(await project.repos.get("/repos/config").whoami()).toBe(
    `repo ${description.projectId}:/repos/config`,
  );

  // The seeded root worker serves a static homepage for un-routed requests
  // and echoes an unknown x-iterate-app selection in its 404 body — a
  // request-specific echo through the fetch lane with no app cold build.
  const probeApp = `probe-${crypto.randomUUID().slice(0, 8)}`;
  const workerResponse = await project.worker.fetch(
    new Request("https://example.com/probe", { headers: { "x-iterate-app": probeApp } }),
  );
  expect(workerResponse).toMatchObject({ status: 404 });
  expect(await workerResponse.text()).toContain(`unknown app: ${probeApp}`);

  const [committedEvent] = await project.streams.get("/some/path").append({
    type: "hello-world",
  });
  expect(committedEvent).toMatchObject({
    type: "hello-world",
    // The birth certificate: created(1), the project-worker feed's
    // outbound project-worker config(2), the PostHog config(3), woken(4) — the first
    // user append is 5.
    offset: 5,
  });
  expect(await project.streams.get("/some/path").getEvents()).toMatchObject([
    {
      type: "events.iterate.com/stream/created",
    },
    {
      type: "events.iterate.com/stream/subscription-configured",
      payload: { subscriptionKey: "project-worker" },
    },
    {
      type: "events.iterate.com/stream/subscription-configured",
      payload: { subscriptionKey: "iterate-platform-posthog" },
    },
    {
      type: "events.iterate.com/stream/woken",
    },
    committedEvent,
  ]);

  const getSecret = async () => "bananas";

  using provision = await project.provideCapability({
    path: ["someMethodInTestRunner"],
    type: "live",
    capability: {
      getSecret: (secretGetter: () => Promise<string>) => secretGetter(),
    },
  });

  // @ts-expect-error - TODO maybe some niceties
  expect(await project.someMethodInTestRunner.getSecret(getSecret)).toBe("bananas");

  // make new itx connection

  using newSession = withItxSession();
  using newItx = newSession.authenticate({
    type: "impersonate",
    secret: adminSecret(),
    token: {
      projectScopes: [description.projectId],
      type: "user",
      principal: "alice",
    },
  });

  using newConnectionProject = newItx.projects.get(description.projectId);
  expect(
    // @ts-expect-error - TODO maybe some niceties
    await newConnectionProject.someMethodInTestRunner.getSecret(getSecret),
  ).toBe("bananas");

  await provision.revoke();

  // @ts-expect-error
  await expect(project.someMethodInTestRunner.getSecret(getSecret)).rejects.toThrow(
    /no capability "someMethodInTestRunner.getSecret"/,
  );
  await expect(
    // @ts-expect-error - TODO maybe some niceties
    newConnectionProject.someMethodInTestRunner.getSecret(getSecret),
  ).rejects.toThrow(/no capability "someMethodInTestRunner.getSecret"/);
});

test("Project describe exposes self-describing builtin capabilities", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = await itx.projects.get(uniqueFixtureSlug("ai-builtin")).create({});
  const description = await project.__describe();

  // Built-ins live in the children map (capabilities holds dynamic mounts
  // only); the collection node itself self-describes with the full
  // per-connection call shapes.
  expect(Object.keys(description.children)).toEqual(expect.arrayContaining(["ai", "integrations"]));
  const integrations = await project.integrations.__describe();
  expect(integrations.instructions).toContain("itx.integrations.gmail.get().request");
  expect(integrations.instructions).toContain("itx.integrations.list()");
});

test("Trusted internal root can access global streams and repos", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  const path = `/global-${crypto.randomUUID()}`;
  const [streamEvent] = await itx.streams.get(path).append({
    type: "events.iterate.test/global-stream",
    payload: { path },
  });
  expect(streamEvent).toMatchObject({
    offset: 3,
    payload: { path },
    type: "events.iterate.test/global-stream",
  });

  using repo = await itx.repos.get(path).create({ type: "empty" });
  expect(await repo.whoami()).toBe(`repo null:${path}`);
});

// This test is handy because it proves that we really only need one round trip to
// take all the actions in this itx script
test("Authenticated session __describe and projects list complete in one HTTP batch", async () => {
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- if this cannot pipeline in one request, Cap'n Web rejects the batch.
  using session = newHttpBatchRpcSession<UnauthenticatedOs>(buildUrl({ path: "/api" }));
  using itx = session.authenticate({
    type: "impersonate",
    secret: adminSecret(),
    token: {
      principal: "alice",
      projectScopes: ["prj_alice", "prj_ref"],
      type: "user",
    },
  });
  // If we didn't do Promise.all, this wouldn't work - wouldn't be sent as part of the same batch
  const [description, projects] = await Promise.all([itx.__describe(), itx.projects.list()]);
  expect(description).toMatchObject({ principal: "alice" });
  expect(projects.map((project) => project.id)).toEqual(["prj_alice", "prj_ref"]);

  // session is now finished - cannot be used again in batch http mode
  await expect(session.authenticate).rejects.toThrow();
});
