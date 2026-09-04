import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { appendFlakeRecord, unknownFlakeRecordFromTelemetry } from "./flake-record.ts";

test("a plain test that passed after retry maps to an unknown-flake record", () => {
  expect(
    unknownFlakeRecordFromTelemetry({
      fullName: "chat can upload a file",
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

test("never-retried, still-failing, and expected-fail tests map to nothing", () => {
  const base = {
    fullName: "some test",
    passedAfterRetry: true,
    durationMs: 10,
  };
  // No retry rescue happened — either it never failed or it never recovered.
  expect(unknownFlakeRecordFromTelemetry({ ...base, passedAfterRetry: false })).toBeNull();
  // createFlake / createFailing register in the runner's expected-fail mode:
  // their retried outcomes must never masquerade as unknown flakes.
  expect(unknownFlakeRecordFromTelemetry({ ...base, expectedState: "failed" })).toBeNull();
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
      readFileSync(join(dir, file), "utf8").trim().split("\n").map(JSON.parse),
    );
    expect(lines).toMatchObject([{ name: "some test", kind: "unknown" }]);
  } finally {
    vi.unstubAllEnvs();
  }
});
