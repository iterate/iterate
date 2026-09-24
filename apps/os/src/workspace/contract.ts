// src/workspace/contract.ts — A WORKSPACE: a domain object on the context at any path
// (`/workspaces/<name>` by convention). It is ONE private overlay over the project's repos; its facts
// live on that path's log, and THIS FILE is the only place they are spelled. The rest of the folder
// derives from it: processor.ts reduces these events and runs the creation and deletion sagas,
// durable-object.ts keeps the overlay behind the `created` guard, src/project/collection.ts is
// `itx.workspaces` (`list`, `create`, `delete`), library.ts hands out the handle (`itx.workspaces.get(path)`: the
// host's verbs plus the typed `append`). Deletion is the creation's mirror: `delete-requested` opens
// it, the processor lands `deleted` — cross-posted to `/` so the catalog drops the entry — and the
// overlay goes with the facet. Every type is derived here, never hand-kept:
//   WorkspaceState                        = ProcessorState<typeof WorkspaceContract>  the reduced state below
//   ConsumedEvent<typeof WorkspaceContract>                                            what reduce and processEvent see
//   EventInput<typeof WorkspaceContract>                                               what `itx.workspaces.get(path).append(…)` takes
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/next/stream/processor";
import { EntityCreationAndDeletionState } from "../project/entity-state.ts";

export const WorkspaceContract = defineProcessorContract({
  slug: "workspace",
  version: "2",
  description: "A workspace: its creation and deletion.",
  /** THE REDUCED STATE — the one every entity keeps (src/project/entity-state.ts): where creation and
   *  deletion stand, as the offsets of the events that say so; the guard every verb reads before it
   *  touches the overlay. Files are not here: the overlay lives in the host's own storage, a commit
   *  is a repo fact, and the mount table is derived from the project catalog, never stored. */
  stateSchema: EntityCreationAndDeletionState,
  events: {
    "events.iterate.com/workspace/create-requested": {
      description:
        "Someone asked for this workspace (`itx.workspaces.create(path)`). No payload: the context it lands on IS the workspace. The collection writes the child's parent link `itx ⇒ itx.builtins.cd(creator)` before this request, the creator being the context that called, so the link is part of the birth and nothing re-points a born context. Nothing to provision — the processor lands created (or create-failed, should the cross-post fail); a request after a failure is a new attempt, one after the certificate a harmless fact.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/workspace/created": {
      description:
        "The birth certificate: on the workspace's path, and cross-posted to / for the project catalog — hence it names the path.",
      payloadSchema: z.object({ path: z.string().min(1) }),
    },
    "events.iterate.com/workspace/create-failed": {
      description: "What the creation attempt reported. Terminal until a new request.",
      payloadSchema: z.object({ error: z.string() }),
    },
    "events.iterate.com/workspace/delete-requested": {
      description:
        "Someone asked for this workspace to go (`itx.workspaces.delete(path)`). No payload: the context it lands on IS the workspace. Nothing to tear down (the overlay goes with the facet) — the processor lands deleted; a request after the certificate is a harmless fact.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/workspace/deleted": {
      description:
        "The death certificate: on the workspace's path, and cross-posted to / for the project catalog, which drops the entry — hence it names the path. Terminal: a deleted workspace is not re-creatable.",
      payloadSchema: z.object({ path: z.string().min(1) }),
    },
  },
  consumes: [
    "events.iterate.com/workspace/create-requested",
    "events.iterate.com/workspace/created",
    "events.iterate.com/workspace/create-failed",
    "events.iterate.com/workspace/delete-requested",
    "events.iterate.com/workspace/deleted",
  ],
  emits: [
    "events.iterate.com/workspace/created",
    "events.iterate.com/workspace/create-failed",
    "events.iterate.com/workspace/deleted",
  ],
});

/** The workspace's reduced state: where its creation and deletion stand (the contract's `stateSchema`). */
export type WorkspaceState = ProcessorState<typeof WorkspaceContract>;
