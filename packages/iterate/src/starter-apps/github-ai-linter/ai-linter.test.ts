import { describe, expect, it, vi } from "vitest";
import { makeProcessorHarness } from "../../processors/testing.ts";
import type { Project } from "../../sdk.ts";
import { GithubAiLinterProcessor, publishGithubAiLinterReview } from "./ai-linter.ts";
import {
  GithubAiLinterProcessorContract,
  githubAiLinterEventTypes,
  type GithubAiLinterAnalysisRequested,
  type GithubAiLinterPublicationResult,
} from "./contract.ts";

const analysisRequest = (headSha: string): GithubAiLinterAnalysisRequested => ({
  appSlug: "iterate",
  baseSha: "base-abc",
  connection: "install-789",
  headSha,
  policyVersion: "2",
  promptVersion: "2",
  pullRequestNumber: 7,
  repository: { id: 101, owner: "acme", repo: "widgets" },
  rules: {
    "structure/example-rule": {
      files: ["**/*.ts"],
      invariant: "Keep the example structurally sound.",
      severity: "error",
      suggestions: "allowed",
    },
  },
  rulesCommit: "rules-abc",
});

describe("GithubAiLinterProcessor", () => {
  it("publishes visible diagnostics as one comment review and skips a suppressed-only result", async () => {
    const createCheckRun = vi.fn(async () => ({
      data: {
        html_url: "https://github.com/acme/widgets/runs/84",
        id: 84,
      },
    }));
    const createReview = vi.fn(async (_input: { body: string }) => ({
      data: {
        html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-42",
        id: 42,
      },
    }));
    const octokit = {
      paginate: vi.fn(async () => []),
      rest: {
        checks: {
          create: createCheckRun,
          listForRef: vi.fn(async () => ({ data: { check_runs: [] } })),
        },
        pulls: {
          createReview,
          get: vi.fn(async () => ({
            data: {
              base: { sha: "base-abc" },
              draft: false,
              head: { sha: "head-abc" },
              state: "open",
            },
          })),
        },
      },
    };
    const project = {
      integrations: { github: { get: () => ({ octokit }) } },
    };
    // The publisher intentionally touches only the GitHub integration surface
    // above. A full Project test double would obscure that narrow dependency.
    const itx = project as unknown as Project;
    const h = makeProcessorHarness<GithubAiLinterProcessorContract, GithubAiLinterProcessor>({
      createProcessor: (deps) =>
        new GithubAiLinterProcessor({
          path: deps.path,
          projectId: deps.projectId,
          publishReview: (analysis) => publishGithubAiLinterReview(itx, analysis),
          stream: deps.stream,
        }),
      path: "/agents/repos/config/pr/7/ai-linter",
    });

    await h.append({
      type: githubAiLinterEventTypes.analysisRequested,
      payload: analysisRequest("head-abc"),
    });
    await h.append({
      type: githubAiLinterEventTypes.diagnosticReported,
      payload: {
        analysisRequestOffset: 1,
        diagnosticKey: "structure/example-rule:src/suppressed.ts:suppressed",
        filename: "src/suppressed.ts",
        labels: [{ span: { endLine: 4, startLine: 4 } }],
        message: "This diagnostic is suppressed.",
        ruleName: "structure/example-rule",
        severity: "error",
      },
    });
    await h.append({
      type: githubAiLinterEventTypes.diagnosticSuppressed,
      payload: {
        analysisRequestOffset: 1,
        diagnosticOffset: 2,
        directive: "disable-next-line",
        filename: "src/suppressed.ts",
        line: 3,
        reason: "The generated boundary is intentional.",
      },
    });
    await h.append({
      type: githubAiLinterEventTypes.diagnosticReported,
      payload: {
        analysisRequestOffset: 1,
        diagnosticKey: "structure/example-rule:src/example.ts:example-export",
        filename: "src/example.ts",
        fix: {
          content: "export const example = true;",
          kind: "suggestion",
          span: { endLine: 11, startLine: 10 },
        },
        help: "Replace both changed lines with the direct export.",
        labels: [{ span: { endLine: 11, startLine: 10 } }],
        message: "Use the direct export.",
        ruleName: "structure/example-rule",
        severity: "error",
      },
    });
    await h.append({
      type: githubAiLinterEventTypes.analysisSettled,
      payload: {
        analysisRequestOffset: 1,
        result: {
          assessment: { summary: "One structural error remains.", verdict: "approve" },
          status: "succeeded",
        },
      },
    });

    expect(h.state()).toMatchObject({
      analyses: [
        {
          analysisRequestOffset: 1,
          diagnosticCount: 2,
          publication: {
            checkRun: {
              id: 84,
              url: "https://github.com/acme/widgets/runs/84",
            },
            reviewId: 42,
            reviewUrl: "https://github.com/acme/widgets/pull/7#pullrequestreview-42",
            status: "succeeded",
          },
          status: "succeeded",
          suppressedDiagnosticCount: 1,
        },
      ],
      latestSuccessfulAnalysis: {
        analysisRequestOffset: 1,
        diagnostics: [
          {
            classification: null,
            diagnostic: {
              diagnosticKey: "structure/example-rule:src/suppressed.ts:suppressed",
            },
            suppression: { directive: "disable-next-line" },
          },
          {
            classification: "new",
            diagnostic: {
              diagnosticKey: "structure/example-rule:src/example.ts:example-export",
            },
            suppression: null,
          },
        ],
      },
      seenDiagnosticKeys: ["structure/example-rule:src/example.ts:example-export"],
    });
    expect(h.events(githubAiLinterEventTypes.reviewPublicationRequested)).toHaveLength(1);
    expect(h.events(githubAiLinterEventTypes.reviewPublicationSettled)).toHaveLength(1);
    expect(createReview).toHaveBeenCalledOnce();
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        commit_id: "head-abc",
        event: "COMMENT",
        comments: [
          {
            body: [
              "**[structure/example-rule]** _new_",
              "Use the direct export.",
              "Replace both changed lines with the direct export.",
              "```suggestion\nexport const example = true;\n```",
            ].join("\n\n"),
            line: 11,
            path: "src/example.ts",
            side: "RIGHT",
            start_line: 10,
            start_side: "RIGHT",
          },
        ],
      }),
    );
    expect(createCheckRun).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        conclusion: "neutral",
        external_id: "iterate-github-ai-linter:101:analysis:1:head:head-abc",
        head_sha: "head-abc",
        name: "Iterate GitHub AI linter",
        status: "completed",
      }),
    );
    expect(createCheckRun.mock.invocationCallOrder[0]).toBeLessThan(
      createReview.mock.invocationCallOrder[0]!,
    );
    const reviewBody = createReview.mock.calls[0]![0].body;
    expect(reviewBody).toContain("1 errors, 0 warnings, 1 suppressed, 0 resolved.");
    expect(reviewBody).not.toContain("This diagnostic is suppressed.");

    await h.append({
      type: githubAiLinterEventTypes.analysisRequested,
      payload: analysisRequest("head-abc"),
    });
    const secondAnalysisOffset = h
      .events(githubAiLinterEventTypes.analysisRequested)
      .at(-1)!.offset;
    await h.append({
      type: githubAiLinterEventTypes.diagnosticReported,
      payload: {
        analysisRequestOffset: secondAnalysisOffset,
        diagnosticKey: "structure/example-rule:src/example.ts:example-export",
        filename: "src/example.ts",
        labels: [{ span: { endLine: 10, startLine: 10 } }],
        message: "Use the direct export.",
        ruleName: "structure/example-rule",
        severity: "error",
      },
    });
    const secondDiagnosticOffset = h
      .events(githubAiLinterEventTypes.diagnosticReported)
      .at(-1)!.offset;
    await h.append({
      type: githubAiLinterEventTypes.diagnosticSuppressed,
      payload: {
        analysisRequestOffset: secondAnalysisOffset,
        diagnosticOffset: secondDiagnosticOffset,
        directive: "disable-next-line",
        filename: "src/example.ts",
        line: 9,
        reason: "The direct export is intentionally deferred.",
      },
    });
    await h.append({
      type: githubAiLinterEventTypes.analysisSettled,
      payload: {
        analysisRequestOffset: secondAnalysisOffset,
        result: {
          assessment: { summary: "The diagnostic is suppressed.", verdict: "approve" },
          status: "succeeded",
        },
      },
    });

    expect(h.state().latestSuccessfulAnalysis?.resolvedDiagnostics).toEqual([]);
    expect(h.state().analyses[1]?.publication).toEqual({
      checkRun: {
        id: 84,
        url: "https://github.com/acme/widgets/runs/84",
      },
      reason: "No visible findings to publish.",
      status: "skipped",
    });
    expect(h.events(githubAiLinterEventTypes.reviewPublicationRequested)).toHaveLength(2);
    expect(h.events(githubAiLinterEventTypes.reviewPublicationSettled)).toHaveLength(2);
    expect(createReview).toHaveBeenCalledOnce();
    expect(createCheckRun).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        conclusion: "success",
        external_id: `iterate-github-ai-linter:101:analysis:${secondAnalysisOffset}:head:head-abc`,
        head_sha: "head-abc",
        name: "Iterate GitHub AI linter",
        status: "completed",
      }),
    );
    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    expect(octokit.paginate).toHaveBeenCalledOnce();
  });

  it("does not publish a suggested change for a rule that forbids suggestions", async () => {
    const createReview = vi.fn(async () => ({
      data: {
        html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-42",
        id: 42,
      },
    }));
    const project = {
      integrations: {
        github: {
          get: () => ({
            octokit: {
              paginate: vi.fn(async () => []),
              rest: {
                checks: {
                  create: vi.fn(async () => ({
                    data: {
                      html_url: "https://github.com/acme/widgets/runs/84",
                      id: 84,
                    },
                  })),
                  listForRef: vi.fn(async () => ({ data: { check_runs: [] } })),
                },
                pulls: {
                  createReview,
                  get: vi.fn(async () => ({
                    data: {
                      base: { sha: "base-abc" },
                      draft: false,
                      head: { sha: "head-abc" },
                      state: "open",
                    },
                  })),
                },
              },
            },
          }),
        },
      },
    };

    await publishGithubAiLinterReview(project as unknown as Project, {
      analysisRequestOffset: 1,
      assessment: { summary: "One unclear metaphor remains.", verdict: "comment" },
      diagnostics: [
        {
          classification: "new",
          diagnostic: {
            diagnosticKey: "terminology/no-metaphorical-lane-door-seam:src/example.ts:review-lane",
            filename: "src/example.ts",
            fix: {
              content: "const reviewQueue = rules;",
              kind: "suggestion",
              span: { endLine: 10, startLine: 10 },
            },
            help: "Explain the actual role of this value and rename the surrounding concepts.",
            labels: [{ span: { endLine: 10, startLine: 10 } }],
            message: "`reviewLane` uses lane as a metaphor.",
            ruleName: "terminology/no-metaphorical-lane-door-seam",
            severity: "error",
          },
          eventOffset: 2,
          suppression: null,
        },
      ],
      request: {
        ...analysisRequest("head-abc"),
        rules: {
          "terminology/no-metaphorical-lane-door-seam": {
            files: ["**/*.ts"],
            invariant: "Do not use lane as a metaphor.",
            severity: "error",
            suggestions: "forbidden",
          },
        },
      },
      resolvedDiagnostics: [],
    });

    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        comments: [
          {
            body: [
              "**[terminology/no-metaphorical-lane-door-seam]** _new_",
              "`reviewLane` uses lane as a metaphor.",
              "Explain the actual role of this value and rename the surrounding concepts.",
            ].join("\n\n"),
            line: 10,
            path: "src/example.ts",
            side: "RIGHT",
          },
        ],
      }),
    );
  });

  it("settles an unfinished analysis as cancelled when a new head arrives", async () => {
    const publishReview = vi.fn();
    const h = makeProcessorHarness<GithubAiLinterProcessorContract, GithubAiLinterProcessor>({
      createProcessor: (deps) =>
        new GithubAiLinterProcessor({
          path: deps.path,
          projectId: deps.projectId,
          publishReview,
          stream: deps.stream,
        }),
    });

    await h.append({
      type: githubAiLinterEventTypes.analysisRequested,
      payload: analysisRequest("head-one"),
    });
    await h.append({
      type: githubAiLinterEventTypes.analysisRequested,
      payload: analysisRequest("head-two"),
    });

    expect(h.state()).toMatchObject({
      analyses: [
        { analysisRequestOffset: 1, status: "cancelled" },
        { analysisRequestOffset: 2, status: "running" },
      ],
      currentAnalysis: {
        analysisRequestOffset: 2,
        request: { headSha: "head-two" },
      },
    });
    expect(h.events(githubAiLinterEventTypes.analysisSettled)).toMatchObject([
      {
        payload: {
          analysisRequestOffset: 1,
          result: { reason: "Superseded by analysis 2.", status: "cancelled" },
        },
      },
    ]);
    expect(publishReview).not.toHaveBeenCalled();
  });

  it("fails an unfinished analysis when its agent exhausts the turn budget", async () => {
    const publishReview = vi.fn();
    const h = makeProcessorHarness<GithubAiLinterProcessorContract, GithubAiLinterProcessor>({
      createProcessor: (deps) =>
        new GithubAiLinterProcessor({
          path: deps.path,
          projectId: deps.projectId,
          publishReview,
          stream: deps.stream,
        }),
    });

    await h.append({
      type: githubAiLinterEventTypes.analysisRequested,
      payload: analysisRequest("head-one"),
    });
    await h.append({
      type: "events.iterate.com/agent/paused",
      payload: {
        reason: "autonomous turn limit reached (10 consecutive turns without external input)",
      },
    });

    expect(h.state()).toMatchObject({
      analyses: [{ analysisRequestOffset: 1, status: "failed" }],
      currentAnalysis: null,
    });
    expect(h.events(githubAiLinterEventTypes.analysisSettled)).toMatchObject([
      {
        payload: {
          analysisRequestOffset: 1,
          result: {
            error:
              "Analysis agent paused: autonomous turn limit reached (10 consecutive turns without external input)",
            status: "failed",
          },
        },
      },
    ]);
    expect(publishReview).not.toHaveBeenCalled();
  });

  it("ignores an old analysis's delayed breaker pause after a new head starts", async () => {
    const h = makeProcessorHarness<GithubAiLinterProcessorContract, GithubAiLinterProcessor>({
      createProcessor: (deps) =>
        new GithubAiLinterProcessor({
          path: deps.path,
          projectId: deps.projectId,
          publishReview: vi.fn(),
          stream: deps.stream,
        }),
    });

    await h.append({
      type: githubAiLinterEventTypes.analysisRequested,
      payload: analysisRequest("head-one"),
    });
    await h.append({
      type: githubAiLinterEventTypes.analysisRequested,
      payload: analysisRequest("head-two"),
    });
    await h.append({
      type: "events.iterate.com/agent/paused",
      payload: {
        reason: "autonomous turn limit reached",
        triggerOffset: 1,
      },
    });

    expect(h.state()).toMatchObject({
      analyses: [
        { analysisRequestOffset: 1, status: "cancelled" },
        { analysisRequestOffset: 2, status: "running" },
      ],
      currentAnalysis: {
        analysisRequestOffset: 2,
        request: { headSha: "head-two" },
      },
    });
  });

  it("cancels superseded publication while its previous attempt is still in flight", async () => {
    const publication = Promise.withResolvers<GithubAiLinterPublicationResult>();
    const publishReview = vi.fn(() => publication.promise);
    const h = makeProcessorHarness<GithubAiLinterProcessorContract, GithubAiLinterProcessor>({
      createProcessor: (deps) =>
        new GithubAiLinterProcessor({
          path: deps.path,
          projectId: deps.projectId,
          publishReview,
          stream: deps.stream,
        }),
    });

    await h.append({
      type: githubAiLinterEventTypes.analysisRequested,
      payload: analysisRequest("head-one"),
    });
    await h.append({
      type: githubAiLinterEventTypes.analysisSettled,
      payload: {
        analysisRequestOffset: 1,
        result: {
          assessment: { summary: "The first head is clean.", verdict: "approve" },
          status: "succeeded",
        },
      },
    });
    expect(publishReview).toHaveBeenCalledOnce();

    await h.append({
      type: githubAiLinterEventTypes.analysisRequested,
      payload: analysisRequest("head-two"),
    });

    expect(h.state().analyses[0]?.publication).toEqual({
      reason: "A newer analysis superseded this unpublished review.",
      status: "cancelled",
    });

    publication.resolve({
      reviewId: 42,
      reviewUrl: "https://github.com/acme/widgets/pull/7#pullrequestreview-42",
      status: "succeeded",
    });
    await h.settle();

    // The late network result loses the processor-owned terminal-key race.
    expect(h.state().analyses[0]?.publication.status).toBe("cancelled");
  });
});
