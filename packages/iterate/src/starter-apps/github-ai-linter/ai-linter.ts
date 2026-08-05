import type { Project } from "../../sdk.ts";
import {
  isIdempotencyConflict,
  StreamProcessor,
  type EmittedInput,
  type ProcessEventArgs,
  type ReduceArgs,
} from "../../processors/index.ts";
import {
  GithubAiLinterProcessorContract,
  githubAiLinterEventTypes,
  type GithubAiLinterPublicationResult,
  type GithubAiLinterState,
} from "./contract.ts";

type GithubAiLinterPublicationAnalysis = NonNullable<
  GithubAiLinterState["latestSuccessfulAnalysis"]
>;

type GithubAiLinterProcessorDeps = {
  publishReview: (
    analysis: GithubAiLinterPublicationAnalysis,
  ) => Promise<GithubAiLinterPublicationResult>;
};

/**
 * One instance runs on one `/ai-linter` child stream, hence one reduced state
 * per pull request. The generic Agent processor independently runs on that
 * same stream and supplies the LLM loop; this processor only understands the
 * small diagnostic protocol and owns GitHub publication.
 */
export class GithubAiLinterProcessor extends StreamProcessor<
  GithubAiLinterProcessorContract,
  GithubAiLinterProcessorDeps
> {
  readonly contract = GithubAiLinterProcessorContract;

  /**
   * Runtime-only publication attempts. Requested/settled stream events are
   * the durable truth: after an eviction the set is empty, and the next
   * caught-up pass safely re-drives any still-requested publication.
   */
  readonly #livePublications = new Set<number>();

  protected override reduce({
    event,
    state,
  }: ReduceArgs<GithubAiLinterProcessorContract>): GithubAiLinterState {
    switch (event.type) {
      case "events.iterate.com/agent/paused":
        return state;

      case githubAiLinterEventTypes.analysisRequested:
        return {
          ...state,
          analyses: [
            ...state.analyses,
            {
              analysisRequestOffset: event.offset,
              baseSha: event.payload.baseSha,
              diagnosticCount: 0,
              headSha: event.payload.headSha,
              publication: { status: "not-requested" },
              rulesCommit: event.payload.rulesCommit,
              status: "running",
              suppressedDiagnosticCount: 0,
            },
          ],
          currentAnalysis: {
            analysisRequestOffset: event.offset,
            diagnostics: [],
            request: event.payload,
          },
        };

      case githubAiLinterEventTypes.diagnosticReported: {
        const current = state.currentAnalysis;
        if (
          current === null ||
          current.analysisRequestOffset !== event.payload.analysisRequestOffset ||
          current.diagnostics.some(
            ({ diagnostic }) => diagnostic.diagnosticKey === event.payload.diagnosticKey,
          )
        ) {
          return state;
        }
        // This POC trusts the agent task for semantic checks which the event
        // schema cannot express: the rule must exist in `current.request`,
        // severity must match it, and the primary span must be on the PR's
        // changed RIGHT side. A later deterministic validator should turn
        // violations into an explicit failed analysis instead of silently
        // accepting or dropping the event.
        // `analysisRequestOffset` belongs to the event protocol, not the
        // diagnostic value retained for comparison and publication.
        const { analysisRequestOffset: _analysisRequestOffset, ...diagnostic } = event.payload;
        return {
          ...state,
          analyses: state.analyses.map((analysis) =>
            analysis.analysisRequestOffset === current.analysisRequestOffset
              ? {
                  ...analysis,
                  diagnosticCount: analysis.diagnosticCount + 1,
                }
              : analysis,
          ),
          currentAnalysis: {
            ...current,
            diagnostics: [
              ...current.diagnostics,
              {
                classification: null,
                diagnostic,
                eventOffset: event.offset,
                suppression: null,
              },
            ],
          },
        };
      }

      case githubAiLinterEventTypes.diagnosticSuppressed: {
        const current = state.currentAnalysis;
        if (
          current === null ||
          current.analysisRequestOffset !== event.payload.analysisRequestOffset ||
          !current.diagnostics.some(
            ({ diagnostic, eventOffset, suppression }) =>
              eventOffset === event.payload.diagnosticOffset &&
              diagnostic.filename === event.payload.filename &&
              suppression === null,
          )
        ) {
          return state;
        }
        return {
          ...state,
          analyses: state.analyses.map((analysis) =>
            analysis.analysisRequestOffset === current.analysisRequestOffset
              ? {
                  ...analysis,
                  suppressedDiagnosticCount: analysis.suppressedDiagnosticCount + 1,
                }
              : analysis,
          ),
          currentAnalysis: {
            ...current,
            diagnostics: current.diagnostics.map((diagnostic) =>
              diagnostic.eventOffset === event.payload.diagnosticOffset
                ? { ...diagnostic, suppression: event.payload }
                : diagnostic,
            ),
          },
        };
      }

      case githubAiLinterEventTypes.analysisSettled: {
        const summary = state.analyses.find(
          ({ analysisRequestOffset }) =>
            analysisRequestOffset === event.payload.analysisRequestOffset,
        );
        if (summary === undefined || summary.status !== "running") return state;

        const current = state.currentAnalysis;
        const settlesCurrent =
          current?.analysisRequestOffset === event.payload.analysisRequestOffset;
        // A superseded agent may race the processor's cancellation. Once a
        // newer request exists, only a cancellation may settle the old one;
        // a late success or failure describes work which was no longer
        // authoritative. The processor uses a separate cancellation key so a
        // late agent settlement cannot prevent that cancellation from landing.
        if (!settlesCurrent && event.payload.result.status !== "cancelled") return state;

        const analyses = state.analyses.map((analysis) =>
          analysis.analysisRequestOffset === event.payload.analysisRequestOffset
            ? {
                ...analysis,
                status: event.payload.result.status,
              }
            : analysis,
        );
        if (!settlesCurrent || event.payload.result.status !== "succeeded") {
          return {
            ...state,
            analyses,
            currentAnalysis: settlesCurrent ? null : current,
          };
        }

        // This first version compares semantic diagnostic identities only.
        // A later reconciler should ingest GitHub thread resolution and other
        // trusted human dispositions before deciding that a repeated key is
        // persistent. Keeping that out of the LLM makes the eventual behavior
        // deterministic instead of prompt-memory based.
        const previousDiagnostics =
          state.latestSuccessfulAnalysis?.diagnostics.filter(
            ({ suppression }) => suppression === null,
          ) ?? [];
        const previousKeys = new Set(
          previousDiagnostics.map(({ diagnostic }) => diagnostic.diagnosticKey),
        );
        const seenKeys = new Set(state.seenDiagnosticKeys);
        const currentReportedKeys = new Set(
          current.diagnostics.map(({ diagnostic }) => diagnostic.diagnosticKey),
        );
        const currentVisibleKeys = new Set(
          current.diagnostics
            .filter(({ suppression }) => suppression === null)
            .map(({ diagnostic }) => diagnostic.diagnosticKey),
        );
        // These assertions only preserve the schema's classification
        // discriminants through Array.map; without them TypeScript widens the
        // object properties to `string`. The runtime values are the same
        // closed vocabulary validated by ReducedDiagnostic.
        const diagnostics = current.diagnostics.map((diagnostic) => {
          if (diagnostic.suppression !== null) return diagnostic;
          if (previousKeys.has(diagnostic.diagnostic.diagnosticKey)) {
            return { ...diagnostic, classification: "persistent" as const };
          }
          if (seenKeys.has(diagnostic.diagnostic.diagnosticKey)) {
            return { ...diagnostic, classification: "reintroduced" as const };
          }
          return { ...diagnostic, classification: "new" as const };
        });
        // Suppression is a disposition of a diagnostic reported on this head,
        // not evidence that a previously visible diagnostic disappeared.
        const resolvedDiagnostics = previousDiagnostics
          .filter(({ diagnostic }) => !currentReportedKeys.has(diagnostic.diagnosticKey))
          .map(({ diagnostic }) => diagnostic);
        for (const diagnosticKey of currentVisibleKeys) seenKeys.add(diagnosticKey);

        return {
          ...state,
          analyses,
          currentAnalysis: null,
          latestSuccessfulAnalysis: {
            analysisRequestOffset: event.payload.analysisRequestOffset,
            assessment: event.payload.result.assessment,
            diagnostics,
            request: current.request,
            resolvedDiagnostics,
          },
          seenDiagnosticKeys: [...seenKeys],
        };
      }

      case githubAiLinterEventTypes.reviewPublicationRequested:
        // The assertion preserves the PublicationState discriminant through
        // Array.map; it is the literal already selected by the branch.
        return {
          ...state,
          analyses: state.analyses.map((analysis) =>
            analysis.analysisRequestOffset === event.payload.analysisRequestOffset &&
            analysis.status === "succeeded" &&
            analysis.publication.status === "not-requested"
              ? { ...analysis, publication: { status: "requested" as const } }
              : analysis,
          ),
        };

      case githubAiLinterEventTypes.reviewPublicationSettled:
        return {
          ...state,
          analyses: state.analyses.map((analysis) =>
            analysis.analysisRequestOffset === event.payload.analysisRequestOffset &&
            analysis.publication.status === "requested"
              ? { ...analysis, publication: event.payload.result }
              : analysis,
          ),
        };
    }
  }

  protected override processEvent(
    args: ProcessEventArgs<GithubAiLinterProcessorContract>,
  ): undefined {
    const { append, blockProcessorWhile, delivery, event, previousState, runInBackground, state } =
      args;

    if (
      event?.type === githubAiLinterEventTypes.analysisRequested &&
      previousState.currentAnalysis !== null &&
      previousState.currentAnalysis.analysisRequestOffset !== event.offset
    ) {
      const supersededOffset = previousState.currentAnalysis.analysisRequestOffset;
      // This short append is the permanent consequence of the new request. It
      // must land before the processor advances; otherwise an eviction could
      // leave the old analysis looking active forever.
      blockProcessorWhile(() =>
        this.#appendUnlessLostSettlementRace(append, {
          type: githubAiLinterEventTypes.analysisSettled,
          idempotencyKey: this.idempotencyKey(
            `analysis-cancelled:${supersededOffset}:superseded-by:${event.offset}`,
          ),
          payload: {
            analysisRequestOffset: supersededOffset,
            result: {
              reason: `Superseded by analysis ${event.offset}.`,
              status: "cancelled",
            },
          },
        }),
      );
    }

    if (event?.type === "events.iterate.com/agent/paused" && state.currentAnalysis !== null) {
      const analysisRequestOffset = state.currentAnalysis.analysisRequestOffset;
      // A breaker pause is appended in the background. A newer analysis may
      // have committed first; its request offset then proves this pause
      // belongs to the superseded analysis and must not fail the new head.
      const pauseIsCurrent =
        event.payload.triggerOffset === undefined ||
        event.payload.triggerOffset >= analysisRequestOffset;
      if (pauseIsCurrent) {
        const reason = event.payload.reason
          ? `: ${event.payload.reason}`
          : " before completing its task.";
        blockProcessorWhile(() =>
          this.#appendUnlessLostSettlementRace(append, {
            type: githubAiLinterEventTypes.analysisSettled,
            idempotencyKey: this.idempotencyKey(
              `analysis-failed-on-agent-pause:${analysisRequestOffset}`,
            ),
            payload: {
              analysisRequestOffset,
              result: {
                error: `Analysis agent paused${reason}`.slice(0, 8_000),
                status: "failed",
              },
            },
          }),
        );
      }
    }

    if (event?.type === githubAiLinterEventTypes.analysisSettled) {
      const summary = state.analyses.find(
        ({ analysisRequestOffset }) =>
          analysisRequestOffset === event.payload.analysisRequestOffset,
      );
      if (summary?.status === "succeeded" && summary.publication.status === "not-requested") {
        // Publication is a long external effect, so the must-happen part is
        // only this small durable request. The caught-up obligation below
        // drives GitHub without holding later pushes behind a network call.
        blockProcessorWhile(() =>
          append({
            type: githubAiLinterEventTypes.reviewPublicationRequested,
            idempotencyKey: this.idempotencyKey(
              `review-publication-requested:${event.payload.analysisRequestOffset}`,
            ),
            payload: { analysisRequestOffset: event.payload.analysisRequestOffset },
          }),
        );
      }
    }

    // Behind head, publication outcomes may already exist in an unseen page.
    // Driving from partial state would duplicate reviews.
    if (!delivery.caughtUp) return;

    const latest = state.latestSuccessfulAnalysis;
    for (const analysis of state.analyses) {
      if (
        analysis.publication.status !== "requested" ||
        analysis.analysisRequestOffset === latest?.analysisRequestOffset
      ) {
        continue;
      }
      // Only the newest successful analysis is fully materialized. Any older
      // requested review has necessarily been overtaken, so settle it instead
      // of retaining every old diagnostic payload in Durable Object memory.
      blockProcessorWhile(() =>
        this.#appendUnlessLostSettlementRace(append, {
          type: githubAiLinterEventTypes.reviewPublicationSettled,
          idempotencyKey: this.idempotencyKey(
            `review-publication-settled:${analysis.analysisRequestOffset}`,
          ),
          payload: {
            analysisRequestOffset: analysis.analysisRequestOffset,
            result: {
              reason: "A newer successful analysis superseded this unpublished review.",
              status: "cancelled",
            },
          },
        }),
      );
    }

    if (latest === null) return;
    const latestSummary = state.analyses.find(
      ({ analysisRequestOffset }) => analysisRequestOffset === latest.analysisRequestOffset,
    );
    if (latestSummary?.publication.status !== "requested") return;
    if (
      state.analyses.some(
        ({ analysisRequestOffset }) => analysisRequestOffset > latest.analysisRequestOffset,
      )
    ) {
      // A failed replacement analysis must not make an older policy result
      // publishable again. New analysis identity supersedes the old review
      // obligation immediately; it does not depend on the replacement
      // succeeding.
      blockProcessorWhile(() =>
        this.#appendUnlessLostSettlementRace(append, {
          type: githubAiLinterEventTypes.reviewPublicationSettled,
          idempotencyKey: this.idempotencyKey(
            `review-publication-settled:${latest.analysisRequestOffset}`,
          ),
          payload: {
            analysisRequestOffset: latest.analysisRequestOffset,
            result: {
              reason: "A newer analysis superseded this unpublished review.",
              status: "cancelled",
            },
          },
        }),
      );
      return;
    }

    // Supersession above is a durable consequence and must not be hidden by
    // this incarnation's runtime-only attempt guard. If publication is already
    // in flight, its eventual settlement races the cancellation on the same
    // idempotency key and the cancellation remains authoritative.
    if (this.#livePublications.has(latest.analysisRequestOffset)) return;

    this.#livePublications.add(latest.analysisRequestOffset);
    // A dropped attempt is recovered from the still-requested state on the
    // next caught-up/revival pass. The GitHub body marker makes the vendor
    // side idempotent if the review landed but its settlement append did not.
    runInBackground(async () => {
      let result: GithubAiLinterPublicationResult;
      try {
        result = await this.deps.publishReview(latest);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = {
          error: message.slice(0, 8_000) || "Unknown GitHub publication failure.",
          status: "failed",
        };
      }
      try {
        await this.#appendUnlessLostSettlementRace(append, {
          type: githubAiLinterEventTypes.reviewPublicationSettled,
          idempotencyKey: this.idempotencyKey(
            `review-publication-settled:${latest.analysisRequestOffset}`,
          ),
          payload: {
            analysisRequestOffset: latest.analysisRequestOffset,
            result,
          },
        });
      } finally {
        this.#livePublications.delete(latest.analysisRequestOffset);
      }
    });
  }

  /**
   * Redelivered cancellations and overlapping publication attempts can race
   * on one processor-owned terminal key. The first committed terminal fact is
   * the authority; a same-key/different-body rejection therefore means the
   * work is already settled, not that the stream should wedge.
   */
  async #appendUnlessLostSettlementRace(
    append: ProcessEventArgs<GithubAiLinterProcessorContract>["append"],
    event: EmittedInput<GithubAiLinterProcessorContract>,
  ): Promise<void> {
    try {
      await append(event);
    } catch (error) {
      if (!isIdempotencyConflict(error)) throw error;
    }
  }
}

