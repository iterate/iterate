import { describe, expect, test } from "vitest";
import {
  routeOpenAiViaGateway,
  isOpenAiPublicApiRequest,
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

test("the shared company route streams in its caller and replaces forged billing metadata", async () => {
  const calls: unknown[] = [];
  const response = await routeOpenAiViaGateway({
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
    consultInterceptor: undefined,
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
