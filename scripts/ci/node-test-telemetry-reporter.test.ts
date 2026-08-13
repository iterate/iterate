import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestEvent } from "node:test/reporters";
import type { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { afterEach, expect, it, vi } from "vitest";
import nodeTestTelemetryReporter from "./node-test-telemetry-reporter.ts";

const originalArtifactDirectory = process.env.TEST_TELEMETRY_ARTIFACT_DIR;
const originalGithubRunId = process.env.GITHUB_RUN_ID;

afterEach(() => {
  restoreEnv("TEST_TELEMETRY_ARTIFACT_DIR", originalArtifactDirectory);
  restoreEnv("GITHUB_RUN_ID", originalGithubRunId);
  vi.restoreAllMocks();
});

it("keeps duplicate Node leaf identities distinct instead of inventing retries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "node-test-telemetry-artifacts-"));
  process.env.TEST_TELEMETRY_ARTIFACT_DIR = directory;
  delete process.env.GITHUB_RUN_ID;

  const duplicateResult = (): TestEvent =>
    ({
      type: "test:pass",
      data: {
        name: "fails clearly when a binding is missing",
        file: "/repo/email.test.ts",
        line: 10,
        column: 1,
        nesting: 1,
        testNumber: 1,
        details: { duration_ms: 5, type: "test" },
      },
    }) as TestEvent;
  const summary = {
    type: "test:summary",
    data: {
      file: undefined,
      success: true,
      duration_ms: 10,
      counts: {
        tests: 2,
        passed: 2,
        cancelled: 0,
        skipped: 0,
        suites: 0,
        todo: 0,
        topLevel: 2,
      },
    },
  } as TestEvent;

  async function* events() {
    yield duplicateResult();
    yield duplicateResult();
    yield summary;
  }
  for await (const _ of nodeTestTelemetryReporter(events())) {
    // Consume the async reporter so delivery completes.
  }

  const files = readdirSync(directory);
  expect(files).toHaveLength(1);
  const artifact = JSON.parse(
    readFileSync(join(directory, files[0]!), "utf8"),
  ) as TestTelemetryArtifact;
  expect(artifact.tests).toHaveLength(2);
  expect(artifact.tests.map(({ retryCount }) => retryCount)).toEqual([0, 0]);
  expect(artifact.tests[0]?.attempts[0]).toEqual(
    expect.objectContaining({
      durationMs: 5,
      scheduleDelayMs: expect.any(Number),
      startedAt: expect.any(String),
    }),
  );
  expect(artifact.ci.executionContext).toBe("local");
  rmSync(directory, { recursive: true });
});

function restoreEnv(name: string, value: string | undefined) {
  if (!value) delete process.env[name];
  else process.env[name] = value;
}
