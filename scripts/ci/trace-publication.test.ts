import { expect, test } from "vitest";
import { traceCommitStatus } from "./trace-publication.ts";
import { renderTrace } from "./trace-viewer.ts";
import { assembleTrace } from "./trace-model.ts";

test("the trace status points at the tested commit and keeps the newest execution on replay", () => {
  const run = {
    headSha: "tested-head",
    createdAt: "2026-09-16T12:00:00Z",
    url: "https://iterate.iterate.app/explainers/ci-trace-run1?sha=abc",
  };
  const first = traceCommitStatus(undefined, run);
  expect(first).toMatchObject({
    sha: "tested-head",
    context: "CI trace",
    state: "success",
    target_url: run.url,
  });
  const next = traceCommitStatus(first!, {
    ...run,
    createdAt: "2026-09-16T13:00:00Z",
    url: run.url.replace("run1", "run2"),
  });
  expect(next).toMatchObject({ target_url: run.url.replace("run1", "run2") });
  expect(traceCommitStatus(next!, run)).toBeNull();
  expect(traceCommitStatus(first!, run)).toBeNull();
});

test("the standalone report embeds OTLP without allowing source names to break out of JSON", async () => {
  const report = assembleTrace(
    {
      workflowId: "run",
      workflowName: '</script><img src=x onerror="alert(1)">',
      workflowPath: "preview.yml",
      repo: "iterate/iterate",
      headSha: "abc",
      sha: "merge",
      ref: "refs/pull/1/merge",
      workflowStatus: "finished",
      workflowCreatedAt: "2026-09-16T12:00:00Z",
      workflowFinishedAt: "2026-09-16T12:01:00Z",
      executions: [{ executionId: "one", execution: 1, createdAt: "2026-09-16T12:00:00Z" }],
      jobs: [],
    },
    new Map(),
  );
  const html = await renderTrace(report);
  expect(html).not.toContain("<img src=x");
  expect(
    JSON.parse(html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)![1]),
  ).toEqual(report);
});
