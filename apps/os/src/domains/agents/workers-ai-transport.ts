// =============================================================================
// Workers AI transport: how one LLM attempt talks to `env.AI`.
// =============================================================================
// Wire format and wall clock only — no journal. The agent processor owns what
// becomes a stream event; this module owns dialing the binding, draining its
// SSE response, guessing assistant text/usage out of the shapes Workers AI
// models actually return, and capping the whole attempt's lifetime.

import { z } from "zod";

/** The `env.AI` surface one attempt needs. `gateway` is optional so bare test
 * fakes stay two-line objects; the BYOK lane requires it and fails the attempt
 * loudly when the host's binding lacks it. */
export type WorkersAiBinding = {
  run(model: string, body: unknown): Promise<unknown>;
  gateway?(gatewayId: string): CloudflareAiGatewayBinding;
};

/** `env.AI.gateway(id)` — the universal-endpoint door used by the BYOK lane. */
export type CloudflareAiGatewayBinding = {
  run(data: {
    provider: string;
    endpoint: string;
    headers: Record<string, string>;
    query: unknown;
  }): Promise<Response>;
};

/**
 * How one attempt travels through the Cloudflare AI Gateway.
 *
 * - `unified`: `env.AI.run` partner models on Cloudflare's unified billing.
 * - `byok`: the gateway's universal endpoint with OUR OpenAI key. Same
 *   gateway (analytics, logs), two differences that matter: OpenAI's own
 *   prompt-cache discount lands on our bill directly (unified billing meters
 *   cached tokens at the uncached price), and the gateway's RESPONSE cache
 *   works on this path (it never engages for partner models).
 *   `responseCacheTtlSeconds` opts a deployment into that response cache —
 *   replayed answers, near-zero cost; only sane where conversations are
 *   synthetic (e2e/preview), never prd.
 */
export type CloudflareAiGatewayTransport =
  | { kind: "unified" }
  | {
      kind: "byok";
      gatewayId: string;
      openaiApiKey: string;
      /** OpenAI `prompt_cache_key`: stable per agent stream so repeated turns
       * route to the same provider-side prompt-cache shard. */
      openaiPromptCacheKey?: string;
      responseCacheTtlSeconds?: number;
    };

type WorkersAiCompletion = {
  /** Assistant text — concatenated across chunks for streamed responses. */
  text: string;
  /** JSON-safe response evidence for the journal (never a live object graph). */
  rawResponse: unknown;
  usage?: unknown;
};

/**
 * One complete attempt: dial `ai.run`, drain the response (streaming or not),
 * and enforce `deadlineMs` over the WHOLE phase — dial plus drain. The cap is
 * load-bearing for recovery: the caller tracks the attempt in a live-execution
 * set its reconciler skips, so an unbounded hang here would push every wedge
 * out to the agent's last-resort backstop instead of failing within the
 * attempt's own horizon.
 *
 * On timeout the response reader is CANCELLED before the error propagates, so
 * a dead attempt can never keep streaming `onChunk` calls (and journaled
 * chunk events) after the caller has already settled it as failed.
 *
 * `onChunk` fires once per parsed SSE chunk, in order and awaited, so the
 * caller can journal chunks as events without racing the drain.
 */
export async function runWorkersAiAttempt(input: {
  ai: WorkersAiBinding;
  deadlineMs: number;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  model: string;
  onChunk: (chunk: unknown, index: number) => Promise<void>;
  /** Defaults to unified billing when omitted (bare test hosts, non-OpenAI models). */
  transport?: CloudflareAiGatewayTransport;
}): Promise<WorkersAiCompletion> {
  const deadline = startDeadline({
    deadlineMs: input.deadlineMs,
    message: `LLM attempt timed out after ${input.deadlineMs / 60_000} minutes.`,
  });
  try {
    const transport = input.transport ?? { kind: "unified" };
    // BYOK carries an OpenAI key, so only OpenAI models can ride it; other
    // vendors' models fall back to unified billing rather than failing.
    if (transport.kind === "byok" && input.model.startsWith("openai/")) {
      return await runByokAttempt({ ...input, deadline, transport });
    }
    const raw = await deadline.race(
      input.ai.run(input.model, {
        messages: input.messages,
        stream: true,
        ...openAiReasoningExtras(input.model),
      }),
    );
    if (raw instanceof ReadableStream) {
      return await drainSseResponse({ body: raw, deadline, onChunk: input.onChunk });
    }
    return {
      text: extractAssistantText(raw),
      rawResponse: jsonCompatible(raw),
      usage: extractUsage(raw),
    };
  } finally {
    deadline.clear();
  }
}

