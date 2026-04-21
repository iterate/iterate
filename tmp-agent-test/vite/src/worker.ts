import { z } from "zod";

const PROMPT = "What is AI Gateway? Answer in one sentence.";
const SYSTEM = "You are a friendly assistant";

const gatewayOptions = {
  gateway: { id: "default" },
  metadata: { teamId: "AI", userId: 12345 },
} as never;

const GatewayMetadata = z.object({ keySource: z.string().optional() }).optional();

const OpenAIChatCompletion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
  gatewayMetadata: GatewayMetadata,
});

const AnthropicMessage = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
    })
    .optional(),
  gatewayMetadata: GatewayMetadata,
});

type Normalized = {
  text: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  keySource?: string;
};

async function timed<T>(label: string, fn: () => Promise<T>) {
  const started = Date.now();
  try {
    const value = await fn();
    return { label, ok: true as const, elapsedMs: Date.now() - started, value };
  } catch (error) {
    return {
      label,
      ok: false as const,
      elapsedMs: Date.now() - started,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

async function runOpenAIStyle(env: Env, model: string): Promise<Normalized> {
  const raw = await env.AI.run(
    model as never,
    {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: PROMPT },
      ],
    } as never,
    gatewayOptions,
  );
  const res = OpenAIChatCompletion.parse(raw);
  return {
    text: res.choices[0].message.content,
    usage: res.usage && {
      inputTokens: res.usage.prompt_tokens,
      outputTokens: res.usage.completion_tokens,
      totalTokens: res.usage.total_tokens,
    },
    keySource: res.gatewayMetadata?.keySource,
  };
}

async function runAnthropicStyle(env: Env, model: string): Promise<Normalized> {
  const raw = await env.AI.run(
    model as never,
    {
      system: SYSTEM,
      messages: [{ role: "user", content: PROMPT }],
      max_tokens: 1024,
    } as never,
    gatewayOptions,
  );
  const res = AnthropicMessage.parse(raw);
  return {
    text: res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(""),
    usage: res.usage && {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      totalTokens: res.usage.input_tokens + res.usage.output_tokens,
    },
    keySource: res.gatewayMetadata?.keySource,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/llm") return new Response("not found", { status: 404 });

    const [kimi, claude, gpt] = await Promise.all([
      timed("kimi-k2.6", () => runOpenAIStyle(env, "@cf/moonshotai/kimi-k2.6")),
      timed("claude-opus-4.7", () => runAnthropicStyle(env, "anthropic/claude-opus-4.7")),
      timed("gpt-5.4", () => runOpenAIStyle(env, "openai/gpt-5.4")),
    ]);

    return Response.json({ kimi, claude, gpt });
  },
} satisfies ExportedHandler<Env>;
