import { describe, expect, it } from "vitest";
import {
  adaptMessagesForModel,
  cloudflareAiGatewayResponseCacheKey,
  maskCloudflareAiGatewayResponseCacheEntropy,
  runWorkersAiAttempt,
} from "./workers-ai-transport.ts";
const DEFAULT_AGENT_MODEL = "openai/gpt-5.6-terra"; // the config schema default

describe("adaptMessagesForModel", () => {
  const messages = [
    { role: "system" as const, content: "durable" },
    { role: "developer" as const, content: "application context" },
    { role: "user" as const, content: "hello" },
  ];

  it("preserves developer context for transports that support it", () => {
    expect(adaptMessagesForModel(messages, { supportsDeveloperRole: true })).toEqual(messages);
  });

  it("maps developer context to system for transports without that role", () => {
    expect(adaptMessagesForModel(messages, { supportsDeveloperRole: false })).toEqual([
      messages[0],
      { role: "system", content: "application context" },
      messages[2],
    ]);
  });
});

describe("runWorkersAiAttempt", () => {
  it("maps developer context to system on the unified Workers AI lane", async () => {
    let requestBody: unknown;

    await runWorkersAiAttempt({
      ai: {
        run: async (_model, body) => {
          requestBody = body;
          return { response: "ok" };
        },
      },
      deadlineMs: 1_000,
      messages: [{ role: "developer", content: "trusted application context" }],
      model: "openai/gpt-5.6-sol",
      onChunk: async () => {},
      transport: { kind: "unified" },
    });

    expect(requestBody).toMatchObject({
      messages: [{ role: "system", content: "trusted application context" }],
    });
  });

  it("cancels the response stream on deadline so no chunk lands after the failure", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":"hel"}\n\n'));
        // …and never closes: a wedged upstream mid-stream.
      },
      cancel() {
        cancelled = true;
      },
    });
    const chunks: unknown[] = [];

    await expect(
      runWorkersAiAttempt({
        ai: { run: async () => body },
        deadlineMs: 50,
        messages: [{ role: "user", content: "hi" }],
        model: "test-model",
        onChunk: async (chunk) => {
          chunks.push(chunk);
        },
      }),
    ).rejects.toThrow(/timed out/);

    // The reader was cancelled BEFORE the error settled the attempt: the
    // source stops producing, so nothing can journal a chunk after the
    // caller records the timeout failure.
    expect(cancelled).toBe(true);
    expect(chunks).toEqual([{ response: "hel" }]);
  });

  it("applies the attempt deadline while a chunk callback is in flight", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":"hel"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      runWorkersAiAttempt({
        ai: { run: async () => body },
        deadlineMs: 50,
        messages: [{ role: "user", content: "hi" }],
        model: "test-model",
        onChunk: () => new Promise(() => {}),
      }),
    ).rejects.toThrow(/timed out/);

    expect(cancelled).toBe(true);
  });

  it("caps the dial itself, not just the drain", async () => {
    await expect(
      runWorkersAiAttempt({
        ai: { run: () => new Promise(() => {}) },
        deadlineMs: 50,
        messages: [{ role: "user", content: "hi" }],
        model: "test-model",
        onChunk: async () => {},
      }),
    ).rejects.toThrow(/timed out/);
  });

  it("pins medium reasoning effort (plus streamed usage) for OpenAI reasoning models only", async () => {
    const bodies: Record<string, unknown>[] = [];
    const ai = {
      run: async (_model: string, body: unknown) => {
        bodies.push(body as Record<string, unknown>);
        return { response: "ok" };
      },
    };
    for (const model of [DEFAULT_AGENT_MODEL, "@cf/test/non-openai-model"]) {
      await runWorkersAiAttempt({
        ai,
        deadlineMs: 1_000,
        messages: [{ role: "user", content: "hi" }],
        model,
        onChunk: async () => {},
      });
    }
    expect(bodies[0]).toMatchObject({
      reasoning_effort: "medium",
      stream_options: { include_usage: true },
    });
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
    expect(bodies[1]).not.toHaveProperty("stream_options");
  });

  it("drains OpenAI chat-completion chunks: delta text, empty final delta, usage-only chunk", async () => {
    // The gpt-5.5 SSE shape on Workers AI: chat.completion.chunk frames with
    // choices[].delta.content, a finish_reason frame with an empty delta, and
    // (with include_usage) a trailing usage frame whose choices array is EMPTY.
    const encoder = new TextEncoder();
    const frames = [
      { choices: [{ delta: { content: "hel", role: "assistant" }, index: 0 }] },
      { choices: [{ delta: { content: "lo" }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const completion = await runWorkersAiAttempt({
      ai: { run: async () => body },
      deadlineMs: 1_000,
      messages: [{ role: "user", content: "hi" }],
      model: DEFAULT_AGENT_MODEL,
      onChunk: async () => {},
    });

    expect(completion.text).toBe("hello");
    expect(completion.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
    });
  });
});

describe("the BYOK gateway lane", () => {
  const encoder = new TextEncoder();
  const sseBody = (frames: unknown[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  const okFrames = [
    { choices: [{ delta: { content: "OK", role: "assistant" }, index: 0 }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
  ];
  type GatewayRequest = {
    provider: string;
    endpoint: string;
    headers: Record<string, string>;
    query: unknown;
  };
  const byokAi = (response: () => Response) => {
    const requests: GatewayRequest[] = [];
    const gatewayIds: string[] = [];
    return {
      requests,
      gatewayIds,
      ai: {
        run: async () => {
          throw new Error("unified lane must not be dialed");
        },
        gateway: (gatewayId: string) => {
          gatewayIds.push(gatewayId);
          return {
            run: async (data: GatewayRequest) => {
              requests.push(data);
              return response();
            },
          };
        },
      },
    };
  };

  it("dials the universal endpoint with our key, strips the model prefix, and pins the prompt cache key", async () => {
    const fake = byokAi(
      () => new Response(sseBody(okFrames), { headers: { "cf-aig-cache-status": "MISS" } }),
    );
    const completion = await runWorkersAiAttempt({
      ai: fake.ai,
      deadlineMs: 1_000,
      messages: [
        { role: "developer", content: "trusted application context" },
        { role: "user", content: "hi" },
      ],
      model: DEFAULT_AGENT_MODEL,
      onChunk: async () => {},
      transport: {
        kind: "byok",
        gatewayId: "default",
        openaiApiKey: "sk-test",
        openaiPromptCacheKey: "prj_1:/agents/onboarding",
        responseCacheTtlSeconds: 600,
      },
    });

    expect(fake.gatewayIds).toEqual(["default"]);
    const request = fake.requests[0]!;
    expect(request.provider).toBe("openai");
    expect(request.endpoint).toBe("chat/completions");
    expect(request.headers.authorization).toBe("Bearer sk-test");
    expect(request.headers["cf-aig-collect-log"]).toBe("true");
    expect(request.headers["cf-aig-collect-log-payload"]).toBe("true");
    expect(request.headers["cf-aig-cache-ttl"]).toBe("600");
    expect(request.headers["cf-aig-cache-key"]).toMatch(/^[0-9a-f]{64}$/);
    expect(request.query).toMatchObject({
      model: "gpt-5.6-terra",
      messages: [
        { role: "developer", content: "trusted application context" },
        { role: "user", content: "hi" },
      ],
      prompt_cache_key: "prj_1:/agents/onboarding",
      reasoning_effort: "medium",
      stream: true,
    });
    expect(completion.text).toBe("OK");
    expect(completion.rawResponse).toMatchObject({
      cloudflareAiGatewayResponseCacheStatus: "MISS",
    });
  });

  it("sends no cache headers when the response cache is not opted into", async () => {
    const fake = byokAi(() => new Response(sseBody(okFrames)));
    const completion = await runWorkersAiAttempt({
      ai: fake.ai,
      deadlineMs: 1_000,
      messages: [{ role: "user", content: "hi" }],
      model: DEFAULT_AGENT_MODEL,
      onChunk: async () => {},
      transport: { kind: "byok", gatewayId: "default", openaiApiKey: "sk-test" },
    });
    const request = fake.requests[0]!;
    expect(request.headers).not.toHaveProperty("cf-aig-cache-ttl");
    expect(request.headers).not.toHaveProperty("cf-aig-cache-key");
    // ...and the gateway's dashboard-level cache default is explicitly
    // opted out of: no-TTL deployments must never serve a cached reply.
    expect(request.headers["cf-aig-skip-cache"]).toBe("true");
    // No header on the response either -> no cache-status claim in evidence.
    expect(completion.rawResponse).not.toHaveProperty("cloudflareAiGatewayResponseCacheStatus");
  });

  it("never caches file-bearing turns even when the deployment enables response caching", async () => {
    const fake = byokAi(() => new Response(sseBody(okFrames)));
    await runWorkersAiAttempt({
      ai: fake.ai,
      deadlineMs: 1_000,
      messages: [
        {
          role: "user",
          content:
            "[Attached file: report.pdf; public url: https://iterate-files--demo.iterate.app/report.pdf?exp=1&ver=v1&sig=x]",
          containsFiles: true,
        },
      ],
      model: DEFAULT_AGENT_MODEL,
      onChunk: async () => {},
      transport: {
        kind: "byok",
        gatewayId: "default",
        openaiApiKey: "sk-test",
        responseCacheTtlSeconds: 600,
      },
    });

    const request = fake.requests[0]!;
    expect(request.endpoint).toBe("chat/completions");
    expect(request.headers["cf-aig-collect-log"]).toBe("true");
    expect(request.headers["cf-aig-collect-log-payload"]).toBe("true");
    expect(request.headers["cf-aig-skip-cache"]).toBe("true");
    expect(request.headers).not.toHaveProperty("cf-aig-cache-ttl");
    expect(request.headers).not.toHaveProperty("cf-aig-cache-key");
    expect(JSON.stringify(request.query)).toContain("iterate-files--demo.iterate.app");
  });

  it("falls back to unified billing for non-OpenAI models", async () => {
    let unifiedDialed = false;
    const completion = await runWorkersAiAttempt({
      ai: {
        run: async () => {
          unifiedDialed = true;
          return { response: "OK" };
        },
        gateway: () => {
          throw new Error("gateway must not be dialed for non-OpenAI models");
        },
      },
      deadlineMs: 1_000,
      messages: [{ role: "user", content: "hi" }],
      model: "@cf/test/non-openai-model",
      onChunk: async () => {},
      transport: { kind: "byok", gatewayId: "default", openaiApiKey: "sk-test" },
    });
    expect(unifiedDialed).toBe(true);
    expect(completion.text).toBe("OK");
  });

  it("fails the attempt loudly on a non-2xx gateway response", async () => {
    const fake = byokAi(() => new Response('{"error":"nope"}', { status: 401 }));
    await expect(
      runWorkersAiAttempt({
        ai: fake.ai,
        deadlineMs: 1_000,
        messages: [{ role: "user", content: "hi" }],
        model: "openai/gpt-5.5",
        onChunk: async () => {},
        transport: { kind: "byok", gatewayId: "default", openaiApiKey: "sk-test" },
      }),
    ).rejects.toThrow(/status 401/);
  });
});

describe("cloudflareAiGatewayResponseCacheKey", () => {
  it("masks minted identity so two fixtures' identical conversations share a key", async () => {
    const bodyFor = (projectId: string, agentPath: string) => ({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "You are the onboarding agent." },
        {
          role: "user",
          content: `<project-context projectId="${projectId}" agentPath="${agentPath}" />\nStart onboarding now`,
        },
      ],
      prompt_cache_key: `${projectId}:${agentPath}`,
      stream: true,
    });
    const keyA = await cloudflareAiGatewayResponseCacheKey(
      bodyFor("prj_0123456789abcdef0123456789abcdef", "/agents/onboarding"),
    );
    const keyB = await cloudflareAiGatewayResponseCacheKey(
      bodyFor("prj_fedcba9876543210fedcba9876543210", "/agents/onboarding"),
    );
    expect(keyA).toBe(keyB);
  });

  it("keeps semantically different requests apart", async () => {
    const bodyFor = (content: string) => ({
      model: "gpt-5.5",
      messages: [{ role: "user", content }],
      stream: true,
    });
    const keyA = await cloudflareAiGatewayResponseCacheKey(bodyFor("What is 2+2?"));
    const keyB = await cloudflareAiGatewayResponseCacheKey(bodyFor("What is 3+3?"));
    expect(keyA).not.toBe(keyB);
  });

  it("masks signed-URL signatures and expiries but keeps the file identity", () => {
    const masked = maskCloudflareAiGatewayResponseCacheEntropy(
      JSON.stringify({
        content:
          "file: https://iterate-files--demo.iterate-preview-4.app/files/report.pdf?exp=1760000000&sig=deadbeef123",
      }),
    );
    expect(masked).toContain("/files/report.pdf");
    expect(masked).toContain("exp=MASKED");
    expect(masked).toContain("sig=MASKED");
    expect(masked).not.toContain("deadbeef123");
  });

  it("masks the clock stamp and the boot-context project line — birth turns share a key across projects", () => {
    // Two projects' onboarding births differ ONLY in per-project boot facts
    // and the per-request clock; the response cache must see them as equal
    // (the preview-burn protection from the response-cache work).
    const bodyFor = (name: string, slug: string, at: string) =>
      JSON.stringify({
        messages: [
          { role: "system", content: "You are an agent." },
          {
            role: "user",
            content: `Platform context for this agent:\n- Project: "${name}" (slug ${slug}, id prj_${"0".repeat(32)}) — the project worker/website serves https://${slug}.iterate-preview-4.app\n- Your agent stream path: /agents/onboarding`,
          },
          { role: "system", content: `Current date and time (UTC): ${at}` },
        ],
      });
    const maskedA = maskCloudflareAiGatewayResponseCacheEntropy(
      bodyFor("Snake Game", "snake", "2026-07-11T10:00:00.000Z"),
    );
    const maskedB = maskCloudflareAiGatewayResponseCacheEntropy(
      bodyFor("Crossword Helper", "crossword", "2026-07-12T18:30:00.000Z"),
    );
    expect(maskedA).toBe(maskedB);
    expect(maskedA).toContain("Current date and time (UTC): MASKED");
    expect(maskedA).toContain("- Project: MASKED");
    expect(maskedA).not.toContain("snake");
  });
});
