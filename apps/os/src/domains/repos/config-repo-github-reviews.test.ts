import { describe, expect, it, vi } from "vitest";
import {
  StreamProcessorRunner,
  type Project,
  type Stream,
  type StreamEvent,
  type StreamEventInput,
} from "iterate/sdk";
import {
  GithubReviewProcessor,
  githubReviewTarget,
  processGithubReviewEvent,
  type GithubReviewConfig,
} from "../../../config-repo-template/github-reviews.ts";

const REPO_ROUTE = `g~${"a".repeat(64)}`;
const REVIEW_PATH = `/agents/repos/${REPO_ROUTE}/pull-requests/7`;
const REVIEW_DETAILS_URL = `https://os.iterate.test/projects/widgets-project/agents/streams${REVIEW_PATH}`;

const CONFIG: GithubReviewConfig = {
  forceLabel: "iterate:review",
  osBaseUrl: "https://os.iterate.test",
  repositories: ["acme/widgets"],
  rules: [
    {
      id: "structure/no-small-single-use-helper",
      files: ["**/*.ts"],
      invariant: "Keep small single-use logic at its call site.",
    },
  ],
  skipLabel: "iterate:skip-review",
  timeoutSeconds: 1_800,
};

function webhook(input?: {
  action?: string;
  before?: string;
  changedLabel?: string;
  headSha?: string;
  labels?: string[];
  offset?: number;
  pathNumber?: number;
  state?: "closed" | "open";
}): StreamEvent {
  const number = 7;
  return {
    createdAt: "2026-07-14T08:00:00.000Z",
    offset: input?.offset ?? 4,
    path: `/agents/repos/${REPO_ROUTE}/pull-requests/${input?.pathNumber ?? number}`,
    type: "events.iterate.com/github/webhook-received",
    payload: {
      appSlug: "iterate-preview",
      connection: "install-42",
      installationId: "42",
      body: {
        action: input?.action ?? "opened",
        ...(input?.before === undefined ? {} : { before: input.before }),
        ...(input?.changedLabel === undefined ? {} : { label: { name: input.changedLabel } }),
        repository: { full_name: "acme/widgets" },
        pull_request: {
          draft: false,
          head: { sha: input?.headSha ?? "head-b" },
          labels: (input?.labels ?? []).map((name) => ({ name })),
          number,
          state: input?.state ?? "open",
        },
      },
    },
  };
}

function reviewRequested(source = webhook(), offset = 5): StreamEvent {
  const target = githubReviewTarget(source, CONFIG);
  if (target === null) throw new Error("test request source must be reviewable");
  return {
    createdAt: "2026-07-14T08:00:00.500Z",
    offset,
    path: REVIEW_PATH,
    type: "events.iterate.com/github-review/requested",
    payload: { sourceOffset: source.offset, target },
  };
}