/**
 * Convert one materialized analysis into a non-blocking GitHub review, or an
 * explicit skipped result when there are no findings to publish. All
 * qualitative freedom ended when the agent appended its diagnostic and
 * assessment events; this function is intentionally mechanical.
 */
export async function publishGithubAiLinterReview(
  itx: Project,
  analysis: GithubAiLinterPublicationAnalysis,
): Promise<GithubAiLinterPublicationResult> {
  const hasVisibleDiagnostics = analysis.diagnostics.some(
    ({ suppression }) => suppression === null,
  );
  const publishesReview = hasVisibleDiagnostics || analysis.assessment.verdict !== "approve";

  const { request } = analysis;
  const params = {
    owner: request.repository.owner,
    pull_number: request.pullRequestNumber,
    repo: request.repository.repo,
  };
  const octokit = itx.integrations.github.get(request.connection).octokit;
  const pull = await octokit.rest.pulls.get(params);
  if (
    pull.data.state !== "open" ||
    pull.data.draft === true ||
    pull.data.head.sha !== request.headSha ||
    pull.data.base.sha !== request.baseSha
  ) {
    return {
      reason: [
        "Pull request changed before publication.",
        `Expected open/non-draft base ${request.baseSha} and head ${request.headSha};`,
        `observed state ${pull.data.state}, draft ${String(pull.data.draft)}, base ${pull.data.base.sha}, head ${pull.data.head.sha}.`,
      ].join(" "),
      status: "cancelled",
    };
  }

  // This proof-of-concept marker is scoped to repository/head/stream offset.
  // If one GitHub PR must receive distinct reviews from several Iterate
  // projects with identical stream coordinates, add a stable project/config
  // identity to the request and marker before enabling that topology.
  const publicationId = `iterate-github-ai-linter:${analysis.request.repository.id}:analysis:${analysis.analysisRequestOffset}:head:${analysis.request.headSha}`;
  const marker = `<!-- ${publicationId} -->`;
  const checkName = "Iterate GitHub AI linter";
  const existingChecks = await octokit.rest.checks.listForRef({
    check_name: checkName,
    filter: "all",
    owner: params.owner,
    per_page: 100,
    ref: request.headSha,
    repo: params.repo,
  });
  const existingCheck = existingChecks.data.check_runs.find(
    (checkRun) => checkRun.external_id === publicationId,
  );
  const checkResponse =
    existingCheck === undefined
      ? await octokit.rest.checks.create({
          conclusion: publishesReview ? "neutral" : "success",
          external_id: publicationId,
          head_sha: request.headSha,
          name: checkName,
          output: {
            summary: publishesReview
              ? `The linter completed and found advisory issues. A non-blocking COMMENT review contains the inline details when publication succeeds.\n\n${analysis.assessment.summary}`
              : analysis.assessment.summary,
            title: publishesReview ? "Advisory findings found" : "No issues found",
          },
          owner: params.owner,
          repo: params.repo,
          status: "completed",
        })
      : { data: existingCheck };
  if (checkResponse.data.html_url === null) {
    throw new Error(`GitHub Check Run ${checkResponse.data.id} did not provide an HTML URL.`);
  }
  const checkRun = { id: checkResponse.data.id, url: checkResponse.data.html_url };
  if (!publishesReview) {
    return {
      checkRun,
      reason: "No visible findings to publish.",
      status: "skipped",
    };
  }

  const reviews = await octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    ...params,
    per_page: 100,
  });
  // The marker is predictable, so body text alone is not authority: a human
  // reviewer could otherwise paste it and suppress the App's real review.
  const existingReview = reviews.find(
    (candidate) =>
      candidate.user?.login === `${request.appSlug}[bot]` &&
      candidate.body?.includes(marker) === true,
  );
  if (existingReview !== undefined) {
    return {
      checkRun,
      reviewId: existingReview.id,
      reviewUrl: existingReview.html_url,
      status: "succeeded",
    };
  }

  // GitHub validates every inline location atomically with createReview. This
  // intentionally records an explicit failed publication if the LLM supplied
  // a stale/non-diff span. The neutral Check Run already records the advisory
  // result, so a review failure cannot leave an unexplained review-only write.
  const reviewResponse = await octokit.rest.pulls.createReview({
    ...params,
    body: githubAiLinterReviewBody(analysis, marker),
    comments: githubAiLinterReviewComments(analysis),
    commit_id: request.headSha,
    event: "COMMENT",
  });
  return {
    checkRun,
    reviewId: reviewResponse.data.id,
    reviewUrl: reviewResponse.data.html_url,
    status: "succeeded",
  };
}

