import { describe, expect, test } from "vitest";
import type { AppConfig } from "../../config.ts";
import {
  applyOpenAiAiGatewayCacheHeaders,
  isOpenAiPublicApiRequest,
  openAiAiGatewayBindingHeaders,
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

describe("openAiAiGatewayBindingHeaders", () => {
  test("injects platform key, collect-log, metadata; forwards OpenAI-* and Accept", () => {
    const headers = openAiAiGatewayBindingHeaders({
      openaiApiKey: "sk-platform",
      projectId: "proj_test",
      requestHeaders: new Headers({
        authorization: "Bearer dummy-from-sandbox",
        "content-type": "application/json",
        "openai-beta": "responses=v1",
        "OpenAI-Organization": "org-xyz",
        accept: "text/event-stream",
        "x-iterate-sandbox": "sbx-1",
        "x-custom-noise": "drop-me",
      }),
    });
    expect(headers.authorization).toBe("Bearer sk-platform");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["cf-aig-collect-log"]).toBe("true");
    expect(headers["cf-aig-collect-log-payload"]).toBe("true");
    expect(JSON.parse(headers["cf-aig-metadata"]!)).toEqual({
      projectId: "proj_test",
      source: "project-egress",
      caller: "sbx-1",
    });
    expect(headers["openai-beta"]).toBe("responses=v1");
    expect(headers["openai-organization"]).toBe("org-xyz");
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["x-custom-noise"]).toBeUndefined();
    expect(headers["x-iterate-sandbox"]).toBeUndefined();
  });

  test("replaces caller authorization even when it looks like a real key", () => {
    const headers = openAiAiGatewayBindingHeaders({
      openaiApiKey: "sk-platform",
      projectId: "proj_test",
      requestHeaders: new Headers({
        authorization: "Bearer sk-customer-real",
      }),
    });
    expect(headers.authorization).toBe("Bearer sk-platform");
    expect(JSON.parse(headers["cf-aig-metadata"]!)).toEqual({
      projectId: "proj_test",
      source: "project-egress",
    });
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
