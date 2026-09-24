import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { appendFlakeRecord, unknownFlakeRecordFromTelemetry } from "./flake-record.ts";

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

test("passing, unfinished and expected-fail tests map to nothing", () => {
  const base = {
    fullName: "some test",
    passedAfterRetry: true,
    durationMs: 10,
  };
  const firstTime = { ...base, passedAfterRetry: false };
  expect(unknownFlakeRecordFromTelemetry({ ...firstTime, state: "passed" })).toBeNull();
  expect(unknownFlakeRecordFromTelemetry({ ...firstTime, state: "skipped" })).toBeNull();
  expect(unknownFlakeRecordFromTelemetry({ ...firstTime, state: "interrupted" })).toBeNull();
  expect(
    unknownFlakeRecordFromTelemetry({ ...firstTime, state: "failed", outcome: "expected" }),
  ).toBeNull();
  // createFlake / createFailing register in the runner's expected-fail mode:
  // their outcomes, retried or failed, must never masquerade as unknown flakes.
  expect(unknownFlakeRecordFromTelemetry({ ...base, expectedState: "failed" })).toBeNull();
  expect(
    unknownFlakeRecordFromTelemetry({ ...firstTime, expectedState: "failed", state: "failed" }),
  ).toBeNull();
  expect(unknownFlakeRecordFromTelemetry({ ...base, expectedState: "skip" })).toBeNull();
  // vitest only reports options for tests that set any — a missing
  // expectedState means a plain test.
  expect(unknownFlakeRecordFromTelemetry(base)).toMatchObject({ outcome: "retried-pass" });
});

test("appendFlakeRecord writes one jsonl line per record into FLAKE_RECORD_DIR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flake-record-"));
  vi.stubEnv("FLAKE_RECORD_DIR", dir);
  vi.stubEnv("GITHUB_WORKSPACE", "");
  try {
    await appendFlakeRecord({
      name: "some test",
      kind: "unknown",
      outcome: "retried-pass",
      durationMs: 5,
      at: "2026-09-04T09:00:00Z",
    });
    const lines = readdirSync(dir).flatMap((file) =>
      readFileSync(join(dir, file), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
    expect(lines).toMatchObject([{ name: "some test", kind: "unknown" }]);
  } finally {
    vi.unstubAllEnvs();
  }
});
