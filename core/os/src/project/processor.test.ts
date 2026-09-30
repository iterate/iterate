// src/project/processor.test.ts — the ProjectProcessor's executable spec: the reduce as declarative
// `{ events → state }` rows (iterate/stream/test-support `reduceProcessor`) — the project's own creation
// and the catalog folded from cross-posted birth certificates. The saga — `session.projects.create`
// landing the request, the processor landing the certificate on `/` — is pinned end to end in
// test/vitest/os/session.e2e.test.ts.

import { expect, onTestFinished, test, vi } from "vitest";
import type { StreamEventInput } from "iterate/stream/processor";
import { reduceProcessor } from "iterate/stream/test-support";
import { runningCause, runningUnder } from "../cause.ts";
import { normalizeControlEvent } from "../stream/core-processor.ts";
import { ownershipRecordOf } from "./custom-hostnames.ts";
import { ProjectProcessor } from "./processor.ts";
import type { ProjectState } from "./contract.ts";

const requested = {
  type: "events.iterate.com/project/create-requested",
  payload: { slug: "acme", orgId: "org_1" },
};
const created = { type: "events.iterate.com/project/created", payload: {} };
const failed = {
  type: "events.iterate.com/project/create-failed",
  payload: { error: "boom" },
};
const deleted = { type: "events.iterate.com/project/deleted", payload: {} };

/** The empty state; a row spreads it and names only what its events changed. */
const empty: ProjectState = {
  creation: null,
  deletion: null,
  repos: {},
  workspaces: {},
  contexts: {},
  secrets: {},
  configRepoTip: null,
  unpublishedCommits: [],
  lastPublicationFactOffset: null,
  publishedCommit: null,
  hostnames: {},
  integrations: {},
  primaryHostname: null,
};

