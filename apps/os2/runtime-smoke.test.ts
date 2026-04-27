/**
 * Default `pnpm test` checks local sqlfu assets only.
 * Full runtime checks require Cloudflare local/prod env: `pnpm test:smoke`
 * (`RUNTIME_SMOKE_FULL=1`).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createORPCClient } from "@orpc/client";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { type ContractRouterClient } from "@orpc/contract";
import { osContract } from "@iterate-com/os2-contract";
import { extractPublicConfigSchema } from "@iterate-com/shared/apps/config";
import { x, type Result } from "tinyexec";
import { describe, expect, test } from "vitest";
import { AppConfig } from "./src/app.ts";

const appRoot = dirname(fileURLToPath(import.meta.url));
const CF_DEV_PORT = 3015;
const hasCfWranglerLocal = existsSync(join(appRoot, ".alchemy/local/wrangler.jsonc"));
const runFullSmoke = process.env.RUNTIME_SMOKE_FULL === "1";
const describeRuntimeSmoke = process.env.CI ? describe.skip : describe.sequential;
const PublicConfigSchema = extractPublicConfigSchema(AppConfig);
const smokeEnv = {
  APP_CONFIG: JSON.stringify({
    pirateSecret: "smoke-secret",
  }),
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
  expect(html).toContain("Pirate Secret");
  expect(html).toContain("Observability / failure demo");
}

function createOpenApiClient(httpBaseUrl: string): ContractRouterClient<typeof osContract> {
  return createORPCClient(
    new OpenAPILink(osContract, {
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
  const config = PublicConfigSchema.parse(await client.__internal.publicConfig({}));
  expect(config).toEqual({});
}

async function assertOrpcWebSocket(httpBaseUrl: string) {
  const websocket = new WebSocket(httpToWsUrl(httpBaseUrl, "/api/orpc-ws"));
  const client: ContractRouterClient<typeof osContract> = createORPCClient(
    new WebSocketRPCLink({ websocket }),
  );

  try {
    const body = await client.ping({});
    expect(body.message).toBe("pong");
  } finally {
    websocket.close();
  }
}

async function assertFullStack(httpBaseUrl: string) {
  await assertSsrHtml(httpBaseUrl);
  await assertTypedClientPing(httpBaseUrl);
  await assertPublicConfigOverride(httpBaseUrl);
  await assertOrpcWebSocket(httpBaseUrl);
}

async function waitForReady(httpBaseUrl: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL("/debug", httpBaseUrl), {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok && (await res.text()).includes("oRPC Ping")) {
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

describe("sqlfu assets", () => {
  test("generated query and migration bundles exist", () => {
    expect(existsSync(join(appRoot, "src/db/queries/.generated/index.ts"))).toBe(true);
    expect(existsSync(join(appRoot, "src/db/migrations/.generated/migrations.ts"))).toBe(true);
  });
});

describeRuntimeSmoke("runtime smoke", () => {
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
