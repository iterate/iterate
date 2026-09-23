// src/project/entity-state.ts — where an entity's creation and deletion stand: the reduced state a
// repo, a workspace and an agent keep in common, spelled once. Each contract takes it as its
// `stateSchema` (repo, workspace) or extends it (agent: the conversation and the loop's obligations
// beside it); the collection (collection.ts) reads it off the facet's `snapshot()` before it asks
// for either. It cannot live in contract.ts: the project contract imports the three entity contracts
// for its `processorDeps`, and a contract importing it back would evaluate a cycle.
import { z } from "zod";

/** What the reduce keeps between events: where creation stands, as the offset of the event that
 *  says so (the request, the certificate, or the failure — read that event for the error), and where
 *  deletion stands the same way (the request, or the certificate). It is the checkpoint the facet
 *  stores, what `snapshot()` and `liveSnapshot()` answer, and the guard every verb reads before it
 *  speaks. */
export const EntityCreationAndDeletionState = z.object({
  creation: z
    .object({
      status: z.enum(["requested", "created", "failed"]),
      offset: z.number().int().positive(),
      /** The context that asked (`create-requested.creator`): the saga writes the parent link to it. */
      creator: z.string().optional(),
    })
    .nullable()
    .default(null),
  /** Where deletion stands, as the offset of the event that says so; null while the entity lives. */
  deletion: z
    .object({
      status: z.enum(["requested", "deleted"]),
      offset: z.number().int().positive(),
    })
    .nullable()
    .default(null),
});
export type EntityCreationAndDeletionState = z.infer<typeof EntityCreationAndDeletionState>;
