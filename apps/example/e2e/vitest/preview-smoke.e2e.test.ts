import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { exampleContract } from "@iterate-com/example-contract";
import { extractPublicConfigSchema } from "@iterate-com/shared/apps/config";
import { describe, expect, test } from "vitest";
import { AppConfig } from "../../src/app.ts";

const baseURL = requireExampleBaseUrl();
const PublicConfigSchema = extractPublicConfigSchema(AppConfig);
const client: ContractRouterClient<typeof exampleContract> = createORPCClient(
  new OpenAPILink(exampleContract, {
    url: new URL("/api", baseURL).toString(),
  }),
);

describe("example preview smoke", () => {
  test("debug page responds with SSR html", async () => {
    const response = await fetch(new URL("/debug", baseURL), {
      signal: AbortSignal.timeout(3_000),
    });

    expect(response.ok).toBe(true);
    expect(await response.text()).toContain("Runtime deps demo");
  });

  test("ping and public config are reachable", async () => {
    const ping = await client.ping({});
    expect(ping.message).toBe("pong");

    const config = PublicConfigSchema.parse(await client.common.publicConfig({}));
    expect(config.posthog.apiKey).toEqual(expect.any(String));
  });

  test("openapi docs are reachable", async () => {
    const response = await fetch(new URL("/api/openapi.json", baseURL), {
      signal: AbortSignal.timeout(3_000),
    });

    expect(response.ok).toBe(true);

    const body = (await response.json()) as {
      paths?: Record<string, unknown>;
    };
    expect(body.paths).toHaveProperty("/ping");
  });
});

function requireExampleBaseUrl() {
  const value = process.env.EXAMPLE_BASE_URL?.trim();
  if (!value) {
    throw new Error(
      "EXAMPLE_BASE_URL is required for example network e2e tests. Start or deploy the worker outside the test runner, then run the suite with EXAMPLE_BASE_URL=https://... .",
    );
  }

  return value.replace(/\/+$/, "");
}
