import { expect, test } from "vitest";
import { partialRetryReason } from "./run-policy.ts";

test("a full rerun can start while the other jobs still show queued old attempts", () => {
  expect(
    partialRetryReason(
      workflow([
        job("prepare", "running", [attempt(1, "00:00", "failed"), attempt(2, "01:01", "running")]),
        job("apps", "queued", [attempt(1, "00:05", "finished")]),
      ]),
      "prepare",
    ),
  ).toBeNull();
});

test("a partial retry cannot retain preparation from before cleanup", () => {
  expect(
    partialRetryReason(
      workflow([
        job("prepare", "finished", [attempt(1, "00:00", "finished")]),
        job("apps", "running", [attempt(1, "00:05", "failed"), attempt(2, "01:01", "running")]),
      ]),
      "apps",
    ),
  ).toContain("retains");
});

test("retrying a job while its original execution is still active also requires recovery", () => {
  const run = workflow([
    job("prepare", "finished", [attempt(1, "01:01", "finished")]),
    job("apps", "running", [attempt(1, "01:05", "failed"), attempt(2, "01:06", "running")]),
    job("finish", "running", [attempt(1, "01:02", "running")]),
  ]);
  expect(partialRetryReason(run, "apps")).toContain("already ran");
  // The original finalizer must still be allowed to clean up.
  expect(partialRetryReason(run, "finish")).toBeNull();
});

test("a previously skipped job's first attempt is still a partial retry", () => {
  expect(
    partialRetryReason(
      workflow([
        job("prepare", "finished", [attempt(1, "00:00", "finished")]),
        job("apps", "running", [attempt(1, "01:01", "running")]),
      ]),
      "apps",
    ),
  ).toContain("retains");
});

function workflow(jobs: any[]): any {
  return {
    executions: [{ executionId: "execution", execution: 2, createdAt: "2026-09-18T01:00:00Z" }],
    jobs,
  };
}
function job(id: string, status: string, attempts: any[]) {
  return { jobId: id, jobKey: `preview-run.yml:${id}`, status, attempts };
}
function attempt(number: number, time: string, status: string) {
  return {
    attemptId: `${number}-${time}`,
    attempt: number,
    startedAt: `2026-09-18T${time}:00Z`,
    status,
  };
}
