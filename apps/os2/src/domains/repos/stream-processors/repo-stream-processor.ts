import { z } from "zod";
import {
  defineProcessorContract,
  implementProcessor,
  reduceProcessorEvents,
  type StreamEvent,
} from "@iterate-com/shared/stream-processors";
import { StreamPath } from "@iterate-com/shared/streams/types";

export function repoStreamPath(repoSlug: string) {
  return StreamPath.parse(`/repos/${repoSlug}`);
}

export const RepoStreamProcessorContract = defineProcessorContract({
  slug: "repo",
  version: "0.1.0",
  description: "Tracks Repo lifecycle facts and Git access state.",
  stateSchema: z.object({
    repo: z
      .object({
        defaultBranch: z.string().trim().min(1),
        remote: z.string().url(),
        slug: z.string().trim().min(1),
        token: z.string().trim().min(1),
        tokenExpiresAt: z.iso.datetime().nullable(),
      })
      .nullable()
      .default(null),
  }),
  initialState: {
    repo: null,
  },
  events: {
    "events.iterate.com/repo/created": {
      description: "A Repo was created and its initial Git access details were recorded.",
      payloadSchema: z.object({
        defaultBranch: z.string().trim().min(1),
        remote: z.string().url(),
        slug: z.string().trim().min(1),
        token: z.string().trim().min(1),
        tokenExpiresAt: z.iso.datetime().nullable(),
      }),
    },
  },
  consumes: ["events.iterate.com/repo/created"],
  emits: [],
  reduce({ state, event }) {
    switch (event.type) {
      case "events.iterate.com/repo/created":
        return {
          ...state,
          repo: event.payload,
        };
    }
  },
});

export type RepoReducedState = z.infer<typeof RepoStreamProcessorContract.stateSchema>;

export function createRepoStreamProcessor() {
  return implementProcessor(RepoStreamProcessorContract, {});
}

export function reduceRepoStreamEvents(args: {
  events: readonly StreamEvent[];
  state?: RepoReducedState;
}) {
  return reduceProcessorEvents({
    contract: RepoStreamProcessorContract,
    events: args.events,
    state: args.state,
  });
}
