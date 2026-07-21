// itx catalogue matrix: proves the REPL examples (src/itx/examples.ts — the
// same entries the Examples panel shows) against a REAL deployed worker
// (local dev server, preview, or production — whatever APP_CONFIG_BASE_URL
// points at), through every server-side runtime of the itx
// (/api). The browser runtime runs the same catalogue through the real REPL
// in specs/repl-examples.spec.ts; itx behavior itself is proven by
// apps/os/e2e/itx/*.
//
// KNOWN CAVEAT (local vite dev only): repo-sourced project worker dials can
// fail with masked "internal error"s against a local dev server — the itx
// own e2e ("Authenticated internal auth itx can create project…",
// project.worker.fetch) fails identically there. Verify project-worker
// failures against a deployed preview before treating them as regressions.

import { expect, test as baseTest } from "vitest";
import { ITX_EXAMPLES } from "../../src/itx/examples.ts";
import { E2E_FILE_TEST_CONCURRENCY } from "../test-support/concurrency.ts";
import {
  createTestProjectPool,
  type TestProjectLease,
} from "../test-support/create-test-project-pool.ts";
import { EXAMPLE_CASES, EXAMPLE_IDS_WITHOUT_CASES } from "./example-cases.ts";
import { connectGlobal, connectProject } from "./e2e-env.ts";
import {
  bakeProjectWorkerRunner,
  ExampleRuntimeDeadlineError,
  finishBeforeRuntimeDeadline,
  MATRIX_RUNTIMES,
  runExampleCode,
  type MatrixRuntime,
} from "./example-matrix.ts";

const MATRIX_EXAMPLES = ITX_EXAMPLES.filter(
  (example) =>
    example.runtimes.some((runtime) => (MATRIX_RUNTIMES as readonly string[]).includes(runtime)) &&
    EXAMPLE_CASES[example.id] !== undefined,
).sort(
  // Start known long cases first so their work overlaps the short catalogue
  // tail. Runtimes within a case are parallel unless the case opts out.
  (left, right) =>
    (EXAMPLE_CASES[right.id]?.completionTimeoutMs ?? 90_000) -
    (EXAMPLE_CASES[left.id]?.completionTimeoutMs ?? 90_000),
);
const QUARANTINED_MATRIX_EXAMPLES = new Set([
  "append-and-read-stream",
  "describe-project",
  "discover-tree",
  "ephemeral-events",
  "repo-edit-file",
  "run-script",
  "secrets-lifecycle",
  "workspace-edit-and-push",
  "workspace-files-transfer",
]);

// Fixed capability mounts, the config repo, and the repo-sourced project
// worker are project-global mutable resources. Give each runtime its own pool
// of exclusive projects so the runtimes can execute concurrently without
// racing those resources. Pool size matches Vitest's in-file concurrency.
const matrixProjectPools: Record<MatrixRuntime, ReturnType<typeof createTestProjectPool>> = {
  node: createTestProjectPool({ size: E2E_FILE_TEST_CONCURRENCY, slugPrefix: "matrix-node" }),
  cli: createTestProjectPool({ size: E2E_FILE_TEST_CONCURRENCY, slugPrefix: "matrix-cli" }),
  "run-script": createTestProjectPool({
    size: E2E_FILE_TEST_CONCURRENCY,
    slugPrefix: "matrix-script",
  }),
  "project-worker": createTestProjectPool({
    size: E2E_FILE_TEST_CONCURRENCY,
    slugPrefix: "matrix-worker",
  }),
};

// Sandbox runtimes intentionally share one warm container, so that case uses
// a separate exclusive-project family and remains serial within the case.
const serialMatrixProjectPool = createTestProjectPool({
  size: E2E_FILE_TEST_CONCURRENCY,
  slugPrefix: "matrix-serial",
});

const projectWorkerExamples = MATRIX_EXAMPLES.filter((example) =>
  example.runtimes.includes("project-worker"),
);
const projectWorkerBakePromises = new Map<string, Promise<void>>();

async function ensureProjectWorkerRunner(projectId: string): Promise<void> {
  const current =
    projectWorkerBakePromises.get(projectId) ??
    bakeProjectWorkerRunner({ examples: projectWorkerExamples, projectId });
  projectWorkerBakePromises.set(projectId, current);
  try {
    await current;
  } catch (error) {
    if (projectWorkerBakePromises.get(projectId) === current) {
      projectWorkerBakePromises.delete(projectId);
    }
    throw error;
  }
}

baseTest("every catalogue example is either matrix-tested or explicitly excluded", () => {
  for (const example of ITX_EXAMPLES) {
    if (EXAMPLE_IDS_WITHOUT_CASES.has(example.id)) continue;
    expect(
      EXAMPLE_CASES[example.id],
      `example "${example.id}" needs a case in example-cases.ts (or an explicit exclusion)`,
    ).toBeDefined();
  }
  // The Playwright REPL spec runs every case through the project REPL, so a
  // case's example must exist and be browser-runnable in a project context.
  for (const id of Object.keys(EXAMPLE_CASES)) {
    const example = ITX_EXAMPLES.find((candidate) => candidate.id === id);
    expect(example, `example-cases.ts references missing example "${id}"`).toBeDefined();
    expect(example!, `cased example "${id}" must be project-context`).toMatchObject({
      context: "project",
    });
    expect(
      example!.runtimes.includes("browser"),
      `cased example "${id}" must be browser-runnable (specs/repl-examples.spec.ts)`,
    ).toBe(true);
  }
});

