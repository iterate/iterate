// itx catalogue matrix: proves the REPL examples (src/itx/examples.ts — the
// same entries the Examples panel shows) against a REAL deployed worker
// (local dev server, preview, or production — whatever APP_CONFIG_BASE_URL
// points at), through every server-side runtime of the itx
// (/api). The browser runtime runs the same catalogue in
// examples-browser.test.ts; itx behavior itself is proven by
// apps/os/e2e/itx/*.
//
// KNOWN CAVEAT (local vite dev only): repo-sourced project worker dials can
// fail with masked "internal error"s against a local dev server — the itx
// own e2e ("Authenticated internal auth itx can create project…",
// project.worker.fetch) fails identically there. Verify project-worker
// failures against a deployed preview before treating them as regressions.

import { expect, test as baseTest } from "vitest";
import { ITX_EXAMPLES } from "../../src/itx/examples.ts";
import { EXAMPLE_CASES, EXAMPLE_IDS_WITHOUT_CASES } from "./example-cases.ts";
import { connectGlobal, connectProject } from "./e2e-env.ts";
import { bakeProjectWorkerRunner, MATRIX_RUNTIMES, runExampleCode } from "./example-matrix.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const PROJECT_SLUG = `itx-e2e-${RUN_SUFFIX}`;

// One project, created here (the harness's job); every example then connects
// INTO it and gets straight to work. The project-worker runtime needs the
// catalogue baked into the project's worker.ts, so the lazy setup commits
// that once.
const MATRIX_EXAMPLES = ITX_EXAMPLES.filter(
  (example) =>
    example.runtimes.some((runtime) => (MATRIX_RUNTIMES as readonly string[]).includes(runtime)) &&
    EXAMPLE_CASES[example.id] !== undefined,
);
const matrixTest = baseTest;

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

// Concurrency-safe under `sequence.concurrent`: the `??=` check-and-assign has
// no await between them, so it's atomic against other microtasks — the first
// matrix test to arrive creates the project, every other awaits the same
// promise (one project, created once). Tests then share that read-only
// projectId but isolate their writes with a per-runtime `marker` (below), so
// concurrent examples don't collide.
//
// The setup is BOUNDED and NON-POISONING: the create + worker bake dials
// RPCs with no deadline of their own, and a wedged repo commit under full
// lane load once parked this promise forever — every matrix test AND every
// vitest retry then awaited the same dead memo, so the whole file produced
// zero output until the lane watchdog killed it (marathons of 2026-07-10).
// A failed or timed-out setup clears the memo, so the next attempt
// re-creates the project fresh instead of re-awaiting the corpse.
const MATRIX_SETUP_TIMEOUT_MS = 120_000;
let matrixSetupPromise: Promise<{ projectId: string }> | null = null;
function ensureMatrixProject(): Promise<{ projectId: string }> {
  matrixSetupPromise ??= (async () => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new Error(
              `matrix project setup (create + worker bake) exceeded ${MATRIX_SETUP_TIMEOUT_MS / 1000}s`,
            ),
          ),
        MATRIX_SETUP_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([
        deadline,
        (async () => {
          using itx = connectGlobal();
          using project = itx.projects.create({
            slug: `${PROJECT_SLUG}-${Date.now().toString(36)}`,
          });
          const { projectId } = await project.__describe();
          await bakeProjectWorkerRunner({
            examples: MATRIX_EXAMPLES.filter((example) =>
              example.runtimes.includes("project-worker"),
            ),
            projectId,
          });
          return { projectId };
        })(),
      ]);
    } catch (error) {
      matrixSetupPromise = null;
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  })();
  return matrixSetupPromise;
}

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
      const { projectId } = await ensureMatrixProject();
      const runtimes = MATRIX_RUNTIMES.filter((runtime) => example.runtimes.includes(runtime));
      expect(runtimes.length).toBeGreaterThan(0);

      // Fresh per attempt, shared across this attempt's runtimes — see
      // ExampleRunContext.attemptSalt.
      const attemptSalt = crypto.randomUUID().slice(0, 8);
      try {
        for (const runtime of runtimes) {
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
        }
      } finally {
        // In a FINALLY: the failed attempts are precisely the ones whose
        // resources must not leak (a stuck container that failed this
        // attempt would otherwise keep holding slot capacity while the
        // retry mints a fresh attemptSalt). Best-effort — slot hygiene
        // never turns the test's own outcome.
        if (exampleCase.cleanup) {
          try {
            using project = connectProject(projectId);
            await exampleCase.cleanup(project, { attemptSalt, marker: "cleanup", projectId });
          } catch (error) {
            console.warn(`example "${example.id}" cleanup failed (ignored):`, error);
          }
        }
      }
    },
  );
}
