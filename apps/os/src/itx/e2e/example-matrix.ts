// The execution-runtime matrix for catalogue examples: ONE script body (an
// example's `code`, with `itx` + `vars` in scope and a trailing `return`)
// runs through every server-side runtime. The browser runtime lives in
// itx.browser.test.ts (vitest's browser project); everything else is here.
//
//   node            AsyncFunction over a Cap'n Web stub in this process
//   cli             `iterate-app-cli itx run -e …` (a real spawned CLI)
//   dynamic-worker  POST /api/itx/run with the body wrapped as a function
//   config-worker   the body baked into the project's repo
//                   worker.js, invoked via itx.worker (env.ITERATE.context)

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { RpcTarget } from "capnweb";
import type { ItxExample, ItxExampleRuntime } from "../examples.ts";
import { adminApiSecret, baseUrl, connectGlobal } from "./e2e-env.ts";

const execFileAsync = promisify(execFile);
const OS_APP_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export const MATRIX_RUNTIMES = ["node", "cli", "dynamic-worker", "config-worker"] as const;
export type MatrixRuntime = (typeof MATRIX_RUNTIMES)[number] & ItxExampleRuntime;

const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (itx: unknown, vars: Record<string, unknown>, rpcTarget: unknown) => Promise<unknown>;

export async function runExampleCode(
  runtime: MatrixRuntime,
  input: { code: string; id?: string; projectId: string; vars: Record<string, unknown> },
): Promise<unknown> {
  // Worker-heavy examples (worker-to-worker, facets) running while the other
  // e2e files load their own dynamic workers can trip the deployment's loader
  // concurrency cap. That's shared-load contention, not a behavior bug — back
  // off and retry that one error; anything else fails immediately.
  return await retryOnLoaderContention(async () => {
    switch (runtime) {
      case "node":
        return await runInNode(input);
      case "cli":
        return await runInCli(input);
      case "dynamic-worker":
        return await runInDynamicWorker(input);
      case "config-worker":
        return await runInConfigWorker(input);
    }
  });
}

const LOADER_CONTENTION_MESSAGE = "Too many concurrent dynamic workers";
const LOADER_CONTENTION_BACKOFF_MS = [2_000, 5_000, 10_000];

