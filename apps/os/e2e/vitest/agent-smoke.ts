/**
 * Smoke: create a project as admin, create an agent, and receive one reply.
 * Runs manually and as an independent preview sub-lane alongside the other
 * isolated suites.
 *
 *   doppler run -- pnpm exec tsx e2e/vitest/agent-smoke.ts [baseUrl]
 *
 * Two whole attempts, with a fresh project each, cover unexpected failures —
 * an attempt IS this gate's "test", so per
 * the fleet retry policy (docs/testing.md#retries-and-timeouts) it gets exactly
 * one retry, same as every vitest/playwright test. It used to run
 * with none at all: a single 90s reply tail took down the whole run, as
 * an uncaught remote rejection crashing the process no less
 * (docs/preview-e2e-flake-hunt.md run log, marathon6 run 26). A genuinely
 * broken slot still fails both attempts inside ~3.5 minutes, and a slow
 * reply that needs attempt 2 is logged as retry telemetry rather than
 * silently absorbed — the 90s tail is a real product-latency signal.
 */
import { fileURLToPath } from "node:url";
import {
  ciTelemetrySourceFromEnvironment,
  normalizeTestTelemetryError,
  testTelemetryArtifactId,
  testTelemetryContextFromEnvironment,
  writeTestTelemetryArtifact,
  writeTestTelemetryFailureSentinel,
  type TestTelemetryAttempt,
} from "@iterate-com/shared/test-support/ci-telemetry";
import { cloudflareWorkerVersionOverrideHeaders } from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { waitForPreviewRolloutBeforeProjectCreation } from "@iterate-com/shared/test-support/preview-rollout-gate";
import { connectItx } from "iterate/node";
import { resolveBaseUrl } from "../test-support/dev-server.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const baseUrl = (process.argv[2] ?? resolveBaseUrl(appRoot) ?? "http://localhost:56455").replace(
  /\/+$/,
  "",
);
const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
if (!secret) throw new Error("need APP_CONFIG_ADMIN_API_SECRET (run under doppler)");

type SmokePhase = { name: string; durationMs: number; category: string };

async function attemptAgentSmoke(phases: SmokePhase[]): Promise<void> {
  const marker = Math.random().toString(36).slice(2, 8);

  // Edge readiness does not mean a freshly deployed Durable Object namespace
  // has finished propagating globally. Use the same absolute deployment
  // boundary as Playwright so this early lane cannot create an object while
  // Cloudflare is still replacing its assigned worker version.
  await waitForPreviewRolloutBeforeProjectCreation();
  using session = connectItx({
    baseUrl,
    headers: cloudflareWorkerVersionOverrideHeaders(process.env),
  });
  const start = Date.now();
  using root = session.authenticate({ type: "admin-secret", secret: secret! });
  using project = await root.projects.get(`agent-smoke-${marker}`).create({});
  const description = await project.__describe();
  phases.push({ name: "create project", category: "fixture", durationMs: Date.now() - start });
  console.log(`project created in ${Date.now() - start}ms:`, description.projectId);

  using agent = project.agents.get("/agents/smoke");
  const readyStartedAt = Date.now();
  await agent.create();
  phases.push({
    name: "create agent",
    category: "runtime",
    durationMs: Date.now() - readyStartedAt,
  });
  const replyStartedAt = Date.now();
  await agent.message("Reply with exactly: pong");
  const reply = await agent.stream.waitForEvent({
    eventTypes: ["events.iterate.com/agents/web-message-sent"],
    timeoutMs: 90_000,
  });
  phases.push({
    name: "wait for agent reply",
    category: "runtime",
    durationMs: Date.now() - replyStartedAt,
  });
  console.log(`agent replied in ${Date.now() - start}ms:`);
  console.log(JSON.stringify(reply.payload, null, 2));

  const events = await agent.stream.getEvents({});
  console.log(
    "agent stream events:",
    events.map((event) => event.type.replace("events.iterate.com/", "")),
  );
}

const ATTEMPTS = 2;
let lastError: unknown;
const runStartedAt = Date.now();
const workspace =
  process.env.TEST_TELEMETRY_WORKSPACE ?? process.env.npm_package_name ?? "@iterate-com/os";
