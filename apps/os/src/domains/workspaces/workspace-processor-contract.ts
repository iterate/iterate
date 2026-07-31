// The workspace processor CONTRACT. Self-contained: state schema and both
// owned events, spelled inline; the schemas the contract genuinely uses twice
// (the overlay table, the canonical repo path, the canonical-mount-key
// record) are hoisted functions below the contract, so the contract still
// opens the file. Consumers reach INTO this module for every piece
// (`WorkspaceConfig`, `WorkspaceMount`, `WorkspaceMountOverlay`,
// `WorkspaceConfigPatch` are derived types; the implementation re-parses
// merges through `stateSchema.shape.config`) — never the other way around.
//
// The DEFAULT mount table is not stored here at all: every project repo is
// mounted at its own `/repos/**` stream path, derived from the project's repo
// list at read time (`effectiveWorkspaceMounts` in ./utils.ts). This contract
// owns only the workspace's existence and its overlay of DEVIATIONS from that
// derived table.
//
// The path predicates come from ./paths.ts and are enforced AT THE SCHEMA, so
// raw stream appends are held to the same canonical form as the RPC doors: a
// non-canonical overlay table can never become durable configuration.

import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/processors";
import { isCanonicalMountPath, isCanonicalRepoPath } from "./paths.ts";

export const WorkspaceProcessorContract = defineProcessorContract({
  slug: "workspace",
  version: "0.4.0",
  description:
    "Workspace lifecycle and configuration: existence plus an overlay of mount deviations. The default mount table is DERIVED (every project repo at its own /repos/** path, commit-to-main); overlays add extra mounts or change a derived mount's fields.",
  stateSchema: z.object({
    // Loose on purpose: pre-0.4.0 birth certificates carried the complete
    // initial mount table; that payload is now ignored — existence is the
    // only birth fact.
    birthCertificate: z.looseObject({}).nullable().default(null).meta({
      description: "Existence marker: null until workspace/created reduces.",
    }),
    // `.prefault({})` PARSES the empty reduce's `{}` through the config
    // schema, so the nested overlay-table default fills in.
    config: workspaceConfigSchema().prefault({}).meta({
      description:
        "Mount overlays: every workspace/configured patch merged together (mergeWorkspaceConfigPatch in the implementation). The live routing table is these overlays merged over the DERIVED default (effectiveWorkspaceMounts).",
    }),
  }),
  events: {
    "events.iterate.com/workspace/created": {
      description:
        "Creates a workspace processor on this stream — a pure existence marker. Mounts are not birth facts: every project repo is mounted at its own /repos/** path by derivation; deviations arrive as workspace/configured patches.",
      // Loose on purpose: pre-0.4.0 events carried `{ config }`; a committed
      // event must never fail the reduce.
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/workspace/configured": {
      description:
        "Deep-merges a mount-overlay patch into the workspace's configuration. Plain objects recurse, so a `mounts` patch edits the overlay per mount point: an unknown key adds an overlay (a complete `{ repoPath, policy }` mounts a repo at a new path; a partial one deviates a DERIVED mount's fields), and `null` clears the overlay at that path (the derived default returns). Omitted keys are untouched.",
      payloadSchema: z.strictObject({
        config: z
          .strictObject({
            mounts: canonicalMountKeys(workspaceMountOverlaySchema().nullable()).optional().meta({
              description:
                "Per-mount-point overlay patches: an unknown key adds an overlay, a partial value edits just those fields, null clears the overlay (back to the derived default). Omitted keys are untouched.",
            }),
          })
          .meta({
            description: "A configuration patch: deep-merged per mount point; null clears.",
          }),
      }),
    },
  },
  consumes: ["events.iterate.com/workspace/created", "events.iterate.com/workspace/configured"],
  emits: [],
});

export type WorkspaceProcessorContract = typeof WorkspaceProcessorContract;
/** The workspace processor's reduced state: existence plus the merged overlays. */
export type WorkspaceProcessorState = ProcessorState<WorkspaceProcessorContract>;
/** A workspace's stored configuration: the mount OVERLAY table, keyed by mount path. */
export type WorkspaceConfig = WorkspaceProcessorState["config"];
/** One stored overlay: the fields it deviates from (or adds over) the derived table. */
export type WorkspaceMountOverlay = WorkspaceConfig["mounts"][string];
/** One COMPLETE repo mount in the effective routing table: the repo a
 * workspace subtree reads from and its commit policy. */
export type WorkspaceMount = {
  policy: "commit-to-main" | "read-only";
  repoPath: string;
};
/** A configuration patch: deep-merged per mount point; null clears an overlay.
 * (Spelled as one z.output<> reference — not an indexed access over it — so
 * the itx-api generator expands it structurally instead of copying the
 * expression verbatim into the generated public API.) */
export type WorkspaceConfigPatch = z.output<
  (typeof WorkspaceProcessorContract.events)["events.iterate.com/workspace/configured"]["payloadSchema"]["shape"]["config"]
>;

/**
 * One mount overlay: partial `{ policy?, repoPath? }`. A COMPLETE overlay
 * mounts a repo at a new path; a partial one deviates one field of a DERIVED
 * mount (e.g. `{ policy: "read-only" }` on a big imported repo). Used twice:
 * the stored config table and the configured event's patch values.
 */
function workspaceMountOverlaySchema() {
  return z
    .strictObject({
      policy: z.enum(["commit-to-main", "read-only"]).optional().meta({
        description:
          "Governs the COMMIT door, not the overlay filesystem: the local layer is private everywhere, but only commit-to-main mounts accept git.commit (the same lane as that repo's commitFiles — no branches, live on main). read-only marks reference material (e.g. a big imported repo) whose changes must not land anywhere yet.",
      }),
      repoPath: canonicalRepoPathSchema().optional().meta({
        description: "The backing repo for this mount, when given.",
      }),
    })
    .meta({
      description:
        "Partial mount fields, merged over the derived mount at this path (or forming a new mount when complete).",
    });
}

/**
 * The stored configuration: the mount OVERLAY table, keyed by mount point.
 * `workspace/configured` events carry a PATCH deep-merged over this — plain
 * objects recurse, so a patch can add one overlay, change one field, or set a
 * mount to `null` to clear its overlay, without restating the table.
 */
function workspaceConfigSchema() {
  return z.strictObject({
    mounts: canonicalMountKeys(workspaceMountOverlaySchema()).default({}).meta({
      description:
        "Mount overlays, keyed by absolute workspace path — deviations from the derived table (every project repo at its own /repos/** path).",
    }),
  });
}

/** A `/repos/**` stream path, canonical. */
function canonicalRepoPathSchema() {
  return z
    .string()
    .refine(isCanonicalRepoPath, "repoPath must be a canonical /repos/** stream path")
    .meta({
      description: "The /repos/** stream this mount reads from (main at HEAD) and commits to.",
    });
}

/** Record keys must be canonical mount points — held at the SCHEMA so raw
 * appends cannot smuggle aliasing spellings (`/a` vs `/a/`) or `.git` mounts
 * past the door validation. Used twice: the config's table and the patch's. */
function canonicalMountKeys<Value extends z.ZodType>(value: Value) {
  return z.record(
    z.string().refine(isCanonicalMountPath, "mount paths must be canonical absolute paths"),
    value,
  );
}
