import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import { StreamProcessor } from "../streams/engine/stream-processor.ts";

export const RepoProcessorContract = defineProcessorContract({
  slug: "repo",
  version: "0.1.0",
  description: "Tiny fake repo projection for the ITX reference implementation.",
  stateSchema: z.object({
    artifactName: z.string().nullable().default(null),
    created: z.boolean().default(false),
    defaultBranch: z.string().nullable().default(null),
    initialized: z.boolean().default(false),
    remote: z.string().nullable().default(null),
  }),
  initialState: {
    artifactName: null,
    created: false,
    defaultBranch: null,
    initialized: false,
    remote: null,
  },
  events: {
    "events.iterate.com/repo/create-requested": {
      description: "A repo creation was requested.",
      payloadSchema: z.object({
        projectId: z.string(),
        path: z.string(),
      }),
    },
    "events.iterate.com/repo/created": {
      description: "The repo was created.",
      payloadSchema: z.object({
        artifactName: z.string(),
        defaultBranch: z.string(),
        path: z.string(),
        projectId: z.string(),
        remote: z.string(),
      }),
    },
    "events.iterate.com/stream/created": {
      description: "The repo stream exists.",
      payloadSchema: z.looseObject({}),
    },
  },
  consumes: [
    "events.iterate.com/repo/create-requested",
    "events.iterate.com/repo/created",
    "events.iterate.com/stream/created",
  ],
  emits: ["events.iterate.com/repo/created"],
});

type RepoProcessorDeps = {
  createRepoArtifact(input: { path: string; projectId: string }): Promise<{
    artifactName: string;
    defaultBranch: string;
    remote: string;
  }>;
  path: string;
  projectId: string;
};

export class RepoProcessor extends StreamProcessor<
  typeof RepoProcessorContract,
  RepoProcessorDeps
> {
  readonly contract = RepoProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof RepoProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/repo/created":
        return {
          ...state,
          artifactName: event.payload.artifactName,
          created: true,
          defaultBranch: event.payload.defaultBranch,
          remote: event.payload.remote,
        };
      case "events.iterate.com/stream/created":
        return { ...state, initialized: true };
      default:
        return state;
    }
  }

  protected override processEvent({
    blockProcessorWhile,
    event,
    state,
    append,
  }: Parameters<StreamProcessor<typeof RepoProcessorContract>["processEvent"]>[0]): undefined {
    if (event.type !== "events.iterate.com/repo/create-requested") return;
    if (event.payload.projectId !== this.deps.projectId || event.payload.path !== this.deps.path) {
      throw new Error(
        `repo/create-requested for "${event.payload.projectId}:${event.payload.path}" on repo "${this.deps.projectId}:${this.deps.path}"`,
      );
    }
    if (state.created) return;

    blockProcessorWhile(async () => {
      const payload = await this.deps.createRepoArtifact(event.payload);
      append({
        type: "events.iterate.com/repo/created",
        idempotencyKey: `repo-created:${this.deps.projectId}:${this.deps.path}`,
        payload: {
          ...payload,
          path: this.deps.path,
          projectId: this.deps.projectId,
        },
      });
    });
  }
}
