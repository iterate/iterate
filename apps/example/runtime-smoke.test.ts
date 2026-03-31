/**
 * Default `pnpm test` runs the `pnpm dev` smoke only (fast, no Cloudflare deploy).
 * Full matrix (build, preview, start, cf:dev, cf:deploy): `pnpm test:smoke` (`RUNTIME_SMOKE_FULL=1`).
 * CI skips this suite so branch test runs do not depend on app runtime boot smoke checks.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { exampleContract } from "@iterate-com/example-contract";
import { extractPublicConfigSchema } from "@iterate-com/shared/apps/config";
import getPort from "get-port";
import { x, type Result } from "tinyexec";
import { beforeAll, describe, expect, test } from "vitest";
import { AppConfig } from "./src/app.ts";

const appRoot = dirname(fileURLToPath(import.meta.url));
const CF_DEV_PORT = 3015;
const hasCfWranglerLocal = existsSync(join(appRoot, ".alchemy/local/wrangler.jsonc"));
const runFullSmoke = process.env.RUNTIME_SMOKE_FULL === "1";
const describeRuntimeSmoke = process.env.CI ? describe.skip : describe.sequential;
const expectedPosthogApiKey = "phc_smoke_override_key";
const PublicConfigSchema = extractPublicConfigSchema(AppConfig);
const smokeEnv = {
  APP_CONFIG: JSON.stringify({
    pirateSecret: "smoke-secret",
    posthog: {
      apiKey: "phc_smoke_base_key",
    },
  }),
  APP_CONFIG_POSTHOG__API_KEY: expectedPosthogApiKey,
};

/** Drop inherited `APP_CONFIG` / `APP_CONFIG_*` so Doppler (or local shells) cannot override smoke fixtures. */
function stripInheritedAppConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key === "APP_CONFIG" || key.startsWith("APP_CONFIG_")) {
      delete next[key];
    }
  }
  return next;
}

function runWithDrainedOutput(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => {
      chunks.push(Buffer.from(data));
      process.stdout.write(data);
    });

    child.stderr?.on("data", (data: Buffer) => {
      chunks.push(Buffer.from(data));
      process.stderr.write(data);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function httpToWsUrl(httpBaseUrl: string, pathname: string) {
  const url = new URL(pathname, httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function parseAlchemyDeployUrl(output: string): string | undefined {
  const fromLog =
    output.match(/url:\s*'(https:\/\/[^']+)'/)?.[1] ??
    output.match(/url:\s*"(https:\/\/[^"]+)"/)?.[1];

  if (fromLog) {
    return fromLog.replace(/\/$/, "");
  }

  const workers = output.match(/(https:\/\/[a-z0-9][-a-z0-9.]*\.workers\.dev)\/?/i);
  return workers?.[1]?.replace(/\/$/, "");
}

async function assertSsrHtml(httpBaseUrl: string) {
  const res = await fetch(new URL("/debug", httpBaseUrl), {
    signal: AbortSignal.timeout(3_000),
  });

  expect(res.ok).toBe(true);

  const html = await res.text();
  expect(html).toContain("Runtime deps demo");
  expect(html).toContain("Pirate Secret");
  expect(html).toContain("Observability / failure demo");
}

function createOpenApiClient(httpBaseUrl: string): ContractRouterClient<typeof exampleContract> {
  return createORPCClient(
    new OpenAPILink(exampleContract, {
      url: new URL("/api", httpBaseUrl).toString(),
    }),
  );
}

async function assertTypedClientPing(httpBaseUrl: string) {
  const client = createOpenApiClient(httpBaseUrl);
  const body = await client.ping({});
  expect(body.message).toBe("pong");
}

async function assertPublicConfigOverride(httpBaseUrl: string) {
  const client = createOpenApiClient(httpBaseUrl);
  const config = PublicConfigSchema.parse(await client.common.publicConfig({}));
  expect(config.posthog.apiKey).toBe(expectedPosthogApiKey);
}

async function assertOrpcWebSocket(httpBaseUrl: string) {
  const websocket = new WebSocket(httpToWsUrl(httpBaseUrl, "/api/orpc-ws"));
  const client: ContractRouterClient<typeof exampleContract> = createORPCClient(
    new WebSocketRPCLink({ websocket }),
  );

  try {
    const body = await client.ping({});
    expect(body.message).toBe("pong");
  } finally {
    websocket.close();
  }
}

const COMMAND_PREFIX = "\x00[command]\x00";

async function assertTerminalWebSocket(httpBaseUrl: string) {
  const url = httpToWsUrl(httpBaseUrl, "/api/pty");

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("terminal WebSocket timeout"));
    }, 5_000);

    ws.addEventListener("open", () => {
      ws.send(
        COMMAND_PREFIX +
          JSON.stringify({
            type: "resize",
            cols: 80,
            rows: 24,
          }),
      );
    });
    ws.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      if (text.includes('"type":"ptyId"') || text.includes("Terminal is not available")) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("terminal WebSocket error"));
    });
  });
}

