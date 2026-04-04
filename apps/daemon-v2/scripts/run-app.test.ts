import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  parseRunAppArgs,
  resolveHealthCheckUrl,
  resolveRuntimeBinding,
  runRegisteredApp,
} from "./run-app.ts";

const exampleAppRoot = fileURLToPath(new URL("../../example", import.meta.url));

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function listenOnRandomPort(server: ReturnType<typeof createServer>) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }
  return address.port;
}

async function createFakeAppScript() {
  const dir = await mkdtemp(join(tmpdir(), "daemon-v2-run-app-"));
  const scriptPath = join(dir, "fake-app.mjs");
  await writeFile(
    scriptPath,
    [
      'import { createServer } from "node:http";',
      "",
      'const host = process.env.HOST || "127.0.0.1";',
      "const port = Number(process.env.PORT || 0);",
      "let healthAttempts = 0;",
      "const server = createServer((request, response) => {",
      '  if (request.url === "/api/__internal/health") {',
      "    healthAttempts += 1;",
      "    if (healthAttempts < 2) {",
      '      response.writeHead(503, { "content-type": "application/json" });',
      "      response.end(JSON.stringify({ ok: false }));",
      "      return;",
      "    }",
      '    response.writeHead(200, { "content-type": "application/json" });',
      "    response.end(JSON.stringify({ ok: true }));",
      "    return;",
      "  }",
      '  response.writeHead(200, { "content-type": "text/plain" });',
      '  response.end("hello");',
      "});",
      "server.listen(port, host);",
      'process.on("SIGTERM", () => {',
      "  server.close(() => process.exit(0));",
      "});",
    ].join("\n"),
    "utf8",
  );
  return {
    dir,
    scriptPath,
  };
}

describe("run-app", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("parses wrapper arguments with a child command", () => {
    expect(
      parseRunAppArgs([
        "--app",
        "./src/app.ts",
        "--cwd",
        "/repo/apps/example",
        "--tag",
        "openapi",
        "--health-check",
        "/api/__internal/health",
        "--",
        "sh",
        "-lc",
        'pnpm dev -- --host "$HOST" --port "$PORT"',
      ]),
    ).toEqual({
      app: "./src/app.ts",
      cwd: "/repo/apps/example",
      command: "sh",
      args: ["-lc", 'pnpm dev -- --host "$HOST" --port "$PORT"'],
      host: undefined,
      port: undefined,
      healthCheck: "/api/__internal/health",
      tags: ["openapi"],
      registryBaseUrl: undefined,
    });
  });

  test("resolves default runtime binding and health URL", async () => {
    const binding = await resolveRuntimeBinding({});
    expect(binding.bindHost).toBe("0.0.0.0");
    expect(binding.connectHost).toBe("127.0.0.1");
    expect(binding.port).toBeGreaterThan(0);

    expect(
      resolveHealthCheckUrl({
        connectHost: "127.0.0.1",
        port: 3210,
      }),
    ).toBe("http://127.0.0.1:3210/api/__internal/health");

    expect(
      resolveHealthCheckUrl({
        healthCheck: "http://127.0.0.1:9999/ready",
        connectHost: "127.0.0.1",
        port: 3210,
      }),
    ).toBe("http://127.0.0.1:9999/ready");
  });

  test("waits for health and then registers the app route", async () => {
    const fakeApp = await createFakeAppScript();
    tempDirs.push(fakeApp.dir);

    let receivedRoute: Record<string, unknown> | null = null;
    let resolveUpsert!: (value: Record<string, unknown>) => void;
    const upsertReceived = new Promise<Record<string, unknown>>((resolve) => {
      resolveUpsert = resolve;
    });

    const registryServer = createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/api/routes/upsert") {
        const body = await readJsonBody(request);
        receivedRoute = body;
        resolveUpsert(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            route: {
              host: body.host,
              target: body.target,
              metadata: body.metadata ?? {},
              tags: body.tags ?? [],
              caddyDirectives: body.caddyDirectives ?? [],
              updatedAt: new Date().toISOString(),
            },
            routeCount: 1,
          }),
        );
        return;
      }

      response.writeHead(404);
      response.end();
    });

    const registryPort = await listenOnRandomPort(registryServer);
    const abortController = new AbortController();

    const runPromise = runRegisteredApp({
      app: "./src/app.ts",
      cwd: exampleAppRoot,
      command: process.execPath,
      args: [fakeApp.scriptPath],
      tags: ["openapi", "openapi"],
      registryBaseUrl: `http://127.0.0.1:${String(registryPort)}`,
      env: process.env,
      signal: abortController.signal,
      healthIntervalMs: 50,
      registrationIntervalMs: 50,
      healthTimeoutMs: 5_000,
      registrationTimeoutMs: 5_000,
    });

    const body = await upsertReceived;
    abortController.abort();
    const exitCode = await runPromise;

    await new Promise<void>((resolve, reject) => {
      registryServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    expect(exitCode).toBe(0);
    expect(receivedRoute).not.toBeNull();
    expect(body.host).toBe("example.iterate.localhost");
    expect(typeof body.target).toBe("string");
    expect(String(body.target)).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(body.tags).toEqual(["openapi"]);
    expect(body.metadata).toMatchObject({
      title: "example",
      openapiPath: "/api/openapi.json",
    });
  });
});
