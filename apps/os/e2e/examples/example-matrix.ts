// The execution-runtime matrix for catalogue examples: ONE script body (an
// example's `code`, with `itx` + `vars` in scope and a trailing `return`)
// runs through every server-side runtime. The browser runtime is proven by
// specs/repl-examples.spec.ts (the real REPL); everything else is here.
//
//   node            AsyncFunction over an itx Cap'n Web stub in this process
//   cli             spawned `tsx scripts/cli.ts itx run --eval … --context …`
//                   (a genuinely separate process; parses the CLI's one JSON doc)
//   run-script      project.capabilityHost.runScript(`async (itx) => { const vars = …; <body> }`)
//                   — the server-side script isolate agents use
//   project-worker  the body baked into the project's repo worker.ts, invoked
//                   via project.worker.runItxExample (env.ITX inside)

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RpcTarget } from "capnweb";
import type { ItxExample, ItxExampleRuntime } from "../../src/itx/examples.ts";
import { runExample } from "../test-support/run-example.ts";
import { baseUrl, connectProject } from "./e2e-env.ts";

export const MATRIX_RUNTIMES = ["node", "cli", "run-script", "project-worker"] as const;
export type MatrixRuntime = (typeof MATRIX_RUNTIMES)[number] & ItxExampleRuntime;

const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (itx: unknown, vars: Record<string, unknown>, rpcTarget: unknown) => Promise<unknown>;

export async function runExampleCode(
  runtime: MatrixRuntime,
  input: {
    code: string;
    id: string;
    projectId: string;
    timeoutMs: number;
    vars: Record<string, unknown>;
  },
): Promise<unknown> {
  // Exactly one attempt: transient absorption is the vitest CI retry's job
  // (E2E_CI_RETRIES, docs/testing.md#retries-and-timeouts). A retry wrapper
  // here used to re-roll anything containing "internal error; reference =" —
  // Cloudflare's redaction of EVERY server-side crash — which could mask
  // real worker-startup product bugs behind a silent second retry layer.
  switch (runtime) {
    case "node":
      return await runInNode(input);
    case "cli":
      return await runInCli(input);
    case "run-script":
      return await runInRunScript(input);
    case "project-worker":
      return await runInProjectWorker(input);
  }
}

const execFileAsync = promisify(execFile);
const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

