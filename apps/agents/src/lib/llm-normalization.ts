import { match } from "schematch";
import { z } from "zod";

/**
 * Tiny bridge for the gap in Cloudflare's `env.AI.run()` binding: it routes
 * `anthropic/*` models to Anthropic's native API unchanged, so an OpenAI-shaped
 * request body gets rejected (needs top-level `system`, requires `max_tokens`,
 * forbids `role: "system"` messages). The AI Gateway's `/compat/chat/completions`
 * HTTP endpoint would normalize this for us, but it's not reachable through the
 * binding's implicit auth — it needs a CF API token. So we convert here instead.
 *
 * Callers always pass OpenAI chat-completions shape. The helpers rewrite when
 * the model is Anthropic and pass through otherwise. Both throw on invalid
 * input.
 */

const OpenAIMessage = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

export const OpenAIChatRequest = z.object({
  messages: z.array(OpenAIMessage).min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
});
export type OpenAIChatRequest = z.infer<typeof OpenAIChatRequest>;

const OpenAIChatCompletion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

const AnthropicMessage = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).min(1),
});

/**
 * Native Workers AI chat shape returned by `@cf/*` text-generation models when
 * the request is the non-OpenAI `{ messages }` form. `response` is the
 * assistant string; `usage` and `tool_calls` are sibling fields we ignore here.
 */
const WorkersAIChatResponse = z.object({
  response: z.string(),
});

const isAnthropicModel = (model: string) => model.startsWith("anthropic/");

/**
 * Takes an OpenAI chat-completions body and returns a body ready for
 * `env.AI.run(model, …)`: unchanged for OpenAI-compatible providers, rewritten
 * to Anthropic's native shape for `anthropic/*` models.
 */
export function normalizeLlmRequest({
  model,
  request,
}: {
  model: string;
  request: OpenAIChatRequest;
}): Record<string, unknown> {
  const parsed = OpenAIChatRequest.parse(request);
  if (!isAnthropicModel(model)) return parsed;

  const systemMessage = parsed.messages.find((m) => m.role === "system");
  const nonSystem = parsed.messages.filter((m) => m.role !== "system");
  return {
    ...(systemMessage && { system: systemMessage.content }),
    messages: nonSystem,
    max_tokens: parsed.max_tokens ?? 1024,
    ...(parsed.temperature !== undefined && { temperature: parsed.temperature }),
    ...(parsed.top_p !== undefined && { top_p: parsed.top_p }),
  };
}

/**
 * Extracts the assistant text from a raw `env.AI.run()` response. Accepts both
 * the OpenAI chat-completions shape (returned directly by OpenAI and Workers AI
 * models) and Anthropic's messages shape. Throws if neither schema matches.
 */
export function normalizeLlmResponse({
  model: _model,
  response,
}: {
  model: string;
  response: unknown;
}): string {
  return match(response)
    .case(OpenAIChatCompletion, (r) => r.choices[0].message.content)
    .case(AnthropicMessage, (r) =>
      r.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(""),
    )
    .case(WorkersAIChatResponse, (r) => r.response)
    .default(match.throw);
}
