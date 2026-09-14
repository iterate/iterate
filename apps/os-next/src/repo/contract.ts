// src/repo/contract.ts — a repo's vocabulary and view (the triplet's first: processor.ts is the pure
// reduce and the saga's effect, durable-object.ts the loadable host). A repo is a domain object with
// its OWN stream, the context at any path (`/repos/<name>` by convention). Its creation is THE SAGA
// (stream/creation-saga.ts), as in apps/os:
// `repos/create-requested` is the durable intent; the processor's effect provisions the Artifacts
// repo and appends the terminal fact — `repos/created`, the birth certificate (cross-posted to `/`
// for the project catalog), or `repos/create-failed`; an open request survives an eviction and is
// re-driven by the at-head pass. Every commit that lands through the repo is `repo/commit-completed`.
// The bytes are not here — they are git, in Artifacts, behind `itx.git`; the host keeps the tip's
// snapshot as a cache in its own storage.
import { z } from "zod";
import { CreationState } from "../stream/creation-saga.ts";
import { defineProcessorContract } from "../stream/processor.ts";

/** The repo's identity — the request's payload, the certificate's, and the failure's: its context
 *  PATH. Any path can host a repo; `/repos/<name>` is the convention, not a rule. A workspace mounts
 *  a repo at that same path. */
const RepoIdentity = z.object({ path: z.string().min(1) });
export type RepoIdentity = z.infer<typeof RepoIdentity>;

/** The Artifacts repo a path is backed by: the path's segments joined with `--` (`/repos/config` →
 *  `repos--config`, `/vendor/lib` → `vendor--lib`), which Artifacts' name grammar
 *  (`[a-zA-Z0-9][a-zA-Z0-9._-]*`) accepts. Injective because a segment may not contain `--`
 *  (refused, as is a segment outside the grammar and the root itself). */
export function repoArtifactName(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) throw new Error("repo: the project's root context is not a repo");
  for (const segment of segments)
    if (segment.includes("--") || !/^[a-zA-Z0-9._-]+$/.test(segment))
      throw new Error(
        `repo: "${path}" cannot back an Artifacts repo — a path segment is [a-zA-Z0-9._-]+ without "--" (got "${segment}")`,
      );
  const name = segments.join("--");
  if (!/^[a-zA-Z0-9]/.test(name))
    throw new Error(
      `repo: "${path}" cannot back an Artifacts repo — its name must start with a letter or digit`,
    );
  return name;
}

/** One commit that landed on `main` through the repo facet. */
const RepoCommit = z.object({
  commitOid: z.string().min(1),
  parentOid: z.string().nullable(),
  message: z.string(),
  changedPaths: z.array(z.string()),
});

export const RepoView = CreationState.extend({
  /** The newest commit that landed THROUGH this repo (a push from outside is not a fact here). */
  tip: z.string().nullable().default(null),
  commits: z.number().int().default(0),
});
/** The repo's reduced state: the saga's slice, and what landed through it. */
export type RepoView = z.infer<typeof RepoView>;

export const RepoContract = defineProcessorContract({
  slug: "repo",
  version: "1",
  description: "A repo's creation saga and the commits that landed through it.",
  stateSchema: RepoView,
  events: {
    "events.iterate.com/repos/create-requested": {
      description:
        "Opens the creation saga: the processor's effect provisions the Artifacts repo and appends the terminal repos/created or repos/create-failed. A request after a failure is a new attempt.",
      payloadSchema: RepoIdentity,
    },
    "events.iterate.com/repos/created": {
      description:
        "The saga's terminal success — the repo's birth certificate, appended on its own path and cross-posted to / for the project catalog.",
      payloadSchema: RepoIdentity,
    },
    "events.iterate.com/repos/create-failed": {
      description:
        "The saga's terminal failure for this attempt: what provisioning reported. Fail-closed until a new request.",
      payloadSchema: RepoIdentity.extend({ error: z.string() }),
    },
    "events.iterate.com/repo/commit-completed": {
      description: "A commit landed on the repo's main through the repo facet.",
      payloadSchema: RepoCommit,
    },
  },
  consumes: [
    "events.iterate.com/repos/create-requested",
    "events.iterate.com/repos/created",
    "events.iterate.com/repos/create-failed",
    "events.iterate.com/repo/commit-completed",
  ],
  emits: ["events.iterate.com/repos/created", "events.iterate.com/repos/create-failed"],
});
