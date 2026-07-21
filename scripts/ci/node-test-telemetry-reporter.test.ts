import type { TestEvent } from "node:test/reporters";
import { afterEach, expect, it, vi } from "vitest";
import nodeTestTelemetryReporter from "./node-test-telemetry-reporter.ts";

const originalEnabled = process.env.TEST_TELEMETRY_ENABLED;
const originalPostHog = process.env.APP_CONFIG_POSTHOG;

afterEach(() => {
  restoreEnv("TEST_TELEMETRY_ENABLED", originalEnabled);
  restoreEnv("APP_CONFIG_POSTHOG", originalPostHog);
  vi.restoreAllMocks();
});

it("keeps duplicate Node leaf identities distinct instead of inventing retries", async () => {
  process.env.TEST_TELEMETRY_ENABLED = "1";
  process.env.APP_CONFIG_POSTHOG = JSON.stringify({ apiKey: "phc_test" });
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

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

  const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
    batch: Array<{ event: string; properties: Record<string, unknown> }>;
  };
  const tests = body.batch.filter(({ event }) => event === "ci test finished");
  expect(tests).toHaveLength(2);
  expect(tests.map(({ properties }) => properties.retry_count)).toEqual([0, 0]);
  expect(tests.every(({ properties }) => properties.execution_context === "local")).toBe(true);
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
