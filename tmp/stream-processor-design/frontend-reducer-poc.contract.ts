import { z } from "zod";
import {
  createEvent,
  defineProcessorContract,
  runProcessorReduce,
  type ProcessorState,
  type StreamEvent,
} from "../../packages/shared/src/stream-processors/stream-processor.ts";

/**
 * Frontend-safe AgentLoop contract sketch.
 *
 * This file deliberately contains no Durable Object, Worker binding, AI binding,
 * loader, socket, fetcher, or processor implementation imports. The intended
 * package split is:
 *
 * - `agent-loop.contract.ts`: schemas, contract, reducer, projection helpers
 * - `agent-loop.processor.ts`: backend-only implementation factory
 *
 * The UI can import the contract module to reconstruct reduced state from
 * committed stream events without constructing the backend processor.
 */

export const CoreStreamProcessorContract = defineProcessorContract({
  slug: "core-stream",
  version: "0.1.0",
  description: "Core stream events shared by processor hosts and projections.",
  state: z.object({}).default({}),
  events: {
    ...createEvent({
      type: "processor-registered",
      description: "A processor registered its public contract on this stream.",
      payloadSchema: z.object({
        slug: z.string(),
        version: z.string(),
        description: z.string(),
        consumes: z.array(z.string()),
        emits: z.array(z.string()),
      }),
    }),
  },
  consumes: ["processor-registered"],
  emits: ["processor-registered"],
});

export const AgentLoopProcessorContract = defineProcessorContract({
  slug: "agent-loop",
  version: "0.1.0",
  description: "Maintains the frontend-visible agent loop projection.",
  state: z
    .object({
      hasRegisteredCurrentVersion: z.boolean().default(false),
      queuedMessageCount: z.number().int().nonnegative().default(0),
      computing: z.boolean().default(false),
      currentRequestId: z.string().nullable().default(null),
      transcript: z
        .array(
          z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string(),
          }),
        )
        .default([]),
    })
    .prefault({}),
  processorDeps: [CoreStreamProcessorContract],
  events: {
    ...createEvent({
      type: "agent-input-added",
      description: "A model-visible row of agent context.",
      payloadSchema: z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    }),
    ...createEvent({
      type: "llm-request-scheduled",
      description: "An LLM request was queued for the agent loop.",
      payloadSchema: z.object({
        requestId: z.string(),
      }),
    }),
    ...createEvent({
      type: "llm-request-started",
      description: "The agent loop started computing an LLM response.",
      payloadSchema: z.object({
        requestId: z.string(),
      }),
    }),
    ...createEvent({
      type: "llm-request-completed",
      description: "The agent loop finished computing an LLM response.",
      payloadSchema: z.object({
        requestId: z.string(),
      }),
    }),
    ...createEvent({
      type: "llm-request-failed",
      description: "The agent loop failed while computing an LLM response.",
      payloadSchema: z.object({
        requestId: z.string(),
        error: z.object({ message: z.string() }),
      }),
    }),
  },
  consumes: [
    "processor-registered",
    "agent-input-added",
    "llm-request-scheduled",
    "llm-request-started",
    "llm-request-completed",
    "llm-request-failed",
  ],
  emits: [
    "processor-registered",
    "agent-input-added",
    "llm-request-scheduled",
    "llm-request-started",
    "llm-request-completed",
    "llm-request-failed",
  ],
  reduce({ state, event }) {
    switch (event.type) {
      case "processor-registered":
        return event.payload.slug === AgentLoopProcessorContract.slug &&
          event.payload.version === AgentLoopProcessorContract.version
          ? { ...state, hasRegisteredCurrentVersion: true }
          : undefined;
      case "agent-input-added":
        return {
          ...state,
          transcript: [
            ...state.transcript,
            { role: event.payload.role, content: event.payload.content },
          ],
        };
      case "llm-request-scheduled":
        return {
          ...state,
          queuedMessageCount: state.queuedMessageCount + 1,
        };
      case "llm-request-started":
        return {
          ...state,
          queuedMessageCount: Math.max(0, state.queuedMessageCount - 1),
          computing: true,
          currentRequestId: event.payload.requestId,
        };
      case "llm-request-completed":
      case "llm-request-failed":
        return state.currentRequestId === event.payload.requestId
          ? { ...state, computing: false, currentRequestId: null }
          : undefined;
      default:
        return undefined;
    }
  },
});

export type AgentLoopState = ProcessorState<typeof AgentLoopProcessorContract>;

/**
 * Frontend projection helper.
 *
 * This is intentionally reduce-only: rendering a frontend projection must never
 * run backend `afterAppend` hooks or trigger derived appends.
 */
export function reduceAgentLoopEvents(args: {
  events: readonly StreamEvent[];
  state?: AgentLoopState;
}): AgentLoopState {
  let state = args.state ?? AgentLoopProcessorContract.state.parse(undefined);

  for (const event of args.events) {
    const reduction = runProcessorReduce({
      processor: { contract: AgentLoopProcessorContract },
      event,
      state,
    });
    state = reduction?.state ?? state;
  }

  return state;
}
