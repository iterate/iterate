import { describe, expect, it, vi } from "vitest";
import {
  ensureGithubReviewCheck,
  expireGithubReviewCheck,
  githubReviewCheckExternalId,
} from "./github-review-check.ts";

function checksApi(input?: {
  create?: ReturnType<typeof vi.fn>;
  listForRef?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
}) {
  return {
    create: input?.create ?? vi.fn(),
    listForRef: input?.listForRef ?? vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
    update: input?.update ?? vi.fn(),
  } as unknown as Parameters<typeof ensureGithubReviewCheck>[0]["checks"];
}

const BASE = {
  appSlug: "iterate",
  externalId: "iterate-review:prj_1:789:7:head:new",
  headSha: "new",
  owner: "acme",
  repo: "widgets",
};

describe("GitHub review checks", () => {
  it("uses an installation-scoped external id", () => {
    expect(
      githubReviewCheckExternalId({
        installationId: "789",
        projectId: "prj_1",
        pullRequestNumber: 7,
        reviewKey: "head:abc",
      }),
    ).toBe("iterate-review:prj_1:789:7:head:abc");
  });

  it("recovers only a check owned by the configured GitHub App", async () => {
    const create = vi.fn();
    const checks = checksApi({
      create,
      listForRef: vi.fn().mockResolvedValue({
        data: {
          check_runs: [
            {
              app: { slug: "hostile-app" },
              external_id: BASE.externalId,
              html_url: "https://github.com/runs/1",
              id: 1,
              status: "in_progress",
            },
            {
              app: { slug: "iterate" },
              external_id: BASE.externalId,
              html_url: "https://github.com/runs/2",
              id: 2,
              status: "in_progress",
            },
          ],
        },
      }),
    });

    await expect(ensureGithubReviewCheck({ ...BASE, checks })).resolves.toEqual({
      id: 2,
      url: "https://github.com/runs/2",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("does not create after a failed recovery lookup", async () => {
    const create = vi.fn();
    const checks = checksApi({
      create,
      listForRef: vi.fn().mockRejectedValue(new Error("GitHub unavailable")),
    });

    await expect(ensureGithubReviewCheck({ ...BASE, checks })).rejects.toThrow(
      "GitHub unavailable",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("cancels the exact superseded check while creating the new shell", async () => {
    const create = vi.fn().mockResolvedValue({
      data: { app: { slug: "iterate" }, html_url: "https://github.com/runs/3", id: 3 },
    });
    const update = vi.fn().mockResolvedValue({ data: {} });
    const checks = checksApi({
      create,
      update,
      listForRef: vi.fn().mockImplementation(({ ref }: { ref: string }) =>
        Promise.resolve({
          data: {
            check_runs:
              ref === "old"
                ? [
                    {
                      app: { slug: "iterate" },
                      external_id: "iterate-review:prj_1:789:7:head:old",
                      html_url: "https://github.com/runs/2",
                      id: 2,
                      status: "in_progress",
                    },
                  ]
                : [],
          },
        }),
      ),
    });

    await expect(
      ensureGithubReviewCheck({
        ...BASE,
        checks,
        now: () => new Date("2026-07-13T12:00:00.000Z"),
        superseded: {
          externalId: "iterate-review:prj_1:789:7:head:old",
          headSha: "old",
        },
      }),
    ).resolves.toEqual({ id: 3, url: "https://github.com/runs/3" });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 2,
        completed_at: "2026-07-13T12:00:00.000Z",
        conclusion: "cancelled",
        status: "completed",
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ external_id: BASE.externalId, head_sha: "new" }),
    );
  });

  it("terminalizes a review shell the agent left running", async () => {
    const update = vi.fn().mockResolvedValue({ data: {} });
    const checks = checksApi({
      update,
      listForRef: vi.fn().mockResolvedValue({
        data: {
          check_runs: [
            {
              app: { slug: "iterate" },
              external_id: BASE.externalId,
              html_url: "https://github.com/runs/3",
              id: 3,
              status: "in_progress",
            },
          ],
        },
      }),
    });

    await expect(
      expireGithubReviewCheck({
        ...BASE,
        checks,
        now: () => new Date("2026-07-13T12:30:00.000Z"),
      }),
    ).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 3,
        conclusion: "failure",
        status: "completed",
      }),
    );
  });
});
