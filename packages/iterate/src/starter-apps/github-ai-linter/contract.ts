import { z } from "zod";
import { defineProcessorContract } from "../../processors/index.ts";

/**
 * Keep the vocabulary flat. These names are also copied into the linter
 * agent's developer task, so changing one here deliberately breaks an old
 * prompt instead of leaving two almost-compatible protocols alive.
 *
 * The const assertion preserves exact event literals for contract typing. It
 * is safe because this object is static vocabulary and is never mutated.
 */
export const githubAiLinterEventTypes = {
  analysisRequested: "events.iterate.com/github-ai-linter/analysis-requested",
  diagnosticReported: "events.iterate.com/github-ai-linter/diagnostic-reported",
  diagnosticSuppressed: "events.iterate.com/github-ai-linter/diagnostic-suppressed",
  analysisSettled: "events.iterate.com/github-ai-linter/analysis-settled",
  reviewPublicationRequested: "events.iterate.com/github-ai-linter/review-publication-requested",
  reviewPublicationSettled: "events.iterate.com/github-ai-linter/review-publication-settled",
} as const;

const PositiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Stream offset zero is the valid "before the first event" coordinate in the
// processor APIs. Keeping it distinct from GitHub IDs and source lines avoids
// accidentally rejecting a request simply because it was the stream's first
// committed event.
const StreamOffset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const RuleName = z.string().regex(/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/);

const GithubAiLinterRule = z.object({
  files: z.array(z.string().min(1)).min(1),
  invariant: z.string().min(1),
  severity: z.enum(["error", "warning"]),
});

export const GithubAiLinterAnalysisRequested = z.object({
  appSlug: z.string().min(1),
  baseSha: z.string().min(1),
  connection: z.string().min(1),
  headSha: z.string().min(1),
  policyVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  pullRequestNumber: PositiveSafeInteger,
  repository: z.object({
    id: PositiveSafeInteger,
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  rules: z.record(RuleName, GithubAiLinterRule),
  rulesCommit: z.string().min(1),
});

const SourceSpanSchema = z
  .object({
    endColumn: PositiveSafeInteger.optional(),
    endLine: PositiveSafeInteger,
    startColumn: PositiveSafeInteger.optional(),
    startLine: PositiveSafeInteger,
  })
  .refine(
    ({ endLine, startLine }) => endLine >= startLine,
    "a source span must end on or after its start line",
  );
const WholeLineSpanSchema = z
  .object({
    endLine: PositiveSafeInteger,
    startLine: PositiveSafeInteger,
  })
  .refine(
    ({ endLine, startLine }) => endLine >= startLine,
    "a source span must end on or after its start line",
  );

const GithubAiLinterDiagnostic = z.object({
  /**
   * Cross-analysis identity. Unlike the GitHub line, this should survive
   * nearby edits: rule + filename + a short semantic anchor is the intended
   * input. The prompt explicitly forbids line numbers and prose here.
   */
  diagnosticKey: z.string().min(1).max(500),
  filename: z.string().min(1).max(2_000),
  fix: z
    .object({
      content: z.string().max(50_000),
      /**
       * The first slice only publishes human-applied GitHub suggestions.
       * A future `fix` kind may authorize an automated branch update, but it
       * must be a separate explicit protocol: never reinterpret an archived
       * suggestion as permission to mutate code.
       */
      kind: z.literal("suggestion"),
      span: WholeLineSpanSchema,
    })
    .optional(),
  help: z.string().min(1).max(8_000).optional(),
  /**
   * Oxlint diagnostics can carry several labels. The first label is the
   * primary one and supplies GitHub's inline location in this first version;
   * later labels remain structured context for a richer renderer.
   */
  labels: z
    .array(
      z.object({
        message: z.string().min(1).max(4_000).optional(),
        span: SourceSpanSchema,
      }),
    )
    .min(1)
    .max(20),
  message: z.string().min(1).max(8_000),
  ruleName: RuleName,
  severity: z.enum(["error", "warning"]),
});

const GithubAiLinterDiagnosticReportedPayload = GithubAiLinterDiagnostic.extend({
  analysisRequestOffset: StreamOffset,
});

const GithubAiLinterDiagnosticSuppressedPayload = z.object({
  analysisRequestOffset: StreamOffset,
  diagnosticOffset: StreamOffset,
  directive: z.enum(["disable", "disable-line", "disable-next-line"]),
  filename: z.string().min(1).max(2_000),
  line: PositiveSafeInteger,
  reason: z.string().min(1).max(4_000),
});

const GithubAiLinterAssessment = z.object({
  summary: z.string().min(1).max(20_000),
  verdict: z.enum(["approve", "comment", "request-changes"]),
});

const GithubAiLinterAnalysisResult = z.discriminatedUnion("status", [
  z.object({
    assessment: GithubAiLinterAssessment,
    status: z.literal("succeeded"),
  }),
  z.object({
    reason: z.string().min(1).max(8_000),
    status: z.literal("cancelled"),
  }),
  z.object({
    error: z.string().min(1).max(8_000),
    status: z.literal("failed"),
  }),
]);

const GithubAiLinterAnalysisSettledPayload = z.object({
  analysisRequestOffset: StreamOffset,
  result: GithubAiLinterAnalysisResult,
});

export const GithubAiLinterPublicationResult = z.discriminatedUnion("status", [
  z.object({
    reviewId: PositiveSafeInteger,
    reviewUrl: z.string().url(),
    status: z.literal("succeeded"),
  }),
  z.object({
    reason: z.string().min(1).max(8_000),
    status: z.literal("cancelled"),
  }),
  z.object({
    error: z.string().min(1).max(8_000),
    status: z.literal("failed"),
  }),
]);

const PublicationState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-requested") }),
  z.object({ status: z.literal("requested") }),
  ...GithubAiLinterPublicationResult.options,
]);

