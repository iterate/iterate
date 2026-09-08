import { z } from "zod";
import type { CfAiRunOptions } from "../itx/cf-capabilities.ts";
import {
  isInterceptedModel,
  noAiInterceptorError,
  InterceptedAiResponse,
  type ProjectAiInterceptorInput,
} from "../../lib/model-interception.ts";
import { readAiCallStop } from "./ai-budget.ts";

import type { AgentLlmResult, AgentLlmUsage } from "./agent-processor-contract.ts";
import type { AiGatewayMetadata } from "./ai-cost-attribution.ts";

// =============================================================================
// Workers AI transport: how one LLM attempt talks to `env.AI`.
// =============================================================================
// Wire format and wall clock only — no journal. The agent processor owns what
// becomes a stream event; this module owns dialing the binding, draining its
// SSE response, guessing assistant text/usage out of the shapes Workers AI
// models actually return, and capping the whole attempt's lifetime.

/** The `env.AI` surface one attempt needs. `gateway` is optional so bare test
 * fakes stay two-line objects; the BYOK lane requires it and fails the attempt
 * loudly when the host's binding lacks it. */
export type WorkersAiBinding = {
  run(
    model: string,
    body: unknown,
    options?: {
      returnRawResponse?: boolean;
      gateway: { id: string; metadata: Record<string, string | number> };
    },
  ): Promise<unknown>;
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
  | { kind: "unified"; gatewayId?: string }
  | {
      kind: "byok";
      gatewayId: string;
      openaiApiKey: string;
      /** OpenAI `prompt_cache_key`: stable per agent stream so repeated turns
       * route to the same provider-side prompt-cache shard. */
      openaiPromptCacheKey?: string;
      responseCacheTtlSeconds?: number;
    };

/** One provider-facing chat message. `containsFiles` is transport metadata,
 * not provider input: it forces cache bypass when the text carries temporary
 * project-file capability URLs. */
export type WorkersAiMessage = {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
  containsFiles?: boolean;
};

/** Keep the projection provider-neutral while adapting the wire format.
 * Untrusted developer context has already been downgraded to user by the
 * projection. Trusted developer messages sent through a transport without a
 * confirmed native developer role receive the conservative system-role
 * equivalent. Today only the direct OpenAI BYOK endpoint opts into that role;
 * the Workers AI partner-model interface remains conservative. Agent actors
 * intentionally stay in this trusted set: agents in one project are one
 * instruction trust domain, and sending to another agent is an explicit
 * capability call. Their system-role fallback is therefore deliberate. */
export function adaptMessagesForModel(
  messages: WorkersAiMessage[],
  options: { supportsDeveloperRole: boolean },
): Array<{ role: "system" | "developer" | "user" | "assistant"; content: string }> {
  return messages.map(({ content, role }) => ({
    content,
    role: role === "developer" && !options.supportsDeveloperRole ? "system" : role,
  }));
}

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
  metadata: AiGatewayMetadata;
  consultInterceptor?: (request: ProjectAiInterceptorInput) => Promise<unknown>;
  agentPath?: string;
  deadlineMs: number;
  messages: WorkersAiMessage[];
  model: string;
  onChunk: (chunk: unknown, index: number) => Promise<void>;
  transport?: CloudflareAiGatewayTransport;
}): Promise<AgentLlmResult> {
  const deadline = startDeadline({
    deadlineMs: input.deadlineMs,
    message: `LLM attempt timed out after ${input.deadlineMs / 60_000} minutes.`,
  });
  try {
    const transport = input.transport ?? { kind: "unified" };
    const providerModel = input.model.replace(/^intercepted\//, "");
    const response = await deadline.race(
      sendAiRequest({
        ai: input.ai,
        transport,
        metadata: input.metadata,
        model: input.model,
        body: {
          messages: adaptMessagesForModel(input.messages, {
            supportsDeveloperRole: transport.kind === "byok" && providerModel.startsWith("openai/"),
          }),
          stream: true,
          ...openAiReasoningExtras(providerModel),
        },
        endpoint: "chat/completions",
        headers: new Headers(),
        containsFiles: input.messages.some((message) => message.containsFiles === true),
        options: {},
        source: {
          source: "agent-turn",
          agentPath: input.agentPath || input.metadata.streamPath || "/",
        },
        consultInterceptor: input.consultInterceptor,
      }),
    );
    const stop = await deadline.race(readAiCallStop(response, providerModel.split("/")[0]!));
    if (stop) {
      await deadline.race(response.body?.cancel() || Promise.resolve());
      return stop;
    }
    if (!response.ok)
      throw new Error(
        `AI request failed with status ${response.status}: ${(await deadline.race(response.text())).slice(0, 500)}`,
      );
    const completion =
      response.headers.get("content-type")?.includes("text/event-stream") && response.body
        ? await drainSseResponse({ body: response.body, deadline, onChunk: input.onChunk })
        : await deadline.race(response.json()).then((value) => ({
            text: extractAssistantText(value),
            rawResponse: value,
            usage: extractUsage(value),
          }));
    const cacheStatus = response.headers.get("cf-aig-cache-status");
    return {
      text: completion.text,
      usage: normalizeLlmUsage(completion.usage),
      rawResponse:
        cacheStatus === null
          ? completion.rawResponse
          : {
              ...z.record(z.string(), z.unknown()).parse(completion.rawResponse),
              cloudflareAiGatewayResponseCacheStatus: cacheStatus,
            },
    };
  } finally {
    deadline.clear();
  }
}

/**
 * Extra chat-completions params for OpenAI reasoning models served through
 * Workers AI (`openai/gpt-5.6`, o-series, codex): pin reasoning effort to
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
type WorkersAiCompletion = {
  /** Assistant text — concatenated across chunks for streamed responses. */
  text: string;
  /** JSON-safe response evidence for the journal (never a live object graph). */
  rawResponse: unknown;
  usage?: unknown;
};

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
    await input.deadline.race(input.onChunk(chunk, chunkCount));
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

