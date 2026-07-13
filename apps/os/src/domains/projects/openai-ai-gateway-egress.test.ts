import { describe, expect, test } from "vitest";
import type { AppConfig } from "../../config.ts";
import {
  isOpenAiPublicApiRequest,
  openAiAiGatewayRoutingFromConfig,
  openAiAiGatewayUrl,
  rewriteOpenAiRequestToAiGateway,
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

describe("openAiAiGatewayUrl", () => {
  test("maps /v1/<rest> onto the OpenAI provider-native gateway path", () => {
    expect(
      openAiAiGatewayUrl({
        accountId: "acc",
        gatewayId: "default",
        openAiUrl: "https://api.openai.com/v1/chat/completions",
      }),
    ).toBe("https://gateway.ai.cloudflare.com/v1/acc/default/openai/chat/completions");

    expect(
      openAiAiGatewayUrl({
        accountId: "acc",
        gatewayId: "default",
        openAiUrl: "https://api.openai.com/v1/responses?foo=1",
      }),
    ).toBe("https://gateway.ai.cloudflare.com/v1/acc/default/openai/responses?foo=1");
  });

  test("handles bare /v1", () => {
    expect(
      openAiAiGatewayUrl({
        accountId: "acc",
        gatewayId: "gw",
        openAiUrl: "https://api.openai.com/v1",
      }),
    ).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/openai");
  });
});

describe("rewriteOpenAiRequestToAiGateway", () => {
  test("injects platform key, metadata, and skip-cache; drops host", async () => {
    const body = JSON.stringify({ model: "gpt-4.1-mini", messages: [] });
    const request = new Request("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: 'Bearer getSecret({ path: "/secrets/openai-api-key" })',
        "content-type": "application/json",
        host: "api.openai.com",
      },
      body,
    });

    const rewritten = rewriteOpenAiRequestToAiGateway({
      request,
      accountId: "acc-1",
      gatewayId: "default",
      openaiApiKey: "sk-platform",
      metadata: { projectId: "prj_abc", source: "project-egress", caller: "sandbox" },
      skipCache: true,
      cfAigAuthorization: "cf-token",
    });

    expect(rewritten.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc-1/default/openai/chat/completions",
    );
    expect(rewritten.headers.get("authorization")).toBe("Bearer sk-platform");
    expect(rewritten.headers.get("cf-aig-skip-cache")).toBe("true");
    expect(rewritten.headers.get("cf-aig-authorization")).toBe("Bearer cf-token");
    expect(rewritten.headers.get("host")).toBeNull();
    expect(JSON.parse(rewritten.headers.get("cf-aig-metadata")!)).toEqual({
      projectId: "prj_abc",
      source: "project-egress",
      caller: "sandbox",
    });
    expect(await rewritten.text()).toBe(body);
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

  test("maps config fields and skipCache from responseCacheTtlSeconds", () => {
    const base = {
      openAiApiKey: { exposeSecret: () => "sk-x" },
      cloudflareAiGateway: { id: "default" },
      cloudflare: {
        accountId: "acc",
        apiToken: { exposeSecret: () => "cfut_x" },
      },
    };

    expect(
      openAiAiGatewayRoutingFromConfig({
        ...base,
        cloudflareAiGateway: { id: "default" },
      } as unknown as AppConfig),
    ).toEqual({
      accountId: "acc",
      gatewayId: "default",
      openaiApiKey: "sk-x",
      cfAigAuthorization: "cfut_x",
      skipCache: true,
    });

    expect(
      openAiAiGatewayRoutingFromConfig({
        ...base,
        cloudflareAiGateway: { id: "e2e", responseCacheTtlSeconds: 600 },
      } as unknown as AppConfig),
    ).toMatchObject({ gatewayId: "e2e", skipCache: false });
  });
});