const reduceRows: {
  name: string;
  events: {
    type: string;
    payload?: unknown;
    source?: { platform?: true; cause?: { chain: string; depth: number } };
  }[];
  state: ProjectState;
}[] = [
  { name: "the empty state", events: [], state: empty },
  {
    name: "a request opens the project's creation, at its offset",
    events: [requested],
    state: { ...empty, creation: { status: "requested", offset: 1 } },
  },
  {
    name: "the certificate completes it, at its offset",
    events: [requested, created],
    state: { ...empty, creation: { status: "created", offset: 2 } },
  },
  {
    name: "a failure closes the attempt at its offset (the error is on that event, not in state); a request after it is a new attempt; born once: a request after the certificate is a harmless fact",
    events: [requested, failed, requested, created, requested],
    state: { ...empty, creation: { status: "created", offset: 4 } },
  },
  {
    name: "a failure after the certificate is a harmless fact too: the project stays created",
    events: [requested, created, failed],
    state: { ...empty, creation: { status: "created", offset: 2 } },
  },
  {
    name: "the config repo's commits move the tip the project follows and each is owed a publication, by its oid and the fact's offset; another repo's commit is ignored",
    events: [
      committed("/repos/config", "aaa"),
      committed("/repos/other", "bbb"),
      committed("/repos/config", "ccc"),
    ],
    state: owing(tip("aaa", 1), tip("ccc", 3)),
  },
  {
    name: "a publication's outcome settles the commit of its generation, a refusal too; the platform's give-up settles nothing; each is the last publication fact, and the published one is the commit the project runs",
    events: [
      committed("/repos/config", "aaa"),
      committed("/repos/config", "bbb"),
      committed("/repos/config", "ccc"),
      workerUpdated("aaa", 1),
      workerUpdateFailed("bbb", 2),
      {
        ...workerUpdateFailed("ccc", 3),
        payload: { ...workerUpdateFailed("ccc", 3).payload, unavailable: true },
      },
      { type: "events.iterate.com/itx/ingress-configured", payload: { target: ["itx", "config"] } },
    ],
    state: { ...owing(tip("ccc", 3)), lastPublicationFactOffset: 6, publishedCommit: "aaa" },
  },
  {
    name: "a repo's and a workspace's certificates each add one entry, by path, stamped with the event's time — the project's own creation untouched",
    events: [requested, created, repoBorn("/repos/config"), workspaceBorn("/workspaces/notes")],
    state: {
      creation: { status: "created", offset: 2 },
      deletion: null,
      repos: { "/repos/config": { createdAt: expect.any(String) } },
      workspaces: { "/workspaces/notes": { createdAt: expect.any(String) } },
      contexts: {},
      secrets: {},
      configRepoTip: null,
      unpublishedCommits: [],
      lastPublicationFactOffset: null,
      publishedCommit: null,
      hostnames: {},
      integrations: {},
      primaryHostname: null,
    },
  },
  {
    name: "a secret's set is its row — the pin, the strategy kind, the first set's time; a re-set with a new pin replaces the row and keeps the time; the same pin again is a no-op; a deletion drops it; a set after the deletion is a new row",
    events: [
      secretSet("/secrets/shop", ["https://shop.example"]),
      secretSet("/secrets/shop", ["https://shop.example"]),
      secretSet(
        "/secrets/shop",
        ["https://shop.example", "https://api.shop.example"],
        "oauth-refresh-token",
      ),
      secretSet("/secrets/gone", ["https://gone.example"]),
      secretDeleted("/secrets/gone"),
      secretDeleted("/secrets/gone"),
      secretSet("/secrets/back", ["https://a.example"]),
      secretDeleted("/secrets/back"),
      secretSet("/secrets/back", ["https://b.example"]),
    ],
    state: {
      ...empty,
      secrets: {
        "/secrets/shop": {
          urls: ["https://shop.example", "https://api.shop.example"],
          refresh: "oauth-refresh-token",
          createdAt: expect.any(String),
        },
        "/secrets/back": { urls: ["https://b.example"], createdAt: expect.any(String) },
      },
    },
  },
  {
    name: "a second certificate for the same path is ignored (born once); an unrelated event leaves the state as it was; any path can host a repo",
    events: [
      repoBorn("/repos/config"),
      repoBorn("/repos/config"),
      { type: "note" },
      repoBorn("/vendor/lib"),
    ],
    state: {
      ...empty,
      repos: {
        "/repos/config": { createdAt: expect.any(String) },
        "/vendor/lib": { createdAt: expect.any(String) },
      },
    },
  },
  {
    name: "a hostname's add is owed at its offset; the answer settles it; a re-add (the re-check) is owed again and keeps what Cloudflare said",
    events: [hostname("add-requested"), addSettled(1, "pending"), hostname("add-requested")],
    state: {
      ...empty,
      hostnames: {
        "www.acme.test": {
          requested: { verb: "add", offset: 3 },
          cloudflare: observation("pending"),
          error: null,
          connectedAt: null,
          claimed: true,
        },
      },
    },
  },
  {
    name: "a failed add keeps its words; a failed re-check keeps the last observation",
    events: [
      hostname("add-requested"),
      addSettled(1, "active"),
      hostname("add-requested"),
      addSettled(3, null, "boom", true),
    ],
    state: {
      ...empty,
      hostnames: {
        "www.acme.test": {
          requested: null,
          cloudflare: observation("active"),
          error: "boom",
          connectedAt: null,
          claimed: true,
        },
      },
    },
  },
  {
    name: "a remove is owed at its offset; an add's late answer does not undo it; the removal drops the entry; an answer or a remove for an unknown hostname is ignored",
    events: [
      hostname("add-requested"),
      hostname("remove-requested"),
      addSettled(1, "active"),
      removed(2),
      addSettled(1, "active"),
      hostname("remove-requested"),
    ],
    state: empty,
  },
  {
    name: "an add asked on the way back from the DNS provider's Domain Connect page records when, and its answer keeps it",
    events: [
      hostname("add-requested"),
      { ...hostname("add-requested"), payload: { hostname: "www.acme.test", connected: true } },
      addSettled(2, "pending"),
    ],
    state: {
      ...empty,
      hostnames: {
        "www.acme.test": {
          requested: null,
          cloudflare: observation("pending"),
          error: null,
          connectedAt: expect.any(String),
          claimed: true,
        },
      },
    },
  },
  {
    name: "an answer settles only its own request: an add asked while another ran stays owed, with the older answer's observation",
    events: [hostname("add-requested"), hostname("add-requested"), addSettled(1, "pending")],
    state: {
      ...empty,
      hostnames: {
        "www.acme.test": {
          requested: { verb: "add", offset: 2 },
          cloudflare: observation("pending"),
          error: null,
          connectedAt: null,
          claimed: true,
        },
      },
    },
  },
  {
    name: "an add asked while a remove ran survives the removal, owed from nothing",
    events: [
      hostname("add-requested"),
      addSettled(1, "active"),
      hostname("remove-requested"),
      hostname("add-requested"),
      removed(3),
    ],
    state: {
      ...empty,
      hostnames: {
        "www.acme.test": {
          requested: { verb: "add", offset: 4 },
          cloudflare: null,
          error: null,
          connectedAt: null,
          claimed: false,
        },
      },
    },
  },
  {
    name: "integrations: a platform `<provider>/connected` is the connection's row, by its log path; `disconnected` drops it",
    events: [
      integrationFact("slack", "connected", "acme"),
      integrationFact("github", "connected", "acme"),
      integrationFact("slack", "connected", "beta"),
      integrationFact("slack", "disconnected", "beta"),
    ],
    state: {
      ...empty,
      integrations: {
        "/integrations/slack/acme": integrationRow("slack", "acme"),
        "/integrations/github/acme": integrationRow("github", "acme"),
      },
    },
  },
  {
    name: "a lend arriving is a borrowed catalog row, with no material of its own; its revocation drops it, another lend's does not",
    events: [
      borrowed("/secrets/google-ada", "lend_a"),
      borrowed("/secrets/cf", "lend_b"),
      lendRevoked("/secrets/cf", "lend_x"),
      lendRevoked("/secrets/cf", "lend_b"),
    ],
    state: {
      ...empty,
      secrets: {
        "/secrets/google-ada": {
          urls: ["https://google.test"],
          createdAt: expect.any(String),
          borrowed: {
            lendId: "lend_a",
            lender: { userId: "user_ada", email: "ada@example.com" },
            integration: { provider: "google", account: "ada@example.com", externalId: "42" },
          },
        },
      },
    },
  },
  {
    name: "a live hostname the project holds becomes primary",
    events: [hostname("add-requested"), addSettled(1, "active"), primary("www.acme.test")],
    state: {
      ...empty,
      hostnames: { "www.acme.test": liveHostname() },
      primaryHostname: "www.acme.test",
    },
  },
  {
    name: "null clears the primary hostname",
    events: [
      hostname("add-requested"),
      addSettled(1, "active"),
      primary("www.acme.test"),
      primary(null),
    ],
    state: { ...empty, hostnames: { "www.acme.test": liveHostname() } },
  },
  {
    name: "a hostname the project does not hold, or one not live, is refused as primary: the primary stays as it was",
    events: [
      hostname("add-requested"),
      addSettled(1, "active"),
      primary("www.acme.test"),
      primary("other.acme.test"),
      { ...hostname("add-requested"), payload: { hostname: "pending.acme.test" } },
      primary("pending.acme.test"),
    ],
    state: {
      ...empty,
      hostnames: {
        "www.acme.test": liveHostname(),
        "pending.acme.test": {
          requested: { verb: "add", offset: 5 },
          cloudflare: null,
          error: null,
          connectedAt: null,
          claimed: false,
        },
      },
      primaryHostname: "www.acme.test",
    },
  },
  {
    name: "a hostname asked for before it is live is refused as primary",
    events: [hostname("add-requested"), addSettled(1, "pending"), primary("www.acme.test")],
    state: {
      ...empty,
      hostnames: {
        "www.acme.test": {
          requested: null,
          cloudflare: observation("pending"),
          error: null,
          connectedAt: null,
          claimed: true,
        },
      },
    },
  },
  {
    name: "asking to remove the primary hostname clears it",
    events: [
      hostname("add-requested"),
      addSettled(1, "active"),
      primary("www.acme.test"),
      hostname("remove-requested"),
      removed(4),
    ],
    state: empty,
  },
  {
    name: "a re-check that finds the primary no longer live clears it",
    events: [
      hostname("add-requested"),
      addSettled(1, "active"),
      primary("www.acme.test"),
      hostname("add-requested"),
      addSettled(4, "pending"),
    ],
    state: {
      ...empty,
      hostnames: {
        "www.acme.test": {
          requested: null,
          cloudflare: observation("pending"),
          error: null,
          connectedAt: null,
          claimed: true,
        },
      },
    },
  },
  {
    name: "a hostname nobody has proven is not the project's: live at Cloudflare, it holds no claim and is refused as primary",
    events: [
      hostname("add-requested"),
      addSettled(1, "active", null, false),
      primary("www.acme.test"),
    ],
    state: {
      ...empty,
      hostnames: { "www.acme.test": { ...liveHostname(), claimed: false } },
    },
  },
  {
    name: "an answer from before the ownership proof held its claim once it reached Cloudflare",
    events: [
      hostname("add-requested"),
      addSettled(1, "active", null, undefined),
      primary("www.acme.test"),
    ],
    state: {
      ...empty,
      hostnames: { "www.acme.test": liveHostname() },
      primaryHostname: "www.acme.test",
    },
  },
  {
    name: "the context registry: each announced context once, by path; a repeat keeps the first",
    events: [childCreated("/agents/a"), childCreated("/repos/config"), childCreated("/agents/a")],
    state: {
      ...empty,
      contexts: {
        "/agents/a": { createdAt: expect.any(String) },
        "/repos/config": { createdAt: expect.any(String) },
      },
    },
  },
  {
    name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
    events: [
      { type: "events.iterate.com/repo/created", payload: { path: 1 } },
      { type: "events.iterate.com/project/create-requested", payload: { slug: "" } },
      workspaceBorn("/w"),
    ],
    state: { ...empty, workspaces: { "/w": { createdAt: expect.any(String) } } },
  },
  {
    name: "a delete request the platform stamped opens the deletion, at its offset — once; the saga's own records change nothing",
    events: [
      requested,
      created,
      deleteRequested({ platform: true }),
      deleteRequested({ platform: true }),
      { type: "events.iterate.com/project/context-deleted", payload: { path: "/a" } },
      deleted,
    ],
    state: { ...empty, creation: { status: "created", offset: 2 }, deletion: { offset: 3 } },
  },
  {
    name: "a forged certificate before the request stops nothing",
    events: [requested, created, deleted, deleteRequested({ platform: true })],
    state: { ...empty, creation: { status: "created", offset: 2 }, deletion: { offset: 4 } },
  },
];
for (const { name, events, state } of reduceRows)
  test(`ProjectProcessor — the reduce: ${name}`, () =>
    expect(reduceProcessor(processorWithoutHostnames(), events)).toEqual(state));