export function extractChunkText(chunk: unknown): string {
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
function normalizeLlmUsage(usage: unknown): AgentLlmUsage | undefined {
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

/** Prepare every company AI request once. Only the final provider call is replaceable.
 * Execute in the caller's context: no response stream crosses another DO RPC hop. */
export async function sendAiRequest(input: {
  ai: WorkersAiBinding;
  transport: CloudflareAiGatewayTransport;
  metadata: AiGatewayMetadata;
  model: string;
  body: unknown;
  endpoint: string;
  headers: Headers;
  containsFiles: boolean;
  options: CfAiRunOptions;
  source: { source: "agent-turn"; agentPath: string } | { source: "ai-run" } | { source: "egress" };
  consultInterceptor: ((request: ProjectAiInterceptorInput) => Promise<unknown>) | undefined;
}): Promise<Response> {
  const providerModel = input.model.replace(/^intercepted\//, "");
  const payload = z.record(z.string(), z.unknown()).parse(input.body);
  const metadata = Object.fromEntries(
    Object.entries(input.metadata).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    ),
  );
  const common = {
    endpoint: input.endpoint,
    gatewayId: input.transport.gatewayId || "default",
    metadata,
    headers: {
      ...Object.fromEntries(
        [...input.headers].filter(([name]) => name.startsWith("openai-") || name === "accept"),
      ),
      "content-type": "application/json",
      "cf-aig-metadata": JSON.stringify(metadata),
      "cf-aig-collect-log": "true",
      "cf-aig-collect-log-payload": "true",
    },
  };

  // OpenAI bills our key. Construct the complete body before hashing it for caching.
  if (providerModel.startsWith("openai/") && input.transport.kind === "byok") {
    const transport = input.transport;
    const body = {
      ...payload,
      ...openAiStreamingUsage(),
      model: providerModel.slice("openai/".length),
      ...(transport.openaiPromptCacheKey && { prompt_cache_key: transport.openaiPromptCacheKey }),
    };
    const cacheHeaders: Record<string, string> =
      transport.responseCacheTtlSeconds !== undefined && !input.containsFiles
        ? {
            "cf-aig-cache-ttl": String(transport.responseCacheTtlSeconds),
            "cf-aig-cache-key": await cloudflareAiGatewayResponseCacheKey(body),
          }
        : { "cf-aig-skip-cache": "true" };
    const request = {
      ...common,
      provider: "openai",
      body,
      headers: { ...common.headers, ...cacheHeaders },
    };
    return dispatch(request, (prepared) => sendOpenAiWithKey(prepared, transport.openaiApiKey));
  }

  // Cloudflare bills this OpenAI model; streaming still needs OpenAI usage reporting.
  if (providerModel.startsWith("openai/")) {
    const request = {
      ...common,
      provider: "workers-ai",
      body: { ...payload, ...openAiStreamingUsage() },
    };
    return dispatch(request, sendWorkersAi);
  }

  // Workers AI model: preserve its own input schema, without OpenAI-specific fields.
  const request = { ...common, provider: "workers-ai", body: payload };
  return dispatch(request, sendWorkersAi);

  function openAiStreamingUsage() {
    const endpointPath = input.endpoint.split("?")[0];
    if (endpointPath !== "chat/completions" && endpointPath !== "completions") return {};
    if (payload.stream !== true) return {};
    return {
      stream_options: {
        ...z.record(z.string(), z.unknown()).parse(payload.stream_options || {}),
        include_usage: true,
      },
    };
  }

  function sendOpenAiWithKey(request: ProjectAiInterceptorInput["request"], apiKey: string) {
    const gateway = input.ai.gateway?.(request.gatewayId);
    if (!gateway)
      throw new Error("AI binding does not expose gateway(); BYOK transport unavailable.");
    return gateway.run({
      provider: request.provider,
      endpoint: request.endpoint,
      headers: { ...request.headers, authorization: `Bearer ${apiKey}` },
      query: request.body,
    });
  }

  async function sendWorkersAi(request: ProjectAiInterceptorInput["request"]) {
    const response = await input.ai.run(input.model, request.body, {
      ...input.options,
      returnRawResponse: true,
      gateway: { ...input.options.gateway, id: request.gatewayId, metadata: request.metadata },
    });
    if (!(response instanceof Response))
      throw new Error("Workers AI did not return the requested raw response");
    return response;
  }

  // Prepared bodies and headers pass through unchanged. Only real dispatch adds credentials.
  async function dispatch(
    request: ProjectAiInterceptorInput["request"],
    sendToProvider: (request: ProjectAiInterceptorInput["request"]) => Promise<Response>,
  ): Promise<Response> {
    if (isInterceptedModel(input.model)) {
      if (!input.consultInterceptor) throw noAiInterceptorError(input.model);
      const response = InterceptedAiResponse.parse(
        await input.consultInterceptor({ ...input.source, model: input.model, request }),
      );
      return new Response(response.body, { status: response.status, headers: response.headers });
    }

    return sendToProvider(request);
  }
}

/** Bump to invalidate every cached response at once (prompt-format overhauls,
 * masking-rule changes). */
const CLOUDFLARE_AI_GATEWAY_RESPONSE_CACHE_KEY_VERSION = "cloudflare-ai-gateway-response-cache-v5";

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
 * agent paths, journal-projection offset prefixes, signed-URL signature/expiry
 * params, and the OpenAI `prompt_cache_key` (which is per-agent BY DESIGN — see
 * LlmTransportConfig — and would otherwise defeat the cross-fixture cache it
 * rides inside). */
export function maskCloudflareAiGatewayResponseCacheEntropy(serialized: string): string {
  return (
    serialized
      .replace(/prj_[0-9a-f]{32}/g, "prj_MASKED")
      // The permanent send stamps: every request embeds its own and all prior
      // requests' timestamps, so they are per-run entropy exactly like the old
      // render-time tail was.
      .replace(/Requested at: [^"\\]*/g, "Requested at: MASKED")
      .replace(
        /- Project: \\"(?:[^"\\]|\\.)*?\\" \(slug [^)]*\)(?: — the project worker\/website serves [^"\\]*)?/g,
        "- Project: MASKED",
      )
      .replace(/"content":"@\d+(?= |\\n)/g, '"content":"@OFFSET')
      .replace(/\/agents\/[A-Za-z0-9._/-]*/g, "/agents/MASKED")
      .replace(/([?&](?:signature|sig|expires|exp|token|key)=)[^"&\\\s]+/gi, "$1MASKED")
      .replace(/"prompt_cache_key":"[^"]*"/g, '"prompt_cache_key":"MASKED"')
  );
}
