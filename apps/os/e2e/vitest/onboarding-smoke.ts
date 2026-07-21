/**
 * Smoke: create a project as admin and watch the onboarding agent greet.
 * Runs manually and as an independent preview sub-lane alongside the other
 * isolated suites.
 *
 *   doppler run -- pnpm exec tsx e2e/vitest/onboarding-smoke.ts [baseUrl]
 *
 * Expected stream-incarnation rollover is recovered once inside each
 * idempotent startup/wait operation. Two whole attempts, a fresh project each,
 * remain for unexpected failures — an attempt IS this gate's "test", so per
 * the fleet retry policy (docs/testing.md#retries-and-timeouts) it gets exactly
 * one retry, same as every vitest/playwright test. It used to run
 * with none at all: a single 90s greeting tail took down the whole run, as
 * an uncaught remote rejection crashing the process no less
 * (docs/preview-e2e-flake-hunt.md run log, marathon6 run 26). A genuinely
 * broken slot still fails both attempts inside ~3.5 minutes, and a slow
 * greeting that needs attempt 2 is logged as retry telemetry rather than
 * silently absorbed — the 90s tail is a real product-latency signal.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareWorkerVersionOverrideHeaders } from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { connectItx } from "iterate/node";
import {
  ensureOnboardingAgentReady,
  waitForOnboardingGreeting,
} from "../../src/lib/onboarding-agent.ts";
import { resolveBaseUrl } from "../test-support/dev-server.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const baseUrl = (process.argv[2] ?? resolveBaseUrl(appRoot) ?? "http://localhost:56455").replace(
  /\/+$/,
  "",
);
const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
if (!secret) throw new Error("need APP_CONFIG_ADMIN_API_SECRET (run under doppler)");

type SmokePhase = { name: string; durationMs: number; category: string };

async function attemptOnboardingSmoke(): Promise<SmokePhase[]> {
  const marker = Math.random().toString(36).slice(2, 8);
  const phases: SmokePhase[] = [];

  using session = connectItx({
    baseUrl,
    headers: cloudflareWorkerVersionOverrideHeaders(process.env),
  });
  const start = Date.now();
  using root = session.authenticate({ type: "admin-secret", secret: secret! });
  using project = await root.projects.get(`onboarding-smoke-${marker}`).create({});
  const description = await project.__describe();
  phases.push({ name: "create project", category: "fixture", durationMs: Date.now() - start });
  console.log(`project created in ${Date.now() - start}ms:`, description.projectId);

  using agent = project.agents.get("/agents/onboarding");
  // Match the dashboard's explicit onboarding flow: agent birth is generic,
  // then this caller appends the onboarding prompt and startup input.
  const readyStartedAt = Date.now();
  await ensureOnboardingAgentReady({ agent });
  phases.push({
    name: "ensure onboarding agent ready",
    category: "runtime",
    durationMs: Date.now() - readyStartedAt,
  });
  const greetingStartedAt = Date.now();
  const greeting = await waitForOnboardingGreeting({
    stream: agent.stream,
    timeoutMs: 90_000,
    onRetry: (error) => {
      console.info("onboarding greeting stream rolled; re-arming from its durable cursor once", {
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  phases.push({
    name: "wait for onboarding greeting",
    category: "runtime",
    durationMs: Date.now() - greetingStartedAt,
  });
  console.log(`onboarding agent greeted in ${Date.now() - start}ms:`);
  console.log(JSON.stringify(greeting.payload, null, 2));

  const events = await agent.stream.getEvents({});
  console.log(
    "agent stream events:",
    events.map((event) => event.type.replace("events.iterate.com/", "")),
  );
  return phases;
}

const ATTEMPTS = 2;
let lastError: unknown;
const runStartedAt = Date.now();
const errors: Array<{ message: string; name?: string; stack?: string }> = [];
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  try {
    const phases = await attemptOnboardingSmoke();
    if (attempt > 1) {
      console.log(
        `[retry-telemetry] onboarding smoke passed on attempt ${attempt}/${ATTEMPTS} — ` +
          `attempt 1's failure above is a real (absorbed) failure`,
      );
    }
    writeSmokeTelemetry({
      durationMs: Date.now() - runStartedAt,
      errors,
      passedAfterRetry: attempt > 1,
      phases,
      retryCount: attempt - 1,
      state: "passed",
    });
    process.exit(0);
  } catch (error) {
    lastError = error;
    errors.push(normalizeError(error));
    console.error(`onboarding smoke attempt ${attempt}/${ATTEMPTS} failed:`, error);
  }
}
writeSmokeTelemetry({
  durationMs: Date.now() - runStartedAt,
  errors,
  passedAfterRetry: false,
  phases: [],
  retryCount: ATTEMPTS - 1,
  state: "failed",
});
console.error(`onboarding smoke failed after ${ATTEMPTS} attempts`);
console.error(lastError);
process.exit(1);

function writeSmokeTelemetry(input: {
  durationMs: number;
  errors: Array<{ message: string; name?: string; stack?: string }>;
  passedAfterRetry: boolean;
  phases: SmokePhase[];
  retryCount: number;
  state: "passed" | "failed";
}) {
  const outputFile = process.env.E2E_RETRY_TELEMETRY_FILE;
  if (!outputFile) return;
  const moduleId = fileURLToPath(import.meta.url);
  const test = {
    fullName: "onboarding smoke > creates a project and receives the greeting",
    moduleId,
    retryCount: input.retryCount,
    passedAfterRetry: input.passedAfterRetry,
    state: input.state,
    durationMs: input.durationMs,
    beforeEachDurationMs: 0,
    afterEachDurationMs: 0,
    bodyDurationMs: input.durationMs,
    phases: input.phases,
    errors: input.errors,
    ...(input.errors[0] ? { firstFailure: input.errors[0].message.slice(0, 300) } : {}),
  };
  writeFileSync(
    outputFile,
    JSON.stringify({
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
          executionWallDurationMs: input.durationMs,
        },
      ],
      retried: input.retryCount > 0 ? [test] : [],
    }),
  );
}

function normalizeError(error: unknown) {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    message: error.message,
    name: error.name,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}