// THE PUBLICATION OF THE CONFIG REPO: `processEvent` driven by hand over a fake publisher.
test("ProjectProcessor — the publication: a commit fact publishes its commit, main's head, as the generation of the fact's offset, its pointer and project/worker-updated in one batch as the platform; a commit that lands during an attempt is published when it settles; a pull back to an earlier commit is a publication of its own", async () => {
  const publisher = fakePublisher({ aaa: {}, bbb: {} });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  publisher.nextAppend = () => held;
  const processor = processorPublishingWith(publisher);
  publisher.main = "aaa";
  deliver(processor, owing(tip("aaa", 5)), unusedAppend);
  // a second commit lands while the first publication is in flight: owed next
  await settle();
  publisher.main = "bbb";
  deliver(processor, owing(tip("aaa", 5), tip("bbb", 7)), unusedAppend);
  await settle();
  expect(publisher).toMatchObject({ batches: [] });
  release();
  await settle();
  expect(publisher.batches.map(summary)).toEqual([
    ["itx.config ⇒ aaa@5", "project/worker-updated aaa@5"],
    ["itx.config ⇒ bbb@7", "project/worker-updated bbb@7"],
  ]);
  // the pointer reads the commit's modules through `itx.config.modules`, which only the platform writes
  const repo = ["itx", "builtins", ["cd", "/repos/config"], "builtins", "facets", ["get", "repo"]];
  const source = ["itx", "config", ["modules", { commitOid: "bbb" }]];
  const manifest = { generation: 7, modules: modulesOf("bbb") };
  expect(publisher.batches[1]).toMatchObject([
    {
      idempotencyKey: "project/config-modules:7",
      payload: { match: "itx.config.modules", target: [...repo, "modules"] },
    },
    {
      idempotencyKey: "project/config-pointer:7",
      payload: {
        match: "itx.config",
        target: ["itx", "builtins", "workers", ["get", { source, cacheKey: "bbb", manifest }]],
      },
    },
    { idempotencyKey: "project/publication:7" },
  ]);
  // delivered again over the same commits, before their outcomes reduced: nothing more
  deliver(processor, owing(tip("aaa", 5), tip("bbb", 7)), unusedAppend);
  await settle();
  expect(publisher.batches).toHaveLength(2);
  // a forced pull back to the first commit is a new fact, and a publication of its own
  publisher.main = "aaa";
  deliver(processor, owing(tip("aaa", 9)), unusedAppend);
  await settle();
  expect(publisher.batches.map(summary).slice(-1)).toEqual([
    ["itx.config ⇒ aaa@9", "project/worker-updated aaa@9"],
  ]);
});

test.for([
  {
    name: "two commits land before the first is published: the first is main moved on, the second published",
    owed: [tip("aaa", 5), tip("bbb", 7)],
    outcomes: [
      ["project/worker-update-failed aaa@5"],
      ["itx.config ⇒ bbb@7", "project/worker-updated bbb@7"],
    ],
  },
  {
    name: "a fact anyone appends naming a commit main is not at is main moved on, and publishes nothing",
    owed: [tip("some-other-commit", 5)],
    outcomes: [["project/worker-update-failed some-other-commit@5"]],
  },
])(
  "ProjectProcessor — every commit fact gets one outcome of its own: $name",
  async ({ owed, outcomes }) => {
    const publisher = fakePublisher({ aaa: {}, bbb: {} });
    publisher.main = "bbb";
    deliver(processorPublishingWith(publisher), owing(...owed), unusedAppend);
    await settle();
    expect(publisher.batches.map(summary)).toEqual(outcomes);
    expect(publisher.batches[0]![0]).toMatchObject({
      idempotencyKey: "project/publication:5",
      payload: { error: "main moved on to bbb before this commit was published" },
    });
  },
);

test("ProjectProcessor — init-at-8: a publication runs under its commit's cause, so init runs one deeper", async () => {
  const publisher = fakePublisher({ aaa: {} });
  publisher.main = "aaa";
  const commit = { chain: "an agent's chain", depth: 7 };
  const state = reduceProcessor(processorWithoutHostnames(), [
    { ...committed("/repos/config", "aaa"), source: { cause: commit } },
  ]);
  // the engine runs the pass one deeper than its event, as it runs a processor's other effects
  runningUnder({ ...commit, depth: 8 }, () =>
    deliver(processorPublishingWith(publisher), state, unusedAppend),
  );
  await settle();
  expect(publisher.batches.map(summary)).toEqual([
    ["itx.config ⇒ aaa@1", "project/worker-updated aaa@1"],
  ]);
  expect(publisher.causes).toMatchObject([commit]);
});

