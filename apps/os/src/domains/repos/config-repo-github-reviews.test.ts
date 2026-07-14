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
          state: "open",
        },
      },
    },
  };
}

function harness(input?: {
  checkRuns?: (args: { page: number; ref: string }) => unknown[];
  liveHead?: string;
  liveLabels?: string[];
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
        status: "in_progress",
      },
    }),
  );
  const listForRef = vi
    .fn()
    .mockImplementation((args: { page: number; ref: string }) =>
      Promise.resolve({ data: { check_runs: input?.checkRuns?.(args) ?? [] } }),
    );
  const update = input?.update ?? vi.fn().mockResolvedValue({ data: {} });
  const octokit = {
    rest: {
      checks: { create, listForRef, update },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            draft: false,
            head: { sha: input?.liveHead ?? "head-b" },
            labels: (input?.liveLabels ?? []).map((name) => ({ name })),
            state: "open",
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
    content: "mentions of the word fart are forbidden - must say superfart always",
    path: CONFIG.rulesPath,
  });
  const set = vi.fn().mockResolvedValue({});
  const itx = {
    agents: { defaults: { forPath: defaultsForPath } },
    integrations: { github: { get: getConnection } },
    projectId: "prj_test",
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
        recurrence: { in: 1_800 },
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
    expect(task.payload.content).toContain("Promise.all");
    expect(task.payload.llmRequestPolicy).toEqual({ behaviour: "interrupt-current-request" });
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
