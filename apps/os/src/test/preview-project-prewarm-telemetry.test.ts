import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestTelemetryArtifact } from "@iterate-com/shared/test-support/ci-telemetry";
import { writePreviewProjectPrewarmTelemetry } from "../../e2e/vitest/preview-project-prewarm-telemetry.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

describe("preview project prewarm telemetry", () => {
  it("records an outer watchdog failure as complete non-gating telemetry", () => {
    const directory = mkdtempSync(join(tmpdir(), "preview-project-prewarm-"));
    temporaryDirectories.push(directory);
    const outputFile = join(directory, "prewarm.json");
    const error = {
      name: "PreviewProjectPrewarmOuterFailureError",
      message: "outer watchdog exited 124",
    };

    writePreviewProjectPrewarmTelemetry(
      {
        error,
        exitCode: 124,
        moduleId: "/test/preview-project-prewarm-fallback.ts",
        runStartedAt: Date.now() - 75_000,
        state: "timedout",
      },
      {
        TEST_TELEMETRY_ARTIFACT_FILE: outputFile,
        TEST_TELEMETRY_LANE: "project-prewarm",
        TEST_TELEMETRY_WORKSPACE: "iterate-root",
      },
    );

    const artifact = TestTelemetryArtifact.parse(JSON.parse(readFileSync(outputFile, "utf8")));
    expect(artifact.run).toMatchObject({ status: "passed" });
    expect(artifact.lanes).toEqual([
      expect.objectContaining({
        status: "passed",
        exitCode: 124,
        testCount: 1,
        collectionErrors: [],
      }),
    ]);
    expect(artifact.tests).toEqual([
      expect.objectContaining({
        state: "timedout",
        expectedState: "timedout",
        outcome: "expected",
        errors: [error],
      }),
    ]);
  });
});
