// src/repo/contract.ts — a repo's vocabulary and view (the triplet's first: processor.ts is the pure
// reduce, durable-object.ts the loadable host). A repo is a domain object with its OWN stream, the
// context at any path (`/repos/<name>` by convention). Its creation is three facts on that path, landed
// by the host's `create()`: `repos/create-requested`, then `repos/created` — the birth certificate,
// cross-posted to `/` for the project catalog — or `repos/create-failed`. Every commit that lands
// through the repo is `repo/commit-completed`. The bytes are not here — they are git, in Artifacts,
// behind `itx.cfArtifacts` (context/repos.ts), addressed by this same path.
import { z } from "zod";
import { defineProcessorContract } from "../stream/processor.ts";

/** The repo's identity — the request's payload, the certificate's, and the failure's: its context
 *  PATH. Any path can host a repo; `/repos/<name>` is the convention, not a rule. A workspace mounts
 *  a repo at that same path. */
const RepoIdentity = z.object({ path: z.string().min(1) });
export type RepoIdentity = z.infer<typeof RepoIdentity>;

export const RepoView = z.object({
  /** The repo's context path, from the request; null before any request. */
  path: z.string().nullable().default(null),
  /** Where creation stands: null before any request; "requested" until a terminal fact; "created"
   *  (the certificate reduced) or "failed" (what the newest attempt reported is in `error`). */
  creation: z.enum(["requested", "created", "failed"]).nullable().default(null),
  error: z.string().nullable().default(null),
});
/** The repo's reduced state: where its creation stands. */
export type RepoView = z.infer<typeof RepoView>;

export const RepoContract = defineProcessorContract({
  slug: "repo",
  version: "1",
  description: "A repo's creation and the commits that landed through it.",
  stateSchema: RepoView,
  events: {
    "events.iterate.com/repos/create-requested": {
      description:
        "create() opened the creation: the host provisions the Artifacts repo and lands repos/created or repos/create-failed. A request after a failure is a new attempt.",
      payloadSchema: RepoIdentity,
    },
    "events.iterate.com/repos/created": {
      description:
        "The repo's birth certificate, on its own path and cross-posted to / for the project catalog.",
      payloadSchema: RepoIdentity,
    },
    "events.iterate.com/repos/create-failed": {
      description: "What provisioning reported. Fail-closed until a new request.",
      payloadSchema: RepoIdentity.extend({ error: z.string() }),
    },
    "events.iterate.com/repo/commit-completed": {
      description: "A commit landed on the repo's main through the repo facet.",
      payloadSchema: z.object({
        commitOid: z.string().min(1),
        message: z.string(),
        changedPaths: z.array(z.string()),
      }),
    },
  },
  consumes: [
    "events.iterate.com/repos/create-requested",
    "events.iterate.com/repos/created",
    "events.iterate.com/repos/create-failed",
  ],
  emits: [],
});
