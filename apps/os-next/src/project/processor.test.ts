// src/project/processor.test.ts — the ProjectProcessor's executable spec, declarative `{ events →
// view }` rows on the shared processor harness (stream/test-support.ts `reduceProcessor`).

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { ProjectProcessor } from "./processor.ts";
import { type ProjectView } from "./contract.ts";

const repoBorn = (path: string) => ({
  type: "events.iterate.com/repos/created",
  payload: { path },
});
const workspaceBorn = (path: string) => ({
  type: "events.iterate.com/workspace/created",
  payload: { path },
});
const agentBorn = (path: string) => ({
  type: "events.iterate.com/agent/created",
  payload: { path },
});

describe("ProjectProcessor — the catalog folded from cross-posted birth certificates", () => {
  const rows: { name: string; events: { type: string; payload?: unknown }[]; view: ProjectView }[] =
    [
      {
        name: "the empty catalog",
        events: [],
        view: { repos: {}, workspaces: {}, agents: {}, mcpConnections: {} },
      },
      {
        name: "a repo's, a workspace's and an agent's certificates each add one entry, by path, stamped with the event's time",
        events: [
          repoBorn("/repos/config"),
          workspaceBorn("/workspaces/notes"),
          agentBorn("/agents/support"),
        ],
        view: {
          repos: { "/repos/config": { createdAt: expect.any(String) } },
          workspaces: { "/workspaces/notes": { createdAt: expect.any(String) } },
          agents: { "/agents/support": { createdAt: expect.any(String) } },
          mcpConnections: {},
        },
      },
      {
        name: "a second certificate for the same path is ignored (born once); an unrelated event leaves the view as it was; any path can host a repo",
        events: [
          repoBorn("/repos/config"),
          repoBorn("/repos/config"),
          { type: "note" },
          repoBorn("/vendor/lib"),
          agentBorn("/agents/support"),
          agentBorn("/agents/support"),
        ],
        view: {
          repos: {
            "/repos/config": { createdAt: expect.any(String) },
            "/vendor/lib": { createdAt: expect.any(String) },
          },
          workspaces: {},
          agents: { "/agents/support": { createdAt: expect.any(String) } },
          mcpConnections: {},
        },
      },
      {
        name: "an MCP connection is born once per grant — its context path and birth time; a second certificate is ignored",
        events: [
          {
            type: "events.iterate.com/project/mcp-connection-created",
            payload: { grantId: "grant_a", path: "/mcp/inbound/grant_a" },
          },
          {
            type: "events.iterate.com/project/mcp-connection-created",
            payload: { grantId: "grant_a", path: "/mcp/inbound/grant_a" },
          },
          {
            type: "events.iterate.com/project/mcp-connection-created",
            payload: { grantId: "admin", path: "/mcp/inbound/admin" },
          },
        ],
        view: {
          repos: {},
          workspaces: {},
          agents: {},
          mcpConnections: {
            grant_a: { path: "/mcp/inbound/grant_a", createdAt: expect.any(String) },
            admin: { path: "/mcp/inbound/admin", createdAt: expect.any(String) },
          },
        },
      },
      {
        name: "a malformed certificate is skipped by the contract, never reduced",
        events: [
          { type: "events.iterate.com/repos/created", payload: { path: 1 } },
          { type: "events.iterate.com/agent/created", payload: {} },
          workspaceBorn("/w"),
        ],
        view: {
          repos: {},
          workspaces: { "/w": { createdAt: expect.any(String) } },
          agents: {},
          mcpConnections: {},
        },
      },
    ];
  for (const { name, events, view } of rows)
    test(name, () => expect(reduceProcessor(new ProjectProcessor(), events)).toEqual(view));
});
