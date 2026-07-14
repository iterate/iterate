import { expect, test } from "vitest";
// oxlint-disable-next-line iterate/no-capnweb-http-batch -- this regression test intentionally proves the one-shot HTTP batch shape.
import { newHttpBatchRpcSession } from "capnweb";
import { RepoArtifactNameCodec } from "../../src/domains/repos/utils.ts";
import type { UnauthenticatedOs } from "../../src/itx-api.generated.ts";
import { appendEvents } from "../test-support/append-events.ts";
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

  // TODO project slug should be derived from tests etc as in apps/os
  using project = itx.projects.create({ slug: "alice-project" });
  const description = await project.__describe();
  expect(description.projectId).toMatch(/prj_[0-9a-f-]+$/);
  expect(description.name).toMatch(/prj_[0-9a-f-]+\.iterate\/$/);

  // projects.get namespaces itx state by the given string, so a slug (or
  // any non-prj_ id) must fail loudly instead of minting a phantom project.
  await expect(itx.projects.get("alice-project").__describe()).rejects.toThrow(/not a project id/);
  expect(messages).toContainEqual([
    expect.any(Number),
    "out",
    ["push", ["pipeline", 1, ["projects", "create"], [{ slug: "alice-project" }]]],
  ]);

  using stream = project.streams.get("/");

  const events = await stream.getEvents();

  // We don't care about ordering, just that the stream contains each of these
  // event types. Mapping to types + arrayContaining is the concise idiomatic way.
  // The repo/* events are CROSS-POSTED COPIES: the config repo commits its
  // facts on its own stream (/repos/config) and the bootstrap's cross-post
  // rule copies them here for the creation saga.
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      "events.iterate.com/stream/created",
      "events.iterate.com/stream/woken",
      "events.iterate.com/stream/subscription-configured",
      "events.iterate.com/project/create-requested",
      "events.iterate.com/repo/create-requested",
      "events.iterate.com/repo/created",
      "events.iterate.com/project/created",
      "events.iterate.com/stream/subscriber-disconnected",
    ]),
  );

  const repoCreated = events.find((event) => event.type === "events.iterate.com/repo/created");
  const projectCreated = events.find(
    (event) => event.type === "events.iterate.com/project/created",
  );
  expect(repoCreated).toMatchObject({
    payload: {
      artifactName: RepoArtifactNameCodec.stringify({
        path: "/repos/config",
        projectId: description.projectId,
      }),
      path: "/repos/config",
      projectId: description.projectId,
    },
    // Provenance: the copy names its source coordinate on the config repo's
    // own stream.
    source: {
      crossPostedFrom: [
        expect.objectContaining({
          path: "/repos/config",
          projectId: description.projectId,
          subscriptionKey: "cross-post:/",
          type: "events.iterate.com/repo/created",
        }),
      ],
    },
  });
  expect(projectCreated).toBeTruthy();
  expect(repoCreated!.offset).toBeLessThan(projectCreated!.offset);

  // First-hand on the config repo's own stream: the same facts, no
  // provenance chain, plus the repo processor + cross-post subscriptions.
  const configRepoEvents = await project.streams.get("/repos/config").getEvents();
  const firstHandRepoCreated = configRepoEvents.find(
    (event) => event.type === "events.iterate.com/repo/created",
  );
  expect(firstHandRepoCreated).toMatchObject({
    payload: { path: "/repos/config", projectId: description.projectId },
  });
  expect(firstHandRepoCreated!.source?.crossPostedFrom).toBeUndefined();
  expect(
    configRepoEvents.some(
      (event) =>
        event.type === "events.iterate.com/stream/subscription-configured" &&
        (event.payload as { subscriptionKey?: string }).subscriptionKey === "cross-post:/",
    ),
  ).toBe(true);

  // The cross-post pipe stays live after bootstrap: a fresh append on the
  // config repo's stream shows up on `/` as a provenance-stamped copy.
  const [configRepoFact] = await appendEvents(project.streams.get("/repos/config"), {
    type: "events.iterate.test/config-repo-fact",
    payload: { marker: description.projectId },
  });
  await stream.waitForEvent({
    // Replay from the start: the copy may land before this waiter attaches.
    afterOffset: 0,
    eventTypes: ["events.iterate.test/config-repo-fact"],
    predicate: (event) =>
      (event.payload as { marker?: string }).marker === description.projectId &&
      event.source?.crossPostedFrom?.[0]?.path === "/repos/config" &&
      event.source.crossPostedFrom[0].offset === configRepoFact!.offset,
    timeoutMs: 30_000,
  });

  expect(await project.repo.whoami()).toBe(`repo ${description.projectId}:/repos/config`);
  expect(await project.repos.get("/repos/config").whoami()).toBe(
    `repo ${description.projectId}:/repos/config`,
  );

  // The seeded root worker serves a static homepage for un-routed requests;
  // the hello app (selected via the trusted x-iterate-app header) echoes the
  // path, which is what this probe is really asserting.
  const workerResponse = await project.worker.fetch(
    new Request("https://example.com/probe", { headers: { "x-iterate-app": "hello" } }),
  );
  expect(await workerResponse.json()).toMatchObject({ app: "hello", path: "/probe" });

  const [committedEvent] = await appendEvents(project.streams.get("/some/path"), {
    type: "hello-world",
  });
  expect(committedEvent).toMatchObject({
    type: "hello-world",
    // The birth certificate: created(1), the project-worker feed's
    // subscription-configured(2), woken(3) — the first user append is 4.
    offset: 4,
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

  using project = itx.projects.create({ slug: "ai-builtin" });
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
  const [streamEvent] = await appendEvents(itx.streams.get(path), {
    type: "events.iterate.test/global-stream",
    payload: { path },
  });
  expect(streamEvent).toMatchObject({
    offset: 3,
    payload: { path },
    type: "events.iterate.test/global-stream",
  });

  using repo = await itx.repos.create({ path });
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
