import { describe, expect, test } from "vitest";
import { reduceRepoStreamEvents, repoStreamPath } from "./repo-stream-processor.ts";

describe("Repo stream processor", () => {
  test("derives Repo state from events.iterate.com/repo/created", () => {
    const state = reduceRepoStreamEvents({
      events: [
        {
          createdAt: "2026-05-11T12:00:00.000Z",
          offset: 1,
          payload: {
            defaultBranch: "main",
            remote: "https://git.cloudflare.com/artifacts/os2/project--banana.git",
            slug: "banana",
            tokenExpiresAt: "2036-05-09T12:00:00.000Z",
          },
          streamPath: repoStreamPath("banana"),
          type: "events.iterate.com/repo/created",
        },
      ],
    });

    expect(state.repo).toEqual({
      defaultBranch: "main",
      remote: "https://git.cloudflare.com/artifacts/os2/project--banana.git",
      slug: "banana",
      tokenExpiresAt: "2036-05-09T12:00:00.000Z",
    });
  });
});
