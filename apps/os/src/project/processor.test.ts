// src/project/processor.test.ts — the ProjectProcessor's executable spec: the reduce as declarative
// `{ events → state }` rows (iterate/stream/test-support `reduceProcessor`) — the project's own creation
// and the catalog folded from cross-posted birth certificates. The saga — `session.projects.create`
// landing the request, the processor landing the certificate on `/` — is pinned end to end in
// e2e/session.e2e.test.ts.

import { expect, test } from "vitest";
import { reduceProcessor } from "iterate/stream/test-support";
import { ProjectProcessor } from "./processor.ts";
import type { ProjectState } from "./contract.ts";

const requested = {
  type: "events.iterate.com/project/create-requested",
  payload: { slug: "acme", orgId: "org_1" },
};
const created = { type: "events.iterate.com/project/created", payload: {} };
const failed = { type: "events.iterate.com/project/create-failed", payload: { error: "boom" } };

/** The empty state; a row spreads it and names only what its events changed. */
const empty: ProjectState = {
  creation: null,
  repos: {},
  workspaces: {},
  secrets: {},
  configRepoTip: null,
};

const reduceRows: {
  name: string;
  events: { type: string; payload?: unknown }[];
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
    name: "the config repo's commits move the tip the apex follows — the latest one, by its oid and the fact's offset; another repo's commit is ignored",
    events: [
      committed("/repos/config", "aaa"),
      committed("/repos/other", "bbb"),
      committed("/repos/config", "ccc"),
    ],
    state: { ...empty, configRepoTip: { commitOid: "ccc", offset: 3 } },
  },
  {
    name: "a repo's and a workspace's certificates each add one entry, by path, stamped with the event's time — the project's own creation untouched",
    events: [requested, created, repoBorn("/repos/config"), workspaceBorn("/workspaces/notes")],
    state: {
      creation: { status: "created", offset: 2 },
      repos: { "/repos/config": { createdAt: expect.any(String) } },
      workspaces: { "/workspaces/notes": { createdAt: expect.any(String) } },
      secrets: {},
      configRepoTip: null,
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
    name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
    events: [
      { type: "events.iterate.com/repo/created", payload: { path: 1 } },
      { type: "events.iterate.com/project/create-requested", payload: { slug: "" } },
      workspaceBorn("/w"),
    ],
    state: { ...empty, workspaces: { "/w": { createdAt: expect.any(String) } } },
  },
];
for (const { name, events, state } of reduceRows)
  test(`ProjectProcessor — the reduce: ${name}`, () =>
    expect(reduceProcessor(processor(), events)).toEqual(state));

// THE APEX FOLLOWS THE CONFIG REPO — the effect, driven by hand: `processEvent` with the kernel's
// arguments faked (an `append` that records and can be held open; `runInBackground` runs the work at
// once). Pinned: a tip that lands WHILE an append is in flight is published by the same attempt once
// the append settles — no further delivery needed (an idempotent hit lands no fresh event to deliver).
test("ProjectProcessor — the apex follows the config repo: each tip is published once, keyed by its commit; a tip that lands during an in-flight append is published when it settles", async () => {
  const processor = new ProjectProcessor(
    () => Promise.reject(new Error("unused")),
    () => Promise.reject(new Error("unused")),
  );
  const appended: { idempotencyKey?: string; payload?: { target?: unknown } }[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const append = async (...events: unknown[]) => {
    calls += 1;
    if (calls === 1) await held; // the first append stays in flight
    appended.push(...(events as typeof appended));
    return [];
  };
  deliver(processor, { ...empty, configRepoTip: tip("aaa", 5) }, append);
  // A second commit lands while the first publication is in flight: dropped by the guard, kept as the newest tip.
  deliver(processor, { ...empty, configRepoTip: tip("bbb", 7) }, append);
  expect(appended).toEqual([]);
  release();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  expect(appended.map((e) => e.idempotencyKey)).toEqual([
    "project/ingress-configured:aaa",
    "project/ingress-configured:bbb",
  ]);
  // The target names the commit twice: the source read at it, the cache keyed by it.
  expect(JSON.stringify(appended[1]!.payload!.target)).toContain('"commitOid":"bbb"');
  expect(JSON.stringify(appended[1]!.payload!.target)).toContain('"cacheKey":"bbb"');
  // Delivered again over the same tip: nothing more.
  deliver(processor, { ...empty, configRepoTip: tip("bbb", 7) }, append);
  await new Promise((r) => setTimeout(r, 0));
  expect(appended).toHaveLength(2);
});

test("template provenance survives replay of the project creation request", () => {
  const configRepoTemplate = "github:example/config#" + "a".repeat(40) + "&path:starter";
  expect(
    reduceProcessor(processor(), [
      { ...requested, payload: { ...requested.payload, configRepoTemplate } },
    ]),
  ).toMatchObject({ creation: { status: "requested", offset: 1, configRepoTemplate } });
});

// The table's event builders are function declarations: the rows above are built when the module
// loads, before these lines run.

/** The reduce never reaches the context or a template; the saga is the e2e's. */
function processor() {
  return new ProjectProcessor(
    () => Promise.reject(new Error("the reduce reaches no itx")),
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

const tip = (commitOid: string, offset: number) => ({ commitOid, offset });

const deliver = (
  processor: ProjectProcessor,
  state: ProjectState,
  append: (...events: unknown[]) => Promise<unknown>,
) =>
  processor.processEvent({
    event: null,
    state,
    previousState: state,
    delivery: { caughtUp: true },
    append: append as never,
    blockProcessorWhile: () => {},
    runInBackground: (work) => void work(),
  });