for (const example of MATRIX_EXAMPLES) {
  const exampleCase = EXAMPLE_CASES[example.id]!;
  const runtimes = MATRIX_RUNTIMES.filter((runtime) => example.runtimes.includes(runtime));
  const runtimeTimeoutMs = exampleCase.completionTimeoutMs ?? 90_000;
  // Quarantined by tasks/quarantined-preview-e2e-retry-flakes.md; keep each
  // generated case visible in discovery while suppressing its live work.
  const matrixTest = QUARANTINED_MATRIX_EXAMPLES.has(example.id) ? baseTest.skip : baseTest;
  // The case budget is shared wall time: parallel runtimes each get the full
  // remainder concurrently, while an explicitly serial case passes the
  // remaining aggregate budget to each successive runtime. The project-worker
  // bake is part of that runtime's budget. Vitest gets 30s more for pool
  // acquisition, cleanup, and reporting, so its watchdog never pre-empts the
  // more diagnostic runtime deadline first. Pool slots are born lazily, so a
  // case pays for at most one project birth per runtime here; those births run
  // concurrently rather than eagerly creating the entire shared pool.
  // A blanket 240s once let one stuck example consume both the lane and retry
  // without identifying the runtime that stalled.
  matrixTest(
    `catalogue example "${example.id}" runs identically across runtimes`,
    { timeout: runtimeTimeoutMs + 30_000 },
    async () => {
      expect(runtimes.length).toBeGreaterThan(0);

      // Fresh per attempt; shared only when a case explicitly elects serial
      // runtime execution (the warm sandbox container).
      const attemptSalt = crypto.randomUUID().slice(0, 8);
      const runRuntime = async (
        runtime: (typeof runtimes)[number],
        projectLease: TestProjectLease,
        timeoutMs: number,
      ) => {
        const { projectId } = projectLease;
        const runtimeDeadline = Date.now() + timeoutMs;
        const ctx = {
          attemptSalt,
          marker: `${runtime}-${crypto.randomUUID().slice(0, 8)}`,
          projectId,
        };
        const vars = exampleCase.vars?.(ctx) ?? {};
        try {
          if (runtime === "project-worker") {
            await finishBeforeRuntimeDeadline(runtime, timeoutMs, () =>
              ensureProjectWorkerRunner(projectId),
            );
          }
          const remainingMs = runtimeDeadline - Date.now();
          if (remainingMs <= 0) {
            throw new ExampleRuntimeDeadlineError(runtime, timeoutMs);
          }
          const result = await runExampleCode(runtime, {
            code: example.code,
            id: example.id,
            projectId,
            timeoutMs: remainingMs,
            vars,
          });
          exampleCase.assert(result, ctx, expect);
        } catch (error) {
          // Promise.race can bound the caller, but it cannot retract an RPC
          // already accepted by the server. Quarantine this project before
          // unwinding the lease so late work cannot contaminate a retry.
          if (error instanceof ExampleRuntimeDeadlineError) projectLease.retire();
          throw new Error(
            `example "${example.id}" failed in the ${runtime} runtime: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          );
        }
      };

      const cleanup = async (projectId: string) => {
        if (!exampleCase.cleanup) return;
        try {
          using project = connectProject(projectId);
          await exampleCase.cleanup(project, { attemptSalt, marker: "cleanup", projectId });
        } catch (error) {
          // Slot hygiene never replaces the test's own result, but remains
          // visible so an accumulating resource leak cannot become folklore.
          console.warn(`example "${example.id}" cleanup failed (ignored):`, error);
        }
      };

      if (exampleCase.runtimeExecution === "serial") {
        using itx = connectGlobal();
        using projectLease = await serialMatrixProjectPool.acquire(itx);
        const caseDeadline = Date.now() + runtimeTimeoutMs;
        try {
          for (const runtime of runtimes) {
            const remainingMs = caseDeadline - Date.now();
            if (remainingMs <= 0) {
              throw new Error(
                `example "${example.id}" exhausted its ${runtimeTimeoutMs}ms serial case budget before the ${runtime} runtime`,
              );
            }
            await runRuntime(runtime, projectLease, remainingMs);
          }
        } finally {
          await cleanup(projectLease.projectId);
        }
        return;
      }

      // Wait for every runtime before returning a failure. Promise.all would
      // let a retry begin while sibling runtimes still held project leases.
      const results = await Promise.allSettled(
        runtimes.map(async (runtime) => {
          using itx = connectGlobal();
          using projectLease = await matrixProjectPools[runtime].acquire(itx);
          try {
            await runRuntime(runtime, projectLease, runtimeTimeoutMs);
          } finally {
            await cleanup(projectLease.projectId);
          }
        }),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, `example "${example.id}" failed in multiple runtimes`);
      }
    },
  );
}