/**
 * The BYOK lane: dial the gateway's universal endpoint with our OpenAI key
 * and drain the SSE response. A response-cache HIT replays the recorded SSE
 * byte-identically, so the drain (and the caller's chunk journaling) is the
 * same code either way; the verdict rides `cloudflareAiGatewayResponseCacheStatus`
 * on the raw-response evidence.
 */
async function runByokAttempt(input: {
  ai: WorkersAiBinding;
  deadline: { race<T>(work: Promise<T>): Promise<T> };
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  model: string;
  onChunk: (chunk: unknown, index: number) => Promise<void>;
  transport: Extract<CloudflareAiGatewayTransport, { kind: "byok" }>;
}): Promise<WorkersAiCompletion> {
  const { transport } = input;
  const gateway = input.ai.gateway?.(transport.gatewayId);
  if (gateway === undefined) {
    throw new Error("AI binding does not expose gateway(); BYOK transport unavailable.");
  }
  const body = {
    model: input.model.replace(/^openai\//, ""),
    messages: input.messages,
    stream: true,
    ...openAiReasoningExtras(input.model),
    ...(transport.openaiPromptCacheKey === undefined
      ? {}
      : { prompt_cache_key: transport.openaiPromptCacheKey }),
  };
  const headers: Record<string, string> = {
    authorization: `Bearer ${transport.openaiApiKey}`,
    "content-type": "application/json",
  };
  const ttlSeconds = transport.responseCacheTtlSeconds;
  if (ttlSeconds !== undefined) {
    headers["cf-aig-cache-ttl"] = String(ttlSeconds);
    headers["cf-aig-cache-key"] = await cloudflareAiGatewayResponseCacheKey(body);
  } else {
    // No TTL configured means this deployment must NEVER serve a cached
    // reply (prd). Said explicitly per request: the gateway otherwise falls
    // back to its dashboard-level cache setting, which is account state this
    // code can't see — live prd evidence showed cache lookups (MISS) even
    // with no cache headers sent.
    headers["cf-aig-skip-cache"] = "true";
  }
  const response = await input.deadline.race(
    gateway.run({ provider: "openai", endpoint: "chat/completions", headers, query: body }),
  );
  if (!response.ok || response.body === null) {
    const detail = await input.deadline.race(response.text()).catch(() => "");
    throw new Error(
      `AI Gateway BYOK request failed with status ${response.status}: ${detail.slice(0, 500)}`,
    );
  }
  const cacheStatus = response.headers.get("cf-aig-cache-status");
  const completion = await drainSseResponse({
    body: response.body,
    deadline: input.deadline,
    onChunk: input.onChunk,
  });
  if (cacheStatus === null) return completion;
  return {
    ...completion,
    rawResponse: {
      ...(completion.rawResponse as Record<string, unknown>),
      cloudflareAiGatewayResponseCacheStatus: cacheStatus,
    },
  };
}

/** Bump to invalidate every cached response at once (prompt-format overhauls,
 * masking-rule changes). */
const CLOUDFLARE_AI_GATEWAY_RESPONSE_CACHE_KEY_VERSION = "cloudflare-ai-gateway-response-cache-v1";

/**
 * The custom `cf-aig-cache-key` for one request body: a hash of the body with
 * fixture-specific identity masked out, so two e2e runs whose conversations
 * differ ONLY in minted ids replay each other's responses.
 *
 * Masking is deliberately narrow — id-shaped tokens only. Over-masking would
 * alias semantically different requests (wrong answers from cache);
 * under-masking is just a cache miss (costs money, never correctness).
 * Everything not masked — prompts, message text, model, sampling params —
 * stays in the hash, so any prompt change invalidates naturally.
 */
export async function cloudflareAiGatewayResponseCacheKey(body: unknown): Promise<string> {
  const masked = maskCloudflareAiGatewayResponseCacheEntropy(JSON.stringify(body));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${CLOUDFLARE_AI_GATEWAY_RESPONSE_CACHE_KEY_VERSION}:${masked}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The masking half of the cache key, separated for tests. Masks: project ids,
 * agent paths, signed-URL signature/expiry params, and the OpenAI
 * `prompt_cache_key` (which is per-agent BY DESIGN — see LlmTransportConfig —
 * and would otherwise defeat the cross-fixture cache it rides inside). */
export function maskCloudflareAiGatewayResponseCacheEntropy(serialized: string): string {
  return serialized
    .replace(/prj_[0-9a-f]{32}/g, "prj_MASKED")
    .replace(/Current date and time \(UTC\): [^"\\]*/g, "Current date and time (UTC): MASKED")
    .replace(
      /- Project: \\"(?:[^"\\]|\\.)*?\\" \(slug [^)]*\)(?: — the project worker\/website serves [^"\\]*)?/g,
      "- Project: MASKED",
    )
    .replace(/\/agents\/[A-Za-z0-9._/-]*/g, "/agents/MASKED")
    .replace(/([?&](?:signature|sig|expires|exp|token|key)=)[^"&\\\s]+/gi, "$1MASKED")
    .replace(/"prompt_cache_key":"[^"]*"/g, '"prompt_cache_key":"MASKED"');
}

/**
 * Extra chat-completions params for OpenAI reasoning models served through
 * Workers AI (`openai/gpt-5.5`, o-series, codex): pin reasoning effort to
 * medium (the pre-#1808 openai-ws posture) and ask streamed responses to
 * carry usage in their final chunk. Gated by model family — non-OpenAI
 * models reject unknown params with a whole-request failure, the same reason
 * the old processor gated its `reasoning` options.
 */
function openAiReasoningExtras(model: string): Record<string, unknown> {
  if (!/(^|\/)(gpt-5|o[1-9]|codex)/.test(model)) return {};
  return { reasoning_effort: "medium", stream_options: { include_usage: true } };
}

/** One armed timer raced against every phase of an attempt, so dial + drain
 * share a single wall-clock budget instead of restarting it per await. */
function startDeadline(input: { deadlineMs: number; message: string }): {
  race<T>(work: Promise<T>): Promise<T>;
  clear(): void;
} {
  let reject: (error: Error) => void;
  const expired = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  // A raced-and-lost `expired` promise would otherwise reject unobserved.
  expired.catch(() => {});
  const timeoutId = setTimeout(() => reject(new Error(input.message)), input.deadlineMs);
  return {
    race: (work) => Promise.race([work, expired]),
    clear: () => clearTimeout(timeoutId),
  };
}

/** Parse SSE frames off the response stream, handing each chunk to `onChunk`
 * and accumulating the assistant text and last-seen usage. Every read races
 * the attempt deadline; on timeout the reader is cancelled so the source
 * stops producing. */
async function drainSseResponse(input: {
  body: ReadableStream;
  deadline: { race<T>(work: Promise<T>): Promise<T> };
  onChunk: (chunk: unknown, index: number) => Promise<void>;
}): Promise<WorkersAiCompletion> {
  const reader = input.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let chunkCount = 0;
  let text = "";
  let usage: unknown;

  const handleChunk = async (chunk: unknown) => {
    text += extractChunkText(chunk);
    usage = extractUsage(chunk) ?? usage;
    await input.onChunk(chunk, chunkCount);
    chunkCount += 1;
  };

  try {
    while (true) {
      const { done, value } = await input.deadline.race(reader.read());
      if (done) break;
      buffered += typeof value === "string" ? value : decoder.decode(value, { stream: true });
      const frames = buffered.split(/\r?\n\r?\n/);
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const chunk = parseSseFrame(frame);
        if (chunk !== undefined) await handleChunk(chunk);
      }
    }
  } catch (error) {
    // Deadline (or a mid-drain read failure): stop the source before the
    // error settles the attempt, so no chunk can land after the completion.
    await reader.cancel().catch(() => {});
    throw error;
  }
  buffered += decoder.decode();
  const finalChunk = parseSseFrame(buffered);
  if (finalChunk !== undefined) await handleChunk(finalChunk);

  return {
    rawResponse: {
      streamed: true,
      chunkCount,
      response: text,
      ...(usage === undefined ? {} : { usage }),
    },
    text,
    ...(usage === undefined ? {} : { usage }),
  };
}

function parseSseFrame(frame: string): unknown | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (data === "" || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

// Response-shape guessing below: Workers AI is not one wire format. Text
// models answer `{ response }`, OpenAI-compatible chat models answer
// `{ choices: [{ message | delta }] }`, and some return content-block arrays.

function extractAssistantText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("AI response did not contain assistant text.");
  }
  if ("response" in raw && typeof raw.response === "string") return raw.response;

  const choices = (raw as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as
      | { message?: { content?: unknown }; delta?: { content?: unknown } }
      | undefined;
    const content = first?.message?.content ?? first?.delta?.content;
    if (typeof content === "string") return content;
  }

  const content = (raw as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
          ? block.text
          : "",
      )
      .join("");
  }

  throw new Error("AI response did not contain assistant text.");
}

