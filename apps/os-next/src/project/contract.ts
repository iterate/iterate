// src/project/contract.ts — the project's catalog (the triplet's first: processor.ts is the pure
// reduce, durable-object.ts the loadable host). The context at `/` hosts the `project` facet; every
// repo, workspace and agent born under the project cross-posts its birth certificate to `/`, and
// this contract folds those into the catalog `itx.repos.list()`, `itx.workspaces.list()` and
// `itx.agents.list()` read. It OWNS no event — the certificates are the repo's, the workspace's and
// the agent's, consumed through `processorDeps`.
import { z } from "zod";
import { defineProcessorContract } from "../stream/processor.ts";
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
});
/** The project's reduced state: the catalog of what exists under it. */
export type ProjectView = z.infer<typeof ProjectView>;

export const ProjectContract = defineProcessorContract({
  slug: "project",
  version: "1",
  description:
    "The project's catalog: every repo, workspace and agent born under it, from the birth certificates cross-posted to /.",
  stateSchema: ProjectView,
  // No events of its own — spelled `{}` (not omitted): the omitted default types as "every key",
  // which would shadow the deps' catalogs and untype the reduce's events.
  events: {},
  processorDeps: [RepoContract, WorkspaceContract, AgentContract],
  consumes: [
    "events.iterate.com/repos/created",
    "events.iterate.com/workspace/created",
    "events.iterate.com/agent/created",
  ],
  emits: [],
});
