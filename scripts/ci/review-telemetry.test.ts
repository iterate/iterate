import { describe, expect, it } from "vitest";
import {
  buildReviewEvents,
  reviewProviderKey,
  selectReviewSources,
  type PullReview,
} from "./review-telemetry.ts";

const headSha = "abcdef";
const iterateReview: PullReview = {
  id: 101,
  state: "COMMENTED",
  commit_id: headSha,
  submitted_at: "2026-07-21T12:00:00Z",
  html_url: "https://example.test/review/101",
  user: { login: "iterate[bot]" },
};

describe("review telemetry", () => {
  it("retains Iterate Review when the pull request has no review check-run", () => {
    const sources = selectReviewSources([], [iterateReview], headSha);
    const events = buildReviewEvents({
      repository: "iterate/iterate",
      pull: {
        number: 42,
        html_url: "https://example.test/pull/42",
        updated_at: "2026-07-21T12:01:00Z",
        head: { sha: headSha },
      },
      ...sources,
      observedAt: "2026-07-21T12:01:30Z",
      threadCounts: {
        total: 2,
        unresolved: 1,
        byProvider: new Map([["iterate", 2]]),
        unresolvedByProvider: new Map([["iterate", 1]]),
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event: "ci review finished",
      timestamp: "2026-07-21T12:00:00Z",
    });
    expect(events[1]?.properties).toEqual(
      expect.objectContaining({
        data_source: "github-review-threads-api",
        review_provider: "iterate",
        finding_count: 2,
        unresolved_finding_count: 1,
      }),
    );
    expect(events[1]?.timestamp).toBe("2026-07-21T12:01:30Z");
  });

  it("does not mistake a human login containing iterate for Iterate Review", () => {
    const sources = selectReviewSources(
      [],
      [{ ...iterateReview, id: 102, user: { login: "iterate-maintainer" } }],
      headSha,
    );

    expect(sources.reviews).toEqual([]);
    expect(reviewProviderKey("iterate-maintainer")).toBe("iterate-maintainer");
    expect(reviewProviderKey("cursor-bugbot-maintainer")).toBe("cursor-bugbot-maintainer");
  });

  it("attributes findings to normalized reviewer identities instead of all threads", () => {
    expect(reviewProviderKey("iterate[bot]")).toBe("iterate");
    expect(reviewProviderKey("cursor", "Cursor Bugbot")).toBe("cursor");
    const sources = selectReviewSources(
      [
        {
          id: 202,
          name: "Cursor Bugbot",
          status: "completed",
          conclusion: "neutral",
          completed_at: "2026-07-21T12:00:03Z",
          started_at: "2026-07-21T12:00:01Z",
          details_url: "https://example.test/check/202",
          app: { slug: "cursor" },
        },
      ],
      [iterateReview],
      headSha,
    );
    const events = buildReviewEvents({
      repository: "iterate/iterate",
      pull: {
        number: 42,
        html_url: "https://example.test/pull/42",
        updated_at: "2026-07-21T12:01:00Z",
        head: { sha: headSha },
      },
      ...sources,
      observedAt: "2026-07-21T12:01:30Z",
      threadCounts: {
        total: 3,
        unresolved: 2,
        byProvider: new Map([
          ["cursor", 1],
          ["iterate", 2],
        ]),
        unresolvedByProvider: new Map([
          ["cursor", 1],
          ["iterate", 1],
        ]),
      },
    });

    expect(
      events
        .filter((event) => event.event === "ci review state observed")
        .map((event) => event.properties.finding_count),
    ).toEqual([1, 2]);
  });
});
