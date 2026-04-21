import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { resolveProvider } from "@cloudflare/codemode/ai";
import type { EventInput as EventInputValue } from "@iterate-com/events-contract";
import { z } from "zod";
import type { CreateMcpToolProvidersOptions } from "~/lib/mcp-tool-providers.ts";
import { createMcpToolProviders } from "~/lib/mcp-tool-providers.ts";

/**
 * Processor for `codemode-block-added` events.
 *
 * Shape follows the in-DO processor pattern:
 * - `reduce` advances the KV-persisted projection
 * - `afterAppend` runs the user's codemode block and emits `codemode-result-added`
 *   via the caller-supplied `append` (which owns transport)
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
}) {
  return {
    slug: "iterate-agent-codemode",
    initialState: iterateAgentProcessorInitialState,
    reduce: (args: { event: unknown; state: IterateAgentProcessorState }) => {
      const parsed = CodemodeBlockAddedEvent.safeParse(args.event);
      if (!parsed.success) return;
      return { ...args.state, blocksProcessed: args.state.blocksProcessed + 1 };
    },
    afterAppend: async (args: {
      append: (input: { event: EventInputValue }) => void | Promise<void>;
      event: unknown;
      state: IterateAgentProcessorState;
    }) => {
      const parsed = CodemodeBlockAddedEvent.safeParse(args.event);
      if (!parsed.success) return;

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

      let result: Awaited<ReturnType<DynamicWorkerExecutor["execute"]>>;
      try {
        // Only the user script is allowed to fail into the result payload; infra-layer
        // errors (executor construction, MCP resolution) escape and crash the DO.
        result = await executor.execute(parsed.data.payload.script, [
          // `builtin.answer()` is the e2e canary asserted by
          // `apps/agents/e2e/vitest/iterate-agent.e2e.test.ts` and `…-mixed-codemode.e2e.test.ts`.
          { name: "builtin", fns: { answer: async () => 42 } },
          ...(deps.eventsCodemodeTools ? [deps.eventsCodemodeTools] : []),
          ...mcpResolved,
        ]);
      } catch (error) {
        result = {
          result: undefined,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      await args.append({
        event: {
          type: "codemode-result-added",
          payload: result,
        } satisfies EventInputValue,
      });
    },
  };
}

/**
 * Reduced projection persisted in the DO's synchronous KV (under key
 * `iterate-agent:stream-processor-state`). Small + lightweight — not execution payloads.
 */
export const IterateAgentProcessorState = z.object({
  blocksProcessed: z.number().int().min(0),
});

export type IterateAgentProcessorState = z.infer<typeof IterateAgentProcessorState>;

export const iterateAgentProcessorInitialState: IterateAgentProcessorState = {
  blocksProcessed: 0,
};

const CodemodeBlockAddedEvent = z.object({
  type: z.literal("codemode-block-added"),
  payload: z.object({
    script: z.string(),
  }),
});
