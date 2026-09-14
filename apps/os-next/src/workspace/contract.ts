// src/workspace/contract.ts — the workspace's vocabulary and view (the triplet's first: processor.ts
// is the pure reduce, durable-object.ts the loadable host). A workspace's DURABLE configuration is
// its birth (`workspace/created`, appended on its own path on first use and cross-posted to `/` for
// the project catalog) and its configured mounts — deviations over the DERIVED table (every project
// repo at `/repos/<name>`, which the host derives at read time and never stores). ONE event,
// `workspace/configured`, patches them; the view is the patches folded. Files are not here: the
// overlay lives in the host's own storage, and a commit is a repo fact, not a workspace one.
import { z } from "zod";
import { defineProcessorContract } from "../stream/processor.ts";

/** One mount: the project repo whose `main` shows through at the mount path. */
const WorkspaceMount = z.object({ repo: z.string().min(1) });
export type WorkspaceMount = z.infer<typeof WorkspaceMount>;

/** The birth certificate — the same payload on the workspace's own path and on `/`. */
const WorkspaceBirth = z.object({
  /** The workspace's context path — a workspace IS its path. */
  path: z.string().min(1),
});

export const WorkspaceView = z.object({
  /** True once `workspace/created` reduced — the workspace exists as a domain object. */
  created: z.boolean().default(false),
  /** The mounts CONFIGURED on this workspace, by absolute mount path — merged over the derived table
   *  by the host (durable-object.ts `mounts()`). */
  mounts: z.record(z.string(), WorkspaceMount).default({}),
});
/** The workspace's reduced state: its configured mounts. */
export type WorkspaceView = z.infer<typeof WorkspaceView>;

export const WorkspaceContract = defineProcessorContract({
  slug: "workspace",
  version: "1",
  description:
    "A workspace's configured mounts: repos shown at paths beyond the derived /repos/<name> table.",
  stateSchema: WorkspaceView,
  events: {
    "events.iterate.com/workspace/created": {
      description:
        "The workspace's birth certificate: appended on its own path on first use and cross-posted to / for the project catalog.",
      payloadSchema: WorkspaceBirth,
    },
    "events.iterate.com/workspace/configured": {
      description:
        "Patch the configured mounts: a mount path → { repo } adds or replaces a mount, → null removes it; paths not named are untouched.",
      payloadSchema: z.object({ mounts: z.record(z.string(), WorkspaceMount.nullable()) }),
    },
  },
  consumes: ["events.iterate.com/workspace/created", "events.iterate.com/workspace/configured"],
  emits: [],
});