async function runInCli(input: {
  code: string;
  id: string;
  projectId: string;
  timeoutMs: number;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  // tsx directly (not `pnpm cli`) so stdout is exactly the run command's one
  // JSON document, with no package-runner banner in front of it.
  const startedAt = performance.now();
  try {
    const { stdout } = await execFileAsync(
      "pnpm",
      [
        "exec",
        "tsx",
        "./scripts/cli.ts",
        "itx",
        "run",
        "--eval",
        input.code,
        "--context",
        input.projectId,
        "--vars",
        JSON.stringify(input.vars),
        "--base-url",
        baseUrl(),
      ],
      {
        cwd: APP_ROOT,
        env: process.env,
        killSignal: "SIGKILL",
        maxBuffer: 10 * 1024 * 1024,
        timeout: input.timeoutMs,
      },
    );
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs >= 10_000) {
      console.warn(
        `[e2e:matrix] CLI runtime for ${input.id} took ${String(Math.round(elapsedMs))}ms`,
      );
    }
    return JSON.parse(stdout);
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const failure = error as Error & {
      code?: number | string | null;
      killed?: boolean;
      signal?: string | null;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };
    const stdout = decodeProcessOutput(failure.stdout);
    const stderr = decodeProcessOutput(failure.stderr);
    const timedOut = failure.killed === true && elapsedMs >= input.timeoutMs - 1_000;
    const stderrTail = stderr.trim().slice(-2_000);
    throw new Error(
      [
        timedOut
          ? `CLI runtime for ${input.id} exceeded ${String(input.timeoutMs)}ms`
          : `CLI runtime command for ${input.id} failed after ${String(elapsedMs)}ms`,
        `(code=${String(failure.code ?? "unknown")}, signal=${String(failure.signal ?? "none")}, killed=${String(failure.killed ?? false)}, stdoutBytes=${String(Buffer.byteLength(stdout))}, stderrBytes=${String(Buffer.byteLength(stderr))})`,
        stderrTail ? `stderr tail:\n${stderrTail}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" "),
      { cause: error },
    );
  }
}

function decodeProcessOutput(output: Buffer | string | undefined): string {
  if (output === undefined) return "";
  return typeof output === "string" ? output : output.toString("utf8");
}

async function runInNode(input: {
  code: string;
  projectId: string;
  timeoutMs: number;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  const script = new AsyncFunction("itx", "vars", "RpcTarget", input.code);
  using project = connectProject(input.projectId);
  return await finishBeforeRuntimeDeadline("node", input.timeoutMs, () =>
    script(project, input.vars, RpcTarget),
  );
}

async function runInRunScript(input: {
  id: string;
  projectId: string;
  timeoutMs: number;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  using project = connectProject(input.projectId);
  // The shared by-id door (test-support/run-example.ts) IS this runtime:
  // the matrix proves the exact envelope any e2e test gets from runExample.
  return await finishBeforeRuntimeDeadline("run-script", input.timeoutMs, () =>
    runExample(input.id, {
      capabilityHost: project.capabilityHost,
      vars: input.vars,
    }),
  );
}

async function runInProjectWorker(input: {
  code: string;
  id: string;
  projectId: string;
  timeoutMs: number;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  using project = connectProject(input.projectId);
  const worker = project.worker as unknown as {
    runItxExample(input: { id: string; vars: Record<string, unknown> }): Promise<unknown>;
  };
  return await finishBeforeRuntimeDeadline("project-worker", input.timeoutMs, () =>
    worker.runItxExample({ id: input.id, vars: input.vars }),
  );
}

async function finishBeforeRuntimeDeadline<Result>(
  runtime: MatrixRuntime,
  timeoutMs: number,
  operation: () => Promise<Result>,
): Promise<Result> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(runtime + " runtime exceeded " + timeoutMs + "ms")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * The project-repo worker.ts for the matrix project: every project-worker
 * example baked in as `async (itx, vars) => { <body> }`, dispatched by id
 * through ONE exported method. `project.worker.runItxExample(...)` reaches the
 * repo-sourced default worker, and the script's handle is the worker's own
 * `await this.env.ITX.get()`. Each runtime has an exclusive project lease, so
 * this proves the same project-scoped itx semantics without sharing mutable
 * repo state with the other runtimes. Plain JavaScript: dynamic workers may
 * import "cloudflare:workers" and nothing else.
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

  // Optional: project.worker dispatch PREFERS flattened invokeCapability and
  // falls back to member replay for workers without one, so this walk only
  // saves the guaranteed-failing probe RPC per call. It mirrors the seeded
  // template worker's dispatcher.
  async invokeCapability({ args = [], path }) {
    let receiver = this;
    for (const segment of path.slice(0, -1)) {
      receiver = await Reflect.get(Object(receiver), segment);
    }
    const method = path.at(-1);
    const handler = Reflect.get(Object(receiver), method);
    if (typeof handler !== "function") {
      throw new Error('"' + path.join(".") + '" is not a method on the example runner');
    }
    return await Reflect.apply(handler, receiver, args);
  }

  processEventBatch(batch) {
    // Every project stream delivers its committed events here; the example
    // runner has nothing to do with them, but must accept the batch so the
    // streams' delivery checkpoints keep advancing.
    void batch;
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
 * Overwrite the matrix project's worker.ts with the example runner. This
 * replaces the seeded template worker — fine inside the matrix's dedicated
 * test project. Repo-sourced workers are late-bound: the next
 * `project.worker.*` call builds the committed source.
 */
export async function bakeProjectWorkerRunner(input: {
  examples: ItxExample[];
  projectId: string;
}): Promise<void> {
  using project = connectProject(input.projectId);
  const commit = await project.repo.commitFiles({
    changes: [{ content: projectWorkerRunnerSource(input.examples), path: "worker.ts" }],
    message: "Bake catalogue examples into the project worker",
  });
  if (commit.noChanges) return;
  if (!commit.changedPaths.includes("worker.ts")) {
    throw new Error(`worker.ts runner commit did not land: ${JSON.stringify(commit)}`);
  }
}
