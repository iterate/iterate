import { describe, expect, test } from "vitest";
import type { AppConfig } from "../../config.ts";
import {
  applyOpenAiAiGatewayCacheHeaders,
  isOpenAiPublicApiRequest,
  openAiAiGatewayRoutingFromConfig,
  openAiGatewayBindingEndpoint,
} from "./openai-ai-gateway-egress.ts";

describe("isOpenAiPublicApiRequest", () => {
  test("matches api.openai.com only", () => {
    expect(isOpenAiPublicApiRequest(new Request("https://api.openai.com/v1/models"))).toBe(true);
    expect(
      isOpenAiPublicApiRequest(
        new Request("https://gateway.ai.cloudflare.com/v1/x/y/openai/models"),
      ),
    ).toBe(false);
    expect(isOpenAiPublicApiRequest(new Request("https://example.com/v1/models"))).toBe(false);
  });
});

describe("openAiGatewayBindingEndpoint", () => {
  test("includes path after /v1 and query string", () => {
    expect(openAiGatewayBindingEndpoint("https://api.openai.com/v1/chat/completions")).toBe(
      "chat/completions",
    );
    expect(openAiGatewayBindingEndpoint("https://api.openai.com/v1/responses?foo=1")).toBe(
      "responses?foo=1",
    );
  });
});

describe("applyOpenAiAiGatewayCacheHeaders", () => {
  test("sets skip-cache when no TTL", async () => {
    const headers: Record<string, string> = {};
    await applyOpenAiAiGatewayCacheHeaders({ headers, body: { model: "x" } });
    expect(headers["cf-aig-skip-cache"]).toBe("true");
    expect(headers["cf-aig-cache-ttl"]).toBeUndefined();
  });

  test("sets cache-ttl and cache-key when TTL is set", async () => {
    const headers: Record<string, string> = {};
    await applyOpenAiAiGatewayCacheHeaders({
      headers,
      body: { model: "gpt-4.1-mini" },
      responseCacheTtlSeconds: 600,
    });
    expect(headers["cf-aig-cache-ttl"]).toBe("600");
    expect(headers["cf-aig-cache-key"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["cf-aig-skip-cache"]).toBeUndefined();
  });
});

describe("openAiAiGatewayRoutingFromConfig", () => {
  test("returns null without accountId", () => {
    const config = {
      openAiApiKey: { exposeSecret: () => "sk" },
      cloudflareAiGateway: { id: "default" },
      cloudflare: {},
    } as unknown as AppConfig;
    expect(openAiAiGatewayRoutingFromConfig(config)).toBeNull();
  });

  test("maps gateway id, platform key, and optional cache TTL", () => {
    expect(
      openAiAiGatewayRoutingFromConfig({
        openAiApiKey: { exposeSecret: () => "sk-x" },
        cloudflareAiGateway: { id: "default" },
        cloudflare: { accountId: "acc" },
      } as unknown as AppConfig),
    ).toEqual({
      gatewayId: "default",
      openaiApiKey: "sk-x",
    });

    expect(
      openAiAiGatewayRoutingFromConfig({
        openAiApiKey: { exposeSecret: () => "sk-x" },
        cloudflareAiGateway: { id: "e2e", responseCacheTtlSeconds: 600 },
        cloudflare: { accountId: "acc" },
      } as unknown as AppConfig),
    ).toEqual({
      gatewayId: "e2e",
      openaiApiKey: "sk-x",
      responseCacheTtlSeconds: 600,
    });
  });
});
