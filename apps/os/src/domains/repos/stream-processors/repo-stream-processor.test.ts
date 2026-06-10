import { describe, expect, test } from "vitest";
import { RepoStreamProcessor } from "./repo-stream-processor.ts";

const iterateContext = () => ({ stream: { append() {}, appendBatch() {} } });

describe("Repo stream processor", () => {
  test("derives Repo state from events.iterate.com/repo/created", async () => {
    const processor = new RepoStreamProcessor({ iterateContext: iterateContext() });

    await processor.ingest({
      events: [
        {
          createdAt: "2026-05-11T12:00:00.000Z",
          offset: 1,
          payload: {
            defaultBranch: "main",
            remote: "https://git.cloudflare.com/artifacts/os/project--banana.git",
            slug: "banana",
            tokenExpiresAt: "2036-05-09T12:00:00.000Z",
          },
          type: "events.iterate.com/repo/created",
        },
      ],
      streamMaxOffset: 1,
    });

    expect(processor.state.repo).toEqual({
      defaultBranch: "main",
      remote: "https://git.cloudflare.com/artifacts/os/project--banana.git",
      slug: "banana",
      tokenExpiresAt: "2036-05-09T12:00:00.000Z",
    });
  });
});
