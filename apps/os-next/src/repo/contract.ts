// src/repo/contract.ts — A REPO: a domain object on the context at any path (`/repos/<name>` by
// convention). Its git lives in Cloudflare Artifacts; its facts live on that path's log, and THIS
// FILE is the only place they are spelled. The rest of the folder derives from it: processor.ts
// reduces these events and runs the creation and deletion sagas, durable-object.ts speaks git behind
// the `created` guard, collection.ts is `itx.repos` (`list`, `create`, `delete`), library.ts hands
// out the handle (`itx.repos.get(path)`: the host's verbs plus the typed `append`). Deletion is the
// creation's mirror: `delete-requested` opens it, the processor tears down the Artifacts repo and
// lands `deleted` — cross-posted to `/` so the catalog drops the entry. Every type is derived here,
// never hand-kept:
//   RepoState                        = ProcessorState<typeof RepoContract>  the reduced state below
//   ConsumedEvent<typeof RepoContract>                                       what reduce and processEvent see
//   EventInput<typeof RepoContract>                                          what `itx.repos.get(path).append(…)` takes
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/next/stream/processor";

export const RepoContract = defineProcessorContract({
  slug: "repo",
  version: "2",
  description: "A repo: its creation and deletion, and the commits that landed through it.",
  /** THE REDUCED STATE — what the reduce keeps between events: where creation stands, as the OFFSET
   *  of the event that says so (the request, the certificate, or the failure — read that event for
   *  the error), and where deletion stands the same way (the request, or the certificate). It is the
   *  checkpoint the facet stores, what `snapshot()` and `liveSnapshot()` answer, and the guard every
   *  verb reads before it speaks git. */
  stateSchema: z.object({
    creation: z
      .object({
        status: z.enum(["requested", "created", "failed"]),
        offset: z.number().int().positive(),
        /** The context that asked (`create-requested.creator`): the saga writes the parent link to it. */
        creator: z.string().optional(),
      })
      .nullable()
      .default(null),
    /** Where deletion stands, as the offset of the event that says so; null while the repo lives. */
    deletion: z
      .object({
        status: z.enum(["requested", "deleted"]),
        offset: z.number().int().positive(),
      })
      .nullable()
      .default(null),
  }),
  events: {
    "events.iterate.com/repo/create-requested": {
      description:
        "Someone asked for this repo (`itx.repos.create(path)`). The context it lands on IS the repo; `creator` is the context that asked — the saga writes the child\'s parent link `itx ⇒ itx.builtins.cd(creator)` before the certificate, so the link is part of the birth and nothing re-points a born context. The processor provisions the Artifacts repo and lands created or create-failed; a request after a failure is a new attempt, one after the certificate a harmless fact.",
      payloadSchema: z.object({ creator: z.string().optional() }),
    },
    "events.iterate.com/repo/created": {
      description:
        "The birth certificate: on the repo's path, and cross-posted to / for the project catalog — hence it names the path.",
      payloadSchema: z.object({ path: z.string().min(1) }),
    },
    "events.iterate.com/repo/create-failed": {
      description: "What provisioning reported. Terminal until a new request.",
      payloadSchema: z.object({ error: z.string() }),
    },
    "events.iterate.com/repo/delete-requested": {
      description:
        "Someone asked for this repo to go (`itx.repos.delete(path)`). No payload: the context it lands on IS the repo. The processor tears down the Artifacts repo it provisioned and lands deleted; a request after the certificate is a harmless fact.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/repo/deleted": {
      description:
        "The death certificate: on the repo's path, and cross-posted to / for the project catalog, which drops the entry — hence it names the path. Terminal: a deleted repo is not re-creatable.",
      payloadSchema: z.object({ path: z.string().min(1) }),
    },
    "events.iterate.com/repo/commit-completed": {
      description:
        "A commit landed on the repo's main through the repo facet: on the repo's path, and cross-posted to / — hence it names the path — where the project processor follows the config repo's commits with the apex (a commit to /repos/config IS its publication).",
      payloadSchema: z.object({
        path: z.string().min(1),
        commitOid: z.string().min(1),
        message: z.string(),
        changedPaths: z.array(z.string()),
      }),
    },
  },
  consumes: [
    "events.iterate.com/repo/create-requested",
    "events.iterate.com/repo/created",
    "events.iterate.com/repo/create-failed",
    "events.iterate.com/repo/delete-requested",
    "events.iterate.com/repo/deleted",
  ],
  emits: [
    "events.iterate.com/repo/created",
    "events.iterate.com/repo/create-failed",
    "events.iterate.com/repo/deleted",
  ],
});

/** The repo's reduced state: where its creation and deletion stand (the contract's `stateSchema`). */
export type RepoState = ProcessorState<typeof RepoContract>;