function extractChunkText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (typeof chunk !== "object" || chunk === null) return "";
  if ("response" in chunk && typeof chunk.response === "string") return chunk.response;

  const choices = (chunk as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as { delta?: { content?: unknown } } | undefined;
    if (typeof first?.delta?.content === "string") return first.delta.content;
  }

  const delta = (chunk as { delta?: { text?: unknown } }).delta;
  return typeof delta?.text === "string" ? delta.text : "";
}

function extractUsage(raw: unknown): unknown | undefined {
  return typeof raw === "object" && raw !== null && "usage" in raw ? raw.usage : undefined;
}

/**
 * Both usage dialects Workers AI models return, in one loose shape: OpenAI
 * chat-completions (`prompt_tokens`/`completion_tokens` plus `*_details`
 * breakdowns) and OpenAI Responses (`input_tokens`/`output_tokens`). Loose
 * because vendors keep adding fields; unknown keys must not fail the parse.
 */
const LlmUsage = z.looseObject({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens_details: z
    .looseObject({ cached_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  completion_tokens_details: z
    .looseObject({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  input_tokens_details: z
    .looseObject({ cached_tokens: z.number().int().nonnegative().optional() })
    .optional(),
  output_tokens_details: z
    .looseObject({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .optional(),
});

/**
 * A vendor usage object as the normalized token-usage-reported payload
 * fields, or undefined when the shape carries no recognizable totals (report
 * nothing rather than zeros — a zero is a claim).
 */
export function normalizeLlmUsage(usage: unknown):
  | {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
    }
  | undefined {
  const parsed = LlmUsage.safeParse(usage);
  if (!parsed.success) return undefined;
  const inputTokens = parsed.data.prompt_tokens ?? parsed.data.input_tokens;
  const outputTokens = parsed.data.completion_tokens ?? parsed.data.output_tokens;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens =
    parsed.data.prompt_tokens_details?.cached_tokens ??
    parsed.data.input_tokens_details?.cached_tokens;
  const reasoningOutputTokens =
    parsed.data.completion_tokens_details?.reasoning_tokens ??
    parsed.data.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
  };
}

/** JSON round-trip so journaled evidence can never carry live references. */
export function jsonCompatible(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}
