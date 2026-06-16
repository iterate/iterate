// runtime-matrix.ts — v2's copy of the apps/os itx runtime matrix, simplified.
//
// One script body, with `itx` and `vars` in scope, runs from:
//
//   node-websocket   this process, over a Cap'n Web WebSocket
//   cli              a spawned command-line process using the same client
//   post-script      POST /api/itx, loaded inside workerd by runScript
//   dynamic-worker   a Worker Loader isolate with env.ITX.get()
//   browser          a real Chromium page with a browser WebSocket
//
// The point is not to build a framework. It is to prove the reference shape does
// not secretly depend on one runtime's calling convention.

import assert from "node:assert";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { itxHttpUrl, itxWebSocketUrl, withItx } from "./client.ts";

const execFileAsync = promisify(execFile);
const APP_ROOT = fileURLToPath(new URL(".", import.meta.url));
const TOKEN = "alice-token";
const BASE_URL = process.env.ITX_BASE ?? "http://127.0.0.1:8788";
const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (itx: unknown, vars: Record<string, unknown>) => Promise<unknown>;

export const MATRIX_RUNTIMES = [
  "node-websocket",
  "cli",
  "post-script",
  "dynamic-worker",
  "browser",
] as const;
export type MatrixRuntime = (typeof MATRIX_RUNTIMES)[number];

type MatrixExample = {
  name: string;
  code: string;
  setup?: (ctx: MatrixContext) => Promise<void>;
  vars?: Record<string, unknown>;
  assert: (result: unknown, runtime: MatrixRuntime) => void;
};

type MatrixContext = {
  path: string;
  projectId: string;
};

const dynamicCalc = {
  type: "dynamic-worker",
  source: {
    type: "inline",
    mainModule: "calc.js",
    modules: {
      "calc.js": `
        import { WorkerEntrypoint } from "cloudflare:workers";
        export class CalcEntrypoint extends WorkerEntrypoint {
          add(a, b) { return a + b; }
        }
      `,
    },
  },
  entrypoint: "CalcEntrypoint",
  props: {},
};

const repoCounter = {
  type: "dynamic-durable-object",
  source: { type: "repo", repo: "shared", commit: "latest", path: "counter.js" },
  className: "CounterDurableObject",
};

export const MATRIX_EXAMPLES: MatrixExample[] = [
  {
    name: "agent builtin",
    code: `return await itx.whoami();`,
    assert: (result) => {
      assert.equal(typeof result, "string");
      assert.ok((result as string).startsWith("agent shared/agents/"));
    },
  },
  {
    name: "project builtin inherited by agent",
    code: `
      const source = await itx.repo.getWorkerSource({ path: "counter.js" });
      return { mainModule: source.mainModule, hasCounter: source.modules["counter.js"].includes("CounterDurableObject") };
    `,
    assert: (result) => {
      assert.deepEqual(result, { mainModule: "counter.js", hasCounter: true });
    },
  },
  {
    name: "dynamic worker capability",
    setup: async (ctx) => {
      using itx = withItx({
        baseUrl: BASE_URL,
        path: ctx.path,
        projectId: ctx.projectId,
        token: TOKEN,
      });
      await itx.provideCapability({ path: ["calc"], capability: dynamicCalc });
    },
    vars: { a: 19, b: 23 },
    code: `return await itx.calc.add(vars.a, vars.b);`,
    assert: (result) => {
      assert.equal(result, 42);
    },
  },
  {
    name: "dynamic durable object facet",
    setup: async (ctx) => {
      using itx = withItx({
        baseUrl: BASE_URL,
        path: ctx.path,
        projectId: ctx.projectId,
        token: TOKEN,
      });
      await itx.provideCapability({ path: ["counter"], capability: repoCounter });
    },
    code: `
      const next = await itx.counter.increment();
      const current = await itx.counter.current();
      return { current, next };
    `,
    assert: (result) => {
      const value = result as { current: number; next: number };
      assert.equal(value.current, value.next);
      assert.equal(typeof value.current, "number");
      assert.ok(value.current >= 1);
    },
  },
];

