/**
 * Create one real, fully-ready project before preview Vitest/Playwright burst.
 * Operational failure is expected, measured, and non-gating; malformed pinning
 * or telemetry is a harness defect and still exits nonzero.
 */
import { fileURLToPath } from "node:url";
import {
  normalizeTestTelemetryError,
  type TestTelemetryError,
  type TestTelemetryPhase,
} from "@iterate-com/shared/test-support/ci-telemetry";
import {
  CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER,
  cloudflareWorkerVersionOverrideHeaders,
} from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { connectItx } from "iterate/node";
import {
  PREVIEW_PROJECT_PREWARM_OPERATION_DEADLINE_MS,
  writePreviewProjectPrewarmTelemetry,
} from "./preview-project-prewarm-telemetry.ts";

const OPERATION_DEADLINE_MS = PREVIEW_PROJECT_PREWARM_OPERATION_DEADLINE_MS;
const runStartedAt = Date.now();
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

const phases: TestTelemetryPhase[] = [];
const annotations: Array<{ type: string; description?: string }> = [];
let state: "passed" | "failed" | "timedout" = "passed";
let error: TestTelemetryError | undefined;

// Do not write a pessimistic sentinel here. If the outer watchdog kills this
// process, the parent shell writes one complete non-gating artifact instead.
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

const { durationMs } = writePreviewProjectPrewarmTelemetry({
  annotations,
  error,
  moduleId,
  phases,
  runStartedAt,
  state,
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
