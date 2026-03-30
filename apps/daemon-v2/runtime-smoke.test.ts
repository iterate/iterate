import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { daemonV2Contract } from "@iterate-com/daemon-v2-contract";
import { extractPublicConfigSchema } from "@iterate-com/shared/apps/config";
import getPort from "get-port";
import { x, type Result } from "tinyexec";
import { beforeAll, describe, expect, test } from "vitest";
import { AppConfig } from "./src/app.ts";

const appRoot = dirname(fileURLToPath(import.meta.url));
const runFullSmoke = process.env.RUNTIME_SMOKE_FULL === "1";
const describeRuntimeSmoke = process.env.CI ? describe.skip : describe.sequential;
const expectedPosthogApiKey = "phc_smoke_override_key";
const PublicConfigSchema = extractPublicConfigSchema(AppConfig);
const smokeEnv = {
  APP_CONFIG: JSON.stringify({
    posthog: {
      apiKey: "phc_smoke_base_key",
    },
  }),
  APP_CONFIG_POSTHOG__API_KEY: expectedPosthogApiKey,
};

function httpToWsUrl(httpBaseUrl: string, pathname: string) {
  const url = new URL(pathname, httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function assertSsrHtml(httpBaseUrl: string) {
  const res = await fetch(new URL("/", httpBaseUrl), {
    signal: AbortSignal.timeout(3_000),
  });

  expect(res.ok).toBe(true);

  const html = await res.text();
  expect(html).toContain("Daemon V2");
  expect(html).toContain("Registry-style control plane");
}

function createOpenApiClient(httpBaseUrl: string): ContractRouterClient<typeof daemonV2Contract> {
  return createORPCClient(
    new OpenAPILink(daemonV2Contract, {
      url: new URL("/api", httpBaseUrl).toString(),
    }),
  );
}

async function assertTypedClientHealth(httpBaseUrl: string) {
  const client = createOpenApiClient(httpBaseUrl);
  const body = await client.common.health({});
  expect(body.ok).toBe(true);
}

async function assertPublicConfigOverride(httpBaseUrl: string) {
  const client = createOpenApiClient(httpBaseUrl);
  const config = PublicConfigSchema.parse(await client.common.publicConfig({}));
  expect(config.posthog.apiKey).toBe(expectedPosthogApiKey);
}

async function assertOrpcWebSocket(httpBaseUrl: string) {
  const websocket = new WebSocket(httpToWsUrl(httpBaseUrl, "/api/orpc-ws"));
  const client: ContractRouterClient<typeof daemonV2Contract> = createORPCClient(
    new WebSocketRPCLink({ websocket }),
  );

  try {
    const body = await client.common.health({});
    expect(body.ok).toBe(true);
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
  await assertTypedClientHealth(httpBaseUrl);
  await assertPublicConfigOverride(httpBaseUrl);
  await assertOrpcWebSocket(httpBaseUrl);
  await assertTerminalWebSocket(httpBaseUrl);
}

async function waitForReady(httpBaseUrl: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL("/", httpBaseUrl), {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok && (await res.text()).includes("Daemon V2")) {
        return;
      }
      last = new Error(`GET / -> ${res.status}`);
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

async function stopServer(child: Result) {
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
      env: { ...process.env, ...env },
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
    await stopServer(child);
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
          ...process.env,
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
});
