import { describe, expect, it, vi } from "vitest";
import type { Project, StreamEvent } from "iterate/sdk";
import {
  githubReviewTarget,
  processGithubReviewEvent,
  type GithubReviewConfig,
} from "../../../config-repo-template/github-reviews.ts";

const CONFIG: GithubReviewConfig = {
  forceLabel: "iterate:review",
  osBaseUrl: "https://os.iterate.test",
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
  const killAgent = vi.fn().mockResolvedValue(undefined);
  const killCapabilityHost = vi.fn().mockResolvedValue(undefined);
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
    capabilityHost: { kill: killCapabilityHost },
    create: createAgent,
    kill: killAgent,
    processor: { snapshot: snapshotAgent },
    stream: { append },
  }));
  const readFile = vi.fn().mockResolvedValue({
    commitOid: "rules-commit",
    content:
      "If there is no actionable feedback, do not leave a review or comment. Policy definitions and tests are exempt from the word rule.",
    path: CONFIG.rulesPath,
  });
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
    repo: { readFile },
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
    killAgent,
    killCapabilityHost,
    listForRef,
    readFile,
    set,
    snapshotAgent,
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
    expect(h.getAgent).toHaveBeenCalledWith(
      "/agents/repos/route/pull-requests/7/iterate-reviews/100",
    );
    expect(h.createAgent).toHaveBeenCalledWith();
    expect(h.snapshotAgent).toHaveBeenCalledOnce();
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 100,
        details_url:
          "https://os.iterate.test/projects/widgets-project/agents/streams/agents/repos/route/pull-requests/7/iterate-reviews/100",
      }),
    );
    // The task prompt's guidance prose is deliberately unpinned
    // (docs/testing.md: prompt-copy pinning); the check-run id riding into
    // the task is proven structurally instead.
    expect(task.payload.content).toContain("100");
    expect(task.payload.llmRequestPolicy).toEqual({ behaviour: "after-current-request" });
  });

  it("reuses an already-created review agent on webhook redelivery", async () => {
    const h = harness({ agentBirthCertificate: { config: {} } });

    await expect(
      processGithubReviewEvent({ config: CONFIG, event: webhook(), itx: h.itx }),
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
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 45,
        details_url:
          "https://os.iterate.test/projects/widgets-project/agents/streams/agents/repos/route/pull-requests/7/iterate-reviews/45",
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
    h.killAgent.mockRejectedValue(new Error("kill requested"));
    h.killCapabilityHost.mockRejectedValue(new Error("kill requested"));

    await processGithubReviewEvent({ config: CONFIG, event, itx: h.itx });

    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 8, conclusion: "cancelled" }),
    );
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 9,
        details_url:
          "https://os.iterate.test/projects/widgets-project/agents/streams/agents/repos/route/pull-requests/7/iterate-reviews/9",
      }),
    );
    expect(h.getAgent).toHaveBeenCalledWith(
      "/agents/repos/route/pull-requests/7/iterate-reviews/8",
    );
    expect(h.killAgent).toHaveBeenCalledOnce();
    expect(h.killCapabilityHost).toHaveBeenCalledOnce();
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
    expect(h.getAgent).toHaveBeenCalledWith(
      "/agents/repos/route/pull-requests/7/iterate-reviews/88",
    );
    expect(h.killAgent.mock.invocationCallOrder[0]).toBeLessThan(
      h.update.mock.invocationCallOrder[0]!,
    );
    expect(h.killCapabilityHost.mock.invocationCallOrder[0]).toBeLessThan(
      h.update.mock.invocationCallOrder[0]!,
    );
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
    expect(h.createAgent).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });

  it("does not cancel visible review state when agent retirement genuinely fails", async () => {
    const h = harness({
      checkRuns: () => [
        {
          app: { slug: "iterate-preview" },
          external_id: "iterate-review:prj_test:42:7:head:head-b",
          html_url: null,
          id: 91,
          status: "in_progress",
        },
      ],
      liveLabels: [CONFIG.skipLabel],
    });
    h.killAgent.mockRejectedValue(new Error("GitHub agent retirement unavailable"));

    await expect(
      processGithubReviewEvent({
        config: CONFIG,
        event: webhook({
          action: "labeled",
          changedLabel: CONFIG.skipLabel,
          labels: [CONFIG.skipLabel],
        }),
        itx: h.itx,
      }),
    ).rejects.toThrow("GitHub agent retirement unavailable");

    expect(h.update).not.toHaveBeenCalled();
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