function githubAiLinterReviewBody(analysis: GithubAiLinterPublicationAnalysis, marker: string) {
  const visible = analysis.diagnostics.filter(({ suppression }) => suppression === null);
  const suppressedCount = analysis.diagnostics.length - visible.length;
  const sections = [
    marker,
    "## Iterate GitHub AI linter",
    [
      `${visible.filter(({ diagnostic }) => diagnostic.severity === "error").length} errors,`,
      `${visible.filter(({ diagnostic }) => diagnostic.severity === "warning").length} warnings,`,
      `${suppressedCount} suppressed,`,
      `${analysis.resolvedDiagnostics.length} resolved.`,
    ].join(" "),
    analysis.assessment.summary,
  ];

  // The tuple assertion gives the loop the exact classification union already
  // accepted by state, rather than claiming anything about external data.
  for (const classification of ["new", "persistent", "reintroduced"] as const) {
    const diagnostics = visible.filter(
      (diagnostic) => diagnostic.classification === classification,
    );
    if (diagnostics.length === 0) continue;
    sections.push(
      `### ${classification[0]!.toUpperCase()}${classification.slice(1)}`,
      diagnostics
        .map(
          ({ diagnostic }) =>
            `- **[${diagnostic.ruleName}]** \`${diagnostic.filename}:${diagnostic.labels[0]!.span.startLine}\` — ${diagnostic.message}`,
        )
        .join("\n"),
    );
  }

  if (analysis.resolvedDiagnostics.length > 0) {
    sections.push(
      "### Resolved",
      analysis.resolvedDiagnostics
        .map(
          (diagnostic) =>
            `- **[${diagnostic.ruleName}]** \`${diagnostic.filename}\` — ${diagnostic.message}`,
        )
        .join("\n"),
    );
  }
  return sections.join("\n\n");
}

