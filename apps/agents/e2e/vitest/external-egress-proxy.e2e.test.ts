import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { agentsContract } from "@iterate-com/agents-contract";
import { HttpResponse, http, useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { describe, expect, test } from "vitest";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const describeExternalEgressProxy = process.env.CI ? describe.skip : describe.sequential;

describeExternalEgressProxy("agents external egress proxy", () => {
  test("routes a sample oRPC fetch through the configured proxy", async () => {
    const proxy = await useMockHttpServer();

    try {
      let capturedRequestUrl: string | null = null;

      proxy.use(
        http.get("https://example.com/", ({ request }) => {
          capturedRequestUrl = request.url;
          return HttpResponse.text("proxied example body");
        }),
      );

      await withAgentsDevServer(
        {
          APP_CONFIG_EXTERNAL_EGRESS_PROXY: proxy.url,
        },
        async (baseUrl) => {
          const client = createAgentsClient(baseUrl);
          const result = await client.fetchExample({});
          const harEntries = proxy.getHar().log.entries;

          expect(result.ok).toBe(true);
          expect(result.status).toBe(200);
          expect(result.body).toBe("proxied example body");
          expect(capturedRequestUrl).toBe("https://example.com/");
          expect(harEntries).toHaveLength(1);
          expect(harEntries[0]?.request.url).toBe("https://example.com/");
        },
      );
    } finally {
      await proxy.close();
    }
  });
});

function createAgentsClient(baseUrl: string): ContractRouterClient<typeof agentsContract> {
  return createORPCClient(
    new OpenAPILink(agentsContract, {
      url: new URL("/api", baseUrl).toString(),
    }),
  );
}

async function withAgentsDevServer(
  env: Record<string, string>,
  run: (baseUrl: string) => Promise<void>,
) {
  const child = spawn("pnpm", ["dev"], {
    cwd: appRoot,
    env: {
      ...stripInheritedAppConfig(process.env),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output: Buffer[] = [];
  child.stdout?.on("data", (data: Buffer) => {
    output.push(Buffer.from(data));
  });
  child.stderr?.on("data", (data: Buffer) => {
    output.push(Buffer.from(data));
  });

  try {
    const baseUrl = await waitForReady(output);
    await run(baseUrl);
  } catch (error) {
    const logs = Buffer.concat(output).toString("utf8");
    throw new Error(`${String(error)}\n--- agents dev log ---\n${logs}`);
  } finally {
    await stopChild(child);
  }
}

async function waitForReady(output: Buffer[], timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const baseUrl = parseWorkersDevUrl(Buffer.concat(output).toString("utf8"));
      if (!baseUrl) {
        throw new Error("Waiting for agents dev server URL...");
      }

      const response = await fetch(new URL("/api/openapi.json", baseUrl), {
        signal: AbortSignal.timeout(2_000),
      });

      if (response.ok) {
        const openApi = (await response.json()) as { paths?: Record<string, unknown> };
        if ((openApi.paths ?? {})["/fetch-example"]) {
          return baseUrl;
        }
      }

      lastError = new Error(`GET /api/openapi.json -> ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await delay(300);
  }

  throw lastError;
}

function parseWorkersDevUrl(output: string) {
  const workersDevUrl =
    output.match(/workersDevUrl:\s*'([^']+)'/)?.[1] ??
    output.match(/workersDevUrl:\s*"([^"]+)"/)?.[1] ??
    output.match(/url:\s*'([^']+)'/)?.[1] ??
    output.match(/url:\s*"([^"]+)"/)?.[1];

  return workersDevUrl?.replace(/\/+$/, "");
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(3_000).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}

function stripInheritedAppConfig(env: NodeJS.ProcessEnv) {
  const next = { ...env };

  for (const key of Object.keys(next)) {
    if (key === "APP_CONFIG" || key.startsWith("APP_CONFIG_")) {
      delete next[key];
    }
  }

  return next;
}
