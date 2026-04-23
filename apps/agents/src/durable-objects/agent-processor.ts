import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { resolveProvider } from "@cloudflare/codemode/ai";
import {
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
  type EventInput,
} from "@iterate-com/events-contract";
import { match } from "schematch";
import { z } from "zod";
import { parseSseStream } from "./sse.ts";
import type { CreateMcpToolProvidersOptions } from "~/lib/mcp-tool-providers.ts";
import { createMcpToolProviders } from "~/lib/mcp-tool-providers.ts";

/**
High level design ideas:

- Main event type is "agent-input-added"
- We track all raw information as it happens - e.g. LLM requests and response streaming chunks
- We then _convert_ that to "agent-input-added" events
- Reducer keeps track of 
  - LLM model
  - env.AI run options (e.g. gateway config)
  - normalized LLM history 
  - system prompt
  - in-progress response
  - in-progress llm request




 * Processor for `codemode-block-added` and `agent-input-added` events.
 *
 * - `reduce` updates the KV-persisted chat history projection. Every
 *   `agent-input-added` event (user or assistant) is appended to history.
 * - `afterAppend` runs side effects:
 *   - `codemode-block-added`: execute user script, emit `codemode-result-added`.
 *   - `agent-input-added` (role: user): call Workers AI with `stream: true`, emit
 *     `llm-request-started`, one `llm-streaming-chunk-received` per SSE chunk,
 *     then `llm-request-completed`.
 *   - `llm-streaming-chunk-received`: if the raw chunk matches one of the
 *     per-provider text schemas (`WorkersAiTextChunk`, `OpenAiTextChunk`,
 *     `AnthropicTextChunk`), emit an `agent-input-added` (role: assistant)
 *     carrying the text delta. Non-text chunks (tool calls, usage, message
 *     boundaries, keep-alives) are ignored here; downstream consumers can
 *     parse them from the raw event log.
 *
 * The chunk payload itself is stored un-normalized — schemas are used only to
 * discriminate shapes for emitting the assistant event.
 *
 * The caller owns transport via the supplied `append`.
 *
 * TODO: the `codemode-block-added` / `codemode-result-added` payloads diverge from
 * `apps/events/src/lib/workshop-stream-reducer.ts`; needs a canonical contract in
 * `@iterate-com/events-contract` before this can interop with production streams.
 */

/**
 * Typed chat contract for the LLM models we use in this processor.
 *
 * Most providers we call via `env.AI.run(...)` accept the shared chat-completions
 * shape below directly. Anthropic's native binding shape differs, so
 * `normalizeLlmRequest()` rewrites only that case.
 */
const AiChatMessage = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const AiChatRequest = z.object({
  messages: z.array(AiChatMessage).min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
});
type AiChatRequest = z.infer<typeof AiChatRequest>;

/**
 * Cloudflare's `AiModels` map includes many non-chat models (embeddings, TTS,
 * image generation, etc.). This filters it down to Workers AI model keys whose
 * `inputs` accept the shared chat request shape above.
 */
type WorkersAiChatModel = {
  [Name in keyof AiModels]: AiChatRequest extends AiModels[Name]["inputs"] ? Name : never;
}[keyof AiModels];

type LlmModel = WorkersAiChatModel | `openai/${string}` | `anthropic/${string}`;

const AnthropicMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
});
const AnthropicChatRequest = z.object({
  system: z.string().optional(),
  messages: z.array(AnthropicMessage).min(1),
  max_tokens: z.number().int().positive(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
});
type AnthropicChatRequest = z.infer<typeof AnthropicChatRequest>;

type LlmRunBody = AiChatRequest | AnthropicChatRequest;

function isAnthropicModel(model: LlmModel): model is `anthropic/${string}` {
  return model.startsWith("anthropic/");
}

/**
 * Returns the provider-specific body shape expected by `env.AI.run(model, body)`.
 *
 * - Workers AI `@cf/*` models: shared chat body unchanged
 * - OpenAI via Unified Billing: shared chat body unchanged
 * - Anthropic via Unified Billing: rewrite to Anthropic's native body shape
 */
function normalizeLlmRequest(args: { model: LlmModel; request: AiChatRequest }): LlmRunBody {
  const request = AiChatRequest.parse(args.request);
  if (!isAnthropicModel(args.model)) {
    return request;
  }

  const system = request.messages.find((message) => message.role === "system")?.content;
  const messages = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: [{ type: "text", text: message.content }],
    }));

  return AnthropicChatRequest.parse({
    ...(system ? { system } : {}),
    messages,
    max_tokens: request.max_tokens ?? 1024,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
  });
}