function harness(input?: {
  agentBirthCertificate?: unknown | null;
  checkRuns?: (args: { page: number; ref: string }) => unknown[];
  liveDraft?: boolean;
  liveHead?: string;
  liveLabels?: string[];
  liveState?: "closed" | "open";
  update?: ReturnType<typeof vi.fn>;
}) {
  let nextCheckId = 100;
  const append = vi.fn().mockResolvedValue([]);
  const cancel = vi.fn().mockResolvedValue(undefined);
  const create = vi.fn().mockImplementation((args: { external_id: string; head_sha: string }) =>
    Promise.resolve({
      data: {
        app: { slug: "iterate-preview" },
        external_id: args.external_id,
        head_sha: args.head_sha,
        html_url: `https://github.test/checks/${nextCheckId}`,
        id: nextCheckId++,
        started_at: "2026-07-14T08:00:00.000Z",
        status: "in_progress",
      },
    }),
  );
  const listForRef = vi.fn().mockImplementation((args: { page: number; ref: string }) => {
    const checks = input?.checkRuns?.(args) ?? [];
    return Promise.resolve({
      data: {
        check_runs: checks.map((check) => ({
          started_at: "2026-07-14T08:00:00.000Z",
          ...(check as object),
        })),
      },
    });
  });
  const update = input?.update ?? vi.fn().mockResolvedValue({ data: {} });
  const octokit = {
    rest: {
      checks: { create, listForRef, update },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            draft: input?.liveDraft ?? false,
            head: { sha: input?.liveHead ?? "head-b" },
            labels: (input?.liveLabels ?? []).map((name) => ({ name })),
            state: input?.liveState ?? "open",
          },
        }),
      },
    },
  };
  const getConnection = vi.fn(() => ({ octokit }));
  const createAgent = vi.fn().mockResolvedValue(undefined);
  const snapshotAgent = vi.fn().mockResolvedValue({
    state: { birthCertificate: input?.agentBirthCertificate ?? null },
  });
  const getAgent = vi.fn(() => ({
    create: createAgent,
    processor: { snapshot: snapshotAgent },
  }));
  const set = vi.fn().mockResolvedValue({});
  const itx = {
    agents: { get: getAgent },
    integrations: { github: { get: getConnection } },
    // Scalar Workers RPC properties are promises at the caller even though
    // the generated project surface describes their resolved value.
    projectId: Promise.resolve("prj_test"),
    processor: {
      snapshot: vi.fn().mockResolvedValue({
        offset: 1,
        state: { birthCertificate: { config: { slug: "widgets-project" } } },
      }),
    },
    scheduler: { cancel, set },
  } as unknown as Project;
  return {
    append,
    cancel,
    create,
    createAgent,
    getConnection,
    getAgent,
    itx,
    listForRef,
    set,
    snapshotAgent,
    update,
  };
}

function processorHarness(input?: {
  config?: GithubReviewConfig;
  github?: ReturnType<typeof harness>;
  stream?: Stream;
}) {
  const github = input?.github ?? harness();
  const streamAppend = vi.fn().mockResolvedValue([]);
  const stream =
    input?.stream ??
    // These focused processor tests exercise only home-stream appends. The
    // partial fake deliberately omits unrelated paging and subscription RPCs.
    ({ append: streamAppend } as unknown as Stream);
  const processor = new GithubReviewProcessor({
    config: input?.config ?? CONFIG,
    itx: github.itx,
    path: REVIEW_PATH,
    projectId: "prj_test",
    stream,
  });
  return {
    github,
    processor,
    runner: new StreamProcessorRunner({ processor, stream }),
    streamAppend,
  };
}

async function deliver(
  runner: ReturnType<typeof processorHarness>["runner"],
  events: StreamEvent[],
  streamMaxOffset = events.at(-1)?.offset ?? 0,
): Promise<void> {
  const opened = await runner.openDelivery();
  await opened.sink({
    events,
    scannedAfterOffset: opened.checkpointOffset,
    scannedThroughOffset: streamMaxOffset,
    streamMaxOffset,
  });
}

