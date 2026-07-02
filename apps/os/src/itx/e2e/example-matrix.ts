// The execution-runtime matrix for catalogue examples: ONE script body (an
// example's `code`, with `itx` + `vars` in scope and a trailing `return`)
// runs through every server-side runtime. The browser runtime lives in
// itx.browser.test.ts (vitest's browser project); everything else is here.
//
//   node            AsyncFunction over a next-engine Cap'n Web stub in this process
//   run-script      project.runScript(`async (itx) => { const vars = …; <body> }`)
//                   — the server-side script isolate agents use
//   project-worker  the body baked into the project's repo worker.js, invoked
//                   via project.worker.runItxExample (env.ITX inside)
//
// TODO(cli port): the `iterate` CLI still speaks the legacy /api/itx surface.
// Re-add a `cli` dispatcher (spawned `pnpm cli itx run --eval …`) once the CLI
// is ported to the next engine.

import { RpcTarget } from "capnweb";
import type { ItxExample, ItxExampleRuntime } from "../examples.ts";
import { connectProject } from "./e2e-env.ts";

export const MATRIX_RUNTIMES = ["node", "run-script", "project-worker"] as const;
export type MatrixRuntime = (typeof MATRIX_RUNTIMES)[number] & ItxExampleRuntime;

const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (itx: unknown, vars: Record<string, unknown>, rpcTarget: unknown) => Promise<unknown>;

export async function runExampleCode(
  runtime: MatrixRuntime,
  input: { code: string; id?: string; projectId: string; vars: Record<string, unknown> },
): Promise<unknown> {
  // Worker-heavy examples running while other suites load their own dynamic
  // workers can trip the deployment's loader isolate cap. That's shared-load
  // contention, not a behavior bug — back off and retry that exact transient;
  // anything else fails immediately.
  return await retryOnWorkerStartupContention(async () => {
    switch (runtime) {
      case "node":
        return await runInNode(input);
      case "run-script":
        return await runInRunScript(input);
      case "project-worker":
        return await runInProjectWorker(input);
    }
  });
}

const LOADER_CONTENTION_MESSAGE = "Too many concurrent dynamic workers";
// The engine redacts server-side exceptions to "internal error; reference = …"
// before they cross Cap'n Web. Mid-suite that shape is overwhelmingly loader
// isolate saturation (each script execution and inline worker is its own
// isolate), so treat it as the same retryable transient; a persistent engine
// bug still fails after the backoff budget.
const MASKED_INTERNAL_ERROR_MESSAGE = "internal error; reference =";
const LOADER_CONTENTION_BACKOFF_MS = [2_000, 5_000, 10_000];

async function retryOnWorkerStartupContention<T>(run: () => Promise<T>): Promise<T> {
  for (const backoffMs of LOADER_CONTENTION_BACKOFF_MS) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        message.includes(LOADER_CONTENTION_MESSAGE) ||
        message.includes(MASKED_INTERNAL_ERROR_MESSAGE);
      if (!retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  return await run();
}

async function runInNode(input: {
  code: string;
  projectId: string;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  const script = new AsyncFunction("itx", "vars", "RpcTarget", input.code);
  using project = connectProject(input.projectId);
  return await script(project, input.vars, RpcTarget);
}

async function runInRunScript(input: {
  code: string;
  projectId: string;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  using project = connectProject(input.projectId);
  // runScript takes an async arrow function source string (see the engine
  // ItxCapabilityHost contract); the example body becomes its body, with the
  // case's vars serialized inline.
  const execution = await project.runScript(
    `async (itx) => {\nconst vars = ${JSON.stringify(input.vars)};\n${input.code}\n}`,
  );
  return execution.result;
}

async function runInProjectWorker(input: {
  code: string;
  id?: string;
  projectId: string;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  if (!input.id) throw new Error("project-worker runs are invoked by example id.");
  using project = connectProject(input.projectId);
  const worker = project.worker as unknown as {
    runItxExample(input: { id: string; vars: Record<string, unknown> }): Promise<unknown>;
  };
  return await worker.runItxExample({ id: input.id, vars: input.vars });
}

/**
 * The project-repo worker.js for the matrix project: every project-worker
 * example baked in as `async (itx, vars) => { <body> }`, dispatched by id
 * through ONE exported method. `project.worker.runItxExample(...)` reaches the
 * repo-sourced default worker, and the script's handle is the worker's own
 * `await this.env.ITX.get()` — the same project-scoped itx every other runtime
 * connects to from outside. Plain JavaScript: dynamic workers may import
 * "cloudflare:workers" and nothing else.
 */
export function projectWorkerRunnerSource(examples: ItxExample[]): string {
  const scripts = examples
    .map(
      (example) => `  ${JSON.stringify(example.id)}: async (itx, vars) => {\n${example.code}\n},`,
    )
    .join("\n");
  return `import { WorkerEntrypoint } from "cloudflare:workers";

const scripts = {
${scripts}
};

export default class ItxExampleRunner extends WorkerEntrypoint {
  fetch() {
    return new Response("itx example runner");
  }

  processEvent(input) {
    // The default project worker receives every committed project event; the
    // example runner has nothing to do with them.
    void input;
  }

  async runItxExample({ id, vars }) {
    const script = scripts[id];
    if (!script) throw new Error("unknown example: " + id);
    const itx = await this.env.ITX.get();
    return await script(itx, vars || {});
  }
}
`;
}

/**
 * Overwrite the matrix project's worker.js with the example runner. This
 * replaces the seeded counter worker — fine inside the matrix's dedicated
 * test project. Repo-sourced workers are late-bound: the next
 * `project.worker.*` call loads the committed source.
 */
export async function bakeProjectWorkerRunner(input: {
  examples: ItxExample[];
  projectId: string;
}): Promise<void> {
  using project = connectProject(input.projectId);
  const commit = await project.repo.commitFiles({
    changes: [{ content: projectWorkerRunnerSource(input.examples), path: "worker.js" }],
    message: "Bake catalogue examples into the project worker",
  });
  if (commit.noChanges) return;
  if (!commit.changedPaths.includes("worker.js")) {
    throw new Error(`worker.js runner commit did not land: ${JSON.stringify(commit)}`);
  }
}
