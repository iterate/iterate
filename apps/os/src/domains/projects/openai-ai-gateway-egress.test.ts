import { describe, expect, test } from "vitest";
import type { AppConfig } from "../../config.ts";
import {
  openAiCredentialOwner,
  routeCompanyOpenAi,
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
      metadata: {
        environment: "test",
        projectId: "proj_test",
        projectSlug: "test",
        streamPath: undefined,
        eventOffset: undefined,
      },
      requestHeaders: new Headers({
        authorization: "Bearer dummy-from-sandbox",
        "content-type": "application/json",
        "openai-beta": "responses=v1",
        "OpenAI-Organization": "org-xyz",
        accept: "text/event-stream",
        "x-iterate-sandbox": "sbx-1",
        "cf-aig-metadata": JSON.stringify({ projectId: "forged", eventOffset: 123 }),
        "x-custom-noise": "drop-me",
      }),
    });
    expect(headers.authorization).toBe("Bearer sk-platform");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["cf-aig-collect-log"]).toBe("true");
    expect(headers["cf-aig-collect-log-payload"]).toBe("true");
    expect(JSON.parse(headers["cf-aig-metadata"]!)).toEqual({
      projectId: "proj_test",
      environment: "test",
      projectSlug: "test",
    });
    expect(headers["openai-beta"]).toBe("responses=v1");
    expect(headers["openai-organization"]).toBe("org-xyz");
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["x-custom-noise"]).toBeUndefined();
    expect(headers["x-iterate-sandbox"]).toBeUndefined();
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

test("credential ownership preserves customer keys and recognizes company key copies", () => {
  const owner = (headers: Record<string, string>) =>
    openAiCredentialOwner(
      new Request("https://api.openai.com/v1/responses", { headers }),
      "sk-company",
    );
  expect(owner({ authorization: "Bearer sk-customer" })).toBe("customer");
  expect(owner({ authorization: "Bearer sk-company" })).toBe("iterate");
  expect(owner({ authorization: "Bearer iterate-platform" })).toBe("iterate");
  expect(owner({ "sec-websocket-protocol": "realtime,openai-insecure-api-key.sk-company" })).toBe(
    "iterate",
  );
  expect(owner({})).toBe("iterate");
});

test("the shared company route streams in its caller and replaces forged billing metadata", async () => {
  const calls: unknown[] = [];
  const response = await routeCompanyOpenAi({
    request: new Request("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-company", "cf-aig-metadata": '{"projectId":"forged"}' },
      body: JSON.stringify({
        model: "gpt-4.1-nano",
        stream: true,
        stream_options: { include_usage: false },
      }),
    }),
    config: {
      openAiApiKey: { exposeSecret: () => "sk-company" },
      cloudflareAiGateway: { id: "default", includeEventOffset: true },
      cloudflare: { accountId: "account" },
    } as any,
    ai: {
      gateway(id: string) {
        expect(id).toBe("default");
        return {
          run(input: unknown) {
            calls.push(input);
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("data: first\n\n"));
                  controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                  controller.close();
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        };
      },
    } as any,
    readIdentity: async () => ({
      environment: "preview_9",
      projectId: "prj_host",
      projectSlug: "host",
    }),
    streamContext: {
      kind: "script-execution",
      streamPath: "/agents/a",
      scriptRunRequestedEventOffset: 0,
      executionId: "execution",
    },
  });
  expect(await response!.text()).toBe("data: first\n\ndata: [DONE]\n\n");
  expect(calls).toMatchObject([
    {
      provider: "openai",
      endpoint: "chat/completions",
      headers: {
        authorization: "Bearer sk-company",
        "cf-aig-metadata": JSON.stringify({
          environment: "preview_9",
          projectId: "prj_host",
          projectSlug: "host",
          streamPath: "/agents/a",
          eventOffset: 0,
        }),
      },
      query: { model: "gpt-4.1-nano", stream: true, stream_options: { include_usage: true } },
    },
  ]);
});
