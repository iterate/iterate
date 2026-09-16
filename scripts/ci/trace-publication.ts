import { z } from "zod";
import { markdownAnnotator } from "../../packages/shared/src/dev/markdown-annotator.ts";

export function tracePullRequestBody(body: string, currentHead: string, run: ReportLink) {
  if (run.headSha !== currentHead) return body;
  const block = markdownAnnotator(body, "ci-trace");
  const previous = block.current?.match(/<!-- ci-trace-run (.+) -->/);
  if (previous) {
    const prior = ReportLink.parse(JSON.parse(previous[1]));
    if (prior.headSha === run.headSha && Date.parse(prior.createdAt) > Date.parse(run.createdAt))
      return body;
  }
  return block.update(
    [
      `[Open interactive CI trace](${run.url}) — ${run.status}, \`${run.headSha.slice(0, 8)}\`.`,
      "Workflow → jobs → setup / wait / test → Playwright attempts and retries. Includes an OTLP JSON download.",
      `<!-- ci-trace-run ${JSON.stringify(run)} -->`,
    ].join("\n\n"),
  );
}

const ReportLink = z.object({
  headSha: z.string(),
  createdAt: z.string(),
  workflowId: z.string(),
  status: z.string(),
  url: z.string().url(),
});
type ReportLink = z.infer<typeof ReportLink>;