test("ProjectProcessor — a commit the probe refuses is project/worker-update-failed with why, keyed by its generation, and no pointer", async () => {
  const publisher = fakePublisher({ bad: { configEntrypoint: false } });
  publisher.main = "bad";
  deliver(processorPublishingWith(publisher), owing(tip("bad", 3)), unusedAppend);
  await settle();
  expect(publisher.batches.map(summary)).toEqual([["project/worker-update-failed bad@3"]]);
  expect(publisher.batches[0]![0]).toMatchObject({
    idempotencyKey: "project/publication:3",
    payload: {
      error: expect.stringMatching(/worker\.ts's default export is not an IterateConfig/),
    },
  });
});

test.for<{ name: string; dropped: FakeCommit }>([
  { name: "a Durable Object class", dropped: { classes: { "agents.ts": ["AgentDurableObject"] } } },
  { name: "its whole module", dropped: { without: "agents.ts", classes: { "worker.ts": [] } } },
])(
  "ProjectProcessor — a commit that drops $name the last publication exported publishes: a facet that names it fails its next call, saying so (worker-loader.ts `namedWorkerLoad`)",
  async ({ dropped }) => {
    const publisher = fakePublisher({ good: {}, dropped });
    const processor = processorPublishingWith(publisher);
    publisher.main = "good";
    deliver(processor, owing(tip("good", 2)), unusedAppend);
    await settle();
    publisher.main = "dropped";
    deliver(processor, owing(tip("good", 2), tip("dropped", 3)), unusedAppend);
    await settle();
    expect(publisher.batches.map(summary).slice(-1)).toEqual([
      ["itx.config ⇒ dropped@3", "project/worker-updated dropped@3"],
    ]);
  },
);

// A fresh incarnation's at-head pass reads whether the tip is published from its state, not memory.
test("ProjectProcessor — a commit is owed until an outcome of its own generation landed: a fresh incarnation over the state that reduced it appends nothing and starts no background work, so it claims nothing", async () => {
  const publisher = fakePublisher({ aaa: {} });
  publisher.main = "aaa";
  let background = 0;
  const runInBackground = (work: () => Promise<unknown>) => {
    background += 1;
    void work();
  };
  const tipped = owing(tip("aaa", 1));
  deliver(processorPublishingWith(publisher), tipped, unusedAppend, runInBackground);
  await settle();
  const [publication] = publisher.batches as [StreamEventInput[]];
  const state = reduceProcessor(processorWithoutHostnames(), [
    committed("/repos/config", "aaa"),
    ...publication.map((event) => normalizeControlEvent(event, "/")),
  ]);
  expect(state).toEqual({
    ...tipped,
    unpublishedCommits: [],
    lastPublicationFactOffset: 4,
    publishedCommit: "aaa",
  });
  deliver(processorPublishingWith(publisher), state, unusedAppend, runInBackground);
  await settle();
  expect({ batches: publisher.batches.length, background }).toEqual({ batches: 1, background: 1 });
});

test.for([
  {
    name: "a fresh incarnation that finds A's outcome after B's fact",
    run: async (publisher: ReturnType<typeof fakePublisher>) => {
      publisher.main = "bbb";
      // A@5 published, then B@7 landed while it ran, then the incarnation ended
      const state = {
        ...owing(tip("bbb", 7)),
        lastPublicationFactOffset: 9,
        published: { commitOid: "aaa", generation: 5, modules: modulesOf("aaa") },
      };
      deliver(processorPublishingWith(publisher), state, unusedAppend);
    },
  },
  {
    name: "a drain whose append was refused",
    run: async (publisher: ReturnType<typeof fakePublisher>) => {
      const processor = processorPublishingWith(publisher);
      publisher.main = "bbb";
      publisher.nextAppend = () => Promise.reject(new Error("the root's append failed"));
      deliver(processor, owing(tip("bbb", 7)), unusedAppend, (work) => {
        void work().catch(() => undefined);
      });
      await settle();
      deliver(processor, owing(tip("bbb", 7)), unusedAppend);
    },
  },
])("ProjectProcessor — B lands during A's publication and is published: $name", async ({ run }) => {
  const publisher = fakePublisher({ aaa: {}, bbb: {} });
  await run(publisher);
  await settle();
  expect(publisher.batches.map(summary).slice(-1)).toEqual([
    ["itx.config ⇒ bbb@7", "project/worker-updated bbb@7"],
  ]);
});

test("ProjectProcessor — a platform failure is met again after 5 s and 30 s with the same generation; one that outlasts the budget lands one give-up, unavailable, and this incarnation owes the tip on", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const overloaded = () =>
    Object.assign(new Error("esm.sh answered 503"), {
      code: "UNAVAILABLE",
      data: { kind: "overloaded" },
    });
  const recovering = fakePublisher({ aaa: {} });
  recovering.main = "aaa";
  recovering.failReadsTimes(2, overloaded);
  deliver(processorPublishingWith(recovering), owing(tip("aaa", 4)), unusedAppend);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(recovering).toMatchObject({ batches: [] });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(recovering.batches.map(summary)).toEqual([
    ["itx.config ⇒ aaa@4", "project/worker-updated aaa@4"],
  ]);
  expect(vi.getTimerCount()).toBe(0); // a pending timer would keep the context resident

  const down = fakePublisher({ aaa: {} });
  down.main = "aaa";
  down.failReadsTimes(Infinity, overloaded);
  const processor = processorPublishingWith(down);
  deliver(processor, owing(tip("aaa", 4)), unusedAppend);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(down.batches.map(summary)).toEqual([["project/worker-update-failed aaa@4"]]);
  expect(down.batches[0]![0]).toMatchObject({
    payload: { unavailable: true, error: "esm.sh answered 503" },
  });
  expect(down.batches[0]![0]).not.toHaveProperty("idempotencyKey");
  // this incarnation gave up on the tip: its own give-up's delivery starts nothing more
  deliver(processor, owing(tip("aaa", 4)), unusedAppend);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(down.batches).toHaveLength(1);
});

