// src/project/processor.test.ts — the ProjectProcessor's executable spec: the reduce as declarative
// `{ events → state }` rows (stream/test-support.ts `reduceProcessor`) — the project's own creation
// and the catalog folded from cross-posted birth certificates. The saga — `session.projects.create`
// landing the request, the processor landing the certificate on `/` — is pinned end to end in
// e2e/session.e2e.test.ts.

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { ProjectProcessor } from "./processor.ts";
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

/** The empty state; a row spreads it and names only what its events changed. */
const empty: ProjectState = {
  creation: null,
  repos: {},
  workspaces: {},
  agents: {},
  mcpClients: {},
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
        mcpClients: {},
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
          type: "events.iterate.com/project/mcp-client-connected",
          payload: { grantId: "grant_a", path: "/mcp/inbound/grant_a" },
        },
        {
          type: "events.iterate.com/project/mcp-client-connected",
          payload: { grantId: "grant_a", path: "/mcp/inbound/grant_a" },
        },
        {
          type: "events.iterate.com/project/mcp-client-connected",
          payload: { grantId: "admin", path: "/mcp/inbound/admin" },
        },
      ],
      state: {
        ...empty,
        mcpClients: {
          grant_a: { path: "/mcp/inbound/grant_a", createdAt: expect.any(String) },
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
    test(name, () => expect(reduceProcessor(new ProjectProcessor(), events)).toEqual(state));
});
