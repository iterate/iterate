import { z } from "zod";
import {
  defineProcessorContract,
  mergeProcessorConfig,
  type ProcessorState,
} from "../streams/processor-contracts.ts";

/**
 * One repo mount: a subtree of the workspace whose fall-through reads come
 * from that repo's main branch and whose commits route to that repo's own
 * commit lane. Mounts are keyed by their absolute workspace path in the
 * config's `mounts` map ("/" mounts the repo at the workspace root).
 *
 * `policy` governs the COMMIT door, not the overlay: the local layer is
 * private scratch everywhere, but only `commit-to-main` mounts accept
 * `git.commit` (the same lane as that repo's `commitFiles` — no branches,
 * live on main). `read-only` marks reference material (e.g. a big imported
 * repo) whose changes must not land anywhere yet.
 */
export const WorkspaceMount = z.strictObject({
  policy: z.enum(["commit-to-main", "read-only"]),
  repoPath: z.string(),
});
/** One repo mount: the repo a workspace subtree reads from and its commit policy. */
export type WorkspaceMount = z.infer<typeof WorkspaceMount>;

/**
 * The workspace's complete configuration: the mount table, keyed by mount
 * point. `configured` events carry a PATCH deep-merged over this — plain
 * objects recurse, so a patch can add one mount, change one field of one
 * mount, or set a mount to `null` to remove it, without restating the table.
 */
export const WorkspaceConfig = z.strictObject({
  mounts: z.record(z.string(), WorkspaceMount).default({}),
});
/** A workspace's complete configuration: the mount table, keyed by mount path. */
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

/** A patch's mount value: partial fields merge into the existing mount. */
const WorkspaceMountPatch = z.strictObject({
  policy: z.enum(["commit-to-main", "read-only"]).optional(),
  repoPath: z.string().optional(),
});

export const WorkspaceConfigPatch = z.strictObject({
  mounts: z.record(z.string(), WorkspaceMountPatch.nullable()).optional(),
});
/** A configuration patch: deep-merged per mount point; null unmounts. */
export type WorkspaceConfigPatch = z.infer<typeof WorkspaceConfigPatch>;

/** Birth certificate: the complete config the workspace is born with. */
export const WorkspaceBirthCertificate = z.strictObject({ config: WorkspaceConfig });
export type WorkspaceBirthCertificate = z.infer<typeof WorkspaceBirthCertificate>;

/**
 * Fold one configuration patch into a complete configuration: the platform's
 * deep merge (plain objects recurse; scalars and null replace), then `null`
 * mount entries — the unmount marker — are dropped, then the result must
 * parse as a COMPLETE config (a partial mount patch must land on an existing
 * mount to merge into). Shared by the reducer and the configure door, so
 * door validation and the fold can never disagree.
 */
export function foldWorkspaceConfig(base: unknown, patch: unknown): WorkspaceConfig {
  const merged = mergeProcessorConfig(base, patch);
  if (
    typeof merged === "object" &&
    merged !== null &&
    "mounts" in merged &&
    typeof merged.mounts === "object" &&
    merged.mounts !== null
  ) {
    (merged as { mounts: unknown }).mounts = Object.fromEntries(
      Object.entries(merged.mounts).filter(([, value]) => value !== null),
    );
  }
  return WorkspaceConfig.parse(merged);
}

export const WorkspaceProcessorContract = defineProcessorContract({
  slug: "workspace",
  version: "0.2.0",
  description:
    "Workspace lifecycle and configuration: birth certificate plus the mount table (mount path → repo, with a per-mount commit policy) that routes the workspace's fall-through reads and commits.",
  stateSchema: z.object({
    birthCertificate: WorkspaceBirthCertificate.nullable().default(null),
    config: WorkspaceConfig.default({ mounts: {} }),
  }),
  events: {
    "events.iterate.com/workspace/created": {
      description:
        "Creates a workspace processor on this stream. The birth certificate carries the complete initial configuration (usually the mount table). Appended by itx.workspaces.create, or by the workspace itself on first touch (with the default table: the config repo mounted at '/').",
      payloadSchema: WorkspaceBirthCertificate,
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
      payloadSchema: z.strictObject({ config: WorkspaceConfigPatch }),
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
/** The workspace processor's reduced state: birth certificate plus folded config. */
export type WorkspaceProcessorState = ProcessorState<WorkspaceProcessorContract>;
