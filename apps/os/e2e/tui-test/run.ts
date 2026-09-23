import {
  ciTelemetrySourceFromEnvironment,
  testTelemetryArtifactId,
  testTelemetryContextFromEnvironment,
  writeTestTelemetryArtifact,
} from "@iterate-com/shared/test-support/ci-telemetry";

// Compatibility entry for the old OS preview orchestrator. The CLI's TUI was removed.
console.info("[tui-test] SKIPPED: the Iterate CLI no longer includes a terminal chat UI.");

const now = new Date().toISOString();
const context = testTelemetryContextFromEnvironment("script", {
  testKind: "e2e",
  lane: "tui",
  workspace: process.env.npm_package_name ?? "@iterate-com/os",
  app: "os",
});
writeTestTelemetryArtifact({
  artifactSchemaVersion: 1,
  artifactId: testTelemetryArtifactId("tui-quarantine", process.pid, Date.now()),
  producer: "tui-quarantine",
  createdAt: now,
  ci: ciTelemetrySourceFromEnvironment(process.env),
  context,
  run: { status: "skipped", startedAt: now, finishedAt: now, durationMs: 0 },
  lanes: [
    {
      context,
      status: "skipped",
      durationMs: 0,
      exitCode: 0,
      testCount: 0,
      retryCount: 0,
      collectionErrors: [],
    },
  ],
  tests: [],
  modules: [],
});
