// src/project/processor.test.ts — the ProjectProcessor's executable spec: the reduce as declarative
// `{ events → state }` rows (stream/test-support.ts `reduceProcessor`) — the project's own creation
// and the catalog folded from cross-posted birth certificates. The saga — `session.projects.create`
// landing the request, the processor landing the certificate on `/` — is pinned end to end in
// e2e/session.e2e.test.ts.

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { ProjectProcessor } from "./processor.ts";

/** The reduce never reaches the context; the saga is the e2e's. */
const processor = () =>
  new ProjectProcessor(() => Promise.reject(new Error("the reduce reaches no itx")));
import type { ProjectState } from "./contract.ts";

const requested = {
  type: "events.iterate.com/project/create-requested",
  payload: { slug: "acme", orgId: "org_1" },
};
const created = { type: "events.iterate.com/project/created", payload: {} };
const failed = { type: "events.iterate.com/project/create-failed", payload: { error: "boom" } };
const repoBorn = (path: string) => ({ type: "events.iterate.com/repo/created", payload: { path } });
const workspaceBorn = (path: string) => ({
  type: "events.iterate.com/workspace/created",
  payload: { path },
});
const agentBorn = (path: string) => ({
  type: "events.iterate.com/agent/created",
  payload: { path },
});
const committed = (path: string, commitOid: string) => ({
  type: "events.iterate.com/repo/commit-completed",
  payload: { path, commitOid, message: "m", changedPaths: ["worker.ts"] },
});
const secretSet = (path: string, urls: string[], refresh?: string) => ({
  type: "events.iterate.com/secret/set",
  payload: { path, urls, refresh },
});
const secretDeleted = (path: string) => ({
  type: "events.iterate.com/secret/deleted",
  payload: { path },
});

/** The empty state; a row spreads it and names only what its events changed. */
const empty: ProjectState = {
  creation: null,
  repos: {},
  workspaces: {},
  agents: {},
  mcpConnections: {},
  secrets: {},
  configRepoTip: null,
};

describe("ProjectProcessor — the reduce", () => {
  const rows: {
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
      name: "a repo's, a workspace's and an agent's certificates each add one entry, by path, stamped with the event's time — the project's own creation untouched",
      events: [
        requested,
        created,
        repoBorn("/repos/config"),
        workspaceBorn("/workspaces/notes"),
        agentBorn("/agents/support"),
      ],
      state: {
        creation: { status: "created", offset: 2 },
        repos: { "/repos/config": { createdAt: expect.any(String) } },
        workspaces: { "/workspaces/notes": { createdAt: expect.any(String) } },
        agents: { "/agents/support": { createdAt: expect.any(String) } },
        mcpConnections: {},
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
        agentBorn("/agents/support"),
        agentBorn("/agents/support"),
      ],
      state: {
        ...empty,
        repos: {
          "/repos/config": { createdAt: expect.any(String) },
          "/vendor/lib": { createdAt: expect.any(String) },
        },
        agents: { "/agents/support": { createdAt: expect.any(String) } },
      },
    },
    {
      name: "an MCP client connects once per grant — the connection's path and first time; a second connect is ignored",
      events: [
        {
          type: "events.iterate.com/project/mcp-connection-created",
          payload: { grantId: "grant_a", path: "/mcp/inbound/grants/grant_a" },
        },
        {
          type: "events.iterate.com/project/mcp-connection-created",
          payload: { grantId: "grant_a", path: "/mcp/inbound/grants/grant_a" },
        },
        {
          type: "events.iterate.com/project/mcp-connection-created",
          payload: { grantId: "admin", path: "/mcp/inbound/admin" },
        },
        // the connection's context moved: the row follows the path, its birth stays the first one
        {
          type: "events.iterate.com/project/mcp-connection-created",
          payload: { grantId: "grant_a", path: "/mcp/inbound/grants/moved/grant_a" },
        },
      ],
      state: {
        ...empty,
        mcpConnections: {
          grant_a: { path: "/mcp/inbound/grants/moved/grant_a", createdAt: expect.any(String) },
          admin: { path: "/mcp/inbound/admin", createdAt: expect.any(String) },
        },
      },
    },
    {
      name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
      events: [
        { type: "events.iterate.com/repo/created", payload: { path: 1 } },
        { type: "events.iterate.com/agent/created", payload: {} },
        { type: "events.iterate.com/project/create-requested", payload: { slug: "" } },
        workspaceBorn("/w"),
      ],
      state: { ...empty, workspaces: { "/w": { createdAt: expect.any(String) } } },
    },
  ];
  for (const { name, events, state } of rows)
    test(name, () => expect(reduceProcessor(processor(), events)).toEqual(state));
});

// THE APEX FOLLOWS THE CONFIG REPO — the effect, driven by hand: `processEvent` with the kernel's
// arguments faked (an `append` that records and can be held open; `runInBackground` runs the work at
// once). Pinned: a tip that lands WHILE an append is in flight is published by the same attempt once
// the append settles — no further delivery needed (an idempotent hit lands no fresh event to deliver).
describe("ProjectProcessor — the apex follows the config repo", () => {
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
      appendTo: (async () => []) as never,
      blockProcessorWhile: () => {},
      runInBackground: (work) => void work(),
    });

  test("each tip is published once, keyed by its commit; a tip that lands during an in-flight append is published when it settles", async () => {
    const processor = new ProjectProcessor(() => Promise.reject(new Error("unused")));
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
});