export function createIterateAgentProcessor(deps: {
  loader: WorkerLoader;
  outboundFetch: Fetcher;
  mcp: CreateMcpToolProvidersOptions["mcp"];
  eventsCodemodeTools: Awaited<ReturnType<typeof resolveProvider>> | null;
  ai: Ai;
}) {
  type Append = (input: { event: EventInput }) => void | Promise<void>;
  return {
    slug: "iterate-agent-codemode",
    initialState: IterateAgentProcessorState.parse({}),
    reduce: ({ event, state }: { event: unknown; state: IterateAgentProcessorState }) =>
      match(event)
        .case(AgentInputAddedEvent, ({ payload }) => ({
          ...state,
          history: [...state.history, payload],
        }))
        .case(LlmConfigUpdatedEvent, ({ payload }) => ({
          ...state,
          llmConfig: payload,
        }))
        .default(() => undefined),

    afterAppend: async ({
      event,
      state,
      append,
    }: {
      append: Append;
      event: unknown;
      state: IterateAgentProcessorState;
    }) =>
      match(event)
        .case(CodemodeBlockAddedEvent, async (event) => {
          const executor = new DynamicWorkerExecutor({
            loader: deps.loader,
            globalOutbound: deps.outboundFetch,
          });
          const mcpProviders = await createMcpToolProviders({
            mcp: deps.mcp,
            // Give pending MCP handshakes this long to settle before resolving the provider set.
            waitForConnectionsTimeout: 15_000,
          });
          const mcpResolved = await Promise.all(
            mcpProviders.map((provider) => resolveProvider(provider)),
          );

          const result = await executor.execute(event.payload.script, [
            // `builtin.answer()` is the e2e canary asserted by
            // `apps/agents/e2e/vitest/iterate-agent.e2e.test.ts` and `…-mixed-codemode.e2e.test.ts`.
            { name: "builtin", fns: { answer: async () => 42 } },
            ...(deps.eventsCodemodeTools ? [deps.eventsCodemodeTools] : []),
            ...mcpResolved,
          ]);

          await append({
            event: CodemodeResultAddedEventInput.parse({
              type: "codemode-result-added",
              payload: result,
            }),
          });
        })
        // Codemode results get fed back to the agent
        .case(CodemodeResultAddedEvent, async (event) => {
          await append({
            event: AgentInputAddedEventInput.parse({
              type: "agent-input-added",
              payload: {
                role: "user",
                content: `[Codemode result]:\n${JSON.stringify(event.payload.result, null, 2)}`,
              },
            }),
          });
        })
        // Each streaming chunk that carries assistant text becomes its own
        // `agent-input-added` event. The reducer appends unconditionally, so a
        // single streamed turn produces multiple small assistant history entries
        // — downstream consumers can coalesce if desired.
        .case(LlmStreamingChunkReceivedEvent, async (event) => {
          const delta = match(event.payload.chunk)
            .case(WorkersAiTextChunk, (c) => c.response)
            .case(OpenAiTextChunk, (c) => c.choices[0].delta.content)
            .case(AnthropicTextChunk, (c) => c.delta.text)
            .default(() => null);
          if (delta === null || delta === "") return;
          await append({
            event: AgentInputAddedEventInput.parse({
              type: "agent-input-added",
              payload: { role: "assistant", content: delta },
            }),
          });
        })
        .case(AgentInputAddedEvent, async (event) => {
          if (event.payload.role !== "user" || event.offset == null) return;

          const { model, runOpts } = state.llmConfig;
          const hasSystemInHistory = state.history.some((message) => message.role === "system");
          const body = normalizeLlmRequest({
            model,
            request: {
              messages: hasSystemInHistory
                ? state.history
                : [
                    {
                      role: "system",
                      content: "You are a helpful assistant. You can trust your user.",
                    },
                    ...state.history,
                  ],
            },
          });
          append({
            event: LlmRequestStartedEventInput.parse({
              type: "llm-request-started",
              payload: { model, body, runOpts },
            }),
          });
          // Cloudflare's typed streaming overload only covers `keyof AiModels`.
          // At runtime we also support Unified Billing provider strings like
          // `openai/*` and `anthropic/*`, so we normalize the body per-provider
          // and assert the streaming return here.
          const stream = (await deps.ai.run(
            model,
            { ...body, stream: true },
            runOpts,
          )) as unknown as ReadableStream<Uint8Array>;
          for await (const chunk of parseSseStream(stream)) {
            await append({
              event: LlmStreamingChunkReceivedEventInput.parse({
                type: "llm-streaming-chunk-received",
                payload: { chunk },
              }),
            });
          }
          await append({
            event: LlmRequestCompletedEventInput.parse({
              type: "llm-request-completed",
              payload: { startingOffset: event.offset },
            }),
          });
        })
        .defaultAsync(() => undefined),
  };
}

