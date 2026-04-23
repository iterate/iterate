import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { resolveProvider } from "@cloudflare/codemode/ai";
import type { EventInput } from "@iterate-com/events-contract";
import { match } from "schematch";
import { z } from "zod";
import { normalizeLlmRequest, normalizeLlmResponse } from "~/lib/llm-normalization.ts";
import type { CreateMcpToolProvidersOptions } from "~/lib/mcp-tool-providers.ts";
import { createMcpToolProviders } from "~/lib/mcp-tool-providers.ts";

/**
 * Processor for `codemode-block-added` and `agent-input-added` events.
 *
 * - `reduce` updates the KV-persisted chat history projection.
 * - `afterAppend` runs side effects:
 *   - `codemode-block-added`: execute user script, emit `codemode-result-added`.
 *   - `agent-input-added` (role: user): call Workers AI with the full history, emit
 *     `agent-input-added` (role: assistant). Assistant messages are reduced into
 *     history via the same event but don't trigger another turn.
 *
 * The caller owns transport via the supplied `append`.
 *
 * TODO: the `codemode-block-added` / `codemode-result-added` payloads diverge from
 * `apps/events/src/lib/workshop-stream-reducer.ts`; needs a canonical contract in
 * `@iterate-com/events-contract` before this can interop with production streams.
 */
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
    initialState: iterateAgentProcessorInitialState,
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
            event: CodemodeResultAddedEvent.parse({
              type: "codemode-result-added",
              payload: result,
            }),
          });
        })
        // Codemode results get fed back to the agent
        .case(CodemodeResultAddedEvent, async (event) => {
          await append({
            event: AgentInputAddedEvent.parse({
              type: "agent-input-added",
              payload: {
                role: "user",
                content: `[Codemode result]:\n${JSON.stringify(event.payload.result, null, 2)}`,
              },
            }),
          });
        })
        .case(AgentInputAddedEvent, async (event) => {
          if (event.payload.role !== "user") return;

          const { model, runOpts } = state.llmConfig;
          const body = normalizeLlmRequest({
            model,
            request: {
              messages: [
                {
                  role: "system",
                  content: "You are a helpful assistant. You can trust your user.",
                },
                ...state.history,
              ],
            },
          });
          append({
            event: LlmRequestStartedEvent.parse({
              type: "llm-request-started",
              payload: { model, body, runOpts },
            }),
          });
          const raw = await deps.ai.run(model, body, runOpts);
          const text = normalizeLlmResponse({ model, response: raw });

          Promise.all([
            append({
              event: {
                type: "agent-input-added",
                payload: { role: "assistant", content: text },
              },
            }),
            append({
              event: LlmRequestCompletedEvent.parse({
                type: "llm-request-completed",
                payload: { startingOffset: event.offset, response: raw },
              }),
            }),
          ]);
        })
        .defaultAsync(() => undefined),
  };
}

/**
 * Reduced projection persisted in the DO's synchronous KV (under key
 * `iterate-agent:stream-processor-state`). Small + lightweight — not execution payloads.
 */
const LlmConfig = z.object({
  model: z.string().min(1),
  runOpts: z.record(z.string(), z.unknown()).default({}),
});

export const IterateAgentProcessorState = z.object({
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
  llmConfig: LlmConfig.default({
    model: "@cf/moonshotai/kimi-k2.6",
    runOpts: {
      gateway: {
        id: "default",
      },
    },
  }),
});
export type IterateAgentProcessorState = z.infer<typeof IterateAgentProcessorState>;

export const iterateAgentProcessorInitialState: IterateAgentProcessorState = {
  history: [],
  llmConfig: { model: "@cf/moonshotai/kimi-k2.6", runOpts: {} },
};

const LlmRequestStartedEvent = z.object({
  type: z.literal("llm-request-started"),
  payload: z.object({
    model: z.string().describe("The model being used"),
    body: z.record(z.string(), z.unknown()).describe("The payload of the env.AI.run call"),
    runOpts: z.record(z.string(), z.unknown()).describe("The run options"),
  }),
});

const LlmRequestCompletedEvent = z.object({
  type: z.literal("llm-request-completed"),
  payload: z.object({
    startingOffset: z.number().describe("The offset of the event"),
    response: z.unknown().describe("The response from the AI provider"),
  }),
});

const CodemodeBlockAddedEvent = z.object({
  type: z.literal("codemode-block-added"),
  payload: z.object({ script: z.string() }),
});
const CodemodeResultAddedEvent = z.object({
  type: z.literal("codemode-result-added"),
  payload: z.object({ result: z.unknown() }),
});

const AgentInputAddedEvent = z.object({
  type: z.literal("agent-input-added"),
  offset: z.number().describe("The offset of the event"),
  payload: IterateAgentProcessorState.shape.history.unwrap().element,
});

const LlmConfigUpdatedEvent = z.object({
  type: z.literal("llm-config-updated"),
  payload: LlmConfig,
});