test("ProjectProcessor — an event that changes the primary hostname holds the cursor until the control plane has it; one that changes nothing writes nothing", async () => {
  const written: (string | null)[] = [];
  const processor = new ProjectProcessor(
    () => {
      throw new Error("unused");
    },
    () => Promise.reject(new Error("unused")),
    () => ({
      reservedZones: [],
      claim: async () => {},
      release: async () => {},
      heldElsewhere: async () => false,
      proof: proven,
      setPrimaryHostname: async (hostname) => void written.push(hostname),
      provider: null,
      connect: async () => null,
      dnsZone: async () => null,
    }),
  );
  const blockers: (() => Promise<unknown>)[] = [];
  for (const [previous, next] of [
    [null, "www.acme.test"],
    ["www.acme.test", "www.acme.test"],
    ["www.acme.test", null],
  ] as const)
    processor.processEvent({
      event: null,
      state: { ...empty, primaryHostname: next },
      previousState: { ...empty, primaryHostname: previous },
      delivery: { caughtUp: false },
      append: (() => Promise.resolve([])) as never,
      blockProcessorWhile: (work) => void blockers.push(work),
      runInBackground: () => {},
    });
  for (const work of blockers) await work();
  expect(written).toEqual(["www.acme.test", null]);
});

// THE CUSTOM HOSTNAMES — the effect, driven by hand with a fake control plane and Cloudflare.
test("ProjectProcessor — a hostname add claims once proven, provisions and answers keyed by its request; an unproven one is provisioned unclaimed; a refusal releases a claim it just took; a remove deletes then releases, leaving another project's custom hostname; a deployment that cannot provision refuses", async () => {
  const calls: string[] = [];
  const processor = new ProjectProcessor(
    () => {
      throw new Error("unused");
    },
    () => Promise.reject(new Error("unused")),
    () => ({
      reservedZones: ["iterate.app"],
      claim: async (name) => void calls.push(`claim ${name}`),
      release: async (name) => void calls.push(`release ${name}`),
      heldElsewhere: async (name) => name.startsWith("taken."),
      proof: async (name) => ({ ...(await proven(name)), proven: !/^(shop|done)\./.test(name) }),
      setPrimaryHostname: async () => {},
      connect: async (name) => ({ provider: "Cloudflare", url: `https://dc.test/apply/${name}` }),
      dnsZone: async () => ({ zone: "acme.test", provider: "cloudflare" }),
      provider: {
        provision: async (name) => {
          calls.push(`provision ${name}`);
          if (name.startsWith("new.")) throw new Error("Cloudflare says no");
          return observation(name.startsWith("done.") ? "active" : "pending");
        },
        remove: async (name) => void calls.push(`remove ${name}`),
      },
    }),
  );
  const appended: {
    idempotencyKey?: string;
    payload: {
      error?: string | null;
      claimed?: boolean;
      cloudflare?: { connect: unknown; records: unknown[] } | null;
    };
  }[] = [];
  const owe = async (
    name: string,
    verb: "add" | "remove",
    offset: number,
    { on = processor, held = false } = {},
  ) => {
    const cloudflare = held ? observation("active") : null;
    const hostnames = {
      [name]: {
        requested: { verb, offset },
        cloudflare,
        error: null,
        connectedAt: null,
        claimed: held,
      },
    };
    deliver(on, { ...empty, hostnames }, async (...events) => {
      appended.push(...(events as typeof appended));
    });
    await settle();
  };
  await owe("www.acme.test", "add", 4);
  await owe("new.acme.test", "add", 5);
  await owe("new.acme.test", "add", 6, { held: true }); // a failed re-check keeps a held claim
  await owe("docs.iterate.app", "add", 7);
  await owe("shop.acme.test", "add", 8); // no ownership record yet
  await owe("www.acme.test", "remove", 9);
  await owe("taken.acme.test", "remove", 10); // another project's custom hostname stays
  await owe("www.acme.test", "add", 11, { on: processorWithoutHostnames() });
  expect(calls).toEqual([
    "claim www.acme.test",
    "provision www.acme.test",
    "claim new.acme.test",
    "provision new.acme.test",
    "release new.acme.test",
    "claim new.acme.test",
    "provision new.acme.test",
    "provision shop.acme.test",
    "remove www.acme.test",
    "release www.acme.test",
    "release taken.acme.test",
  ]);
  expect(
    appended.map((event) => [
      event.idempotencyKey,
      event.payload.error || null,
      event.payload.claimed,
    ]),
  ).toEqual([
    ["project/hostname-add:www.acme.test:4", null, true],
    ["project/hostname-add:new.acme.test:5", "Cloudflare says no", false],
    ["project/hostname-add:new.acme.test:6", "Cloudflare says no", true],
    [
      "project/hostname-add:docs.iterate.app:7",
      "'docs.iterate.app' is under iterate.app, which this deployment serves itself.",
      false,
    ],
    ["project/hostname-add:shop.acme.test:8", null, false],
    ["project/hostname-remove:www.acme.test:9", null, undefined],
    ["project/hostname-remove:taken.acme.test:10", null, undefined],
    [
      "project/hostname-add:www.acme.test:11",
      "This deployment cannot add custom hostnames.",
      false,
    ],
  ]);
  // a hostname Cloudflare is done with but nobody has proven still carries where to add the record
  await owe("done.acme.test", "add", 12);
  expect(appended.at(-1)!.payload).toMatchObject({
    claimed: false,
    cloudflare: { status: "active", dns: { zone: "acme.test" } },
  });
  // the records to add end with the ownership record, which Domain Connect writes too
  expect(appended[4]!.payload.cloudflare!.records.at(-1)).toEqual({
    type: "TXT",
    name: "_iterate.shop.acme.test",
    value: "iterate-project=prj_test",
  });
  // a hostname not yet live carries the one-click link its DNS provider offers
  expect(appended[0]!.payload.cloudflare).toMatchObject({
    status: "pending",
    connect: { provider: "Cloudflare", url: "https://dc.test/apply/www.acme.test" },
    dns: { zone: "acme.test", provider: "cloudflare" },
  });
});

