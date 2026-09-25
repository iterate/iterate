import { z } from "zod";

/** A full CI suite publishes this even when its flake record list is empty. */
export const FlakeSuiteSummary = z
  .object({
    headSha: z.string().min(1),
    branch: z.string(),
    status: z.enum(["complete", "incomplete"]),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    testCount: z.number().int().nonnegative(),
    tests: z.array(
      z.object({
        name: z.string().min(1),
        outcome: z.enum(["pass", "fail", "skip"]),
        // What the flake dashboard's Cost section reads (scripts/ci/flake-dashboard/dashboard.ts):
        // how long the row ran, when it started after the suite did, its tags, its retries,
        // whether it failed after them, and its first failure's message.
        durationMs: z.number().int().nonnegative().optional(),
        startMs: z.number().int().nonnegative().optional(),
        tags: z.array(z.string()).optional(),
        retries: z.number().int().nonnegative().optional(),
        failed: z.boolean().optional(),
        error: z.string().max(300).optional(),
      }),
    ),
    // The kind "unknown" records the suite wrote (retried passes and hard failures of plain tests):
    // the dashboard marks a run incomplete when its record lines do not add up to it.
    unknownFlakeCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    // The preview e2e suite only: whether it ran its rows tagged `slow`, which a PR that touches
    // none of their code skips. Absent from summaries written before the tag existed, when every
    // row ran. scripts/ci/pr-ttg-guard.ts splits the PR time to green on it.
    slowRows: z.enum(["ran", "skipped"]).optional(),
    diagnostics: z.array(z.string()),
    runUrl: z.url(),
  })
  .refine(
    (summary) =>
      summary.status !== "complete" ||
      (summary.testCount > 0 && !!summary.branch && summary.diagnostics.length === 0),
    "A complete suite needs executed tests and no missing-result diagnostics",
  );
