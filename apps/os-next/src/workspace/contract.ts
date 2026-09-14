// src/workspace/contract.ts — the workspace's vocabulary and view (the triplet's first: processor.ts
// is the pure reduce and the saga's effect, durable-object.ts the loadable host). A workspace is a
// domain object with its OWN stream, the context at any path. Its creation is THE SAGA
// (stream/creation-saga.ts), as in apps/os: `workspace/create-requested` is the durable intent; the
// processor's effect — nothing to provision yet, a workspace is its facet's storage — lands the
// terminal `workspace/created`, the birth certificate (cross-posted to `/` for the project catalog),
// or `workspace/create-failed`. Its configuration is its configured mounts — deviations over the
// DERIVED table (every catalogued repo at its own path, which the host derives at read time and never
// stores); ONE event, `workspace/configured`, patches them. Files are not here: the overlay lives in
// the host's own storage, and a commit is a repo fact, not a workspace one.
import { z } from "zod";
import { CreationState } from "../stream/creation-saga.ts";
import { defineProcessorContract } from "../stream/processor.ts";

/** The workspace's identity — the request's payload, the certificate's, and the failure's: its
 *  context path. A workspace IS its path. */
const WorkspaceIdentity = z.object({ path: z.string().min(1) });

/** One mount: the PATH of the project repo whose `main` shows through at the mount path. */
const WorkspaceMount = z.object({ repo: z.string().min(1) });
export type WorkspaceMount = z.infer<typeof WorkspaceMount>;

export const WorkspaceView = CreationState.extend({
  /** The mounts CONFIGURED on this workspace, by absolute mount path (the value: the repo's path) —
   *  merged over the derived table by the host (durable-object.ts `mounts()`). */
  mounts: z.record(z.string(), WorkspaceMount).default({}),
});
/** The workspace's reduced state: the saga's slice, and its configured mounts. */
export type WorkspaceView = z.infer<typeof WorkspaceView>;

export const WorkspaceContract = defineProcessorContract({
  slug: "workspace",
  version: "1",
  description:
    "A workspace's creation saga and its configured mounts: repos shown at paths beyond the derived table.",
  stateSchema: WorkspaceView,
  events: {
    "events.iterate.com/workspace/create-requested": {
      description:
        "Opens the creation saga: the processor's effect lands the terminal workspace/created or workspace/create-failed. A request after a failure is a new attempt.",
      payloadSchema: WorkspaceIdentity,
    },
    "events.iterate.com/workspace/created": {
      description:
        "The saga's terminal success — the workspace's birth certificate, appended on its own path and cross-posted to / for the project catalog.",
      payloadSchema: WorkspaceIdentity,
    },
    "events.iterate.com/workspace/create-failed": {
      description: "The saga's terminal failure for this attempt. Fail-closed until a new request.",
      payloadSchema: WorkspaceIdentity.extend({ error: z.string() }),
    },
    "events.iterate.com/workspace/configured": {
      description:
        "Patch the configured mounts: a mount path → { repo } adds or replaces a mount, → null removes it; paths not named are untouched.",
      payloadSchema: z.object({ mounts: z.record(z.string(), WorkspaceMount.nullable()) }),
    },
  },
  consumes: [
    "events.iterate.com/workspace/create-requested",
    "events.iterate.com/workspace/created",
    "events.iterate.com/workspace/create-failed",
    "events.iterate.com/workspace/configured",
  ],
  emits: ["events.iterate.com/workspace/created", "events.iterate.com/workspace/create-failed"],
});
