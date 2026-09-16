import { expect, test } from "vitest";
import { tracePullRequestBody } from "./trace-publication.ts";
import { renderTrace } from "./trace-viewer.ts";
import { assembleTrace } from "./trace-model.ts";

test("publishing preserves human text, replaces only its block, and rejects stale runs/heads", () => {
  const original = "Human notes\n\n<!-- preview -->\nOther automation\n<!-- /preview -->";
  const run = {
    headSha: "current",
    createdAt: "2026-09-16T12:00:00Z",
    workflowId: "run1",
    status: "finished",
    url: "https://iterate.iterate.app/explainers/ci-trace-run1?sha=abc",
  };
  const first = tracePullRequestBody(original, "current", run);
  expect(first).toContain(original);
  expect(first).toContain(`[Open interactive CI trace](${run.url})`);
  const next = tracePullRequestBody(first, "current", {
    ...run,
    createdAt: "2026-09-16T13:00:00Z",
    workflowId: "run2",
    url: run.url.replace("run1", "run2"),
  });
  expect(next).not.toContain("ci-trace-run1?");
  expect(tracePullRequestBody(next, "current", run)).toBe(next);
  expect(tracePullRequestBody(next, "new-head", run)).toBe(next);
  expect(tracePullRequestBody(first, "current", run)).toBe(first);
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
