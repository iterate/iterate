// src/project/contract.ts — A PROJECT: the context at `/`. Its facts live on that root log, and THIS
// FILE is the only place they are spelled. The `project` facet hosted there is the catalog host — the
// collections hang off it (`itx.repos`, `itx.workspaces`: collection.ts, one per
// entity on src/project/durable-object.ts) — and the project is itself a domain object with a
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
import { SecretCatalog, SecretContract } from "../secret/contract.ts";

export const ProjectContract = defineProcessorContract({
  slug: "project",
  // 2: the catalog grew `agents`; 3: `mcpConnections`; 4: the state grew `creation`, and the certificates
  // it folds were renamed (`repo/created`, `agent/created`); 5: the catalog grew `secrets`; 6: the state
  // grew `configRepoTip` — the apex follows the config repo's commits. A checkpoint reduced under an
  // older version is reused as-is by the engine, so the bump is what re-reduces every existing root log.
  // 7: removed the MCP connection catalog; MCP runs directly on the project root.
  version: "8",
  description:
    "The project: where its own creation stands, and the catalog of every repo, workspace and secret born under it (from the certificates cross-posted to /).",
  /** THE REDUCED STATE — what the reduce keeps between events: where the project's OWN creation
   *  stands, as the OFFSET of the event that says so (the request, the certificate, or the failure —
   *  read that event for the error), and the CATALOG of what exists under it — read by each
   *  collection's `list()` and rendered by the dash from `liveSnapshot()`. */
  stateSchema: z.object({
    creation: z
      .object({
        status: z.enum(["requested", "created", "failed"]),
        offset: z.number().int().positive(),
        configRepoTemplate: z.string().optional(),
      })
      .nullable()
      .default(null),
    /** Every repo born under the project, by its context path. */
    repos: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
    /** Every workspace born under the project, by path. */
    workspaces: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
    /** The project secret catalog. */
    secrets: SecretCatalog.default({}),
    /** The config repo's tip as its commits reach `/`: the latest `repo/commit-completed` from
     *  `/repos/config` — the commit the apex follows — by its oid (what the ingress target names) and
     *  the OFFSET of the fact (the publication the processor owes for it). Null until the seed. */
    configRepoTip: z
      .object({ commitOid: z.string().min(1), offset: z.number().int().positive() })
      .nullable()
      .default(null),
  }),
  events: {
    "events.iterate.com/project/create-requested": {
      description:
        "Someone asked for this project (`session.projects.create`). The payload is the directory row's facts — the slug and the organization — so the log is self-describing. The processor lands created or create-failed; a request after the certificate is a harmless fact.",
      payloadSchema: z.object({
        slug: z.string().min(1),
        orgId: z.string().min(1),
        configRepoTemplate: z.string().optional(),
      }),
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
  },
  // THE RELATIONSHIP: the project consumes the entities' certificates without owning them.
  processorDeps: [RepoContract, WorkspaceContract, SecretContract],
  consumes: [
    "events.iterate.com/project/create-requested",
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-failed",
    "events.iterate.com/repo/created",
    "events.iterate.com/workspace/created",
    "events.iterate.com/repo/deleted",
    "events.iterate.com/workspace/deleted",
    "events.iterate.com/secret/set",
    "events.iterate.com/secret/deleted",
    "events.iterate.com/repo/commit-completed",
  ],
  emits: [
    "events.iterate.com/project/created",
    "events.iterate.com/project/create-failed",
    // the core's: the saga points the project's apex at the seeded config repo's commit, and the
    // processor re-points it at every later commit of the config repo (a commit IS its publication)
    "events.iterate.com/project/ingress-configured",
  ],
});

/** The project's reduced state: where its creation stands, and the catalog (the contract's
 *  `stateSchema`). */
export type ProjectState = ProcessorState<typeof ProjectContract>;