function githubAiLinterReviewComments(analysis: GithubAiLinterPublicationAnalysis) {
  return analysis.diagnostics
    .filter(({ suppression }) => suppression === null)
    .map(({ classification, diagnostic }) => {
      const span = diagnostic.fix?.span ?? diagnostic.labels[0]!.span;
      const body = [
        `**[${diagnostic.ruleName}]**${classification === null ? "" : ` _${classification}_`}`,
        diagnostic.message,
        diagnostic.help,
        diagnostic.fix === undefined
          ? undefined
          : `${suggestionFence(diagnostic.fix.content)}suggestion\n${diagnostic.fix.content}\n${suggestionFence(diagnostic.fix.content)}`,
      ]
        .filter((part) => part !== undefined)
        .join("\n\n");
      // Octokit requires literal RIGHT-side enum members. These assertions
      // preserve those constants across the map/spread expression; locations
      // themselves came from the validated diagnostic schema.
      return {
        body,
        line: span.endLine,
        path: diagnostic.filename,
        side: "RIGHT" as const,
        ...(span.startLine === span.endLine
          ? {}
          : { start_line: span.startLine, start_side: "RIGHT" as const }),
      };
    });
}

function suggestionFence(content: string) {
  const longestRun = Math.max(3, ...[...content.matchAll(/`+/g)].map(([run]) => run.length + 1));
  return "`".repeat(longestRun);
}
