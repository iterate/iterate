import {
  ciTelemetrySourceFromEnvironment,
  testTelemetryArtifactId,
  testTelemetryContextFromEnvironment,
  writeTestTelemetryArtifact,
} from "@iterate-com/shared/test-support/ci-telemetry";

// The TUI e2e lane is deliberately SKIPPED.
//
// The terminal UI has known bugs and no users right now, and its test
// framework (@microsoft/tui-test 0.0.4) has defects of its own: it reuses a
// worker it already terminated on timeout for its retry, and it hardwires
// shared global state (the spec transform cache under cwd, the zsh dotfiles
// folder under tmpdir) that concurrent invocations race on. Keeping the lane
// green required a patched framework plus a bespoke isolation harness — not
// worth carrying for a surface nobody uses yet.
//
// The specs and tui-test.config.ts next to this file are kept as the starting
// point for reviving the lane once the TUI matters again. The evidence and
// removal criteria live in tasks/quarantined-tui-e2e.md.
console.info(
  "[tui-test] SKIPPED: quarantined by tasks/quarantined-tui-e2e.md — the terminal UI has known bugs and tui-test 0.0.4 is not concurrency-safe.",
);

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
