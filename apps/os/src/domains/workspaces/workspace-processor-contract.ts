// The workspace processor CONTRACT. Self-contained: state schema and both
// owned events, spelled inline; the schemas the contract genuinely uses twice
// (the birth certificate, the complete configuration, the canonical repo
// path, the canonical-mount-key record) are hoisted functions below the
// contract, so the contract still opens the file. Consumers reach INTO this
// module for every piece (`WorkspaceConfig`, `WorkspaceMount`,
// `WorkspaceConfigPatch` are derived types; the implementation re-parses
// merges through `stateSchema.shape.config`) — never the other way around.
//
// The path predicates come from ./paths.ts and are enforced AT THE SCHEMA, so
// raw stream appends are held to the same canonical form as the RPC doors: a
// non-canonical mount table can never become durable configuration.

import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/processors";
import { isCanonicalMountPath, isCanonicalRepoPath } from "./paths.ts";

export const WorkspaceProcessorContract = defineProcessorContract({
  slug: "workspace",
  version: "0.3.0",
  description:
    "Workspace lifecycle and configuration: birth certificate plus the mount table (mount path → repo, with a per-mount commit policy) that routes the workspace's fall-through reads and commits.",
  stateSchema: z.object({
    birthCertificate: workspaceBirthCertificateSchema().nullable().default(null).meta({
      description:
        "Existence marker: null until workspace/created reduces. Preserves the exact configuration the workspace was born with; the live table is `config`.",
    }),
    // `.prefault({})` PARSES the empty reduce's `{}` through the config
    // schema, so the nested mount-table default fills in.
    config: workspaceConfigSchema().prefault({}).meta({
      description:
        "The live configuration: the birth certificate's config with every workspace/configured patch merged in (mergeWorkspaceConfigPatch in the implementation).",
    }),
  }),
  events: {
    "events.iterate.com/workspace/created": {
      description:
        "Creates a workspace processor on this stream. The birth certificate carries the complete initial configuration (usually the mount table). Appended by itx.workspaces.create, or by the workspace itself on first touch (with the default table: the config repo mounted at '/').",
      payloadSchema: workspaceBirthCertificateSchema(),
      examples: [
        {
          description:
            "A workspace is born with the config repo mounted at its root (committable) and a big imported repo mounted read-only at /iterate.",
          payload: {
            config: {
              mounts: {
                "/": { policy: "commit-to-main", repoPath: "/repos/config" },
                "/iterate": { policy: "read-only", repoPath: "/repos/iterate" },
              },
            },
          },
        },
      ],
    },
    "events.iterate.com/workspace/configured": {
      description:
        "Deep-merges a configuration patch into an existing workspace configuration. Plain objects recurse, so a `mounts` patch edits the table per mount point: an unknown key adds a mount, a partial value changes just those fields of an existing mount, and `null` removes one. Omitted keys are untouched.",
      payloadSchema: z.strictObject({
        config: z
          .strictObject({
            mounts: canonicalMountKeys(
              // The default-free partial twin of the complete mount schema:
              // patch fields merge into the existing mount at this path.
              z
                .strictObject({
                  policy: z.enum(["commit-to-main", "read-only"]).optional().meta({
                    description: "New commit policy for this mount, when given.",
                  }),
                  repoPath: canonicalRepoPathSchema().optional().meta({
                    description: "New backing repo for this mount, when given.",
                  }),
                })
                .meta({
                  description:
                    "Partial mount fields, merged into the existing mount at this path. An entry that never forms a complete mount is DROPPED by the reduce (the configure door rejects it loudly before the append).",
                })
                .nullable(),
            )
              .optional()
              .meta({
                description:
                  "Per-mount-point patches: an unknown key adds a mount, a partial value edits just those fields, null unmounts. Omitted keys are untouched.",
              }),
          })
          .meta({
            description: "A configuration patch: deep-merged per mount point; null unmounts.",
          }),
      }),
      examples: [
        {
          description:
            "One patch flips the /iterate mount to committable and unmounts /scratch; every other mount is untouched.",
          payload: {
            config: {
              mounts: {
                "/iterate": { policy: "commit-to-main" },
                "/scratch": null,
              },
            },
          },
        },
      ],
    },
  },
  consumes: ["events.iterate.com/workspace/created", "events.iterate.com/workspace/configured"],
  emits: [],
});

export type WorkspaceProcessorContract = typeof WorkspaceProcessorContract;
/** The workspace processor's reduced state: birth certificate plus the merged config. */
export type WorkspaceProcessorState = ProcessorState<WorkspaceProcessorContract>;
/** A workspace's complete configuration: the mount table, keyed by mount path. */
export type WorkspaceConfig = WorkspaceProcessorState["config"];
/** One repo mount: the repo a workspace subtree reads from and its commit policy. */
export type WorkspaceMount = WorkspaceConfig["mounts"][string];
/** A configuration patch: deep-merged per mount point; null unmounts.
 * (Spelled as one z.output<> reference — not an indexed access over it — so
 * the itx-api generator expands it structurally instead of copying the
 * expression verbatim into the generated public API.) */
export type WorkspaceConfigPatch = z.output<
  (typeof WorkspaceProcessorContract.events)["events.iterate.com/workspace/configured"]["payloadSchema"]["shape"]["config"]
>;

/**
 * The birth certificate — the complete configuration the workspace is born
 * with. Used twice: the workspace/created payload and the state's
 * `birthCertificate`.
 */
function workspaceBirthCertificateSchema() {
  return z.strictObject({
    config: workspaceConfigSchema().meta({
      description: "The complete configuration the workspace is born with.",
    }),
  });
}

/**
 * The complete configuration: the mount table, keyed by mount point. Used
 * twice: inside the birth certificate and as the state's live `config`.
 * `workspace/configured` events carry a PATCH deep-merged over this — plain
 * objects recurse, so a patch can add one mount, change one field of one
 * mount, or set a mount to `null` to remove it, without restating the table.
 */
function workspaceConfigSchema() {
  return z.strictObject({
    mounts: canonicalMountKeys(
      z
        .strictObject({
          policy: z.enum(["commit-to-main", "read-only"]).meta({
            description:
              "Governs the COMMIT door, not the overlay: the local layer is private scratch everywhere, but only commit-to-main mounts accept git.commit (the same lane as that repo's commitFiles — no branches, live on main). read-only marks reference material (e.g. a big imported repo) whose changes must not land anywhere yet.",
          }),
          repoPath: canonicalRepoPathSchema(),
        })
        .meta({
          description:
            "One repo mount: a subtree of the workspace whose fall-through reads come from that repo's main branch and whose commits route to that repo's own commit lane.",
        }),
    )
      .default({})
      .meta({
        description:
          "The mount table, keyed by absolute workspace path ('/' mounts the repo at the workspace root).",
      }),
  });
}

/** A `/repos/**` stream path, canonical. Used twice: the complete mount and
 * the patch's partial mount. */
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
