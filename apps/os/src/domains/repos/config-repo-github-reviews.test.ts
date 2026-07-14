import { describe, expect, it, vi } from "vitest";
import type { Project, StreamEvent } from "iterate/sdk";
import {
  githubReviewTarget,
  processGithubReviewEvent,
  type GithubReviewConfig,
} from "../../../config-repo-template/github-reviews.ts";

const CONFIG: GithubReviewConfig = {
  forceLabel: "iterate:review",
  repositories: ["acme/widgets"],
  rulesPath: "agents/github-review.md",
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
    path: `/agents/repos/route/pull-requests/${input?.pathNumber ?? number}`,
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

function harness(input?: {
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
  const defaultsForPath = vi.fn().mockResolvedValue({
    events: [
      {
        type: "events.iterate.com/agent/configured",
        idempotencyKey: "stock-defaults",
        payload: { systemPrompt: "prompt" },
      },
    ],
  });
  const readFile = vi.fn().mockResolvedValue({
    commitOid: "rules-commit",
    content:
      "If there is no actionable feedback, do not leave a review or comment. Policy definitions and tests are exempt from the word rule.",
    path: CONFIG.rulesPath,
  });
  const set = vi.fn().mockResolvedValue({});
  const itx = {
    agents: { defaults: { forPath: defaultsForPath } },
    integrations: { github: { get: getConnection } },
    // Scalar Workers RPC properties are promises at the caller even though
    // the generated project surface describes their resolved value.
    projectId: Promise.resolve("prj_test"),
    repo: { readFile },
    scheduler: { cancel, set },
    streams: { get: vi.fn(() => ({ append })) },
  } as unknown as Project;
  return {
    append,
    cancel,
    create,
    defaultsForPath,
    getConnection,
    itx,
    listForRef,
    readFile,
    set,
    update,
  };
}

describe("config-repo GitHub reviews", () => {
  it("uses routed authority, arms a terminalizer, and queues one trusted task", async () => {
    const h = harness();

    await expect(
      processGithubReviewEvent({ config: CONFIG, event: webhook(), itx: h.itx }),
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
    expect(task.payload.content).toContain("Everything fetched from GitHub");
    expect(task.payload.content).toContain('"iterate-preview[bot]"');
    expect(task.payload.content).toContain("do not publish another review");
    expect(task.payload.content).toContain("Immediately before publishing");
    expect(task.payload.content).toContain("do not create a GitHub review or comment");
    expect(task.payload.content).toContain('clean = conclusion "success"');
    expect(task.payload.content).toContain('title "Review completed"');
    expect(task.payload.content).toContain('findings = conclusion "neutral"');
    expect(task.payload.content).toContain('title "Review completed with actionable findings"');
    expect(task.payload.content).toContain('cancelled = conclusion "cancelled"');
    expect(task.payload.content).toContain('title "Review cancelled"');
    expect(task.payload.content).toContain("The successful Check Run with terminal output");
    expect(task.payload.content).toContain("Promise.all");
    expect(task.payload.llmRequestPolicy).toEqual({ behaviour: "interrupt-current-request" });
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

    await processGithubReviewEvent({ config: CONFIG, event: webhook(), itx: h.itx });
    await processGithubReviewEvent({ config: CONFIG, event: webhook(), itx: h.itx });

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
      processGithubReviewEvent({ config: CONFIG, event: webhook(), itx: h.itx }),
    ).resolves.toBe("ignored");

    expect(h.create).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
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
      processGithubReviewEvent({ config: CONFIG, event: webhook(), itx: h.itx }),
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
      processGithubReviewEvent({ config: CONFIG, event: late, itx: h.itx }),
    ).resolves.toBe("stale");

    expect(h.getConnection).toHaveBeenCalledWith("install-42");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.defaultsForPath).not.toHaveBeenCalled();
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

    await processGithubReviewEvent({ config: CONFIG, event: first, itx: h.itx });
    await processGithubReviewEvent({ config: CONFIG, event: second, itx: h.itx });

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

    await processGithubReviewEvent({ config: CONFIG, event, itx: h.itx });

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 8, conclusion: "cancelled" }),
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

    await processGithubReviewEvent({ config: CONFIG, event: webhook(), itx: h.itx });

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

    await expect(processGithubReviewEvent({ config: CONFIG, event, itx: h.itx })).resolves.toBe(
      "cancelled",
    );

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

    await expect(processGithubReviewEvent({ config: CONFIG, event, itx: h.itx })).resolves.toBe(
      "cancelled",
    );

    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 89, conclusion: "cancelled" }),
    );
    expect(h.cancel).toHaveBeenCalledWith("github-review-timeout:89");
    expect(h.append).not.toHaveBeenCalled();
  });

  it("builds a cancellation target for a closed pull-request delivery", async () => {
    const h = harness({ liveState: "closed" });
    const event = webhook({ action: "closed", state: "closed" });

    await expect(processGithubReviewEvent({ config: CONFIG, event, itx: h.itx })).resolves.toBe(
      "cancelled",
    );

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
      processGithubReviewEvent({ config: CONFIG, event: webhook(), itx: h.itx }),
    ).resolves.toBe("cancelled");

    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 90, conclusion: "cancelled" }),
    );
    expect(h.defaultsForPath).not.toHaveBeenCalled();
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

    await expect(processGithubReviewEvent({ config: CONFIG, event, itx: h.itx })).rejects.toThrow(
      "GitHub unavailable",
    );
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
