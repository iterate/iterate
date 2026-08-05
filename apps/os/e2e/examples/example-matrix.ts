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
import { ITX_INITIAL_CONNECTION_RETRY_PREFIX } from "../../scripts/itx.ts";
import type { ItxExample, ItxExampleRuntime } from "../../src/itx/examples.ts";
import { runExample } from "../test-support/run-example.ts";
import { baseUrl, connectProject } from "./e2e-env.ts";

export const MATRIX_RUNTIMES = ["node", "cli", "run-script", "project-worker"] as const;
export type MatrixRuntime = (typeof MATRIX_RUNTIMES)[number] & ItxExampleRuntime;
export type CliInitialConnectionRetry = {
  attemptDurationMs: number;
  delayMs: number;
  error: string;
  errorCode?: string;
  failedAttempt: number;
  nextAttempt: number;
  startedAt: string;
};

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
    onInitialConnectionRetry?: (retry: CliInitialConnectionRetry) => Promise<void> | void;
  },
): Promise<unknown> {
  // Execute user code exactly once. The CLI may make one observable fresh
  // dial before its RPC session exists, but neither it nor these runtime
  // adapters replay authentication or an operation. A wrapper here used to
  // re-roll anything containing "internal error; reference =" — Cloudflare's
  // redaction of EVERY server-side crash — which could mask real
  // worker-startup product bugs behind a silent second retry layer.
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
  projectId: string;
  timeoutMs: number;
  vars: Record<string, unknown>;
  onInitialConnectionRetry?: (retry: CliInitialConnectionRetry) => Promise<void> | void;
}): Promise<unknown> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), input.timeoutMs);
  // tsx directly (not `pnpm cli`) so stdout is exactly the run command's one
  // JSON document, with no package-runner banner in front of it.
  try {
    const { stderr, stdout } = await execFileAsync(
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
        signal: abortController.signal,
      },
    );
    await reportCliDiagnostics(stderr, input.onInitialConnectionRetry);
    if (!stdout.trim()) {
      throw new Error(
        "CLI process exited successfully before writing its JSON result; the command lifecycle was interrupted",
      );
    }
    return JSON.parse(stdout);
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new ExampleRuntimeDeadlineError("cli", input.timeoutMs, { cause: error });
    }
    throw cliProcessFailure(error);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function reportCliDiagnostics(
  stderr: string,
  onInitialConnectionRetry:
    | ((retry: CliInitialConnectionRetry) => Promise<void> | void)
    | undefined,
) {
  for (const line of stderr.split(/\r?\n/u).filter(Boolean)) {
    if (!line.startsWith(ITX_INITIAL_CONNECTION_RETRY_PREFIX)) {
      console.warn(`[cli stderr] ${line}`);
      continue;
    }
    const retry = parseInitialConnectionRetry(
      line.slice(ITX_INITIAL_CONNECTION_RETRY_PREFIX.length),
    );
    console.warn(`${ITX_INITIAL_CONNECTION_RETRY_PREFIX}${JSON.stringify(retry)}`);
    await onInitialConnectionRetry?.(retry);
  }
}

function parseInitialConnectionRetry(value: string): CliInitialConnectionRetry {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (
    typeof parsed.attemptDurationMs !== "number" ||
    typeof parsed.delayMs !== "number" ||
    typeof parsed.error !== "string" ||
    typeof parsed.failedAttempt !== "number" ||
    typeof parsed.nextAttempt !== "number" ||
    typeof parsed.startedAt !== "string" ||
    (parsed.errorCode !== undefined && typeof parsed.errorCode !== "string")
  ) {
    throw new Error(`Invalid CLI initial-connection retry diagnostic: ${value}`);
  }
  return parsed as CliInitialConnectionRetry;
}

function cliProcessFailure(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return error;
  const processError = error as { stderr?: unknown; stdout?: unknown };
  const stderr = compactProcessOutput(processError.stderr);
  const stdout = compactProcessOutput(processError.stdout);
  const output = stderr ?? stdout;
  if (output === undefined) return error;
  return new Error(
    `cli process failed — ${stderr === undefined ? "stdout" : "stderr"}: ${output}`,
    {
      cause: error,
    },
  );
}

function compactProcessOutput(output: unknown): string | undefined {
  if (typeof output !== "string") return undefined;
  const compact = output.replace(/\s+/gu, " ").trim();
  if (compact.length === 0) return undefined;
  const limit = 2_000;
  return compact.length > limit ? `…${compact.slice(-limit)}` : compact;
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

export async function finishBeforeRuntimeDeadline<Result>(
  runtime: MatrixRuntime,
  timeoutMs: number,
  operation: () => Promise<Result>,
): Promise<Result> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new ExampleRuntimeDeadlineError(runtime, timeoutMs)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export class ExampleRuntimeDeadlineError extends Error {
  constructor(
    readonly runtime: MatrixRuntime,
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`${runtime} runtime exceeded ${timeoutMs}ms`, options);
    this.name = "ExampleRuntimeDeadlineError";
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