test("ProjectProcessor — one request per hostname at a time: a remove asked while an add runs waits for it, and the same worker runs it once the add is answered — no further delivery needed", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const held = new Promise<void>((resolve) => (finish = resolve));
  const processor = new ProjectProcessor(
    () => {
      throw new Error("unused");
    },
    () => Promise.reject(new Error("unused")),
    () => ({
      reservedZones: [],
      claim: async (name) => void calls.push(`claim ${name}`),
      release: async (name) => void calls.push(`release ${name}`),
      heldElsewhere: async () => false,
      proof: proven,
      setPrimaryHostname: async () => {},
      connect: async () => null,
      dnsZone: async () => null,
      provider: {
        provision: async () => {
          await held;
          return observation("pending");
        },
        remove: async (name) => void calls.push(`remove ${name}`),
      },
    }),
  );
  const owe = (verb: "add" | "remove", offset: number) =>
    deliver(
      processor,
      {
        ...empty,
        hostnames: {
          "www.acme.test": {
            requested: { verb, offset },
            cloudflare: null,
            error: null,
            connectedAt: null,
            claimed: false,
          },
        },
      },
      async () => [],
    );
  owe("add", 1);
  await settle();
  owe("remove", 2); // the add is still running: nothing starts
  await settle();
  expect(calls).toEqual(["claim www.acme.test"]);
  finish(); // the add is answered; the worker drains the remove it saw asked meanwhile
  await settle();
  expect(calls).toEqual(["claim www.acme.test", "remove www.acme.test", "release www.acme.test"]);
});

test("ProjectProcessor — a drained re-check knows the add it just answered provisioned: its failure keeps the claim", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const held = new Promise<void>((resolve) => (finish = resolve));
  let provisions = 0;
  const processor = new ProjectProcessor(
    () => {
      throw new Error("unused");
    },
    () => Promise.reject(new Error("unused")),
    () => ({
      reservedZones: [],
      claim: async (name) => void calls.push(`claim ${name}`),
      release: async (name) => void calls.push(`release ${name}`),
      heldElsewhere: async () => false,
      proof: proven,
      setPrimaryHostname: async () => {},
      connect: async () => null,
      dnsZone: async () => null,
      provider: {
        provision: async () => {
          provisions += 1;
          if (provisions > 1) throw new Error("Cloudflare is down");
          await held;
          return observation("pending");
        },
        remove: async () => {},
      },
    }),
  );
  const owe = (offset: number) =>
    deliver(
      processor,
      {
        ...empty,
        hostnames: {
          "www.acme.test": {
            requested: { verb: "add", offset },
            cloudflare: null,
            error: null,
            connectedAt: null,
            claimed: false,
          },
        },
      },
      async () => [],
    );
  owe(1);
  await settle();
  owe(2); // a re-check asked while the first add runs; the state has no observation yet
  finish();
  await settle();
  expect(calls).toEqual(["claim www.acme.test", "claim www.acme.test"]);
});

// THE DELETION SAGA — driven by hand like the effects above, over a fake reach (processor.ts
// `ProjectDeletion`) that records every call.
test("ProjectProcessor — the deletion: the saga destroys each context the registry names deepest first, then deletes the repo its path backs, each answered by a keyed context-deleted that nothing reads back, then the hostnames, the project's storage, the certificate, and `/` last — and no other saga runs meanwhile", async () => {
  const calls: string[] = [];
  const processor = new ProjectProcessor(
    () => {
      calls.push("getItx (another saga ran)");
      throw new Error("unused");
    },
    () => Promise.reject(new Error("unused")),
    () => ({
      reservedZones: [],
      claim: async () => {},
      release: async (name) => void calls.push(`release ${name}`),
      heldElsewhere: async () => false,
      proof: proven,
      setPrimaryHostname: async () => {},
      connect: async () => null,
      dnsZone: async () => null,
      provider: {
        provision: async () => observation("active"),
        remove: async (name) => void calls.push(`remove ${name}`),
      },
    }),
    () => ({
      destroyContext: async (path) => void calls.push(`destroy ${path}`),
      deleteRepo: async (path) => void calls.push(`delete repo ${path}`),
      deleteProjectStorage: async () => void calls.push("delete storage"),
    }),
  );
  // the registry, as the announcements reduce into it (a non-canonical path is no context)
  const announced = [
    "/repos",
    "/repos/config",
    "/agents/web/1",
    "/agents",
    "/agents/web",
    "/x/../y",
  ].map(childCreated);
  const registered = reduceProcessor(processorWithoutHostnames(), announced);
  const appended: { type: string; idempotencyKey?: string; payload: unknown }[] = [];
  const state: ProjectState = {
    ...registered,
    creation: { status: "requested", offset: 1 }, // would run the creation saga, were it not deleted
    deletion: { offset: 9 },
    hostnames: {
      "www.acme.test": {
        requested: null,
        cloudflare: observation("active"),
        error: null,
        connectedAt: null,
        claimed: true,
      },
    },
  };
  deliver(processor, state, async (...events) => {
    appended.push(...(events as typeof appended));
  });
  await settle();
  // every registered context's repo, by its path, once the context is gone; none for `/`
  expect(calls).toEqual([
    "destroy /agents/web/1",
    "delete repo /agents/web/1",
    "destroy /agents/web",
    "delete repo /agents/web",
    "destroy /repos/config",
    "delete repo /repos/config",
    "destroy /agents",
    "delete repo /agents",
    "destroy /repos",
    "delete repo /repos",
    "remove www.acme.test",
    "release www.acme.test",
    "delete storage",
    "destroy /",
  ]);
  expect(appended.map((event) => event.idempotencyKey)).toEqual([
    "project/context-deleted:/agents/web/1",
    "project/context-deleted:/agents/web",
    "project/context-deleted:/repos/config",
    "project/context-deleted:/agents",
    "project/context-deleted:/repos",
    "project/deleted",
  ]);
  // nothing the saga writes is read back: the registry still names every context, so a pass
  // after an eviction destroys them all again, and a member's forged record skips none
  const deleted = appended.filter(
    (event) => event.type === "events.iterate.com/project/context-deleted",
  );
  expect(reduceProcessor(processorWithoutHostnames(), [...announced, ...deleted])).toMatchObject({
    contexts: registered.contexts,
  });
});

