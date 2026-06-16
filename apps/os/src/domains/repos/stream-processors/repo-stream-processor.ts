// Implements the "repo" processor.
// A pure projection of Repo lifecycle facts and Git access state into reduced
// state. Hosted on RepoDurableObject via createStreamProcessorHost; it has no
// side effects of its own.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { StreamProcessor } from "~/domains/streams/engine/stream-processor.ts";

export function repoStreamPath(path: string) {
  return StreamPath.parse(path);
}

export const RepoStreamProcessorContract = defineProcessorContract({
  slug: "repo",
  version: "0.1.0",
  description: "Tracks Repo lifecycle facts and Git access state.",
  stateSchema: z.object({
    repo: z
      .object({
        defaultBranch: z.string().trim().min(1),
        path: z.string().trim().min(1),
        remote: z.string().url(),
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
        path: z.string().trim().min(1),
        remote: z.string().url(),
        tokenExpiresAt: z.iso.datetime().nullable(),
      }),
    },
  },
  consumes: ["events.iterate.com/repo/created"],
  emits: [],
});

export type RepoStreamProcessorContract = typeof RepoStreamProcessorContract;

export type RepoReducedState = z.infer<typeof RepoStreamProcessorContract.stateSchema>;

export class RepoStreamProcessor extends StreamProcessor<RepoStreamProcessorContract> {
  readonly contract = RepoStreamProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<RepoStreamProcessorContract>["reduce"]>[0],
  ): RepoReducedState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/repo/created":
        return {
          ...state,
          repo: event.payload,
        };
      default:
        return state;
    }
  }
}
