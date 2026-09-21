// src/project/contract.ts — A PROJECT: the context at `/`. Its facts live on that root log, and THIS
// FILE is the only place they are spelled. The `project` facet hosted there is the catalog host — the
// collections hang off it (`itx.repos`, `itx.workspaces`, `itx.agents`: src/<entity>/collection.ts,
// fields of src/project/durable-object.ts) — and the project is itself a domain object with a
// creation saga: `session.projects.create` (session.ts) says the directory row, enables the `project`
// row on `/` and appends `project/create-requested`; processor.ts runs the saga from state at head
// and lands `project/created` or `project/create-failed`; the dash renders the state live. The rest
// of the folder derives from here: processor.ts reduces these events, durable-object.ts hosts the
// processor and the collections. Every type is derived here, never hand-kept:
//   ProjectState                        = ProcessorState<typeof ProjectContract>  the reduced state below
//   ConsumedEvent<typeof ProjectContract>                                          what reduce and processEvent see
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/next/stream/processor";
import { RepoContract } from "../repo/contract.ts";
import { WorkspaceContract } from "../workspace/contract.ts";
import { AgentContract } from "../agent/contract.ts";

export const ProjectContract = defineProcessorContract({
  slug: "project",
  // 2: the catalog grew `agents`; 3: `mcpConnections`; 4: the state grew `creation`, and the certificates
  // it folds were renamed (`repo/created`, `agent/created`). A checkpoint reduced under an older
  // version is reused as-is by the engine, so the bump is what re-reduces every existing root log.
  version: "4",
  description:
    "The project: where its own creation stands, and the catalog of every repo, workspace and agent born under it (from the birth and death certificates cross-posted to /) and every MCP connection born under it.",
  /** THE REDUCED STATE — what the reduce keeps between events: where the project's OWN creation
   *  stands, as the OFFSET of the event that says so (the request, the certificate, or the failure —
   *  read that event for the error), and the CATALOG of what exists under it — read by each
   *  collection's `list()` and rendered by the dash from `liveSnapshot()`. */
  stateSchema: z.object({
    creation: z
      .object({
        status: z.enum(["requested", "created", "failed"]),
        offset: z.number().int().positive(),
      })
      .nullable()
      .default(null),
    /** Every repo born under the project, by its context path. */
    repos: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
    /** Every workspace born under the project, by path. */
    workspaces: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
    /** Every agent born under the project, by path — announced by its own (userspace) processor. */
    agents: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
    /** Every MCP connection born under the project, by its grant (the connection — mcp.ts): the
     *  context its scripts run on and are logged at (`/mcp/inbound/<grantId>`), and when it was born. */
    mcpConnections: z
      .record(z.string(), z.object({ path: z.string(), createdAt: z.string() }))
      .default({}),
  }),
  events: {
    "events.iterate.com/project/create-requested": {
      description:
        "Someone asked for this project (`session.projects.create`). The payload is the directory row's facts — the slug and the organization — so the log is self-describing. The processor lands created or create-failed; a request after the certificate is a harmless fact.",
      payloadSchema: z.object({ slug: z.string().min(1), orgId: z.string().min(1) }),
    },
    "events.iterate.com/project/created": {
      description:
        "The birth certificate: existence only, on `/` — the context it lands on IS the project.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/project/create-failed": {
      description: "What provisioning reported. Terminal until a new request.",
      payloadSchema: z.object({ error: z.string() }),
    },
    /** The one certificate the catalog owns beside its own: the birth of an MCP connection's context
     *  under the project — the grant's first run here (mcp.ts appends it to `/`, idempotent on the
     *  grant), the context that cannot cross-post its own birth. */
    "events.iterate.com/project/mcp-connection-created": {
      description:
        "An MCP connection's context was born under this project — the grant's first run here; its scripts run on, and are logged at, `path`.",
      payloadSchema: z.object({ grantId: z.string().min(1), path: z.string().min(1) }),
    },
  },
  // THE RELATIONSHIP: the project consumes the entities' certificates without owning them.
  processorDeps: [RepoContract, WorkspaceContract, AgentContract],
  consumes: [
    "events.iterate.com/project/create-requested",
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-failed",
    "events.iterate.com/project/mcp-connection-created",
    "events.iterate.com/repo/created",
    "events.iterate.com/workspace/created",
    "events.iterate.com/agent/created",
    "events.iterate.com/repo/deleted",
    "events.iterate.com/workspace/deleted",
    "events.iterate.com/agent/deleted",
  ],
  emits: [
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-failed",
    // the core's: the saga points the project's apex at the seeded config repo's commit
    "events.iterate.com/project/ingress-configured",
  ],
});

/** The project's reduced state: where its creation stands, and the catalog (the contract's
 *  `stateSchema`). */
export type ProjectState = ProcessorState<typeof ProjectContract>;
