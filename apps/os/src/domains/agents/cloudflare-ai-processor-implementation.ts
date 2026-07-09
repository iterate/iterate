import type { StreamEvent } from "../streams/schemas.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import {
  buildAgentLlmRequestBody,
  flattenMessageToText,
  reduceAgentEvents,
} from "./agent-processor-implementation.ts";
import { DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS } from "./agent-processor-contract.ts";
import { CloudflareAiProcessorContract } from "./cloudflare-ai-processor-contract.ts";

export class CloudflareAiProcessor extends StreamProcessor<
  CloudflareAiProcessorContract,
  {
    ai: { run(model: string, body: unknown): Promise<unknown> };
    readStreamEvents(): Promise<StreamEvent[]>;
    /** Injected clock (expiry decisions); production defaults to Date.now. */
    now?: () => number;
  }
> {
  readonly contract = CloudflareAiProcessorContract;

  /** Executions alive in THIS incarnation — the "actual" half of the
   * reconciliation. See the openai-ws sibling for the full story. */
  readonly #liveExecutions = new Set<number>();

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<CloudflareAiProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/agent/llm-request-requested": {
        if (event.payload.provider !== CloudflareAiProcessorContract.slug) return state;
        return {
          ...state,
          requests: {
            ...state.requests,
            [String(event.offset)]: {
              status: "requested" as const,
              model: event.payload.model,
              expiresAt:
                event.payload.expiresAt ??
                Date.parse(event.createdAt) + DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS,
            },
          },
        };
      }
      case "events.iterate.com/cloudflare-ai/llm-request-started": {
        const key = String(event.payload.llmRequestId);
        const existing = state.requests[key];
        if (existing === undefined) return state;
        return {
          ...state,
          requests: { ...state.requests, [key]: { ...existing, status: "started" as const } },
        };
      }
      // Terminal events (see the openai-ws sibling for the doctrine).
      case "events.iterate.com/cloudflare-ai/llm-request-completed":
      case "events.iterate.com/agent/llm-request-completed": {
        const requests = { ...state.requests };
        delete requests[String(event.payload.llmRequestId)];
        return { ...state, requests };
      }
      case "events.iterate.com/agent/llm-request-cancelled": {
        if (event.payload.phase !== "requested") return state;
        const requests = { ...state.requests };
        delete requests[String(event.payload.llmRequestId)];
        return { ...state, requests };
      }
      default:
        return state;
    }
  }

  /**
   * End-of-batch reconciliation of desired (open obligations in the fold)
   * against actual (this incarnation's live executions) — a verbatim sibling
   * of OpenAiWsProcessor.processEventBatch; the doctrine lives there.
   */
  protected override async processEventBatch(
    args: Parameters<StreamProcessor<typeof CloudflareAiProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    await super.processEventBatch(args);
    // At-head gate — see the openai-ws sibling.
    if (args.checkpointOffset < args.streamMaxOffset) return;
    const now = (this.deps.now ?? Date.now)();
    const settle: { llmRequestId: number; message: string }[] = [];
    for (const [id, request] of Object.entries(args.state.requests)) {
      const llmRequestId = Number(id);
      if (this.#liveExecutions.has(llmRequestId)) continue;
      if (request.status === "requested" && now < request.expiresAt) {
        this.#liveExecutions.add(llmRequestId);
        args.runInBackground(() => this.#executeRequest({ llmRequestId, model: request.model }));
        continue;
      }
      settle.push({
        llmRequestId,
        message:
          request.status === "started"
            ? "LLM request orphaned: the incarnation executing it went away before completing. Failed by the reconciler; the agent's next trigger reschedules."
            : "LLM request expired before any attempt started (the host was down past the request's expiry). Failed by the reconciler; the agent's next trigger reschedules.",
      });
    }
    if (settle.length === 0) return;
    args.blockProcessorWhile(async () => {
      for (const { llmRequestId, message } of settle) {
        console.error("[cloudflare-ai] settling undriven llm request", { llmRequestId, message });
        await this.#appendCompletion({
          llmRequestId,
          durationMs: 0,
          result: { status: "failure" as const, error: { message } },
        });
      }
    });
  }

  async #executeRequest(input: { llmRequestId: number; model: string }): Promise<void> {
    const { llmRequestId, model } = input;
    const startedAt = Date.now();
    try {
      // Started-evidence outside the inner try — see the openai-ws sibling:
      // a failed append means the vendor was never dialed, no completion may
      // land, and the finally must still release the live-set entry.
      await this.stream.append({
        type: "events.iterate.com/cloudflare-ai/llm-request-started",
        idempotencyKey: `cloudflare-ai/llm-request-started@${llmRequestId}`,
        payload: {
          llmRequestId,
          model,
        },
      });
      try {
        const body = buildAgentLlmRequestBody({
          events: await this.deps.readStreamEvents(),
          llmRequestId,
        });
        // Workers AI chat bodies are text-only here: file attachments flatten
        // to hint lines telling the agent how to fetch/convert the bytes.
        const messages = body.messages.map((message) => ({
          role: message.role,
          content: flattenMessageToText(message),
        }));
        const raw = await this.deps.ai.run(model, { messages, stream: true });
        const completion =
          raw instanceof ReadableStream
            ? await this.#consumeStream({ body: raw, llmRequestId })
            : {
                text: extractAssistantText(raw),
                rawResponse: jsonCompatible(raw),
                usage: extractUsage(raw),
              };

        if (await this.#isRequestStillCurrent({ llmRequestId })) {
          await this.stream.append({
            type: "events.iterate.com/agent/output-added",
            idempotencyKey: `cloudflare-ai/agent-output-added@${llmRequestId}`,
            payload: { content: completion.text, llmRequestId },
          });
        }

        await this.#appendCompletion({
          durationMs: Date.now() - startedAt,
          llmRequestId,
          result: {
            status: "success" as const,
            rawResponse: completion.rawResponse,
            ...(completion.usage === undefined ? {} : { usage: completion.usage }),
          },
        });
      } catch (error) {
        await this.#appendCompletion({
          durationMs: Date.now() - startedAt,
          llmRequestId,
          result: {
            status: "failure" as const,
            error: { message: stringifyError(error) },
          },
        });
      }
    } finally {
      this.#liveExecutions.delete(llmRequestId);
    }
  }

  /** The one durable outcome of a request — provider + agent completion pair.
   * Success, in-execution failure, and the reconciler all land here with
   * identical idempotency keys, so races collapse at the append dedup layer. */
  async #appendCompletion(input: {
    durationMs: number;
    llmRequestId: number;
    result:
      | { status: "success"; rawResponse?: unknown; usage?: unknown }
      | { status: "failure"; error: { message: string }; rawResponse?: unknown };
  }): Promise<void> {
    await this.stream.append(
      {
        type: "events.iterate.com/cloudflare-ai/llm-request-completed",
        idempotencyKey: `cloudflare-ai/provider-completed@${input.llmRequestId}`,
        payload: {
          durationMs: input.durationMs,
          llmRequestId: input.llmRequestId,
          result: input.result,
        },
      },
      {
        type: "events.iterate.com/agent/llm-request-completed",
        idempotencyKey: `cloudflare-ai/agent-completed@${input.llmRequestId}`,
        payload: {
          durationMs: input.durationMs,
          llmRequestId: input.llmRequestId,
          provider: "cloudflare-ai",
          result: input.result,
        },
      },
    );
  }

  async #consumeStream(input: {
    body: ReadableStream;
    llmRequestId: number;
  }): Promise<{ rawResponse: unknown; text: string; usage?: unknown }> {
    const reader = input.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let sequence = 0;
    let text = "";
    let usage: unknown;

    const handleChunk = async (chunk: unknown) => {
      text += extractChunkText(chunk);
      usage = extractUsage(chunk) ?? usage;
      await this.stream.append({
        type: "events.iterate.com/cloudflare-ai/llm-response-chunk",
        idempotencyKey: `cloudflare-ai/llm-response-chunk@${input.llmRequestId}:${sequence}`,
        payload: {
          chunk: jsonCompatible(chunk),
          llmRequestId: input.llmRequestId,
          sequence,
        },
      });
      sequence += 1;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += typeof value === "string" ? value : decoder.decode(value, { stream: true });
      const frames = buffered.split(/\r?\n\r?\n/);
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const chunk = parseSseFrame(frame);
        if (chunk !== undefined) await handleChunk(chunk);
      }
    }
    buffered += decoder.decode();
    const finalChunk = parseSseFrame(buffered);
    if (finalChunk !== undefined) await handleChunk(finalChunk);

    return {
      rawResponse: {
        streamed: true,
        chunkCount: sequence,
        response: text,
        ...(usage === undefined ? {} : { usage }),
      },
      text,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  async #isRequestStillCurrent(input: { llmRequestId: number }) {
    const state = reduceAgentEvents(await this.deps.readStreamEvents());
    return (
      state.currentRequest?.phase === "requested" &&
      state.currentRequest.llmRequestId === input.llmRequestId
    );
  }
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

function jsonCompatible(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
