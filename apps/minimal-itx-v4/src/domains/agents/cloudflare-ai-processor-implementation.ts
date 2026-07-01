import { z } from "zod";
import type { StreamEvent } from "../../types.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import { buildAgentLlmRequestBody, reduceAgentEvents } from "./agent-processor-implementation.ts";
import { CloudflareAiProcessorContract } from "./cloudflare-ai-processor-contract.ts";

export type AiLike = {
  run(model: string, body: unknown): Promise<unknown>;
};

type CloudflareAiState = z.infer<typeof CloudflareAiProcessorContract.stateSchema>;
type LlmRequestRequestedEvent = Extract<
  ReturnType<typeof CloudflareAiProcessorContract.parseEvent>,
  { type: "events.iterate.com/agent/llm-request-requested" }
>;

export class CloudflareAiProcessor extends StreamProcessor<
  typeof CloudflareAiProcessorContract,
  {
    ai: AiLike;
    readStreamEvents(): Promise<StreamEvent[]>;
  }
> {
  readonly contract = CloudflareAiProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof CloudflareAiProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/cloudflare-ai/llm-request-started":
        return {
          ...state,
          requests: {
            ...state.requests,
            [String(event.payload.llmRequestId)]: { status: "started" as const },
          },
        };
      case "events.iterate.com/cloudflare-ai/llm-request-completed":
        return {
          ...state,
          requests: {
            ...state.requests,
            [String(event.payload.llmRequestId)]: { status: "completed" as const },
          },
        };
      default:
        return state;
    }
  }

  protected override processEvent({
    event,
    runInBackground,
    state,
  }: Parameters<
    StreamProcessor<typeof CloudflareAiProcessorContract>["processEvent"]
  >[0]): undefined {
    if (event.type !== "events.iterate.com/agent/llm-request-requested") return;
    if (event.payload.provider !== CloudflareAiProcessorContract.slug) return;
    const llmRequestId = event.offset;
    if (state.requests[String(llmRequestId)]?.status === "completed") return;
    runInBackground(() => this.#executeRequest({ event, state }));
  }

  async #executeRequest(input: {
    event: LlmRequestRequestedEvent;
    state: CloudflareAiState;
  }): Promise<void> {
    const llmRequestId = input.event.offset;
    const startedAt = Date.now();
    await this.stream.append({
      type: "events.iterate.com/cloudflare-ai/llm-request-started",
      idempotencyKey: `cloudflare-ai/llm-request-started@${llmRequestId}`,
      payload: {
        llmRequestId,
        model: input.event.payload.model,
      },
    });

    try {
      const body = buildAgentLlmRequestBody({
        events: await this.deps.readStreamEvents(),
        llmRequestId,
      });
      const raw = await this.deps.ai.run(input.event.payload.model, { ...body, stream: true });
      const completion =
        raw instanceof ReadableStream
          ? await this.#consumeStream({ body: raw, sourceEvent: input.event })
          : {
              text: extractAssistantText(raw),
              rawResponse: jsonCompatible(raw),
              usage: extractUsage(raw),
            };

      const durationMs = Date.now() - startedAt;
      const providerResult = {
        status: "success" as const,
        rawResponse: completion.rawResponse,
        ...(completion.usage === undefined ? {} : { usage: completion.usage }),
      };

      if (await this.#isRequestStillCurrent({ llmRequestId })) {
        await this.stream.append({
          type: "events.iterate.com/agent/output-added",
          idempotencyKey: `cloudflare-ai/agent-output-added@${llmRequestId}`,
          payload: { content: completion.text, llmRequestId },
        });
      }

      await this.stream.append(
        {
          type: "events.iterate.com/cloudflare-ai/llm-request-completed",
          idempotencyKey: `cloudflare-ai/provider-completed@${llmRequestId}`,
          payload: {
            durationMs,
            llmRequestId,
            result: providerResult,
          },
        },
        {
          type: "events.iterate.com/agent/llm-request-completed",
          idempotencyKey: `cloudflare-ai/agent-completed@${llmRequestId}`,
          payload: {
            durationMs,
            llmRequestId,
            provider: "cloudflare-ai",
            result: providerResult,
          },
        },
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const failure = {
        status: "failure" as const,
        error: { message: stringifyError(error) },
      };
      await this.stream.append(
        {
          type: "events.iterate.com/cloudflare-ai/llm-request-completed",
          idempotencyKey: `cloudflare-ai/provider-completed@${llmRequestId}`,
          payload: {
            durationMs,
            llmRequestId,
            result: failure,
          },
        },
        {
          type: "events.iterate.com/agent/llm-request-completed",
          idempotencyKey: `cloudflare-ai/agent-completed@${llmRequestId}`,
          payload: {
            durationMs,
            llmRequestId,
            provider: "cloudflare-ai",
            result: failure,
          },
        },
      );
    }
  }

  async #consumeStream(input: {
    body: ReadableStream;
    sourceEvent: LlmRequestRequestedEvent;
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
        idempotencyKey: `cloudflare-ai/llm-response-chunk@${input.sourceEvent.offset}:${sequence}`,
        payload: {
          chunk: jsonCompatible(chunk),
          llmRequestId: input.sourceEvent.offset,
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
