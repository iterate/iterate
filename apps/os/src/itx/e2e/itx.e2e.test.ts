// itx catalogue matrix: proves the REPL examples (src/itx/examples.ts — the
// same entries the Examples panel shows) against a REAL deployed worker
// (local dev server, preview, or production — whatever APP_CONFIG_BASE_URL
// points at), through every server-side runtime of the NEXT engine
// (/api/itx-next). The browser runtime runs the same catalogue in
// itx.browser.test.ts; engine behavior itself is proven by
// apps/os/e2e/engine/*.
//
// KNOWN CAVEAT (local vite dev only): repo-sourced project worker dials can
// fail with masked "internal error"s against a local dev server — the engine's
// own e2e ("Authenticated internal auth itx can create project…",
// project.worker.fetch) fails identically there. Verify project-worker
// failures against a deployed preview before treating them as regressions.

import { expect, test as baseTest } from "vitest";
import { ITX_EXAMPLES } from "../examples.ts";
import { connectGlobal } from "./e2e-env.ts";
import { EXAMPLE_CASES, EXAMPLE_IDS_WITHOUT_CASES } from "./example-cases.ts";
import { bakeProjectWorkerRunner, MATRIX_RUNTIMES, runExampleCode } from "./example-matrix.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const PROJECT_SLUG = `itx-e2e-${RUN_SUFFIX}`;

// One project, created here (the harness's job); every example then connects
// INTO it and gets straight to work. The project-worker runtime needs the
// catalogue baked into the project's worker.js, so the lazy setup commits
// that once.
const MATRIX_EXAMPLES = ITX_EXAMPLES.filter(
  (example) =>
    example.runtimes.some((runtime) => (MATRIX_RUNTIMES as readonly string[]).includes(runtime)) &&
    EXAMPLE_CASES[example.id] !== undefined,
);
const matrixTest = process.env.OS_ITX_E2E_SKIP_MATRIX === "true" ? baseTest.skip : baseTest;

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
    expect(example!.context, `cased example "${id}" must be project-context`).toBe("project");
    expect(
      example!.runtimes.includes("browser"),
      `cased example "${id}" must be browser-runnable (specs/repl-examples.spec.ts)`,
    ).toBe(true);
  }
});

let matrixSetupPromise: Promise<{ projectId: string }> | null = null;
function ensureMatrixProject(): Promise<{ projectId: string }> {
  matrixSetupPromise ??= (async () => {
    using itx = connectGlobal();
    using project = itx.projects.create({ slug: PROJECT_SLUG });
    const { projectId } = await project.describe();
    await bakeProjectWorkerRunner({
      examples: MATRIX_EXAMPLES.filter((example) => example.runtimes.includes("project-worker")),
      projectId,
    });
    return { projectId };
  })();
  return matrixSetupPromise;
}

for (const example of MATRIX_EXAMPLES) {
  const exampleCase = EXAMPLE_CASES[example.id]!;
  // Cold isolates and a dynamic-worker load per call make these the slowest
  // tests in the suite.
  matrixTest(
    `catalogue example "${example.id}" runs identically across runtimes`,
    { timeout: 240_000 },
    async () => {
      const { projectId } = await ensureMatrixProject();
      const runtimes = MATRIX_RUNTIMES.filter((runtime) => example.runtimes.includes(runtime));
      expect(runtimes.length).toBeGreaterThan(0);

      for (const runtime of runtimes) {
        const ctx = { marker: `${runtime}-${crypto.randomUUID().slice(0, 8)}`, projectId };
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
    },
  );
}