test("ProjectProcessor — the deletion: a context announced while a pass runs (the creation saga's `/repos/config`) is destroyed, and its repo deleted, by the same pass, before `/`", async () => {
  const calls: string[] = [];
  const registered = reduceProcessor(processorWithoutHostnames(), ["/a", "/b"].map(childCreated));
  const state: ProjectState = { ...registered, deletion: { offset: 9 } };
  const processor = new ProjectProcessor(
    () => {
      throw new Error("unused");
    },
    () => Promise.reject(new Error("unused")),
    () => null,
    () => ({
      destroyContext: async (path) => {
        calls.push(`destroy ${path}`);
        if (path !== "/a") return;
        // its announcement is delivered while the pass is destroying `/a`
        const announced = reduceProcessor(processorWithoutHostnames(), [
          ...["/a", "/b"].map(childCreated),
          childCreated("/repos/config"),
        ]);
        processor.processEvent({
          event: childCreated("/repos/config") as never,
          state: { ...announced, deletion: { offset: 9 } },
          previousState: state,
          delivery: { caughtUp: false },
          append: (async () => []) as never,
          blockProcessorWhile: () => {},
          runInBackground: () => {},
        });
      },
      deleteRepo: async (path) => void calls.push(`delete repo ${path}`),
      deleteProjectStorage: async () => void calls.push("delete storage"),
    }),
  );
  deliver(processor, state, async () => {});
  await settle();
  expect(calls).toEqual([
    "destroy /a",
    "delete repo /a",
    "destroy /b",
    "delete repo /b",
    "destroy /repos/config",
    "delete repo /repos/config",
    "delete storage",
    "destroy /",
  ]);
});

