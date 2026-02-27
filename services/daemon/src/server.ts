import { execFile, spawn, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createAdaptorServer } from "@hono/node-server";
import { daemonServiceManifest } from "@iterate-com/daemon-contract";
import { createRegistryClient } from "@iterate-com/registry-service/client";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { mountServiceSubRouterHttpRoutes } from "../../../packages/shared/src/jonasland/index.ts";
import { baseApp, injectWebSocket } from "./utils/hono.ts";
import { ptyRouter } from "./routers/pty.ts";

const env = daemonServiceManifest.envVars.parse(process.env);
const execFileAsync = promisify(execFile);
const DEFAULT_EXPORT_PATTERN = /^\s*export\s+default\b/m;
const EXEC_TS_TIMEOUT_MS = 30_000;
const serviceRegistryHost = "daemon.iterate.localhost";
const serviceRegistryOpenApiPath = "/api/openapi.json";
const TSX_BINARIES = [process.env.TSX_BINARY, "/opt/pidnap/node_modules/.bin/tsx", "tsx"].filter(
  (value): value is string => typeof value === "string" && value.trim().length > 0,
);
const packageRootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const terminalClientDistDir = resolve(packageRootDir, "client-dist");
const terminalClientAssetsDir = resolve(terminalClientDistDir, "assets");
const terminalClientIndexPath = resolve(terminalClientDistDir, "index.html");

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

type DaemonContext = {
  requestId: string;
  serviceName: string;
};

type StreamShellRow = {
  stream: "stdout" | "stderr" | "status";
  text: string;
  timestamp: string;
  exitCode?: number | null;
  signal?: string | null;
};

const os = implement(daemonServiceManifest.orpcContract).$context<DaemonContext>();

baseApp.get("/healthz", (c) => c.text("ok"));
baseApp.get("/terminal/assets/*", async (c) => {
  const pathname = new URL(c.req.url).pathname;
  const response = await serveTerminalAsset(pathname);
  if (response) return response;
  return c.json({ error: "not_found" }, 404);
});
baseApp.get("/terminal", async () => {
  return await serveTerminalIndex();
});
baseApp.get("/terminal/", async () => {
  return await serveTerminalIndex();
});
baseApp.get("/terminal/*", async () => {
  return await serveTerminalIndex();
});
baseApp.route("/api/pty", ptyRouter);
mountServiceSubRouterHttpRoutes({ app: baseApp, manifest: daemonServiceManifest });

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getStaticContentType(filePath: string): string {
  return STATIC_CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
}

async function readTerminalIndexHtml(): Promise<string | null> {
  try {
    return await readFile(terminalClientIndexPath, "utf8");
  } catch (error) {
    const maybeErr = error as NodeJS.ErrnoException;
    if (maybeErr.code === "ENOENT") return null;
    throw error;
  }
}

