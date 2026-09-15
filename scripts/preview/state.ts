import { z } from "zod";

export const CloudflarePreviewSlotDisplay = z.object({
  dopplerConfig: z.string().trim().min(1),
  slug: z.string().trim().min(1),
});
export type CloudflarePreviewSlotDisplay = z.infer<typeof CloudflarePreviewSlotDisplay>;

const CloudflarePreviewStatus = z.enum([
  "awaiting-tests",
  "claim-failed",
  "cleanup-failed",
  "deploy-failed",
  "deployed",
  "released",
  "tests-failed",
]);

export const CloudflarePreviewAppEntry = z.object({
  appDisplayName: z.string().trim().min(1),
  appSlug: z.string().trim().min(1),
  status: CloudflarePreviewStatus,
  updatedAt: z.string().trim().min(1),
  /** When the successful app deploy command completed for this exact version. */
  deployedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  headSha: z.string().trim().min(1).nullable().optional(),
  message: z.string().trim().min(1).nullable().optional(),
  publicUrl: z.string().trim().url().nullable().optional(),
  runUrl: z.string().trim().url().nullable().optional(),
  shortSha: z.string().trim().min(1).nullable().optional(),
  cleanupDurationMs: z.number().nonnegative().finite().nullable().optional(),
  deployDurationMs: z.number().nonnegative().finite().nullable().optional(),
  /** Time spent resolving the Doppler-backed public URL and Worker identity. */
  deployConfigDurationMs: z.number().nonnegative().finite().nullable().optional(),
  /** Time spent in the app's build, Cloudflare mutation, and app-level smoke command. */
  deployCommandDurationMs: z.number().nonnegative().finite().nullable().optional(),
  /** Time from a successful deploy command to exact-version readiness. */
  deployReadinessDurationMs: z.number().nonnegative().finite().nullable().optional(),
  /** Time spent proving that a content-identical recorded deployment can be reused. */
  deployReuseProofDurationMs: z.number().nonnegative().finite().nullable().optional(),
  /** Public Worker script and immutable Wrangler version proven by this entry. */
  deployedWorkerName: z.string().trim().min(1).nullable().optional(),
  deployedWorkerVersion: z.uuid().nullable().optional(),
  testDurationMs: z.number().nonnegative().finite().nullable().optional(),
  /** Rendered retry telemetry for the last test run (renderPreviewRetrySummary). */
  testRetries: z.string().trim().min(1).nullable().optional(),
  /** Wrangler-reported "Total Upload" of the deployed worker, in KiB. */
  workerSizeKib: z.number().nonnegative().finite().nullable().optional(),
  /** Wrangler-reported gzip size of the deployed worker, in KiB. */
  workerGzipKib: z.number().nonnegative().finite().nullable().optional(),
  /** Content fingerprint of the deployed sources (contentFingerprintPaths). */
  deployedFingerprint: z.string().trim().min(1).nullable().optional(),
  /**
   * Main's deployed gzip size in KiB at deploy time, read from the
   * `worker-size/<app>` commit status main deploys publish — the baseline for
   * the table's "vs main" delta. Absent until the first post-merge main
   * deploy publishes one.
   */
  mainWorkerGzipKib: z.number().nonnegative().finite().nullable().optional(),
});
export type CloudflarePreviewAppEntry = z.infer<typeof CloudflarePreviewAppEntry>;

export const CloudflarePreviewState = z.object({
  apps: z.record(z.string().trim().min(1), CloudflarePreviewAppEntry).default({}),
  // Display only (see CloudflarePreviewSlotDisplay). Bodies written before
  // the semaphore became the single lease truth carry extra lease fields
  // (leaseId, leasedUntil, type); z.object strips them on parse.
  environmentConfigLease: CloudflarePreviewSlotDisplay.nullable().default(null),
  /**
   * Prominent banner rendered at the top of the managed PR-body section —
   * slot exhaustion, slot takeovers, and moves land here so they are
   * impossible to miss. Cleared by the next successful deploy claim.
   */
  notice: z.string().trim().min(1).nullable().default(null),
});

export type CloudflarePreviewState = z.infer<typeof CloudflarePreviewState>;