async function retryOnLoaderContention<T>(run: () => Promise<T>): Promise<T> {
  for (const backoffMs of LOADER_CONTENTION_BACKOFF_MS) {
    try {
      return await run();
    } catch (error) {
      // The cli runtime surfaces script errors on the spawned process's
      // stderr (execFile attaches it to the error), so check both.
      const message = [
        error instanceof Error ? error.message : String(error),
        String((error as { stderr?: unknown }).stderr ?? ""),
      ].join("\n");
      if (!message.includes(LOADER_CONTENTION_MESSAGE)) throw error;
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
  using itx = connectGlobal();
  using projectItx = await itx.projects.get(input.projectId);
  return await script(projectItx, input.vars, RpcTarget);
}

async function runInCli(input: {
  code: string;
  projectId: string;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  const { stdout } = await execFileAsync(
    "pnpm",
    [
      "exec",
      "iterate-app-cli",
      "itx",
      "run",
      "-e",
      input.code,
      "--vars",
      JSON.stringify(input.vars),
      "--context",
      input.projectId,
    ],
    {
      cwd: OS_APP_ROOT,
      env: {
        ...process.env,
        APP_CONFIG_ADMIN_API_SECRET: adminApiSecret(),
        APP_CONFIG_BASE_URL: baseUrl(),
      },
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout.trim());
}

async function runInDynamicWorker(input: {
  code: string;
  projectId: string;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  const response = await fetch(new URL("/api/itx/run", baseUrl()), {
    body: JSON.stringify({
      context: input.projectId,
      functionSource: `async ({ itx, vars }) => {\n${input.code}\n}`,
      vars: input.vars,
    }),
    headers: matrixAuthHeaders(),
    method: "POST",
  });
  const body = (await response.json()) as { error?: string; result?: unknown };
  if (!response.ok) {
    throw new Error(`/api/itx/run failed: ${body.error ?? JSON.stringify(body)}`);
  }
  return body.result;
}

async function runInConfigWorker(input: {
  code: string;
  id?: string;
  projectId: string;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  if (!input.id) throw new Error("config-worker runs are invoked by example id.");
  using itx = connectGlobal();
  using projectItx = await itx.projects.get(input.projectId);
  const worker = (projectItx as never as Record<string, any>).worker;
  return await worker.runItxExample({ id: input.id, vars: input.vars });
}

/**
 * The project-repo worker.js for the matrix project: every config-worker
 * example baked in as `async ({ itx, vars }) => { <body> }`, dispatched by id
 * through ONE exported method. `itx.worker.runItxExample(...)` reaches it via
 * the Project DO's path replay, and the script's handle is the config
 * worker's own env.ITERATE.context — the same project-scoped itx every other
 * runtime connects to from outside.
 */
export function configWorkerRunnerSource(examples: ItxExample[]): string {
  const scripts = examples
    .map(
      (example) =>
        `  ${JSON.stringify(example.id)}: async ({ itx, vars }) => {\n${example.code}\n  },`,
    )
    .join("\n");
  return `import { WorkerEntrypoint } from "cloudflare:workers";

const scripts = {
${scripts}
};

export default class extends WorkerEntrypoint {
  async fetch() {
    return new Response("itx example runner");
  }

  async runItxExample({ id, vars }) {
    const script = scripts[id];
    if (!script) throw new Error("unknown example: " + id);
    const itx = await this.env.ITERATE.context;
    return await script({ itx, vars: vars ?? {} });
  }
}
`;
}

/**
 * Commit files into a project's repo. The push itself runs
 * as an itx script via /api/itx/run (the in-isolate path agents use); the
 * file contents travel via the endpoint's vars.
 */
export async function pushProjectRepoFiles(input: {
  commitMessage: string;
  files: Record<string, string>;
  projectId: string;
  projectSlug: string;
}): Promise<void> {
  const pushScript = async ({
    itx,
    vars,
  }: {
    itx: Record<string, any>;
    vars: { dir: string; files: Record<string, string>; message: string; projectSlug: string };
  }) => {
    const repo = await itx.repos.ensureProjectRepoInfo({ projectSlug: vars.projectSlug });
    const url = new URL(repo.remote);
    url.username = "x";
    url.password = repo.token.split("?")[0];
    await itx.workspace.gitClone({
      branch: repo.defaultBranch,
      depth: 1,
      dir: vars.dir,
      url: url.toString(),
    });
    for (const [path, content] of Object.entries(vars.files)) {
      await itx.workspace.writeFile(`${vars.dir}/${path}`, content);
      await itx.workspace.gitAdd({ dir: vars.dir, filepath: path });
    }
    await itx.workspace.gitCommit({
      author: { email: "e2e@iterate.com", name: "itx e2e" },
      dir: vars.dir,
      message: vars.message,
    });
    await itx.workspace.gitPush({ dir: vars.dir, ref: repo.defaultBranch, remote: "origin" });
    return { pushed: true };
  };

  const response = await fetch(new URL("/api/itx/run", baseUrl()), {
    body: JSON.stringify({
      context: input.projectId,
      functionSource: pushScript.toString(),
      vars: {
        dir: `/e2e-config-${crypto.randomUUID().slice(0, 8)}`,
        files: input.files,
        message: input.commitMessage,
        projectSlug: input.projectSlug,
      },
    }),
    headers: matrixAuthHeaders(),
    method: "POST",
  });
  const body = (await response.json()) as { error?: string; result?: unknown };
  if (!response.ok) throw new Error(`config worker push failed: ${body.error}`);
}

function matrixAuthHeaders() {
  return {
    authorization: `Bearer ${adminApiSecret()}`,
    "content-type": "application/json",
  };
}
