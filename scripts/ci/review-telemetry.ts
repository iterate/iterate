import { durationMs, systemEvent, type PostHogEvent } from "./posthog-events.ts";

export type ReviewCheck = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
  started_at: string | null;
  details_url: string | null;
  app?: { slug?: string | null } | null;
};

export type PullReview = {
  id: number;
  state: string;
  commit_id: string | null;
  submitted_at?: string | null;
  html_url: string;
  user?: { login: string } | null;
};

export type ReviewPull = {
  number: number;
  html_url: string;
  updated_at: string;
  head: { sha: string };
};

export type ReviewThreadCounts = {
  total: number;
  unresolved: number;
  byProvider: Map<string, number>;
  unresolvedByProvider: Map<string, number>;
};

/** Maps GitHub App slugs, check names, and bot logins onto one reviewer dimension. */
export function reviewProviderKey(...identities: Array<string | null | undefined>) {
  const normalized = identities
    .filter((identity): identity is string => Boolean(identity))
    .map((identity) => identity.trim().toLowerCase());
  if (
    normalized.some((identity) =>
      ["cursor", "cursor[bot]", "bugbot", "bugbot[bot]", "cursor bugbot", "cursor-bugbot"].includes(
        identity,
      ),
    )
  ) {
    return "cursor";
  }
  if (
    normalized.some((identity) =>
      ["iterate", "iterate[bot]", "iterate review", "iterate-review"].includes(identity),
    )
  ) {
    return "iterate";
  }
  return (identities.find(Boolean) ?? "unknown")
    .toLowerCase()
    .replace(/\[bot\]$/u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

export function selectReviewSources(
  checks: readonly ReviewCheck[],
  reviews: readonly PullReview[],
  headSha: string,
) {
  return {
    checks: checks.filter((check) => {
      const identity = `${check.name} ${check.app?.slug ?? ""}`;
      const provider = reviewProviderKey(check.app?.slug, check.name);
      return (
        (provider === "cursor" || provider === "iterate") &&
        /bugbot|code.?review|iterate review/iu.test(identity)
      );
    }),
    reviews: reviews.filter(
      (review) =>
        review.commit_id === headSha &&
        /^iterate(?:\[bot\])?$/iu.test(review.user?.login ?? "") &&
        review.submitted_at,
    ),
  };
}

export function buildReviewEvents(input: {
  repository: string;
  pull: ReviewPull;
  checks: readonly ReviewCheck[];
  reviews: readonly PullReview[];
  threadCounts: ReviewThreadCounts;
  observedAt: string;
}): PostHogEvent[] {
  const { repository, pull, threadCounts } = input;
  const events: PostHogEvent[] = [];
  const providers = new Set<string>();
  for (const check of input.checks) {
    if (check.status !== "completed") continue;
    const provider = reviewProviderKey(check.app?.slug, check.name);
    providers.add(provider);
    events.push(
      systemEvent(
        "ci review finished",
        `github-review-check:${check.id}:${check.completed_at}:${check.conclusion}`,
        `ci-review:${provider}:${pull.number}:${pull.head.sha}`,
        {
          repository,
          automation_platform: "github",
          data_source: "github-checks-api",
          pull_request_number: pull.number,
          pull_request_url: pull.html_url,
          head_sha: pull.head.sha,
          review_provider: provider,
          review_name: check.name,
          review_url: check.details_url,
          status: check.status,
          conclusion: check.conclusion,
          started_at: check.started_at,
          finished_at: check.completed_at,
          duration_ms: durationMs(check.started_at, check.completed_at),
        },
        check.completed_at ?? undefined,
      ),
    );
  }

  for (const review of input.reviews) {
    const provider = reviewProviderKey(review.user?.login);
    providers.add(provider);
    events.push(
      systemEvent(
        "ci review finished",
        `github-review:${review.id}:${review.submitted_at}:${review.state}`,
        `ci-review:${provider}:${pull.number}:${pull.head.sha}`,
        {
          repository,
          automation_platform: "github",
          data_source: "github-pull-reviews-api",
          pull_request_number: pull.number,
          pull_request_url: pull.html_url,
          head_sha: pull.head.sha,
          review_provider: provider,
          review_name: "Iterate Review",
          review_url: review.html_url,
          status: "completed",
          conclusion: review.state.toLowerCase(),
          finished_at: review.submitted_at,
        },
        review.submitted_at ?? undefined,
      ),
    );
  }
  for (const provider of providers) {
    events.push(
      systemEvent(
        "ci review state observed",
        `github-review-state:${provider}:${pull.number}:${pull.head.sha}:${input.observedAt}`,
        `ci-review:${provider}:${pull.number}:${pull.head.sha}`,
        {
          repository,
          automation_platform: "github",
          data_source: "github-review-threads-api",
          pull_request_number: pull.number,
          pull_request_url: pull.html_url,
          head_sha: pull.head.sha,
          review_provider: provider,
          finding_count: threadCounts.byProvider.get(provider) ?? 0,
          unresolved_finding_count: threadCounts.unresolvedByProvider.get(provider) ?? 0,
          observed_at: input.observedAt,
        },
        input.observedAt,
      ),
    );
  }
  return events;
}