async function serveTerminalIndex(): Promise<Response> {
  const html = await readTerminalIndexHtml();
  if (!html) {
    return new Response(
      "terminal ui is not built\nrun: pnpm --filter @iterate-com/daemon-service build:client\n",
      {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function serveTerminalAsset(pathname: string): Promise<Response | null> {
  const relativePath = pathname
    .replace(/^\/terminal\/assets\//, "")
    .split("/")
    .filter(Boolean)
    .join("/");
  if (relativePath.length === 0) return null;

  const assetPath = resolve(terminalClientAssetsDir, relativePath);
  if (!assetPath.startsWith(`${terminalClientAssetsDir}${sep}`)) return null;

  try {
    const asset = await readFile(assetPath);
    return new Response(asset, {
      headers: {
        "content-type": getStaticContentType(assetPath),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    const maybeErr = error as NodeJS.ErrnoException;
    if (maybeErr.code === "ENOENT") return null;
    throw error;
  }
}

async function registerOpenApiRoute(): Promise<void> {
  const servicesClient = createRegistryClient({ url: env.SERVICES_ORPC_URL });
  const routeTarget = `127.0.0.1:${String(env.DAEMON_SERVICE_PORT)}`;

  for (let attempt = 1; attempt <= 90; attempt += 1) {
    try {
      await servicesClient.routes.upsert({
        host: serviceRegistryHost,
        target: routeTarget,
        metadata: {
          openapiPath: serviceRegistryOpenApiPath,
          title: "Daemon Service",
        },
        tags: ["openapi", "daemon"],
      });
      return;
    } catch {
      await delay(1_000);
    }
  }
}

function ensureModuleSource(code: string): string {
  if (DEFAULT_EXPORT_PATTERN.test(code)) return code;
  return `export default async () => {\n${code}\n};\n`;
}

function buildRunnerSource(scriptPath: string, resultPath: string): string {
  const scriptUrl = pathToFileURL(scriptPath).href;
  return [
    "import { writeFile } from 'node:fs/promises';",
    `import run from ${JSON.stringify(scriptUrl)};`,
    "",
    "async function main() {",
    "  if (typeof run !== 'function') {",
    "    throw new Error('code must export default async function');",
    "  }",
    "  const result = await run();",
    `  await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ result }), "utf8");`,
    "}",
    "",
    "void main().catch((error) => {",
    "  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);",
    "  process.stderr.write(message);",
    "  process.exitCode = 1;",
    "});",
    "",
  ].join("\n");
}

async function runTsxFile(scriptPath: string): Promise<{ stdout: string; stderr: string }> {
  let notFoundError: Error | null = null;
  for (const tsxBinary of TSX_BINARIES) {
    try {
      const { stdout, stderr } = await execFileAsync(tsxBinary, [scriptPath], {
        maxBuffer: 1024 * 1024 * 5,
        timeout: EXEC_TS_TIMEOUT_MS,
      });
      return { stdout, stderr };
    } catch (error) {
      const maybeErrno = error as NodeJS.ErrnoException;
      if (maybeErrno.code === "ENOENT") {
        notFoundError = maybeErrno;
        continue;
      }
      throw error;
    }
  }
  throw notFoundError ?? new Error("tsx binary not found");
}

function getExecErrorDetails(error: unknown): { stderr: string; stdout: string; message: string } {
  const execError = error as ExecFileException & { stderr?: string; stdout?: string };
  return {
    stderr: typeof execError.stderr === "string" ? execError.stderr.trim() : "",
    stdout: typeof execError.stdout === "string" ? execError.stdout.trim() : "",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function executeTypeScriptSnippet(code: string): Promise<{ ok: true; result?: unknown }> {
  const dir = join(tmpdir(), "jonasland-daemon-exec");
  await mkdir(dir, { recursive: true });
  const runId = randomUUID();
  const scriptPath = join(dir, `script-${runId}.mts`);
  const runnerPath = join(dir, `runner-${runId}.mts`);
  const resultPath = join(dir, `result-${runId}.json`);

  try {
    await writeFile(scriptPath, ensureModuleSource(code), "utf8");
    await writeFile(runnerPath, buildRunnerSource(scriptPath, resultPath), "utf8");
    await runTsxFile(runnerPath);
    const payloadText = await readFile(resultPath, "utf8");
    const parsed = JSON.parse(payloadText) as { result?: unknown };
    return { ok: true, result: parsed.result };
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {});
    await rm(runnerPath, { force: true }).catch(() => {});
    await rm(resultPath, { force: true }).catch(() => {});
  }
}

function pushChunkLines(params: {
  chunk: string;
  buffer: string;
  stream: "stdout" | "stderr";
  push: (row: StreamShellRow) => void;
}): string {
  let current = params.buffer + params.chunk;
  while (true) {
    const newline = current.indexOf("\n");
    if (newline < 0) break;
    const line = current.slice(0, newline).replace(/\r$/, "");
    current = current.slice(newline + 1);
    params.push({
      stream: params.stream,
      text: line,
      timestamp: new Date().toISOString(),
    });
  }
  return current;
}

async function* streamShellCommand(params: {
  command: string;
  cwd?: string;
  signal?: AbortSignal;
}): AsyncGenerator<StreamShellRow> {
  const queue: StreamShellRow[] = [];
  let notify: (() => void) | undefined;
  let done = false;

  const wake = () => {
    const next = notify;
    notify = undefined;
    next?.();
  };

  const push = (row: StreamShellRow) => {
    queue.push(row);
    wake();
  };

  const child = spawn("/bin/bash", ["-lc", params.command], {
    cwd: params.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  push({
    stream: "status",
    text: `started: ${params.command}`,
    timestamp: new Date().toISOString(),
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer = pushChunkLines({
      chunk,
      buffer: stdoutBuffer,
      stream: "stdout",
      push,
    });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer = pushChunkLines({
      chunk,
      buffer: stderrBuffer,
      stream: "stderr",
      push,
    });
  });

  child.on("error", (error) => {
    push({
      stream: "status",
      text: `error: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: new Date().toISOString(),
    });
    done = true;
    wake();
  });

  child.on("close", (exitCode, signal) => {
    if (stdoutBuffer.length > 0) {
      push({
        stream: "stdout",
        text: stdoutBuffer,
        timestamp: new Date().toISOString(),
      });
      stdoutBuffer = "";
    }

    if (stderrBuffer.length > 0) {
      push({
        stream: "stderr",
        text: stderrBuffer,
        timestamp: new Date().toISOString(),
      });
      stderrBuffer = "";
    }

    push({
      stream: "status",
      text: "finished",
      timestamp: new Date().toISOString(),
      exitCode,
      signal,
    });
    done = true;
    wake();
  });

  const abortHandler = () => {
    child.kill("SIGTERM");
    push({
      stream: "status",
      text: "aborted",
      timestamp: new Date().toISOString(),
      signal: "SIGTERM",
    });
  };
  params.signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }

      while (queue.length > 0) {
        const next = queue.shift();
        if (next) yield next;
      }
    }
  } finally {
    params.signal?.removeEventListener("abort", abortHandler);
    if (!child.killed && !done) {
      child.kill("SIGTERM");
    }
  }
}

const daemonRouter = os.router({
  service: {
    health: os.service.health.handler(async ({ context }) => ({
      ok: true,
      service: context.serviceName,
      version: daemonServiceManifest.version,
    })),
    sql: os.service.sql.handler(async () => ({
      rows: [],
      headers: [],
      stat: {
        rowsAffected: 0,
        rowsRead: null,
        rowsWritten: null,
        queryDurationMs: 0,
      },
    })),
  },
  tools: {
    execTs: os.tools.execTs.handler(async ({ input }) => {
      return await executeTypeScriptSnippet(input.code);
    }),
    streamShell: os.tools.streamShell.handler(async function* ({ input, signal }) {
      yield* streamShellCommand({
        command: input.command,
        cwd: input.cwd,
        signal,
      });
    }),
  },
});

const rpcHandler = new RPCHandler(daemonRouter);
const openAPIHandler = new OpenAPIHandler(daemonRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      docsProvider: "scalar",
      docsPath: "/docs",
      specPath: "/openapi.json",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "jonasland daemon-service API",
          version: daemonServiceManifest.version,
        },
        servers: [{ url: "/api" }],
      },
    }),
  ],
});

for (const path of ["/api/openapi.json", "/api/docs", "/api/docs/*"]) {
  baseApp.all(path, async (c) => {
    const { matched, response } = await openAPIHandler.handle(c.req.raw, {
      prefix: "/api",
      context: {
        requestId: randomUUID(),
        serviceName: daemonServiceManifest.name,
      },
    });
    if (matched) return c.newResponse(response.body, response);
    return c.json({ error: "not_found" }, 404);
  });
}

baseApp.post("/api/tools/exec-ts", async (c) => {
  const body = (await c.req.json()) as { code?: string };
  const code = body.code;
  if (!code || code.trim().length === 0) {
    return c.json({ error: "code is required" }, 400);
  }

  try {
    return c.json(await executeTypeScriptSnippet(code));
  } catch (error) {
    const details = getExecErrorDetails(error);
    const errorMessage = details.stderr || details.stdout || details.message;
    const status = errorMessage.includes("code must export default async function") ? 400 : 500;
    return c.json({ error: errorMessage }, status);
  }
});

baseApp.all("/orpc/*", async (c) => {
  const { matched, response } = await rpcHandler.handle(c.req.raw, {
    prefix: "/orpc",
    context: {
      requestId: randomUUID(),
      serviceName: daemonServiceManifest.name,
    },
  });

  if (matched) return c.newResponse(response.body, response);
  return c.json({ error: "not_found" }, 404);
});

export const startDaemonService = async () => {
  const server = createAdaptorServer({ fetch: baseApp.fetch });
  injectWebSocket(server);

  await new Promise<void>((resolve) => {
    server.listen(env.DAEMON_SERVICE_PORT, "0.0.0.0", () => resolve());
  });

  void registerOpenApiRoute();

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void startDaemonService();
}
