// src/repo/contract.ts — a repo's vocabulary and view (the triplet's first: processor.ts is the pure
// reduce and the saga's effect, durable-object.ts the loadable host). A repo is a domain object with
// its OWN stream, the context at `/repos/<name>`. Its creation is a SAGA, as in apps/os:
// `repos/create-requested` is the durable intent; the processor's effect provisions the Artifacts
// repo and appends the terminal fact — `repos/created`, the birth certificate (cross-posted to `/`
// for the project catalog), or `repos/create-failed`; an open request survives an eviction and is
// re-driven by the at-head pass. Every commit that lands through the repo is `repo/commit-completed`.
// The bytes are not here — they are git, in Artifacts, behind `itx.git`; the host keeps the tip's
// snapshot as a cache in its own storage.
import { z } from "zod";
import { defineProcessorContract } from "../stream/processor.ts";

/** The repo's identity — the request's payload, the certificate's, and the failure's. */
const RepoIdentity = z.object({
  name: z.string().min(1),
  /** The repo's context path, `/repos/<name>` — what a workspace mounts. */
  path: z.string().min(1),
});
export type RepoIdentity = z.infer<typeof RepoIdentity>;

/** One commit that landed on `main` through the repo facet. */
const RepoCommit = z.object({
  commitOid: z.string().min(1),
  parentOid: z.string().nullable(),
  message: z.string(),
  changedPaths: z.array(z.string()),
});

export const RepoView = z.object({
  /** The saga's position: null before any request; "requested" while the effect is owed;
   *  "created" (the certificate reduced) or "failed" (closed for this attempt) at a terminal. */
  creation: z.enum(["requested", "created", "failed"]).nullable().default(null),
  /** How many `create-requested` have been reduced — a request after a failure is a new attempt. */
  attempts: z.number().int().default(0),
  /** What the newest failed attempt reported. */
  error: z.string().nullable().default(null),
  /** The newest commit that landed THROUGH this repo (a push from outside is not a fact here). */
  tip: z.string().nullable().default(null),
  commits: z.number().int().default(0),
});
/** The repo's reduced state: where its creation stands, and what landed through it. */
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
