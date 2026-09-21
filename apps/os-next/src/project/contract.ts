// src/project/contract.ts — the project's catalog (the triplet's first: processor.ts is the pure
// reduce, durable-object.ts the loadable host). The context at `/` hosts the `project` facet; every
// repo, workspace and agent born under the project cross-posts its birth certificate to `/`, and
// this contract folds those into the catalog `itx.repos.list()`, `itx.workspaces.list()` and
// `itx.agents.list()` read. It OWNS no event — the certificates are the repo's, the workspace's and
// the agent's, consumed through `processorDeps`.
import { z } from "zod";
import { defineProcessorContract } from "iterate/next/stream/processor";
import { RepoContract } from "../repo/contract.ts";
import { WorkspaceContract } from "../workspace/contract.ts";
import { AgentContract } from "../agent/contract.ts";

export const ProjectView = z.object({
  /** Every repo born under the project, by its context path. */
  repos: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
  /** Every workspace born under the project, by path. */
  workspaces: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
  /** Every agent born under the project, by path — announced by its own (userspace) processor. */
  agents: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
  /** Every MCP client that connected to the project, by its grant (the connection — mcp.ts): the
   *  context path its scripts run on and are logged at, and when it first connected. */
  mcpClients: z
    .record(z.string(), z.object({ path: z.string(), createdAt: z.string() }))
    .default({}),
});
/** The project's reduced state: the catalog of what exists under it. */
export type ProjectView = z.infer<typeof ProjectView>;

export const ProjectContract = defineProcessorContract({
  slug: "project",
  // 2: the catalog grew `agents`; 3: `mcpClients`. A checkpoint reduced under an older version
  // has no such slot and is reused as-is by the engine, so the bump is what re-reduces every
  // existing catalog from its log.
  version: "3",
  description:
    "The project's catalog: every repo, workspace and agent born under it, from the birth certificates cross-posted to /, and every MCP client that connected.",
  stateSchema: ProjectView,
  events: {
    /** The one fact the catalog owns itself: an MCP client's first use of the project (mcp.ts
     *  appends it to `/`, idempotent on the grant), naming the connection's context. */
    "events.iterate.com/project/mcp-client-connected": {
      description:
        "An MCP client connected to this project through an OAuth grant; its scripts run on, and are logged at, `path`.",
      payloadSchema: z.object({ grantId: z.string().min(1), path: z.string().min(1) }),
    },
  },
  processorDeps: [RepoContract, WorkspaceContract, AgentContract],
  consumes: [
    "events.iterate.com/repos/created",
    "events.iterate.com/workspace/created",
    "events.iterate.com/agent/created",
    "events.iterate.com/project/mcp-client-connected",
  ],
  emits: [],
});
