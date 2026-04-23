import { fileURLToPath } from "node:url";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { agentsContract } from "@iterate-com/agents-contract";
import { HttpResponse, http, useMockHttpServer } from "@iterate-com/mock-http-proxy";
import { useCloudflareTunnelLease, useDevServer } from "@iterate-com/shared/test-helpers";
import { expect, test } from "vitest";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

test(
  "routes a sample oRPC fetch through the configured proxy",
  { tags: ["local-dev-server", "mocked-internet"] },
  async () => {
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
        args: ["exec", "tsx", "./alchemy.run.ts"],
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
  },
);

function createAgentsClient(baseUrl: string): ContractRouterClient<typeof agentsContract> {
  return createORPCClient(
    new OpenAPILink(agentsContract, {
      url: new URL("/api", baseUrl).toString(),
    }),
  );
}

function stripInheritedAppConfig(env: NodeJS.ProcessEnv): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "APP_CONFIG" || key.startsWith("APP_CONFIG_")) continue;
    if (value != null) next[key] = value;
  }
  return next;
}
