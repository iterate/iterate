import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { appendFlakeRecord, unknownFlakeRecordFromTelemetry } from "./flake-record.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

test("a plain test that passed after retry maps to an unknown-flake record", () => {
  expect(
    unknownFlakeRecordFromTelemetry({
      fullName: "chromium › chat.spec.ts › chat can upload a file",
      leafName: "chat can upload a file",
      expectedState: "passed",
      passedAfterRetry: true,
      durationMs: 1200,
      startedAt: "2026-09-04T09:00:00Z",
      firstFailure: "Timeout 30000ms exceeded waiting for getByLabel('attachment')",
    }),
  ).toMatchObject({
    name: "chat can upload a file",
    kind: "unknown",
    outcome: "retried-pass",
    at: "2026-09-04T09:00:00Z",
    error: "Timeout 30000ms exceeded waiting for getByLabel('attachment')",
  });
});

test("a plain test that failed every attempt maps to an unexpected-error record", () => {
  const failed = {
    fullName: "e2e › socket › opens",
    leafName: "opens",
    passedAfterRetry: false,
    durationMs: 61_000,
    startedAt: "2026-09-04T09:00:00Z",
    firstFailure: "socket closed before the stream opened",
  };
  // vitest: the final state; Playwright: its verdict against the expected status.
  for (const verdict of [{ state: "failed" }, { state: "timedOut", outcome: "unexpected" }])
    expect(unknownFlakeRecordFromTelemetry({ ...failed, ...verdict })).toEqual({
      name: "opens",
      kind: "unknown",
      outcome: "unexpected-error",
      durationMs: 61_000,
      at: "2026-09-04T09:00:00Z",
      error: "socket closed before the stream opened",
    });
});

test.for([
  { name: "a first attempt that passed", telemetry: { passedAfterRetry: false, state: "passed" } },
  { name: "a skipped test", telemetry: { passedAfterRetry: false, state: "skipped" } },
  { name: "an interrupted test", telemetry: { passedAfterRetry: false, state: "interrupted" } },
  // Playwright calls a test whose first attempt failed and whose retry was cut short by a cancelled
  // run "unexpected"; the retry never finished, so it is not a hard failure.
  {
    name: "a retry a cancelled run cut short",
    telemetry: { passedAfterRetry: false, state: "interrupted", outcome: "unexpected" },
  },
  {
    name: "a failure Playwright expected",
    telemetry: { passedAfterRetry: false, state: "failed", outcome: "expected" },
  },
  // createFlake / createFailing register in the runner's expected-fail mode: their outcomes,
  // retried or failed, must never masquerade as unknown flakes.
  { name: "an expected-fail retried pass", telemetry: { expectedState: "failed" } },
  {
    name: "an expected-fail test that failed",
    telemetry: { passedAfterRetry: false, expectedState: "failed", state: "failed" },
  },
  { name: "a skip-mode test", telemetry: { expectedState: "skip" } },
])("$name maps to no flake record", ({ telemetry }) => {
  expect(
    unknownFlakeRecordFromTelemetry({
      fullName: "some test",
      passedAfterRetry: true,
      durationMs: 10,
      ...telemetry,
    }),
  ).toBeNull();
});

test("vitest reports options only for tests that set any: a missing expectedState is a plain test", () => {
  expect(
    unknownFlakeRecordFromTelemetry({
      fullName: "some test",
      passedAfterRetry: true,
      durationMs: 10,
    }),
  ).toMatchObject({ outcome: "retried-pass" });
});

test("appendFlakeRecord writes one jsonl line per record into FLAKE_RECORD_DIR", async () => {
  using dir = temporaryDirectory();
  vi.stubEnv("FLAKE_RECORD_DIR", dir.path);
  vi.stubEnv("GITHUB_WORKSPACE", "");
  await appendFlakeRecord({
    name: "some test",
    kind: "unknown",
    outcome: "retried-pass",
    durationMs: 5,
    at: "2026-09-04T09:00:00Z",
  });
  const lines = readdirSync(dir.path).flatMap((file) =>
    readFileSync(join(dir.path, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
  expect(lines).toMatchObject([{ name: "some test", kind: "unknown" }]);
});
