import { afterEach, expect, it, vi } from "vitest";
import { PreviewE2ePostHog } from "./e2e-posthog.ts";

afterEach(() => vi.unstubAllGlobals());

it("sends Playwright and Vitest through the shared CI test event family", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const telemetry = new PreviewE2ePostHog({
    environment: {
      APP_CONFIG_POSTHOG: JSON.stringify({ apiKey: "phc_test" }),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    },
    headSha: "abcdef0123456789",
    operation: "test",
    pullRequestNumber: 42,
    runUrl: "https://example.test/run/123",
  });

  telemetry.runStarted();
  telemetry.testFinished({
    app: "os",
    framework: "playwright",
    lane: "playwright",
    name: "feed resumes",
    moduleId: "specs/resume.spec.ts",
    project: "web",
    state: "passed",
    durationMs: 20_000,
    retryCount: 0,
    passedAfterRetry: false,
    attempts: [
      {
        attemptIndex: 0,
        state: "passed",
        durationMs: 20_000,
        phases: [{ name: "evict transport", category: "runtime", durationMs: 10_000 }],
      },
    ],
    phases: [],
    errors: [],
  });
  telemetry.moduleFinished({
    app: "os",
    framework: "vitest",
    lane: "vitest",
    moduleId: "apps/os/e2e/example.test.ts",
    environmentSetupDurationMs: 1,
    prepareDurationMs: 2,
    collectDurationMs: 3,
    setupDurationMs: 4,
    testAndHookDurationMs: 5,
    importDurationMs: 6,
  });
  telemetry.appFinished({
    app: "os",
    status: "passed",
    durationMs: 21_000,
    exitCode: 0,
    testCount: 1,
    retryCount: 0,
    collectionErrors: [],
  });
  telemetry.runFinished({ status: "passed", durationMs: 22_000 });
  await telemetry.shutdown();

  expect(fetchMock).toHaveBeenCalledOnce();
  const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
    batch: Array<{ event: string; properties: Record<string, unknown> }>;
  };
  expect(body.batch.map(({ event }) => event)).toEqual([
    "ci test run started",
    "ci test finished",
    "ci test attempt finished",
    "ci test phase finished",
    "ci test module finished",
    "ci test lane finished",
    "ci test run finished",
  ]);
  expect(body.batch[1]?.properties).toEqual(
    expect.objectContaining({ framework: "playwright", test_kind: "e2e" }),
  );
  expect(body.batch[4]?.properties).toEqual(
    expect.objectContaining({ framework: "vitest", test_kind: "e2e" }),
  );
});

it("records attributable preview deployment phases", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const telemetry = new PreviewE2ePostHog({
    environment: {
      APP_CONFIG_POSTHOG: JSON.stringify({ apiKey: "phc_test" }),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    },
    headSha: "abcdef0123456789",
    operation: "deploy",
    pullRequestNumber: 42,
    runUrl: "https://example.test/run/123",
  });

  telemetry.deployRunStarted();
  telemetry.deployAppFinished({
    app: "os",
    slot: "preview-2",
    status: "passed",
    durationMs: 115_500,
    configDurationMs: 500,
    commandDurationMs: 42_900,
    readinessDurationMs: 72_100,
    workerName: "os-preview-2",
    workerVersion: "11111111-1111-4111-8111-111111111111",
  });
  telemetry.deployRunFinished({
    status: "passed",
    durationMs: 116_000,
    slot: "preview-2",
  });
  await telemetry.shutdown();

  expect(fetchMock).toHaveBeenCalledOnce();
  const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
    batch: Array<{ event: string; properties: Record<string, unknown> }>;
  };
  expect(body.batch.map(({ event }) => event)).toEqual([
    "ci deploy run started",
    "ci deploy lane finished",
    "ci deploy phase finished",
    "ci deploy phase finished",
    "ci deploy phase finished",
    "ci deploy run finished",
  ]);
  expect(body.batch[1]?.properties).toEqual(
    expect.objectContaining({
      app: "os",
      command_duration_ms: 42_900,
      readiness_duration_ms: 72_100,
      worker_version: "11111111-1111-4111-8111-111111111111",
    }),
  );
});
