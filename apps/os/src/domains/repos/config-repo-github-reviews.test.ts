import { describe, expect, it, vi } from "vitest";
import { StreamProcessorRunner, type Stream, type StreamEvent } from "iterate/sdk";
import {
  GithubReviewProcessor,
  githubReviewDispatch,
  type GithubReviewConfig,
} from "../../../config-repo-template/github-reviews.ts";

const REPO_ROUTE = `g~${"a".repeat(64)}`;
const REVIEW_PATH = `/agents/repos/${REPO_ROUTE}/pull-requests/7`;

const CONFIG = {
  forceLabel: "iterate:review",
  repositories: ["acme/widgets"],
  rules: [
    {
      id: "structure/no-small-single-use-helper",
      files: ["**/*.ts"],
      invariant: "Keep small single-use logic at its call site.",
    },
  ],
  skipLabel: "iterate:skip-review",
} satisfies GithubReviewConfig;

function webhook(input?: {
  action?: string;
  changedLabel?: string;
  connection?: string | null;
  draft?: boolean;
  headSha?: string;
  labels?: string[];
  offset?: number;
  pathNumber?: number;
  state?: "closed" | "open";
}) {
  const number = 7;
  return {
    createdAt: "2026-07-14T08:00:00.000Z",
    offset: input?.offset ?? 4,
    path: `/agents/repos/${REPO_ROUTE}/pull-requests/${input?.pathNumber ?? number}`,
    type: "events.iterate.com/github/webhook-received",
    payload: {
      appSlug: "iterate-preview",
      ...(input?.connection === null ? {} : { connection: input?.connection ?? "install-42" }),
      installationId: "42",
      body: {
        action: input?.action ?? "opened",
        ...(input?.changedLabel === undefined ? {} : { label: { name: input.changedLabel } }),
        repository: { full_name: "acme/widgets" },
        pull_request: {
          draft: input?.draft ?? false,
          head: { sha: input?.headSha ?? "head-b" },
          labels: (input?.labels ?? []).map((name) => ({ name })),
          number,
          state: input?.state ?? "open",
        },
      },
    },
  };
}

function reviewRequested(source = webhook(), offset = 5) {
  const dispatch = githubReviewDispatch(source, CONFIG);
  if (dispatch === null) throw new Error("test request source must be reviewable");
  return {
    createdAt: "2026-07-14T08:00:00.500Z",
    offset,
    path: REVIEW_PATH,
    type: "events.iterate.com/github-review/requested",
    payload: { target: dispatch.target },
  };
}

function processorHarness() {
  const append = vi.fn().mockResolvedValue([]);
  // The runtime calls only `append` in this focused test. Implementing every
  // RPC method on Stream would obscure that boundary, so this cast narrows the
  // deliberate fake to the one capability the processor exercises.
  const stream = { append } as unknown as Stream;
  const processor = new GithubReviewProcessor({
    config: CONFIG,
    path: REVIEW_PATH,
    projectId: "prj_test",
    stream,
  });
  return { append, runner: new StreamProcessorRunner({ processor, stream }) };
}

async function deliver(
  runner: ReturnType<typeof processorHarness>["runner"],
  events: StreamEvent[],
  streamMaxOffset = events.at(-1)?.offset ?? 0,
) {
  const opened = await runner.openDelivery();
  await opened.sink({
    events,
    scannedAfterOffset: opened.checkpointOffset,
    scannedThroughOffset: streamMaxOffset,
    streamMaxOffset,
  });
}

