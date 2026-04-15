import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { agentsContract } from "@iterate-com/agents-contract";
import { HttpResponse, http, useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { useCloudflareTunnelLease, useDevServer } from "@iterate-com/shared/test-helpers";
import { describe, expect, test } from "vitest";
import { requireSemaphoreE2eEnv } from "../test-support/require-semaphore-e2e-env.ts";

requireSemaphoreE2eEnv(process.env);

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

describe.sequential("agents external egress proxy", () => {
  test("routes a sample oRPC fetch through the configured proxy", async () => {
    const proxy = await useMockHttpServer({ onUnhandledRequest: "bypass" });

    try {
      let capturedRequestUrl: string | null = null;

      proxy.use(
        http.get("https://example.com/*", ({ request }) => {
          capturedRequestUrl = request.url;
          return HttpResponse.text("proxied example body");
        }),
      );

      await using tunnelLease = await useCloudflareTunnelLease({});
      await using devServer = await useDevServer({
        cwd: appRoot,
        command: "pnpm",
        args: ["dev"],
        port: tunnelLease.localPort,
        env: {
          ...stripInheritedAppConfig(process.env),
          APP_CONFIG_EXTERNAL_EGRESS_PROXY: proxy.url,
        },
      });

      const client = createAgentsClient(devServer.baseUrl);
      const result = await client.fetchExample({});
      const harEntries = proxy.getHar().log.entries;

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.body).toBe("proxied example body");
      expect(capturedRequestUrl).toBe("https://example.com/");
      expect(harEntries).toHaveLength(1);
      expect(harEntries[0]?.request.url).toBe("https://example.com/");
    } finally {
      await proxy.close();
    }
  });

  test("IterateAgent codemode script can fetch https://example.com/ via egress proxy", async () => {
    const proxy = await useMockHttpServer({ onUnhandledRequest: "bypass" });

    try {
      proxy.use(
        http.get("https://example.com/*", () =>
          HttpResponse.text("proxied example body from codemode"),
        ),
      );

      await using tunnelLease = await useCloudflareTunnelLease({});
      await using devServer = await useDevServer({
        cwd: appRoot,
        command: "pnpm",
        args: ["dev"],
        port: tunnelLease.localPort,
        env: {
          ...stripInheritedAppConfig(process.env),
          APP_CONFIG_EXTERNAL_EGRESS_PROXY: proxy.url,
        },
      });

      const instance = `fetch-smoke-${randomBytes(4).toString("hex")}`;
      const payload = await runIterateAgentCodemodeFetchSmoke({
        baseUrl: devServer.baseUrl,
        instanceName: instance,
      });

      expect(payload.error ?? "").toBe("");
      expect(payload.result).toMatchObject({
        status: 200,
        body: "proxied example body from codemode",
      });

      const harEntries = proxy.getHar().log.entries;
      expect(harEntries.some((e) => e.request.url.startsWith("https://example.com"))).toBe(true);
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

const CODEMODE_FETCH_EXAMPLE_SCRIPT = `
async () => {
  const r = await fetch("https://example.com/");
  return { status: r.status, body: await r.text() };
}
`.trim();

type CodemodeExecutePayload = {
  result?: { status?: number; body?: string };
  error?: string;
};

async function runIterateAgentCodemodeFetchSmoke(args: {
  baseUrl: string;
  instanceName: string;
  timeoutMs?: number;
}): Promise<CodemodeExecutePayload> {
  const timeoutMs = args.timeoutMs ?? 120_000;
  const wsUrl = new URL(args.baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = `/agents/iterate-agent/${args.instanceName}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl.toString());
    const deadline = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error(`IterateAgent codemode timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.addEventListener("open", () => {
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: "event",
            event: {
              type: "codemode-block-added",
              payload: { script: CODEMODE_FETCH_EXAMPLE_SCRIPT },
            },
          }),
        );
      }, 3_000);
    });

    ws.addEventListener("message", (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "type" in parsed &&
        (parsed as { type: string }).type === "append" &&
        "event" in parsed
      ) {
        const event = (parsed as { event: { type?: string; payload?: CodemodeExecutePayload } })
          .event;
        if (event.type === "codemode-result-added") {
          clearTimeout(deadline);
          try {
            ws.close();
          } catch {}
          resolve(event.payload ?? {});
        }
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(deadline);
      reject(new Error("WebSocket error connecting to IterateAgent"));
    });
  });
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