const ReducedDiagnostic = z.object({
  classification: z.enum(["new", "persistent", "reintroduced"]).nullable(),
  diagnostic: GithubAiLinterDiagnostic,
  eventOffset: StreamOffset,
  suppression: GithubAiLinterDiagnosticSuppressedPayload.nullable(),
});

const AnalysisSummary = z.object({
  analysisRequestOffset: StreamOffset,
  baseSha: z.string().min(1),
  diagnosticCount: z.number().int().nonnegative(),
  headSha: z.string().min(1),
  publication: PublicationState,
  rulesCommit: z.string().min(1),
  status: z.enum(["running", "succeeded", "cancelled", "failed"]),
  suppressedDiagnosticCount: z.number().int().nonnegative(),
});

const MaterializedAnalysis = z.object({
  analysisRequestOffset: StreamOffset,
  assessment: GithubAiLinterAssessment,
  diagnostics: z.array(ReducedDiagnostic),
  request: GithubAiLinterAnalysisRequested,
  resolvedDiagnostics: z.array(GithubAiLinterDiagnostic),
});

const ActiveAnalysis = z.object({
  /**
   * There is deliberately no wall-clock expiry in the first slice. New pushes
   * cancel old work, while the Agent processor's autonomous-turn breaker
   * explicitly fails an analysis which cannot finish within its configured
   * budget. A future time limit should likewise be a typed processor-authored
   * settlement event driven by a durable alarm, not an implicit timestamp
   * check that silently changes reduced state.
   */
  analysisRequestOffset: StreamOffset,
  diagnostics: z.array(ReducedDiagnostic),
  request: GithubAiLinterAnalysisRequested,
});

export const GithubAiLinterState = z.object({
  /**
   * These are intentionally lightweight headers, not copies of every prompt
   * and diagnostic. The stream remains the canonical full history. If a PR
   * eventually accumulates enough pushes for even these headers to matter,
   * move cold headers to a paged read model rather than retaining full
   * diagnostics in Durable Object state.
   */
  analyses: z.array(AnalysisSummary).default([]),
  currentAnalysis: ActiveAnalysis.nullable().default(null),
  latestSuccessfulAnalysis: MaterializedAnalysis.nullable().default(null),
  /**
   * This small semantic-key index is what lets a later result distinguish
   * "new" from "reintroduced." A production-scale rule engine should replace
   * it with a compact/bounded index; the event history already contains the
   * authoritative data needed to rebuild one.
   */
  seenDiagnosticKeys: z.array(z.string()).default([]),
});

export const GithubAiLinterProcessorContract = defineProcessorContract({
  slug: "github-ai-linter",
  version: "0.2.0",
  description:
    "Reduces one pull request's AI diagnostics and mechanically publishes its GitHub review.",
  stateSchema: GithubAiLinterState,
  events: {
    [githubAiLinterEventTypes.analysisRequested]: {
      description: "Pins one pull-request head and immutable rules snapshot for analysis.",
      payloadSchema: GithubAiLinterAnalysisRequested,
    },
    [githubAiLinterEventTypes.diagnosticReported]: {
      description: "One Oxlint-shaped diagnostic reported by the analysis agent.",
      payloadSchema: GithubAiLinterDiagnosticReportedPayload,
    },
    [githubAiLinterEventTypes.diagnosticSuppressed]: {
      description: "Records that a source directive suppresses one reported diagnostic.",
      payloadSchema: GithubAiLinterDiagnosticSuppressedPayload,
    },
    [githubAiLinterEventTypes.analysisSettled]: {
      description: "The sole terminal fact for an analysis request.",
      payloadSchema: GithubAiLinterAnalysisSettledPayload,
    },
    [githubAiLinterEventTypes.reviewPublicationRequested]: {
      description: "Opens the durable obligation to publish one immutable GitHub review.",
      payloadSchema: z.object({ analysisRequestOffset: StreamOffset }),
    },
    [githubAiLinterEventTypes.reviewPublicationSettled]: {
      description: "Records the terminal GitHub publication result.",
      payloadSchema: z.object({
        analysisRequestOffset: StreamOffset,
        result: GithubAiLinterPublicationResult,
      }),
    },
  },
  // `agent/paused` is owned by the platform Agent contract. This userspace
  // processor consumes it only to turn an exhausted analysis into a durable
  // terminal fact instead of leaving it visibly `running`.
  processorDeps: [
    {
      "events.iterate.com/agent/paused": {
        description: "The generic Agent processor paused its autonomous turn loop.",
        payloadSchema: z.object({
          reason: z.string().optional(),
          triggerOffset: StreamOffset.optional(),
        }),
      },
    },
  ],
  consumes: [...Object.values(githubAiLinterEventTypes), "events.iterate.com/agent/paused"],
  // `diagnostic-reported` and `diagnostic-suppressed` are declared above and
  // consumed here, but are not processor emissions: the generic Agent appends
  // them with its ordinary stream capability. This list is deliberately only
  // the mechanical processor's own consequences.
  emits: [
    githubAiLinterEventTypes.analysisSettled,
    githubAiLinterEventTypes.reviewPublicationRequested,
    githubAiLinterEventTypes.reviewPublicationSettled,
  ],
});

export type GithubAiLinterProcessorContract = typeof GithubAiLinterProcessorContract;
export type GithubAiLinterState = z.infer<typeof GithubAiLinterState>;
export type GithubAiLinterAnalysisRequested = z.infer<typeof GithubAiLinterAnalysisRequested>;
export type GithubAiLinterPublicationResult = z.infer<typeof GithubAiLinterPublicationResult>;
