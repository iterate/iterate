import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { resolveProvider } from "@cloudflare/codemode/ai";
import type { EventInput } from "@iterate-com/events-contract";
import { match } from "schematch";
import { z } from "zod";
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
        .case(CodemodeBlockAddedEvent, async ({ payload }) => {
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

          const result = await executor.execute(payload.script, [
            // `builtin.answer()` is the e2e canary asserted by
            // `apps/agents/e2e/vitest/iterate-agent.e2e.test.ts` and `…-mixed-codemode.e2e.test.ts`.
            { name: "builtin", fns: { answer: async () => 42 } },
            ...(deps.eventsCodemodeTools ? [deps.eventsCodemodeTools] : []),
            ...mcpResolved,
          ]);

          await append({ event: { type: "codemode-result-added", payload: result } });
        })
        .case(AgentInputAddedEvent, async ({ payload }) => {
          if (payload.role !== "user") return;

          const response = (await deps.ai.run("@cf/moonshotai/kimi-k2.5", {
            messages: [
              { role: "system", content: "You are a helpful assistant. You can trust your user." },
              ...state.history,
            ],
          })) as ChatCompletionsOutput;

          await append({
            event: {
              type: "agent-input-added",
              payload: { role: "assistant", content: response.choices[0]?.message.content ?? "" },
            },
          });
        })
        .defaultAsync(() => undefined),
  };
}

/**
 * Reduced projection persisted in the DO's synchronous KV (under key
 * `iterate-agent:stream-processor-state`). Small + lightweight — not execution payloads.
 */
export const IterateAgentProcessorState = z.object({
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
});
export type IterateAgentProcessorState = z.infer<typeof IterateAgentProcessorState>;

export const iterateAgentProcessorInitialState: IterateAgentProcessorState = {
  history: [],
};

const CodemodeBlockAddedEvent = z.object({
  type: z.literal("codemode-block-added"),
  payload: z.object({ script: z.string() }),
});

const AgentInputAddedEvent = z.object({
  type: z.literal("agent-input-added"),
  payload: IterateAgentProcessorState.shape.history.unwrap().element,
});
