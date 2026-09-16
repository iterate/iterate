import { z } from "zod";

/** One immutable descriptor shared by prepare, app tests and every browser shard. */
export const PreviewTestRun = z.object({
  id: z.string().min(1).max(200),
  expiresAt: z.number().int().positive(),
});
export type PreviewTestRun = z.infer<typeof PreviewTestRun>;

export const PREVIEW_TEST_RUN_HEADER = "x-iterate-preview-test-run";

/** The streams playground has arbitrary namespaces, not Auth-generated projects. */
export function previewTestStreamProjectId(run: PreviewTestRun): string {
  return `preview-test-${run.id.replaceAll("/", "-")}`;
}

export function previewTestRunHeaders(
  environment: Record<string, string | undefined>,
): Record<string, string> {
  const raw = environment.PREVIEW_TEST_RUN;
  if (!raw) return {};
  const run = PreviewTestRun.parse(JSON.parse(raw));
  return { [PREVIEW_TEST_RUN_HEADER]: JSON.stringify(run) };
}