async function assertFullStack(httpBaseUrl: string) {
  await assertSsrHtml(httpBaseUrl);
  await assertTypedClientPing(httpBaseUrl);
  await assertPublicConfigOverride(httpBaseUrl);
  await assertOrpcWebSocket(httpBaseUrl);
  await assertTerminalWebSocket(httpBaseUrl);
}

async function waitForReady(httpBaseUrl: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL("/debug", httpBaseUrl), {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok && (await res.text()).includes("Runtime deps demo")) {
        return;
      }
      last = new Error(`GET /debug -> ${res.status}`);
    } catch (error) {
      last = error;
    }

    await delay(300);
  }

  throw last;
}

async function readChildOutput(child: Result) {
  try {
    const result = await Promise.resolve(child);
    return `${result.stdout}${result.stderr}`;
  } catch (childError) {
    if (childError instanceof Error && "output" in childError) {
      const output = childError.output as { stdout?: string; stderr?: string };
      return `${output.stdout ?? ""}${output.stderr ?? ""}`;
    }

    return childError instanceof Error ? childError.message : String(childError);
  }
}

async function stopService(child: Result) {
  if (child.exitCode !== null || child.killed) return;

  child.kill("SIGTERM");
  await Promise.race([
    Promise.resolve(child).then(
      () => undefined,
      () => undefined,
    ),
    delay(3_000).then(() => child.kill("SIGKILL")),
  ]);
}

async function withServer(
  command: string,
  args: string[],
  env: Record<string, string>,
  httpBaseUrl: string,
  run: () => Promise<void>,
) {
  const child = x(command, args, {
    persist: true,
    throwOnError: false,
    nodeOptions: {
      cwd: appRoot,
      env: { ...stripInheritedAppConfig(process.env), ...env },
      stdio: "pipe",
    },
  });

  try {
    await waitForReady(httpBaseUrl);
    await run();
  } catch (error) {
    child.kill("SIGTERM");
    const output = await readChildOutput(child);
    throw new Error(`${String(error)}\n--- server log ---\n${output}`);
  } finally {
    await stopService(child);
  }
}

describeRuntimeSmoke("runtime smoke", () => {
  beforeAll(async () => {
    if (!runFullSmoke) return;

    await x("pnpm", ["build"], {
      throwOnError: true,
      nodeOptions: {
        cwd: appRoot,
        stdio: "inherit",
        env: {
          ...stripInheritedAppConfig(process.env),
          ...smokeEnv,
          NODE_ENV: "production",
        },
      },
    });
  });

  test("pnpm dev", async () => {
    const port = await getPort({ host: "127.0.0.1" });
    const base = `http://127.0.0.1:${port}`;

    await withServer(
      "pnpm",
      ["dev", "--host", "127.0.0.1", "--port", String(port)],
      smokeEnv,
      base,
      () => assertFullStack(base),
    );
  });

  test.skipIf(!runFullSmoke)("pnpm preview", async () => {
    const port = await getPort({ host: "127.0.0.1" });
    const base = `http://127.0.0.1:${port}`;

    await withServer(
      "pnpm",
      ["preview", "--host", "127.0.0.1", "--port", String(port)],
      smokeEnv,
      base,
      () => assertFullStack(base),
    );
  });

  test.skipIf(!runFullSmoke)("pnpm start", async () => {
    const port = await getPort({ host: "127.0.0.1" });
    const base = `http://127.0.0.1:${port}`;

    await withServer(
      "pnpm",
      ["start", "--port", String(port)],
      { ...smokeEnv, HOST: "127.0.0.1" },
      base,
      () => assertFullStack(base),
    );
  });

  test.skipIf(!runFullSmoke || !hasCfWranglerLocal)("pnpm cf:dev", async () => {
    const base = `http://127.0.0.1:${CF_DEV_PORT}`;
    await withServer("pnpm", ["run", "cf:dev"], smokeEnv, base, () => assertFullStack(base));
  });

  test.skipIf(!runFullSmoke)(
    "pnpm cf:deploy",
    async () => {
      const { code, output } = await runWithDrainedOutput("pnpm", ["run", "cf:deploy"], {
        cwd: appRoot,
        env: { ...stripInheritedAppConfig(process.env), ...smokeEnv },
      });

      if (code !== 0) {
        throw new Error(`cf:deploy exited with code ${code}`);
      }

      const deployUrl = parseAlchemyDeployUrl(output);
      if (!deployUrl) {
        throw new Error(`Could not find deployed workers.dev URL in cf:deploy output:\n${output}`);
      }

      await assertFullStack(deployUrl);
    },
    600_000,
  );
});