describe("config-repo GitHub reviews", () => {
  it("folds a durable obligation and stamps its reconciled task and completion", async () => {
    const { runner, streamAppend } = processorHarness();
    await deliver(runner, [reviewRequested()]);

    await expect(runner.snapshot()).resolves.toEqual({
      offset: 5,
      state: {
        pendingRequests: [
          {
            sourceOffset: 4,
            target: {
              appSlug: "iterate-preview",
              connection: "install-42",
              fullName: "acme/widgets",
              headSha: "head-b",
              installationId: "42",
              number: 7,
              owner: "acme",
              repo: "widgets",
              requestKey: "head:head-b",
              reviewAgentPath: REVIEW_PATH,
              trigger: "automatic",
            },
          },
        ],
      },
    });
    expect(streamAppend).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: "iterate-review:prj_test:42:7:head:head-b",
        source: {
          processor: {
            slug: "github-review",
            version: "0.3.0",
            stream: { path: REVIEW_PATH, projectId: "prj_test" },
            whileProcessing: {
              offset: 5,
              type: "events.iterate.com/github-review/requested",
            },
          },
        },
        type: "events.iterate.com/agents/message-received",
      }),
    );
    expect(streamAppend).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: "github-review/request-processed:4:head:head-b",
        payload: {
          requestKey: "head:head-b",
          result: "queued",
          sourceOffset: 4,
        },
        source: {
          processor: {
            slug: "github-review",
            version: "0.3.0",
            stream: { path: REVIEW_PATH, projectId: "prj_test" },
            whileProcessing: {
              offset: 5,
              type: "events.iterate.com/github-review/requested",
            },
          },
        },
        type: "events.iterate.com/github-review/request-processed",
      }),
    );
  });

  it("ignores a checkpointed request after its repository is removed from config", async () => {
    const h = harness();
    const { runner, streamAppend } = processorHarness({
      config: { ...CONFIG, repositories: [] },
      github: h,
    });
    await deliver(runner, [reviewRequested()]);

    expect(h.getConnection).not.toHaveBeenCalled();
    expect(h.createAgent).not.toHaveBeenCalled();
    expect(streamAppend).toHaveBeenCalledOnce();
    expect(streamAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          requestKey: "head:head-b",
          result: "ignored",
          sourceOffset: 4,
        },
        type: "events.iterate.com/github-review/request-processed",
      }),
    );
  });

  it("preserves every review request appended before the first wake", async () => {
    const h = harness({ liveHead: "head-c" });
    const { runner, streamAppend } = processorHarness({ github: h });
    const triggeringWebhook = webhook({ headSha: "head-b", offset: 2 });
    const interleavedWebhook = webhook({ headSha: "head-c", offset: 4 });
    await deliver(runner, [
      reviewRequested(triggeringWebhook, 3),
      reviewRequested(interleavedWebhook, 5),
    ]);

    expect(h.getConnection).toHaveBeenCalledTimes(2);
    expect(streamAppend).toHaveBeenCalledTimes(3);
    expect(streamAppend).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        payload: expect.objectContaining({ result: "stale", sourceOffset: 2 }),
        type: "events.iterate.com/github-review/request-processed",
      }),
    );
    expect(streamAppend).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: "iterate-review:prj_test:42:7:head:head-c",
        type: "events.iterate.com/agents/message-received",
      }),
    );
    expect(streamAppend).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        payload: expect.objectContaining({ result: "queued", sourceOffset: 4 }),
        type: "events.iterate.com/github-review/request-processed",
      }),
    );
  });

  it("refolds a completed review journal without touching GitHub or appending events", async () => {
    const firstHarness = harness();
    const journal = [reviewRequested()];
    let nextOffset = 6;
    const appendToJournal = vi.fn(async (...inputs: StreamEventInput[]): Promise<StreamEvent[]> => {
      const committed = inputs.map(
        (input): StreamEvent => ({
          ...input,
          createdAt: "2026-07-14T08:00:01.000Z",
          offset: nextOffset++,
          path: REVIEW_PATH,
        }),
      );
      journal.push(...committed);
      return committed;
    });
    const stream = { append: appendToJournal } as unknown as Stream;
    const { runner: firstRunner } = processorHarness({
      github: firstHarness,
      stream,
    });

    await deliver(firstRunner, [...journal], 5);
    expect(journal.map((event) => event.type)).toEqual([
      "events.iterate.com/github-review/requested",
      "events.iterate.com/agents/message-received",
      "events.iterate.com/github-review/request-processed",
    ]);
    await deliver(firstRunner, journal.slice(1), 7);
    await expect(firstRunner.snapshot()).resolves.toEqual({
      offset: 7,
      state: { pendingRequests: [] },
    });

    const refoldHarness = harness();
    const refoldAppend = vi.fn().mockResolvedValue([]);
    const { runner: refoldedRunner } = processorHarness({
      github: refoldHarness,
      stream: { append: refoldAppend } as unknown as Stream,
    });
    await deliver(refoldedRunner, journal, 7);

    await expect(refoldedRunner.snapshot()).resolves.toEqual({
      offset: 7,
      state: { pendingRequests: [] },
    });
    expect(refoldHarness.getConnection).not.toHaveBeenCalled();
    expect(refoldAppend).not.toHaveBeenCalled();
  });

  it("uses routed authority, arms a terminalizer, and queues one trusted task", async () => {
    const h = harness();

    await expect(
      processGithubReviewEvent({
        appendAgentMessage: h.append,
        config: CONFIG,
        event: webhook(),
        itx: h.itx,
      }),
    ).resolves.toBe("queued");

    expect(h.getConnection).toHaveBeenCalledWith("install-42");
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        external_id: "iterate-review:prj_test:42:7:head:head-b",
        head_sha: "head-b",
      }),
    );
    expect(h.set).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "github-review-timeout:100",
        recurrence: { at: "2026-07-14T08:30:00.000Z" },
        script: expect.stringContaining('get("install-42").octokit'),
      }),
    );
    const task = h.append.mock.calls[0]!.at(-1) as {
      idempotencyKey: string;
      payload: { content: string; llmRequestPolicy: object };
    };
    expect(task.idempotencyKey).toBe("iterate-review:prj_test:42:7:head:head-b");
    expect(h.getAgent).toHaveBeenCalledWith(REVIEW_PATH);
    expect(h.createAgent).toHaveBeenCalledWith({});
    expect(h.snapshotAgent).toHaveBeenCalledOnce();
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 100,
        details_url: REVIEW_DETAILS_URL,
      }),
    );
    // The task prompt's guidance prose is deliberately unpinned
    // (docs/testing.md: prompt-copy pinning); the check-run id riding into
    // the task is proven structurally instead.
    expect(task.payload.content).toContain("100");
    expect(task.payload.content).toContain('"structure/no-small-single-use-helper"');
    expect(task.payload.llmRequestPolicy).toEqual({ behaviour: "interrupt-current-request" });
  });

  it("reuses an already-created review agent on webhook redelivery", async () => {
    const h = harness({ agentBirthCertificate: { config: {} } });

    await expect(
      processGithubReviewEvent({
        appendAgentMessage: h.append,
        config: CONFIG,
        event: webhook(),
        itx: h.itx,
      }),
    ).resolves.toBe("queued");

    expect(h.snapshotAgent).toHaveBeenCalledOnce();
    expect(h.createAgent).not.toHaveBeenCalled();
    expect(h.append).toHaveBeenCalledOnce();
  });

  it("does not extend the Check Run deadline when a webhook is redelivered", async () => {
    const h = harness({
      checkRuns: () => [
        {
          app: { slug: "iterate-preview" },
          external_id: "iterate-review:prj_test:42:7:head:head-b",
          html_url: "https://github.test/checks/44",
          id: 44,
          status: "in_progress",
        },
      ],
    });

    await processGithubReviewEvent({
      appendAgentMessage: h.append,
      config: CONFIG,
      event: webhook(),
      itx: h.itx,
    });
    await processGithubReviewEvent({
      appendAgentMessage: h.append,
      config: CONFIG,
      event: webhook(),
      itx: h.itx,
    });

    expect(h.create).not.toHaveBeenCalled();
    expect(h.set).toHaveBeenCalledTimes(2);
    expect(h.set.mock.calls.map(([schedule]) => schedule.recurrence)).toEqual([
      { at: "2026-07-14T08:30:00.000Z" },
      { at: "2026-07-14T08:30:00.000Z" },
    ]);
    expect(h.append.mock.calls.map((call) => call.at(-1).idempotencyKey)).toEqual([
      "iterate-review:prj_test:42:7:head:head-b",
      "iterate-review:prj_test:42:7:head:head-b",
    ]);
  });

  it("deduplicates a completed successful review of the same automatic head", async () => {
    const h = harness({
      checkRuns: () => [
        {
          app: { slug: "iterate-preview" },
          conclusion: "success",
          external_id: "iterate-review:prj_test:42:7:head:head-b",
          id: 45,
          status: "completed",
        },
      ],
    });

    await expect(
      processGithubReviewEvent({
        appendAgentMessage: h.append,
        config: CONFIG,
        event: webhook(),
        itx: h.itx,
      }),
    ).resolves.toBe("ignored");

    expect(h.create).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 45,
        details_url: REVIEW_DETAILS_URL,
      }),
    );
  });

  it("retries a cancelled review of the same automatic head", async () => {
    const h = harness({
      checkRuns: () => [
        {
          app: { slug: "iterate-preview" },
          conclusion: "cancelled",
          external_id: "iterate-review:prj_test:42:7:head:head-b",
          id: 46,
          status: "completed",
        },
      ],
    });

    await expect(
      processGithubReviewEvent({
        appendAgentMessage: h.append,
        config: CONFIG,
        event: webhook(),
        itx: h.itx,
      }),
    ).resolves.toBe("queued");

    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        external_id: "iterate-review:prj_test:42:7:head:head-b",
        head_sha: "head-b",
      }),
    );
    expect(h.set).toHaveBeenCalledWith(
      expect.objectContaining({ key: "github-review-timeout:100" }),
    );
    expect(h.append).toHaveBeenCalledOnce();
  });

  it("drops an out-of-order old synchronize before it can create or interrupt", async () => {
    const h = harness({ liveHead: "head-c" });
    const late = webhook({ action: "synchronize", before: "head-a", headSha: "head-b" });

    await expect(
      processGithubReviewEvent({
        appendAgentMessage: h.append,
        config: CONFIG,
        event: late,
        itx: h.itx,
      }),
    ).resolves.toBe("stale");

    expect(h.getConnection).toHaveBeenCalledWith("install-42");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.createAgent).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
  });

  it("gives explicit same-head review requests distinct identities", async () => {
    const h = harness();
    const first = webhook({
      action: "labeled",
      changedLabel: CONFIG.forceLabel,
      labels: [CONFIG.forceLabel],
      offset: 10,
    });
    const second = webhook({
      action: "labeled",
      changedLabel: CONFIG.forceLabel,
      labels: [CONFIG.forceLabel],
      offset: 11,
    });

    await processGithubReviewEvent({
      appendAgentMessage: h.append,
      config: CONFIG,
      event: first,
      itx: h.itx,
    });
    await processGithubReviewEvent({
      appendAgentMessage: h.append,
      config: CONFIG,
      event: second,
      itx: h.itx,
    });

    expect(h.create.mock.calls.map(([args]) => args.external_id)).toEqual([
      "iterate-review:prj_test:42:7:request:10",
      "iterate-review:prj_test:42:7:request:11",
    ]);
    expect(h.append.mock.calls.map((call) => call.at(-1).idempotencyKey)).toEqual([
      "iterate-review:prj_test:42:7:request:10",
      "iterate-review:prj_test:42:7:request:11",
    ]);
  });

  it("restarts same-head review UI without cancelling its own replay identity", async () => {
    const exactExternalId = "iterate-review:prj_test:42:7:request:10";
    const h = harness({
      checkRuns: () => [
        {
          app: { slug: "iterate-preview" },
          external_id: "iterate-review:prj_test:42:7:head:head-b",
          html_url: null,
          id: 8,
          status: "in_progress",
        },
        {
          app: { slug: "iterate-preview" },
          external_id: exactExternalId,
          html_url: null,
          id: 9,
          status: "in_progress",
        },
      ],
    });
    const event = webhook({
      action: "labeled",
      changedLabel: CONFIG.forceLabel,
      labels: [CONFIG.forceLabel],
      offset: 10,
    });
    await processGithubReviewEvent({
      appendAgentMessage: h.append,
      config: CONFIG,
      event,
      itx: h.itx,
    });

    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 8, conclusion: "cancelled" }),
    );
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 9,
        details_url: REVIEW_DETAILS_URL,
      }),
    );
    expect(h.cancel).toHaveBeenCalledWith("github-review-timeout:8");
    expect(h.cancel).not.toHaveBeenCalledWith("github-review-timeout:9");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.set).toHaveBeenCalledWith(expect.objectContaining({ key: "github-review-timeout:9" }));
  });

  it("paginates check recovery and trusts only the routed App", async () => {
    const hostilePage = Array.from({ length: 100 }, (_, id) => ({
      app: { slug: "hostile-app" },
      external_id: "iterate-review:prj_test:42:7:head:head-b",
      html_url: null,
      id,
      status: "in_progress",
    }));
    const h = harness({
      checkRuns: ({ page }) =>
        page === 1
          ? hostilePage
          : [
              {
                app: { slug: "iterate-preview" },
                external_id: "iterate-review:prj_test:42:7:head:head-b",
                html_url: null,
                id: 777,
                status: "in_progress",
              },
            ],
    });

    await processGithubReviewEvent({
      appendAgentMessage: h.append,
      config: CONFIG,
      event: webhook(),
      itx: h.itx,
    });

    expect(h.listForRef).toHaveBeenCalledTimes(2);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.set).toHaveBeenCalledWith(
      expect.objectContaining({ key: "github-review-timeout:777" }),
    );
  });

  it("cancels running checks and their terminalizers when the live skip label is present", async () => {
    const h = harness({
      liveLabels: [CONFIG.skipLabel],
      checkRuns: () => [
        {
          app: { slug: "iterate-preview" },
          external_id: "iterate-review:prj_test:42:7:head:head-b",
          html_url: null,
          id: 88,
          status: "in_progress",
        },
      ],
    });
    const event = webhook({
      action: "labeled",
      changedLabel: CONFIG.skipLabel,
      labels: [CONFIG.skipLabel],
    });

    await expect(
      processGithubReviewEvent({ appendAgentMessage: h.append, config: CONFIG, event, itx: h.itx }),
    ).resolves.toBe("cancelled");

    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 88, conclusion: "cancelled" }),
    );
    expect(h.cancel).toHaveBeenCalledWith("github-review-timeout:88");
    expect(h.append).not.toHaveBeenCalled();
  });

  it("cancels current-head review UI when the pull request becomes draft", async () => {
    const h = harness({
      liveDraft: true,
      checkRuns: () => [
        {
          app: { slug: "iterate-preview" },
          external_id: "iterate-review:prj_test:42:7:head:head-b",
          html_url: null,
          id: 89,
          status: "in_progress",
        },
      ],
    });
    const event = webhook({ action: "converted_to_draft" });

    await expect(
      processGithubReviewEvent({ appendAgentMessage: h.append, config: CONFIG, event, itx: h.itx }),
    ).resolves.toBe("cancelled");

    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 89, conclusion: "cancelled" }),
    );
    expect(h.cancel).toHaveBeenCalledWith("github-review-timeout:89");
    expect(h.append).not.toHaveBeenCalled();
  });

  it("builds a cancellation target for a closed pull-request delivery", async () => {
    const h = harness({ liveState: "closed" });
    const event = webhook({ action: "closed", state: "closed" });

    await expect(
      processGithubReviewEvent({ appendAgentMessage: h.append, config: CONFIG, event, itx: h.itx }),
    ).resolves.toBe("cancelled");

    expect(h.listForRef).toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });

  it("reconciles a close racing with an otherwise eligible webhook", async () => {
    const h = harness({
      liveState: "closed",
      checkRuns: () => [
        {
          app: { slug: "iterate-preview" },
          external_id: "iterate-review:prj_test:42:7:head:head-b",
          html_url: null,
          id: 90,
          status: "in_progress",
        },
      ],
    });

    await expect(
      processGithubReviewEvent({
        appendAgentMessage: h.append,
        config: CONFIG,
        event: webhook(),
        itx: h.itx,
      }),
    ).resolves.toBe("cancelled");

    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 90, conclusion: "cancelled" }),
    );
    expect(h.createAgent).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });

  it("does not queue a newer review when superseded-check cancellation fails", async () => {
    const update = vi.fn().mockRejectedValue(new Error("GitHub unavailable"));
    const h = harness({
      checkRuns: ({ ref }) =>
        ref === "head-a"
          ? [
              {
                app: { slug: "iterate-preview" },
                external_id: "iterate-review:prj_test:42:7:head:head-a",
                html_url: null,
                id: 5,
                status: "in_progress",
              },
            ]
          : [],
      update,
    });
    const event = webhook({ action: "synchronize", before: "head-a", headSha: "head-b" });

    await expect(
      processGithubReviewEvent({ appendAgentMessage: h.append, config: CONFIG, event, itx: h.itx }),
    ).rejects.toThrow("GitHub unavailable");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });

  it("requires routed identity and path/body agreement", () => {
    const mismatched = webhook({ pathNumber: 8 });
    expect(githubReviewTarget(mismatched, CONFIG)).toBeNull();
    const missingConnection = webhook();
    delete missingConnection.payload?.connection;
    expect(githubReviewTarget(missingConnection, CONFIG)).toBeNull();
  });
});