export async function runRuntimeMatrix(label = crypto.randomUUID().slice(0, 8)): Promise<void> {
  for (const example of MATRIX_EXAMPLES) {
    const ctx = {
      path: `/agents/matrix-${label}-${slug(example.name)}`,
      projectId: "shared",
    };
    await example.setup?.(ctx);
    for (const runtime of MATRIX_RUNTIMES) {
      const result = await runExampleCode(runtime, {
        code: example.code,
        ctx,
        vars: example.vars ?? {},
      });
      example.assert(result, runtime);
    }
  }
}

async function runExampleCode(
  runtime: MatrixRuntime,
  input: { code: string; ctx: MatrixContext; vars: Record<string, unknown> },
): Promise<unknown> {
  switch (runtime) {
    case "node-websocket":
      return await runInNode(input);
    case "cli":
      return await runInCli(input);
    case "post-script":
      return await runByPostScript(input);
    case "dynamic-worker":
      return await runInDynamicWorker(input);
    case "browser":
      return await runInBrowser(input);
  }
}

async function runInNode(input: {
  code: string;
  ctx: MatrixContext;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  const script = new AsyncFunction("itx", "vars", input.code);
  using itx = withItx({
    baseUrl: BASE_URL,
    path: input.ctx.path,
    projectId: input.ctx.projectId,
    token: TOKEN,
  });
  return await script(itx, input.vars);
}

async function runInCli(input: {
  code: string;
  ctx: MatrixContext;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--experimental-strip-types",
      "cli.ts",
      "run",
      "--base-url",
      BASE_URL,
      "--project-id",
      input.ctx.projectId,
      "--path",
      input.ctx.path,
      "--token",
      TOKEN,
      "--code",
      input.code,
      "--vars",
      JSON.stringify(input.vars),
    ],
    { cwd: APP_ROOT, maxBuffer: 20 * 1024 * 1024 },
  );
  return JSON.parse(stdout.trim());
}

async function runByPostScript(input: {
  code: string;
  ctx: MatrixContext;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  const response = await fetch(
    itxHttpUrl({ baseUrl: BASE_URL, path: input.ctx.path, projectId: input.ctx.projectId }),
    {
      body: `async (itx) => { const vars = ${JSON.stringify(input.vars)};\n${input.code}\n}`,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
      method: "POST",
    },
  );
  const body = (await response.json()) as { error?: string; result?: unknown };
  if (!response.ok) throw new Error(`POST /api/itx failed: ${body.error ?? JSON.stringify(body)}`);
  return body.result;
}

async function runInDynamicWorker(input: {
  code: string;
  ctx: MatrixContext;
  vars: Record<string, unknown>;
}): Promise<unknown> {
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
    baseUrl: BASE_URL,
    path: input.ctx.path,
    projectId: input.ctx.projectId,
    token: TOKEN,
  });
  await itx.provideCapability({ path: [runnerName], capability: runner });
  return await itx[runnerName].run(input.vars);
}

async function runInBrowser(input: {
  code: string;
  ctx: MatrixContext;
  vars: Record<string, unknown>;
}): Promise<unknown> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    return await page.evaluate(
      async ({ code, vars, wsUrl }) => {
        const { newWebSocketRpcSession } = await import("https://esm.sh/capnweb@0.8.0");
        const script = new (async function () {}.constructor as new (
          ...args: string[]
        ) => (itx: unknown, vars: Record<string, unknown>) => Promise<unknown>)(
          "itx",
          "vars",
          code,
        );
        const itx = newWebSocketRpcSession(new WebSocket(wsUrl));
        try {
          return await script(itx, vars);
        } finally {
          itx[Symbol.dispose]?.();
        }
      },
      {
        code: input.code,
        vars: input.vars,
        wsUrl: itxWebSocketUrl({
          baseUrl: BASE_URL,
          path: input.ctx.path,
          projectId: input.ctx.projectId,
          token: TOKEN,
          tokenInQuery: true,
        }),
      },
    );
  } finally {
    await browser.close();
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