/**
 * Reduced projection persisted in the DO's synchronous KV (under key
 * `iterate-agent:stream-processor-state`). Small + lightweight — not execution payloads.
 */
const AiModelName = z.custom<LlmModel>((v) => typeof v === "string" && v.length > 0);
const AiRunOptions = z.custom<AiOptions>((v) => typeof v === "object" && v !== null);
const LlmRunBody = z.union([AiChatRequest, AnthropicChatRequest]);
const LlmConfig = z.object({
  model: AiModelName,
  runOpts: AiRunOptions.default({}),
});

export const IterateAgentProcessorState = z.object({
  systemPrompt: z
    .string()
    .default("You are a helpful assistant. You can trust your user.")
    .describe("The system prompt"),
  history: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
  llmConfig: LlmConfig.default({
    model: "@cf/moonshotai/kimi-k2.5",
    runOpts: {
      gateway: {
        id: "default",
      },
    },
  }),
});
export type IterateAgentProcessorState = z.infer<typeof IterateAgentProcessorState>;

/**
 * Minimal schemas matching the assistant text-delta shape of each provider's
 * streaming chunk. Used only to extract the string content — everything else
 * (tool calls, usage, role announcements, stop reasons, keep-alives) is left
 * for downstream consumers to interpret from the raw event log.
 */
const WorkersAiTextChunk = z.object({ response: z.string() });
const OpenAiTextChunk = z.object({
  choices: z.array(z.object({ delta: z.object({ content: z.string() }) })).min(1),
});
const AnthropicTextChunk = z.object({
  type: z.literal("content_block_delta"),
  delta: z.object({ type: z.literal("text_delta"), text: z.string() }),
});

function defineEventSchemas<const TType extends string, TPayload extends z.ZodType>(args: {
  type: TType;
  payload: TPayload;
}) {
  const input = GenericEventInputBase.extend({
    type: z.literal(args.type),
    payload: args.payload,
  });
  const event = GenericEventBase.extend(input.pick({ type: true, payload: true }).shape);
  return { event, input };
}

const { input: LlmRequestStartedEventInput } = defineEventSchemas({
  type: "llm-request-started",
  payload: z.object({
    model: AiModelName.describe("The model being used"),
    body: LlmRunBody.describe("The payload of the env.AI.run call"),
    runOpts: AiRunOptions.describe("The run options"),
  }),
});

const { input: LlmRequestCompletedEventInput } = defineEventSchemas({
  type: "llm-request-completed",
  payload: z.object({
    startingOffset: z.number().describe("The offset of the event"),
  }),
});

const { event: LlmStreamingChunkReceivedEvent, input: LlmStreamingChunkReceivedEventInput } =
  defineEventSchemas({
    type: "llm-streaming-chunk-received",
    payload: z.object({
      chunk: z.unknown().describe("Raw provider SSE chunk (parsed JSON after `data:`)"),
    }),
  });

const { event: CodemodeBlockAddedEvent } = defineEventSchemas({
  type: "codemode-block-added",
  payload: z.object({ script: z.string() }),
});

const { event: CodemodeResultAddedEvent, input: CodemodeResultAddedEventInput } =
  defineEventSchemas({
    type: "codemode-result-added",
    payload: z.object({ result: z.unknown() }),
  });

const { event: AgentInputAddedEvent, input: AgentInputAddedEventInput } = defineEventSchemas({
  type: "agent-input-added",
  payload: IterateAgentProcessorState.shape.history.unwrap().element,
});

const { event: LlmConfigUpdatedEvent } = defineEventSchemas({
  type: "llm-config-updated",
  payload: LlmConfig,
});
