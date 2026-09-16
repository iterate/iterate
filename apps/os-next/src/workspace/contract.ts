// src/workspace/contract.ts — the workspace's vocabulary and view (the triplet's first: processor.ts
// is the pure reduce, durable-object.ts the loadable host). A workspace is a domain object with its
// OWN stream, the context at any path. Its creation is two facts on that path, landed by the host's
// `create()`: `workspace/create-requested`, then `workspace/created` — the birth certificate,
// cross-posted to `/` for the project catalog. Nothing to provision yet, so nothing fails. Files are
// not here: the overlay lives in the host's own storage, and a commit is a repo fact, not a workspace
// one; the mount table is derived from the project catalog, never stored.
import { z } from "zod";
import { defineProcessorContract } from "../stream/processor.ts";

/** The workspace's identity — the request's payload and the certificate's: its context path. A
 *  workspace IS its path. */
const WorkspaceIdentity = z.object({ path: z.string().min(1) });

export const WorkspaceView = z.object({
  /** The workspace's context path, from the request; null before any request. */
  path: z.string().nullable().default(null),
  /** Where creation stands: null before any request; "requested" until the certificate; "created". */
  creation: z.enum(["requested", "created"]).nullable().default(null),
});
/** The workspace's reduced state: where its creation stands. */
export type WorkspaceView = z.infer<typeof WorkspaceView>;

export const WorkspaceContract = defineProcessorContract({
  slug: "workspace",
  version: "1",
  description: "A workspace's creation.",
  stateSchema: WorkspaceView,
  events: {
    "events.iterate.com/workspace/create-requested": {
      description: "create() opened the creation: the host lands workspace/created.",
      payloadSchema: WorkspaceIdentity,
    },
    "events.iterate.com/workspace/created": {
      description:
        "The workspace's birth certificate, on its own path and cross-posted to / for the project catalog.",
      payloadSchema: WorkspaceIdentity,
    },
  },
  consumes: [
    "events.iterate.com/workspace/create-requested",
    "events.iterate.com/workspace/created",
  ],
  emits: [],
});