describe("config-repo GitHub reviews", () => {
  it("dispatches one attributed interrupt to the persistent pull-request agent", async () => {
    const { append, runner } = processorHarness();
    await deliver(runner, [reviewRequested()]);

    await expect(runner.snapshot()).resolves.toEqual({ offset: 5, state: {} });
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith({
      idempotencyKey: "github-review/task:head:head-b",
      payload: {
        actor: { type: "github" },
        content: expect.stringMatching(
          /acme\/widgets pull request #7[\s\S]+structure\/no-small-single-use-helper/,
        ),
        llmRequestPolicy: { behaviour: "interrupt-current-request" },
        role: "developer",
      },
      source: {
        processor: {
          slug: "github-review",
          stream: { path: REVIEW_PATH, projectId: "prj_test" },
          version: "0.1.0",
          whileProcessing: {
            offset: 5,
            type: "events.iterate.com/github-review/requested",
          },
        },
      },
      type: "events.iterate.com/agents/context-added",
    });
  });

  it("does not strand a request behind an unrelated agent event", async () => {
    const { append, runner } = processorHarness();
    await deliver(
      runner,
      [
        reviewRequested(),
        {
          createdAt: "2026-07-14T08:00:01.000Z",
          offset: 6,
          path: REVIEW_PATH,
          type: "events.iterate.com/agents/context-added",
          payload: {},
        },
      ],
      6,
    );

    expect(append).toHaveBeenCalledOnce();
    await expect(runner.snapshot()).resolves.toEqual({ offset: 6, state: {} });
  });

  it("keeps burst ordering so the newest push supplies the final interrupt", async () => {
    const { append, runner } = processorHarness();
    await deliver(runner, [
      reviewRequested(webhook({ headSha: "head-b", offset: 2 }), 3),
      reviewRequested(webhook({ headSha: "head-c", offset: 4 }), 5),
    ]);

    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls.map(([event]) => event.idempotencyKey)).toEqual([
      "github-review/task:head:head-b",
      "github-review/task:head:head-c",
    ]);
    expect(append.mock.calls[1]?.[0].payload.content).toContain("requested head head-c");
  });

  it("turns cancellation into an interrupt that cannot ask for a review", async () => {
    const { append, runner } = processorHarness();
    await deliver(runner, [reviewRequested(webhook({ action: "closed", offset: 10 }), 11)]);

    const content = append.mock.calls[0]?.[0].payload.content;
    expect(content).toContain("structural review cancellation");
    expect(content).toContain("Do not inspect the diff or publish a GitHub review");
    expect(content).not.toContain("Configured rules:");
  });

  it("derives the canonical PR target and a head-stable automatic request", () => {
    const dispatch = githubReviewDispatch(webhook(), CONFIG);
    expect(dispatch?.target).toEqual({
      appSlug: "iterate-preview",
      connection: "install-42",
      fullName: "acme/widgets",
      headSha: "head-b",
      number: 7,
      owner: "acme",
      repo: "widgets",
      requestKey: "head:head-b",
      reviewAgentPath: REVIEW_PATH,
      trigger: "automatic",
    });
    expect(dispatch?.inputs).toEqual([
      {
        idempotencyKey: `github-review/subscription@${REVIEW_PATH}`,
        payload: {
          delivery: {
            expression: [
              "workers",
              [
                "get",
                {
                  className: "GithubReviewProcessorDurableObject",
                  durableWorkerKey: "github-review-processor",
                  path: REVIEW_PATH,
                  source: {
                    files: { repoPath: "/repos/config", type: "repo" },
                    options: { entryPoint: "worker.ts" },
                  },
                  type: "stateful",
                },
              ],
              "wakeStreamSubscriber",
            ],
            mode: "wake",
            processorSlug: "github-review",
          },
          subscriptionKey: "userspace/github-review",
        },
        type: "events.iterate.com/stream/subscription-configured",
      },
      {
        idempotencyKey: "github-review/requested:head:head-b",
        payload: { target: dispatch?.target },
        type: "events.iterate.com/github-review/requested",
      },
    ]);
  });

  it("accepts explicit label controls and gives each request its own key", () => {
    expect(
      githubReviewDispatch(
        webhook({ action: "labeled", changedLabel: "ITERATE:REVIEW", offset: 8 }),
        CONFIG,
      )?.target,
    ).toMatchObject({ requestKey: "request:8", trigger: "explicit" });
    expect(
      githubReviewDispatch(
        webhook({ action: "unlabeled", changedLabel: "ITERATE:SKIP-REVIEW", offset: 9 }),
        CONFIG,
      )?.target,
    ).toMatchObject({ requestKey: "request:9", trigger: "explicit" });
  });

  it.each([
    { action: "closed", offset: 10 },
    { action: "converted_to_draft", offset: 11 },
    {
      action: "labeled",
      changedLabel: "iterate:skip-review",
      labels: ["iterate:skip-review"],
      offset: 12,
    },
  ])("turns $action into an interrupting cancellation", (input) => {
    expect(githubReviewDispatch(webhook(input), CONFIG)?.target).toMatchObject({
      requestKey: `cancel:${input.offset}`,
      trigger: "cancel",
    });
  });

  it("ignores ineligible, malformed, and noncanonical webhook events", () => {
    expect(githubReviewDispatch(webhook({ labels: [CONFIG.skipLabel] }), CONFIG)).toBeNull();
    expect(githubReviewDispatch(webhook({ draft: true }), CONFIG)).toBeNull();
    expect(githubReviewDispatch(webhook({ action: "edited" }), CONFIG)).toBeNull();
    expect(githubReviewDispatch(webhook({ pathNumber: 8 }), CONFIG)).toBeNull();

    expect(githubReviewDispatch(webhook({ connection: null }), CONFIG)).toBeNull();
  });
});
