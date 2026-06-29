// Implements the "repo" processor.
// Repo creation is requested as a stream fact. The processor owns the artifact
// creation/fork side effect and records the resulting repo/created fact; the
// Durable Object host only supplies the concrete Cloudflare Artifacts helper.

import { z } from "zod";
import {
  buildProcessorIdempotencyKey,
  defineProcessorContract,
} from "@iterate-com/shared/streams/stream-processors";
import { StreamPath } from "@iterate-com/shared/streams/types";
import {
  StreamProcessor,
  type StreamProcessorDeps,
} from "~/domains/streams/engine/stream-processor.ts";

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
    "events.iterate.com/repo/create-requested": {
      description: "Requests creation of the repo identified by this stream path.",
      payloadSchema: z.object({
        path: z.string().trim().min(1),
        source: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("empty") }),
            z.object({
              artifactName: z.string().trim().min(1),
              defaultBranchOnly: z.boolean().optional(),
              description: z.string().optional(),
              kind: z.literal("artifact-fork"),
            }),
          ])
          .default({ kind: "empty" }),
      }),
    },
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
  consumes: ["events.iterate.com/repo/create-requested", "events.iterate.com/repo/created"],
  emits: ["events.iterate.com/repo/created"],
});

export type RepoStreamProcessorContract = typeof RepoStreamProcessorContract;

export type RepoReducedState = z.infer<typeof RepoStreamProcessorContract.stateSchema>;
export type RepoCreateRequestedPayload = z.infer<
  (typeof RepoStreamProcessorContract.events)["events.iterate.com/repo/create-requested"]["payloadSchema"]
>;
export type RepoCreatedPayload = z.infer<
  (typeof RepoStreamProcessorContract.events)["events.iterate.com/repo/created"]["payloadSchema"]
>;

export type RepoStreamProcessorDeps = StreamProcessorDeps<
  RepoStreamProcessorContract,
  {
    createRepoArtifact(input: RepoCreateRequestedPayload): Promise<RepoCreatedPayload>;
  }
>;

export class RepoStreamProcessor extends StreamProcessor<
  RepoStreamProcessorContract,
  RepoStreamProcessorDeps
> {
  readonly contract = RepoStreamProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<RepoStreamProcessorContract>["reduce"]>[0],
  ): RepoReducedState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/repo/create-requested":
        return state;
      case "events.iterate.com/repo/created":
        return {
          ...state,
          repo: event.payload,
        };
      default:
        return state;
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<RepoStreamProcessorContract>["processEvent"]>[0],
  ): undefined {
    const { event, previousState } = args;
    if (event.type !== "events.iterate.com/repo/create-requested") return;
    if (previousState.repo !== null) return;

    args.blockProcessorWhile(async () => {
      const created = await this.deps.createRepoArtifact(event.payload);
      await this.deps.stream.append({
        event: {
          type: "events.iterate.com/repo/created",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: RepoStreamProcessorContract,
            key: "repo-created",
            sourceEvent: event,
          }),
          payload: created,
        },
      });
    });
  }
}
