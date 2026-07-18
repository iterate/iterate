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
import { createTestProjectPool } from "../test-support/create-shared-test-project.ts";
import { E2E_FILE_TEST_CONCURRENCY } from "../test-support/concurrency.ts";
import { EXAMPLE_CASES, EXAMPLE_IDS_WITHOUT_CASES } from "./example-cases.ts";
import { connectGlobal, connectProject } from "./e2e-env.ts";
import {
  bakeProjectWorkerRunner,
  MATRIX_RUNTIMES,
  runExampleCode,
  type MatrixRuntime,
} from "./example-matrix.ts";

const MATRIX_EXAMPLES = ITX_EXAMPLES.filter(
  (example) =>
    example.runtimes.some((runtime) => (MATRIX_RUNTIMES as readonly string[]).includes(runtime)) &&
    EXAMPLE_CASES[example.id] !== undefined,
);
const matrixTest = baseTest;

// Fixed public capability mounts, the config repo, and the repo-sourced
// project worker are project-global mutable resources. Markers cannot isolate
// them. Give each simultaneously eligible runtime an exclusive project, and
// keep separate pools per runtime so a node example's repo commit cannot
// rebuild the worker underneath a project-worker example.
//
// Pool size equals Vitest's in-file concurrency, so acquiring a lease never
// serializes a runnable test. A project is reused only after its previous owner
// releases it. Peak matrix ownership is 4 runtimes × 2 projects.
const matrixProjectPools: Record<MatrixRuntime, ReturnType<typeof createTestProjectPool>> = {
  node: createTestProjectPool({
    size: E2E_FILE_TEST_CONCURRENCY,
    slugPrefix: "matrix-node",
  }),
  cli: createTestProjectPool({
    size: E2E_FILE_TEST_CONCURRENCY,
    slugPrefix: "matrix-cli",
  }),
  "run-script": createTestProjectPool({
    size: E2E_FILE_TEST_CONCURRENCY,
    slugPrefix: "matrix-script",
  }),
  "project-worker": createTestProjectPool({
    size: E2E_FILE_TEST_CONCURRENCY,
    slugPrefix: "matrix-worker",
  }),
};

// The sandbox example deliberately runs all runtimes against one warm
// container. It is the only serial-runtime case, so it gets a separate
// exclusive-project family instead of weakening isolation for every example.
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
    // A failed setup must not poison later tests or a Vitest retry that leases
    // this otherwise healthy project.
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
  // Cold isolates and a dynamic-worker load per call make these the slowest
  // tests in the suite. The budget is case-driven, NOT the blanket heavy
  // ceiling: the first runtime pays the example's cold path
  // (completionTimeoutMs — e.g. a sandbox container boot), later runtimes
  // reuse it warm. A blanket 240s meant one stuck example burned
  // 240s + 240s retry and the lane died by watchdog instead of reporting
  // WHICH example was stuck (marathons j3tqdhncb6/rhhms9q9pv, 2026-07-10).
  matrixTest(
    `catalogue example "${example.id}" runs identically across runtimes`,
    { timeout: (exampleCase.completionTimeoutMs ?? 90_000) + 30_000 },
    async () => {
      const runtimes = MATRIX_RUNTIMES.filter((runtime) => example.runtimes.includes(runtime));
      expect(runtimes.length).toBeGreaterThan(0);

      // Fresh per attempt; shared only by a case that explicitly elects
      // serial runtime execution (the warm sandbox container).
      const attemptSalt = crypto.randomUUID().slice(0, 8);
      const runRuntime = async (runtime: (typeof runtimes)[number], projectId: string) => {
        if (runtime === "project-worker") await ensureProjectWorkerRunner(projectId);
        const ctx = {
          attemptSalt,
          marker: `${runtime}-${crypto.randomUUID().slice(0, 8)}`,
          projectId,
        };
        const vars = exampleCase.vars?.(ctx) ?? {};
        try {
          const result = await runExampleCode(runtime, {
            code: example.code,
            id: example.id,
            projectId,
            timeoutMs: exampleCase.completionTimeoutMs ?? 90_000,
            vars,
          });
          exampleCase.assert(result, ctx, expect);
        } catch (error) {
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
        try {
          for (const runtime of runtimes) {
            await runRuntime(runtime, projectLease.projectId);
          }
        } finally {
          await cleanup(projectLease.projectId);
        }
        return;
      }

      // Wait for every runtime to settle before returning a failure. Promise.all
      // would let the retry start while sibling runtimes still owned projects.
      const results = await Promise.allSettled(
        runtimes.map(async (runtime) => {
          using itx = connectGlobal();
          using projectLease = await matrixProjectPools[runtime].acquire(itx);
          try {
            await runRuntime(runtime, projectLease.projectId);
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
