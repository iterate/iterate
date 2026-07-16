import { describe, expect, it } from "vitest";
import type { StreamEvent } from "iterate/sdk";
import {
  githubReviewDispatch,
  type GithubReviewConfig,
} from "../../../config-repo-template/github-reviews.ts";

const REPO_ID = `g~${"a".repeat(64)}`;
const CONFIG = {
  forceLabel: "iterate:review",
  repositories: ["acme/widgets"],
  rules: [
    {
      id: "typescript/explain-type-cast",
      files: ["**/*.ts"],
      invariant: "Explain every cast.",
    },
  ],
  skipLabel: "iterate:skip-review",
} satisfies GithubReviewConfig;

function webhook(input?: {
  action?: string;
  appSlug?: string;
  changedLabel?: string;
  draft?: boolean;
  fullName?: string;
  headSha?: string;
  installationId?: string;
  labels?: string[];
  number?: number;
  offset?: number;
  path?: string;
  state?: "closed" | "open";
  type?: string;
}): StreamEvent {
  const number = input?.number ?? 7;
  return {
    createdAt: "2026-07-16T08:00:00.000Z",
    offset: input?.offset ?? 4,
    path: input?.path ?? `/agents/repos/${REPO_ID}/pull-requests/${number}`,
    type: input?.type ?? "events.iterate.com/github/webhook-received",
    payload: {
      ...(input?.appSlug === "" ? {} : { appSlug: input?.appSlug ?? "iterate-preview" }),
      body: {
        action: input?.action ?? "opened",
        ...(input?.changedLabel === undefined ? {} : { label: { name: input.changedLabel } }),
        repository: { full_name: input?.fullName ?? "acme/widgets" },
        pull_request: {
          draft: input?.draft ?? false,
          head: { sha: input?.headSha ?? "head-b" },
          labels: (input?.labels ?? []).map((name) => ({ name })),
          number,
          state: input?.state ?? "open",
        },
      },
      installationId: input?.installationId ?? "115079265",
    },
  };
}

function task(event: StreamEvent) {
  const dispatch = githubReviewDispatch(event, CONFIG);
  if (dispatch === null) throw new Error("expected a review dispatch");
  return dispatch;
}

describe("config-repo GitHub structural reviews", () => {
  it("turns an eligible webhook into one attributed task on the existing PR stream", () => {
    const event = webhook();
    const dispatch = task(event);

    expect(dispatch.path).toBe(event.path);
    expect(dispatch.input).toMatchObject({
      type: "events.iterate.com/agents/context-added",
      idempotencyKey: "github-review/task:head:head-b",
      payload: {
        actor: { type: "github" },
        llmRequestPolicy: { behaviour: "interrupt-current-request" },
        refs: [
          {
            eventType: event.type,
            offset: event.offset,
            streamPath: event.path,
            type: "event",
          },
        ],
        role: "developer",
      },
    });

    const content = dispatch.input.payload?.content;
    expect(content).toEqual(expect.any(String));
    expect(content).toContain("trusted `github/route-context`");
    expect(content).toContain("requested head head-b");
    expect(content).toContain('"id": "typescript/explain-type-cast"');
    expect(content).toContain('"files": [');
    expect(content).toContain("iterate-lint-disable-next-line <rule-id> -- <reason>");
    expect(content).toContain("trusted human's explicit disposition");
    expect(content).toContain("<!-- iterate-ai-lint:115079265:head:head-b -->");
    expect(content).toContain("iterate-preview[bot]");
    expect(content).toContain("exactly one consolidated COMMENT review");
  });

  it("deduplicates automatic retries by head while explicit requests remain distinct", () => {
    expect(task(webhook({ offset: 4 })).input.idempotencyKey).toBe(
      task(webhook({ offset: 99 })).input.idempotencyKey,
    );

    expect(
      task(webhook({ action: "labeled", changedLabel: "ITERATE:REVIEW", offset: 12 })).input
        .idempotencyKey,
    ).toBe("github-review/task:request:12");
    expect(
      task(webhook({ action: "unlabeled", changedLabel: "ITERATE:SKIP-REVIEW", offset: 13 })).input
        .idempotencyKey,
    ).toBe("github-review/task:request:13");
  });

  it("interrupts obsolete review work when the PR is disabled", () => {
    const closed = task(webhook({ action: "closed", offset: 20 }));
    expect(closed.input.idempotencyKey).toBe("github-review/task:cancel:20");
    expect(closed.input.payload?.content).toContain("structural-review cancellation");
    expect(closed.input.payload?.content).toContain("Do not inspect the diff");

    const skipped = task(
      webhook({
        action: "labeled",
        changedLabel: "iterate:skip-review",
        labels: ["iterate:skip-review"],
        offset: 21,
      }),
    );
    expect(skipped.input.idempotencyKey).toBe("github-review/task:cancel:21");
  });

  it.each([
    ["wrong event type", webhook({ type: "example.test/other" })],
    ["noncanonical stream", webhook({ path: "/agents/repos/route/pull-requests/7" })],
    ["nested stream", webhook({ path: `/agents/repos/${REPO_ID}/pull-requests/7/reviews` })],
    ["mismatched PR number", webhook({ path: `/agents/repos/${REPO_ID}/pull-requests/8` })],
    ["unconfigured repository", webhook({ fullName: "acme/other" })],
    ["draft PR", webhook({ draft: true })],
    ["closed PR without a cancellation action", webhook({ state: "closed" })],
    ["already skipped PR", webhook({ labels: ["ITERATE:SKIP-REVIEW"] })],
    ["unrelated action", webhook({ action: "edited" })],
    ["missing routed installation", webhook({ installationId: "" })],
  ])("ignores %s", (_name, event) => {
    expect(githubReviewDispatch(event, CONFIG)).toBeNull();
  });

  it("fails closed on malformed webhook data", () => {
    const event = webhook();
    event.payload = { body: { action: "opened" } };
    expect(githubReviewDispatch(event, CONFIG)).toBeNull();
  });

  it("still dispatches when the optional App slug is absent", () => {
    const content = task(webhook({ appSlug: "" })).input.payload?.content;
    expect(content).toContain("authenticated GitHub App bot named by the trusted route");
  });
});