const telemetryContext = testTelemetryContextFromEnvironment("script", {
  testKind: "e2e",
  lane: "agent-smoke",
  workspace,
  app: "os",
});
const telemetryArtifactId = testTelemetryArtifactId("agent-smoke", process.pid, runStartedAt);
const telemetryCi = ciTelemetrySourceFromEnvironment(
  process.env,
  `local-agent-smoke-${process.pid}-${runStartedAt}`,
);
writeTestTelemetryFailureSentinel({
  artifactId: telemetryArtifactId,
  producer: "agent-smoke",
  startedAt: new Date(runStartedAt).toISOString(),
  ci: telemetryCi,
  context: telemetryContext,
});
const errors: Array<{ message: string; name?: string; stack?: string }> = [];
const attempts: TestTelemetryAttempt[] = [];
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const attemptStartedAt = Date.now();
  const phases: SmokePhase[] = [];
  try {
    await attemptAgentSmoke(phases);
    attempts.push({
      attemptIndex: attempt - 1,
      state: "passed",
      durationMs: Date.now() - attemptStartedAt,
      startedAt: new Date(attemptStartedAt).toISOString(),
      startedAtSource: "reporter-clock",
      phases,
    });
    if (attempt > 1) {
      console.log(
        `[retry-telemetry] agent smoke passed on attempt ${attempt}/${ATTEMPTS} — ` +
          `attempt 1's failure above is a real (absorbed) failure`,
      );
    }
    writeSmokeTelemetry({
      durationMs: Date.now() - runStartedAt,
      errors,
      attempts,
      passedAfterRetry: attempt > 1,
      retryCount: attempt - 1,
      state: "passed",
    });
    process.exit(0);
  } catch (error) {
    lastError = error;
    const normalized = normalizeTestTelemetryError(error, "Unknown agent smoke error");
    errors.push(normalized);
    attempts.push({
      attemptIndex: attempt - 1,
      state: "failed",
      durationMs: Date.now() - attemptStartedAt,
      startedAt: new Date(attemptStartedAt).toISOString(),
      startedAtSource: "reporter-clock",
      error: normalized,
      phases,
    });
    console.error(`agent smoke attempt ${attempt}/${ATTEMPTS} failed:`, error);
  }
}
writeSmokeTelemetry({
  durationMs: Date.now() - runStartedAt,
  errors,
  attempts,
  passedAfterRetry: false,
  retryCount: ATTEMPTS - 1,
  state: "failed",
});
console.error(`agent smoke failed after ${ATTEMPTS} attempts`);
console.error(lastError);
process.exit(1);

function writeSmokeTelemetry(input: {
  durationMs: number;
  errors: Array<{ message: string; name?: string; stack?: string }>;
  attempts: TestTelemetryAttempt[];
  passedAfterRetry: boolean;
  retryCount: number;
  state: "passed" | "failed";
}) {
  const moduleId = fileURLToPath(import.meta.url);
  const finishedAtMs = Date.now();
  const test = {
    fullName: "agent smoke > creates a project and receives an agent reply",
    moduleId,
    tags: [],
    annotations: [],
    retryCount: input.retryCount,
    passedAfterRetry: input.passedAfterRetry,
    state: input.state,
    durationMs: input.durationMs,
    attemptDetail: "complete" as const,
    startedAt: new Date(runStartedAt).toISOString(),
    startedAtSource: "reporter-clock" as const,
    beforeEachDurationMs: 0,
    afterEachDurationMs: 0,
    bodyDurationMs: input.durationMs,
    attempts: input.attempts,
    phases: [],
    errors: input.errors,
    ...(input.errors[0] && { firstFailure: input.errors[0].message.slice(0, 300) }),
  };
  writeTestTelemetryArtifact({
    artifactSchemaVersion: 1,
    artifactId: telemetryArtifactId,
    producer: "agent-smoke",
    createdAt: new Date(finishedAtMs).toISOString(),
    ci: telemetryCi,
    context: telemetryContext,
    run: {
      status: input.state,
      startedAt: new Date(runStartedAt).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: input.durationMs,
      ...(input.state === "failed" && input.errors.at(-1) && { error: input.errors.at(-1) }),
    },
    lanes: [
      {
        context: telemetryContext,
        status: input.state,
        durationMs: input.durationMs,
        exitCode: input.state === "passed" ? 0 : 1,
        testCount: 1,
        retryCount: input.retryCount,
        collectionErrors: [],
      },
    ],
    tests: [test],
    modules: [
      {
        moduleId,
        environmentSetupDurationMs: 0,
        prepareDurationMs: 0,
        collectDurationMs: 0,
        setupDurationMs: 0,
        testAndHookDurationMs: input.durationMs,
        importDurationMs: 0,
        imports: [],
        executionWallDurationMs: input.durationMs,
      },
    ],
  });
}
