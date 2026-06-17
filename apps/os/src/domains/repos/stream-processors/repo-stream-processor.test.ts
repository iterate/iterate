import { describe, expect, test } from "vitest";
import type { StreamEventInput } from "@iterate-com/shared/streams/stream-event";
import { RepoStreamProcessor } from "./repo-stream-processor.ts";
import type { StreamProcessorStream } from "~/domains/streams/engine/stream-processor.ts";

describe("Repo stream processor", () => {
  test("derives Repo state from events.iterate.com/repo/created", async () => {
    const processor = new RepoStreamProcessor({
      stream: { append() {}, appendBatch() {} } as unknown as StreamProcessorStream,
      createRepoArtifact: async () => {
        throw new Error("createRepoArtifact should not be called for repo/created.");
      },
    });

    await processor.ingest({
      events: [
        {
          createdAt: "2026-05-11T12:00:00.000Z",
          offset: 1,
          payload: {
            defaultBranch: "main",
            path: "/repos/banana",
            remote: "https://git.cloudflare.com/artifacts/os/project--banana.git",
            tokenExpiresAt: "2036-05-09T12:00:00.000Z",
          },
          type: "events.iterate.com/repo/created",
        },
      ],
      streamMaxOffset: 1,
    });

    expect(processor.state.repo).toEqual({
      defaultBranch: "main",
      path: "/repos/banana",
      remote: "https://git.cloudflare.com/artifacts/os/project--banana.git",
      tokenExpiresAt: "2036-05-09T12:00:00.000Z",
    });
  });

  test("turns repo/create-requested into repo/created through the artifact dependency", async () => {
    const appended: StreamEventInput[] = [];
    const processor = new RepoStreamProcessor({
      stream: {
        append(args: { event: StreamEventInput }) {
          appended.push((args as { event: StreamEventInput }).event);
        },
        appendBatch() {},
      } as unknown as StreamProcessorStream,
      createRepoArtifact: async (input) => ({
        defaultBranch: "main",
        path: input.path,
        remote: "https://git.cloudflare.com/artifacts/os/project--banana.git",
        tokenExpiresAt: null,
      }),
    });

    await processor.ingest({
      events: [
        {
          createdAt: "2026-05-11T12:00:00.000Z",
          offset: 1,
          payload: {
            path: "/repos/banana",
            source: { kind: "empty" },
          },
          type: "events.iterate.com/repo/create-requested",
        },
      ],
      streamMaxOffset: 1,
    });

    expect(appended).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/repo/created",
        idempotencyKey: "repo/repo-created@1",
        payload: {
          defaultBranch: "main",
          path: "/repos/banana",
          remote: "https://git.cloudflare.com/artifacts/os/project--banana.git",
          tokenExpiresAt: null,
        },
      }),
    ]);
  });
});