test("ProjectProcessor — the deletion: a pass that keeps failing runs again after 5 s and 30 s, then records delete-failed, is reported, and stops in this incarnation; a later incarnation starts it again", async () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  let passes = 0;
  const appended: unknown[] = [];
  const reported: unknown[] = [];
  const incarnation = () =>
    new ProjectProcessor(
      () => {
        throw new Error("unused");
      },
      () => Promise.reject(new Error("unused")),
      () => null,
      () => ({
        destroyContext: async () => {
          passes += 1;
          throw new Error("Cloudflare said no");
        },
        deleteRepo: async () => {},
        deleteProjectStorage: async () => {},
      }),
    );
  const state: ProjectState = {
    ...reduceProcessor(processorWithoutHostnames(), [childCreated("/a")]),
    deletion: { offset: 9 },
  };
  const run = (processor: ProjectProcessor) =>
    deliver(
      processor,
      state,
      async (...events) => void appended.push(...events),
      (work) => void work().catch((error: unknown) => void reported.push(error)),
    );
  const first = incarnation();
  run(first);
  await vi.advanceTimersByTimeAsync(0);
  expect(passes).toBe(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(passes).toBe(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(passes).toBe(3);
  expect(appended).toMatchObject([
    {
      type: "events.iterate.com/project/delete-failed",
      payload: { error: "Cloudflare said no" },
    },
  ]);
  expect(reported).toMatchObject([{ message: "Cloudflare said no" }]);
  // its own delete-failed, delivered to it, does not start it again: no retry storm
  run(first);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(passes).toBe(3);
  // a later incarnation does
  run(incarnation());
  await vi.advanceTimersByTimeAsync(0);
  expect(passes).toBe(4);
});

test("template provenance survives replay of the project creation request", () => {
  const configRepoTemplate = "github:example/config#" + "a".repeat(40) + "&path:starter";
  expect(
    reduceProcessor(processorWithoutHostnames(), [
      { ...requested, payload: { ...requested.payload, configRepoTemplate } },
    ]),
  ).toMatchObject({ creation: { status: "requested", offset: 1, configRepoTemplate } });
});

// The table's event builders are function declarations: the rows above are built when the module
// loads, before these lines run.

/** The reduce never reaches the context or a template; the saga is the e2e's. */
function processorWithoutHostnames() {
  return new ProjectProcessor(
    () => {
      throw new Error("the reduce reaches no itx");
    },
    () => Promise.reject(new Error("the reduce downloads no template")),
  );
}

function repoBorn(path: string) {
  return { type: "events.iterate.com/repo/created", payload: { path } };
}

function workspaceBorn(path: string) {
  return { type: "events.iterate.com/workspace/created", payload: { path } };
}

function committed(path: string, commitOid: string) {
  return {
    type: "events.iterate.com/repo/commit-completed",
    payload: { path, commitOid, message: "m", changedPaths: ["worker.ts"] },
  };
}

function secretSet(path: string, urls: string[], refresh?: string) {
  return { type: "events.iterate.com/secret/set", payload: { path, urls, refresh } };
}

function secretDeleted(path: string) {
  return { type: "events.iterate.com/secret/deleted", payload: { path } };
}

function tip(commitOid: string, offset: number) {
  return { commitOid, offset };
}

/** The state after these commit facts landed on `/` and before any outcome: each owed, the last
 *  the tip. */
function owing(...commits: ReturnType<typeof tip>[]): ProjectState {
  return { ...empty, configRepoTip: commits.at(-1)!, unpublishedCommits: commits };
}

/** A config commit as the fake probe answers it, by default the default template's shape. */
type FakeCommit = {
  configEntrypoint?: boolean;
  classes?: Record<string, string[]>;
  /** A module of the default template's the commit deletes. */
  without?: string;
};

/** A fake of publication.ts `ProjectPublisher`: files whose text names their commit, reads that fail
 *  as often as asked, and a platform append recording each batch and the cause it ran under. */
function fakePublisher(commits: Record<string, FakeCommit>) {
  let readFailures = 0;
  let readFailure: () => Error = () => new Error("no failure asked for");
  const publisher = {
    batches: [] as StreamEventInput[][],
    causes: [] as unknown[],
    main: null as string | null,
    /** What the next append waits on: held open until it settles, refused if it rejects. */
    nextAppend: undefined as (() => Promise<void>) | undefined,
    failReadsTimes: (times: number, failure: () => Error) => {
      readFailures = times;
      readFailure = failure;
    },
    head: async () => publisher.main,
    files: async (commitOid: string) => {
      if (readFailures > 0) {
        readFailures -= 1;
        throw readFailure();
      }
      const files: Record<string, string> = {
        "package.json": '{"main":"worker.ts"}',
        "worker.ts": `// ${commitOid}`,
        "agents.ts": `// ${commitOid}`,
        "AGENTS.md": "not a module",
        "lib/helper.ts": "not top-level",
      };
      delete files[commits[commitOid]?.without ?? ""];
      return files;
    },
    identityOf: async (files: Record<string, string>, module: string) =>
      `${files["worker.ts"]!.slice(3)}:${module}`,
    probe: async (files: Record<string, string>) => {
      const commit = commits[files["worker.ts"]!.slice(3)]!;
      return {
        configEntrypoint: commit.configEntrypoint ?? true,
        constructError: null,
        classes: commit.classes || defaultClasses(),
      };
    },
    appendAsPlatform: async (...events: StreamEventInput[]) => {
      publisher.causes.push(runningCause());
      const next = publisher.nextAppend;
      publisher.nextAppend = undefined;
      await next?.();
      publisher.batches.push(events);
      return [];
    },
  };
  return publisher;
}

/** The Durable Object classes the default template's modules export (configs/default). */
function defaultClasses() {
  return { "agents.ts": ["AgentCollectionDurableObject", "AgentDurableObject"], "worker.ts": [] };
}

/** The manifest's modules the fake publisher answers for a commit of the default shape. */
function modulesOf(commitOid: string) {
  return {
    "agents.ts": { identity: `${commitOid}:agents.ts`, classes: defaultClasses()["agents.ts"] },
    "worker.ts": { identity: `${commitOid}:worker.ts`, classes: defaultClasses()["worker.ts"] },
  };
}

function processorPublishingWith(publisher: ReturnType<typeof fakePublisher>) {
  return new ProjectProcessor(
    () => {
      throw new Error("the publication reaches no itx");
    },
    () => Promise.reject(new Error("the publication downloads no template")),
    () => null,
    () => null,
    () => publisher,
  );
}

/** The engine's append: a publication appends as the platform instead. */
const unusedAppend = () => Promise.reject(new Error("the publication appends as the platform"));

/** A batch, one line per event: the pointer's commit and generation, or the fact's. */
const summary = (batch: StreamEventInput[]) =>
  batch.flatMap((event) => {
    const payload = event.payload as {
      match?: string;
      target?: [
        string,
        string,
        string,
        [string, { cacheKey: string; manifest: { generation: number } }],
      ];
      commitOid?: string;
      generation?: number;
    };
    // the pointer's own producer rule rides its batch, pinned once in the publication row
    if (payload.match === "itx.config.modules") return [];
    if (payload.match)
      return `${payload.match} ⇒ ${payload.target![3][1].cacheKey}@${payload.target![3][1].manifest.generation}`;
    return `${event.type.replace("events.iterate.com/", "")} ${payload.commitOid}@${payload.generation}`;
  });

function workerUpdated(commitOid: string, generation: number) {
  return {
    type: "events.iterate.com/project/worker-updated",
    payload: { commitOid, generation, modules: modulesOf(commitOid) },
  };
}

function workerUpdateFailed(commitOid: string, generation: number) {
  return {
    type: "events.iterate.com/project/worker-update-failed",
    payload: { commitOid, generation, error: "boom" },
  };
}

function hostname(verb: "add-requested" | "remove-requested") {
  return {
    type: `events.iterate.com/project/hostname-${verb}`,
    payload: { hostname: "www.acme.test" },
  };
}

/** An add's answer: `claimed` whether the project holds the claim after it (by default, when it
 *  reached Cloudflare); `undefined` spells an answer from before the ownership proof. */
function addSettled(
  requestOffset: number,
  status: string | null,
  error: string | null = null,
  claimed: boolean | undefined = Boolean(status),
) {
  return {
    type: "events.iterate.com/project/hostname-add-settled",
    payload: {
      hostname: "www.acme.test",
      requestOffset,
      cloudflare: status && observation(status),
      error,
      claimed,
    },
  };
}

/** A fake `ProjectHostnames.proof`: the ownership record for project `prj_test`, found in DNS. */
async function proven(hostname: string) {
  return { record: ownershipRecordOf(hostname, "prj_test"), proven: true };
}

function primary(hostname: string | null) {
  return { type: "events.iterate.com/project/primary-hostname-configured", payload: { hostname } };
}

function liveHostname() {
  return {
    requested: null,
    cloudflare: observation("active"),
    error: null,
    connectedAt: null,
    claimed: true,
  };
}

function removed(requestOffset: number) {
  return {
    type: "events.iterate.com/project/hostname-removed",
    payload: { hostname: "www.acme.test", requestOffset },
  };
}

function integrationRow(provider: "slack" | "google" | "github", connection: string) {
  return {
    provider,
    connection,
    client: "iterate" as const,
    account: `Acme ${provider}`,
    externalId: "X1",
  };
}

/** A connection's fact on `/`, stamped `source.platform` as src/integrations/ stamps it. */
function integrationFact(
  provider: "slack" | "google" | "github",
  fact: "connected" | "disconnected",
  connection: string,
) {
  const { provider: _provider, ...connected } = integrationRow(provider, connection);
  return {
    type: `events.iterate.com/${provider}/${fact}`,
    payload: fact === "connected" ? connected : { connection },
    source: { platform: true as const },
  };
}

function observation(status: string) {
  return {
    status,
    sslStatus: status,
    records: [{ type: "CNAME" as const, name: "www.acme.test", value: "cname.iterate.app" }],
    connect: null,
    dns: null,
  };
}

/** A context announcing itself to `/` (iterate-context-durable-object.ts `announceToAncestors`). */
function childCreated(childPath: string) {
  return { type: "events.iterate.com/itx/child-created", payload: { childPath } };
}

function deleteRequested(source?: { platform: true }) {
  return { type: "events.iterate.com/project/delete-requested", payload: {}, source };
}

/** Two turns: a background effect's awaits, then its append. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((r) => setTimeout(r, 0));
};

const deliver = (
  processor: ProjectProcessor,
  state: ProjectState,
  append: (...events: unknown[]) => Promise<unknown>,
  runInBackground: (work: () => Promise<unknown>) => void = (work) => void work(),
) =>
  processor.processEvent({
    event: null,
    state,
    previousState: state,
    delivery: { caughtUp: true },
    append: append as never,
    blockProcessorWhile: () => {},
    runInBackground,
  });

function borrowed(path: string, lendId: string) {
  return {
    type: "events.iterate.com/secret/borrowed",
    payload: {
      path,
      lendId,
      lender: { userId: "user_ada", email: "ada@example.com" },
      urls: ["https://google.test"],
      integration: { provider: "google", account: "ada@example.com", externalId: "42" },
    },
  };
}

function lendRevoked(path: string, lendId: string) {
  return {
    type: "events.iterate.com/secret/lend-revoked",
    payload: { path, lendId, reason: "lender" },
  };
}
