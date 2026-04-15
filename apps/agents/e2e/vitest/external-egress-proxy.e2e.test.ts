import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { agentsContract } from "@iterate-com/agents-contract";
import { useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { HttpResponse, http } from "msw";
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

      const port = await getAvailablePort();
      const baseUrl = `http://127.0.0.1:${port}`;

      await withAgentsDevServer(
        {
          HOST: "127.0.0.1",
          PORT: String(port),
          APP_CONFIG_EXTERNAL_EGRESS_PROXY: proxy.url,
        },
        baseUrl,
        async () => {
          const client = createAgentsClient(baseUrl);
          const result = await client.fetchExample({});
          const harEntries = proxy.getHar().log.entries;

          expect(result).toEqual({
            ok: true,
            status: 200,
            url: "https://example.com/",
            body: "proxied example body",
          });
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
  baseUrl: string,
  run: () => Promise<void>,
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
    await waitForReady(baseUrl);
    await run();
  } catch (error) {
    const logs = Buffer.concat(output).toString("utf8");
    throw new Error(`${String(error)}\n--- agents dev log ---\n${logs}`);
  } finally {
    await stopChild(child);
  }
}

async function waitForReady(baseUrl: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/api/openapi.json", baseUrl), {
        signal: AbortSignal.timeout(2_000),
      });

      if (response.ok) {
        const openApi = (await response.json()) as { paths?: Record<string, unknown> };
        if ((openApi.paths ?? {})["/fetch-example"]) {
          return;
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

async function stopChild(child: ReturnType<typeof spawn>) {
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

async function getAvailablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address == null || typeof address === "string") {
    server.close();
    throw new Error("Failed to allocate a local port for the agents e2e test.");
  }

  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  return port;
}
