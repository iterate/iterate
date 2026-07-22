/**
 * Create one real, fully-ready project before preview Vitest/Playwright burst.
 * Operational failure is expected, measured, and non-gating; malformed pinning
 * or telemetry is a harness defect and still exits nonzero.
 */
import { fileURLToPath } from "node:url";
import {
  ciTelemetrySourceFromEnvironment,
  normalizeTestTelemetryError,
  testTelemetryArtifactId,
  testTelemetryContextFromEnvironment,
  writeTestTelemetryArtifact,
  writeTestTelemetryFailureSentinel,
  type TestTelemetryError,
  type TestTelemetryPhase,
} from "@iterate-com/shared/test-support/ci-telemetry";
import {
  CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER,
  cloudflareWorkerVersionOverrideHeaders,
} from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { connectItx } from "iterate/node";

const OPERATION_DEADLINE_MS = 70_000;
const producer = "preview-project-prewarm";
const runStartedAt = Date.now();
const startedAt = new Date(runStartedAt).toISOString();
const moduleId = fileURLToPath(import.meta.url);

const baseUrl = requiredEnvironment("APP_CONFIG_BASE_URL").replace(/\/+$/, "");
new URL(baseUrl);
const adminSecret = requiredEnvironment("APP_CONFIG_ADMIN_API_SECRET");
const headers = cloudflareWorkerVersionOverrideHeaders(process.env);
if (!headers[CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER]) {
  throw new Error(
    "Preview project prewarm requires the exact E2E Cloudflare Worker version override header.",
  );
}

const workspace =
  process.env.TEST_TELEMETRY_WORKSPACE ?? process.env.npm_package_name ?? "iterate-root";
const context = testTelemetryContextFromEnvironment("script", {
  testKind: "e2e",
  lane: "project-prewarm",
  workspace,
  app: "os",
});
const ci = ciTelemetrySourceFromEnvironment(
  process.env,
  `local-preview-project-prewarm-${process.pid}-${runStartedAt}`,
);
const artifactId = testTelemetryArtifactId(producer, process.pid, runStartedAt);
writeTestTelemetryFailureSentinel({ artifactId, producer, startedAt, ci, context });

const phases: TestTelemetryPhase[] = [];
const annotations: Array<{ type: string; description?: string }> = [];
let state: "passed" | "failed" | "timedout" = "passed";
let error: TestTelemetryError | undefined;

const session = connectItx({
  auth: { type: "admin-secret", secret: adminSecret },
  baseUrl,
  headers,
});
try {
  const result = await withDeadline(runPrewarm(), OPERATION_DEADLINE_MS);
  if (result === "timedout") {
    state = "timedout";
    error = {
      name: "PreviewProjectPrewarmTimeoutError",
      message: `Full project prewarm did not finish within ${OPERATION_DEADLINE_MS}ms.`,
    };
    console.warn(`[preview-project-prewarm] ${error.message}`);
  }
} catch (caught) {
  state = "failed";
  error = normalizeTestTelemetryError(caught, "Unknown preview project prewarm failure");
  console.warn("[preview-project-prewarm] full project creation failed (non-gating)", error);
} finally {
  try {
    session[Symbol.dispose]();
  } catch (caught) {
    state = "failed";
    error = normalizeTestTelemetryError(caught, "Preview project prewarm disposal failed");
    console.warn("[preview-project-prewarm] ITX disposal failed (non-gating)", error);
  }
}

const finishedAtMs = Date.now();
const durationMs = finishedAtMs - runStartedAt;
const attempt = {
  attemptIndex: 0,
  state,
  durationMs,
  startedAt,
  startedAtSource: "reporter-clock" as const,
  ...(error ? { error } : {}),
  phases,
};
writeTestTelemetryArtifact({
  artifactSchemaVersion: 1,
  artifactId,
  producer,
  createdAt: new Date(finishedAtMs).toISOString(),
  ci,
  context,
  // The optimization is non-gating by design. Its logical test outcome is
  // expected even when it times out/fails, so analytics retain the latency
  // and error without classifying healthy product lanes as failed.
  run: {
    status: "passed",
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs,
  },
  lanes: [
    {
      context,
      status: "passed",
      durationMs,
      exitCode: 0,
      testCount: 1,
      retryCount: 0,
      collectionErrors: [],
    },
  ],
  tests: [
    {
      fullName: "preview project prewarm > creates one fully-ready project",
      moduleId,
      expectedState: state,
      outcome: "expected",
      configuredTimeoutMs: OPERATION_DEADLINE_MS,
      tags: [],
      annotations,
      retryCount: 0,
      passedAfterRetry: false,
      state,
      durationMs,
      startedAt,
      startedAtSource: "reporter-clock",
      attemptDetail: "complete",
      beforeEachDurationMs: 0,
      afterEachDurationMs: 0,
      bodyDurationMs: durationMs,
      attempts: [attempt],
      phases,
      errors: error ? [error] : [],
      ...(error ? { firstFailure: error.message.slice(0, 300) } : {}),
    },
  ],
  modules: [
    {
      moduleId,
      environmentSetupDurationMs: 0,
      prepareDurationMs: 0,
      collectDurationMs: 0,
      setupDurationMs: 0,
      testAndHookDurationMs: durationMs,
      importDurationMs: 0,
      imports: [],
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      executionWallDurationMs: durationMs,
    },
  ],
});

console.log(`[preview-project-prewarm] ${state} in ${durationMs}ms`);

async function runPrewarm() {
  await phase("fixture: establish admin ITX session", () => session.__describe());
  const slug = uniqueFixtureSlug("preview-prewarm", { maxPrefixLength: 20 });
  const project = await phase("fixture: wait for full project readiness", async () =>
    session.projects.get(slug).create({}),
  );
  try {
    const identity = await phase("fixture: read project identity", () => project.identity());
    annotations.push({
      type: "fixture-projects",
      description: JSON.stringify({
        projectIds: [identity.projectId],
        projectSlugs: [identity.slug],
      }),
    });
    console.log(`[preview-project-prewarm] created ${identity.slug} (${identity.projectId})`);
  } finally {
    project[Symbol.dispose]();
  }
}

async function phase<T>(name: string, body: () => Promise<T>): Promise<T> {
  const phaseStartedAt = Date.now();
  try {
    return await body();
  } catch (caught) {
    phases.push({
      name,
      category: "fixture",
      startedAt: new Date(phaseStartedAt).toISOString(),
      durationMs: Date.now() - phaseStartedAt,
      error: normalizeTestTelemetryError(caught),
    });
    throw caught;
  } finally {
    if (!phases.some((candidate) => candidate.name === name)) {
      phases.push({
        name,
        category: "fixture",
        startedAt: new Date(phaseStartedAt).toISOString(),
        durationMs: Date.now() - phaseStartedAt,
      });
    }
  }
}

async function withDeadline(
  operation: Promise<void>,
  deadlineMs: number,
): Promise<"completed" | "timedout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = operation.then(
    () => "completed" as const,
    (caught: unknown) => ({ caught }),
  );
  const timeout = new Promise<"timedout">((resolve) => {
    timer = setTimeout(() => resolve("timedout"), deadlineMs);
  });
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  if (typeof result === "object") throw result.caught;
  return result;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Preview project prewarm requires ${name}.`);
  return value;
}
