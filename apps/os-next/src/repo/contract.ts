// src/repo/contract.ts — A REPO: a domain object on the context at any path (`/repos/<name>` by
// convention). Its git lives in Cloudflare Artifacts; its facts live on that path's log, and THIS
// FILE is the only place they are spelled. The rest of the folder derives from it: processor.ts
// reduces these events and runs the creation saga, durable-object.ts speaks git behind the
// `created` guard, collection.ts is `itx.repos` (`list`, `create`), library.ts hands out the handle
// (`itx.repos.get(path)`: the host's verbs plus the typed `append`). Every type is derived here,
// never hand-kept:
//   RepoState                        = ProcessorState<typeof RepoContract>  the reduced state below
//   ConsumedEvent<typeof RepoContract>                                       what reduce and processEvent see
//   EventInput<typeof RepoContract>                                          what `itx.repos.get(path).append(…)` takes
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/next/stream/processor";

export const RepoContract = defineProcessorContract({
  slug: "repo",
  version: "1",
  description: "A repo: its creation, and the commits that landed through it.",
  /** THE REDUCED STATE — what the reduce keeps between events: where creation stands, as the OFFSET
   *  of the event that says so (the request, the certificate, or the failure — read that event for
   *  the error). It is the checkpoint the facet stores, what `snapshot()` and `liveSnapshot()`
   *  answer, and the guard every verb reads before it speaks git. */
  stateSchema: z.object({
    creation: z
      .object({
        status: z.enum(["requested", "created", "failed"]),
        offset: z.number().int().positive(),
      })
      .nullable()
      .default(null),
  }),
  events: {
    "events.iterate.com/repo/create-requested": {
      description:
        "Someone asked for this repo (`itx.repos.create(path)`). No payload: the context it lands on IS the repo. The processor provisions the Artifacts repo and lands created or create-failed; a request after a failure is a new attempt, one after the certificate a harmless fact.",
      payloadSchema: z.object({}),
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
    "events.iterate.com/repo/create-requested",
    "events.iterate.com/repo/created",
    "events.iterate.com/repo/create-failed",
  ],
  emits: ["events.iterate.com/repo/created", "events.iterate.com/repo/create-failed"],
});

/** The repo's reduced state: where its creation stands (the contract's `stateSchema`). */
export type RepoState = ProcessorState<typeof RepoContract>;
