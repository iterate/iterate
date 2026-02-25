import { execFile, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createAdaptorServer } from "@hono/node-server";
import { daemonServiceManifest } from "@iterate-com/daemon-contract";
import { baseApp, injectWebSocket } from "./utils/hono.ts";
import { ptyRouter } from "./routers/pty.ts";

const env = daemonServiceManifest.envVars.parse(process.env);
const execFileAsync = promisify(execFile);
const DEFAULT_EXPORT_PATTERN = /^\s*export\s+default\b/m;
const EXEC_TS_TIMEOUT_MS = 30_000;
const TSX_BINARIES = [process.env.TSX_BINARY, "/opt/pidnap/node_modules/.bin/tsx", "tsx"].filter(
  (value): value is string => typeof value === "string" && value.trim().length > 0,
);

baseApp.get("/healthz", (c) => c.text("ok"));
baseApp.route("/api/pty", ptyRouter);

function serviceHealthPayload() {
  return {
    ok: true as const,
    service: daemonServiceManifest.name,
    version: daemonServiceManifest.version,
  };
}

function serviceSqlPayload() {
  return {
    rows: [],
    headers: [],
    stat: {
      rowsAffected: 0,
      rowsRead: null,
      rowsWritten: null,
      queryDurationMs: 0,
    },
  };
}

function parseSqlStatementInput(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const payload = input as {
    statement?: unknown;
    json?: { statement?: unknown };
  };
  const statementRaw =
    typeof payload.statement === "string"
      ? payload.statement
      : typeof payload.json?.statement === "string"
        ? payload.json.statement
        : null;
  const statement = statementRaw?.trim();
  return statement && statement.length > 0 ? statement : null;
}

baseApp.get("/api/service/health", (c) => c.json(serviceHealthPayload()));
baseApp.get("/orpc/service/health", (c) => c.json({ json: serviceHealthPayload() }));

baseApp.post("/api/service/sql", async (c) => {
  const input = await c.req.json().catch(() => null);
  const statement = parseSqlStatementInput(input);
  if (!statement) return c.json({ error: "statement is required" }, 400);
  return c.json(serviceSqlPayload());
});

baseApp.post("/orpc/service/sql", async (c) => {
  const input = await c.req.json().catch(() => null);
  const statement = parseSqlStatementInput(input);
  if (!statement) return c.json({ error: "statement is required" }, 400);
  return c.json({ json: serviceSqlPayload() });
});

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

baseApp.post("/api/tools/exec-ts", async (c) => {
  const body = (await c.req.json()) as { code?: string };
  const code = body.code;
  if (!code || code.trim().length === 0) {
    return c.json({ error: "code is required" }, 400);
  }

  const dir = join(tmpdir(), "jonasland-daemon-exec");
  await mkdir(dir, { recursive: true });
  const runId = randomUUID();
  const scriptPath = join(dir, `script-${runId}.mts`);
  const runnerPath = join(dir, `runner-${runId}.mts`);
  const resultPath = join(dir, `result-${runId}.json`);

  try {
    await writeFile(scriptPath, ensureModuleSource(code), "utf8");
    await writeFile(runnerPath, buildRunnerSource(scriptPath, resultPath), "utf8");
    try {
      await runTsxFile(runnerPath);
      const payloadText = await readFile(resultPath, "utf8");
      const parsed = JSON.parse(payloadText) as { result?: unknown };
      return c.json({ ok: true as const, result: parsed.result });
    } catch (error) {
      const details = getExecErrorDetails(error);
      const errorMessage = details.stderr || details.stdout || details.message;
      const status = errorMessage.includes("code must export default async function") ? 400 : 500;
      return c.json({ error: errorMessage }, status);
    }
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {});
    await rm(runnerPath, { force: true }).catch(() => {});
    await rm(resultPath, { force: true }).catch(() => {});
  }
});

export const startDaemonService = async () => {
  const server = createAdaptorServer({ fetch: baseApp.fetch });
  injectWebSocket(server);

  await new Promise<void>((resolve) => {
    server.listen(env.DAEMON_SERVICE_PORT, "0.0.0.0", () => resolve());
  });

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
