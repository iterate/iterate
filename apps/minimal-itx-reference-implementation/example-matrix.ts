// The server-side execution-runtime matrix for catalogue examples: ONE script
// body (an example's `code`, with `itx` + `vars` in scope and a trailing
// `return`) runs through every server-side runtime. The browser runtime lives
// in itx.browser.test.ts (vitest's browser project); everything else is here.
// Mirrors apps/os/src/itx/e2e/example-matrix.ts.
//
//   node            AsyncFunction over a Cap'n Web stub in this process
//   cli             a spawned `cli.ts run …` (a real process boundary)
//   post-script     POST /api/itx with the body wrapped as a function
//   dynamic-worker  a Worker Loader isolate reached via env.ITX.get()
//
// The point is not to build a framework. It is to prove the reference shape
// does not secretly depend on one runtime's calling convention.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { itxHttpUrl, withItx } from "./client.ts";
import { baseUrl, token } from "./e2e-env.ts";
import type { ItxExample } from "./examples.ts";

const execFileAsync = promisify(execFile);
const APP_ROOT = fileURLToPath(new URL(".", import.meta.url));
const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (itx: unknown, vars: Record<string, unknown>) => Promise<unknown>;

export const MATRIX_RUNTIMES = ["node", "cli", "post-script", "dynamic-worker"] as const;
export type MatrixRuntime = (typeof MATRIX_RUNTIMES)[number];

export type MatrixCoordinate = { path: string; projectId: string };

/** The fresh coordinate an example runs at: agent examples get a unique agent
 *  path so durable state never bleeds between runs; project examples use the
 *  prj_ref project root. */
export function exampleCoordinate(example: ItxExample, label: string): MatrixCoordinate {
  const path = example.context === "agent" ? `/agents/matrix-${label}-${slug(example.id)}` : "/";
  return { path, projectId: "prj_ref" };
}

export async function runExampleCode(
  runtime: MatrixRuntime,
  input: { code: string; ctx: MatrixCoordinate; vars: Record<string, unknown> },
): Promise<unknown> {
  switch (runtime) {
    case "node":
      return await runInNode(input);
    case "cli":
      return await runInCli(input);
    case "post-script":
      return await runByPostScript(input);
    case "dynamic-worker":
      return await runInDynamicWorker(input);
  }
}

type RunInput = { code: string; ctx: MatrixCoordinate; vars: Record<string, unknown> };

async function runInNode(input: RunInput): Promise<unknown> {
  const script = new AsyncFunction("itx", "vars", input.code);
  using itx = withItx({
    baseUrl: baseUrl(),
    path: input.ctx.path,
    projectId: input.ctx.projectId,
    token: token(),
  });
  return await script(itx, input.vars);
}

async function runInCli(input: RunInput): Promise<unknown> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--experimental-strip-types",
      "cli.ts",
      "run",
      "--base-url",
      baseUrl(),
      "--project-id",
      input.ctx.projectId,
      "--path",
      input.ctx.path,
      "--token",
      token(),
      "--code",
      input.code,
      "--vars",
      JSON.stringify(input.vars),
    ],
    { cwd: APP_ROOT, maxBuffer: 20 * 1024 * 1024 },
  );
  return JSON.parse(stdout.trim());
}

async function runByPostScript(input: RunInput): Promise<unknown> {
  const agentScriptCode = `async (itx) => { const vars = ${JSON.stringify(input.vars)};\n${input.code}\n}`;
  const projectScript =
    input.ctx.path === "/"
      ? agentScriptCode
      : `async (itx) => {
          const run = await itx.agents.get(${JSON.stringify(input.ctx.path)}).runScript({
            code: ${JSON.stringify(agentScriptCode)},
          });
          return run.result;
        }`;
  const response = await fetch(itxHttpUrl({ baseUrl: baseUrl(), projectId: input.ctx.projectId }), {
    // The server runs `program(itx)`, so vars are baked into the body as a
    // local — the body still authors against `itx` + `vars` in scope, the
    // same contract every other runtime gives it.
    body: projectScript,
    headers: { authorization: `Bearer ${token()}`, "content-type": "text/plain" },
    method: "POST",
  });
  const body = (await response.json()) as { error?: string; result?: unknown };
  if (!response.ok) throw new Error(`POST /api/itx failed: ${body.error ?? JSON.stringify(body)}`);
  return body.result;
}

async function runInDynamicWorker(input: RunInput): Promise<unknown> {
  const runnerName = `runner_${crypto.randomUUID().replace(/-/g, "_")}`;
  const runner = {
    type: "dynamic-worker",
    source: {
      type: "inline",
      mainModule: "runner.js",
      modules: {
        "runner.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";
          export class MatrixRunnerEntrypoint extends WorkerEntrypoint {
            async run(vars) {
              const itx = await this.env.ITX.get();
              ${input.code}
            }
          }
        `,
      },
    },
    entrypoint: "MatrixRunnerEntrypoint",
    props: {},
  };
  using itx = withItx({
    baseUrl: baseUrl(),
    path: input.ctx.path,
    projectId: input.ctx.projectId,
    token: token(),
  });
  await itx.provideCapability({ path: [runnerName], capability: runner });
  return await itx[runnerName].run(input.vars);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
