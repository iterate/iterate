interface Env {
  AI: Ai;
}

const PROMPT = "What is AI Gateway? Answer in one sentence.";
const SYSTEM = "You are a friendly assistant";

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

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const gatewayOptions = {
      gateway: { id: "default" },
      metadata: { teamId: "AI", userId: 12345 },
    } as never;

    const [kimi, claude, gpt] = await Promise.all([
      timed("kimi-k2.6", () =>
        env.AI.run(
          "@cf/moonshotai/kimi-k2.6" as never,
          {
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: PROMPT },
            ],
          },
          gatewayOptions,
        ),
      ),
      timed("claude-opus-4.7", () =>
        env.AI.run(
          "anthropic/claude-opus-4.7" as never,
          {
            system: SYSTEM,
            messages: [{ role: "user", content: PROMPT }],
            max_tokens: 1024,
          } as never,
          gatewayOptions,
        ),
      ),
      timed("gpt-5.4", () =>
        env.AI.run(
          "openai/gpt-5.4" as never,
          {
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: PROMPT },
            ],
          } as never,
          gatewayOptions,
        ),
      ),
    ]);

    return Response.json({ kimi, claude, gpt });
  },
};
