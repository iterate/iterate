import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";

// =============================================================================
// pi processor contract.
//
// An event-sourced port of the badlogic/pi coding-agent core loop
// (https://github.com/badlogic/pi-mono, packages/agent/src/agent-loop.ts) as a
// single stream processor: turn taking, steering/follow-up queues,
// interruption, tool calls, and compaction — with the run state machine as a
// fold and the LLM/tool work as idempotency-keyed side effects.
//
// The mapping from pi's in-memory loop to events:
// - pi's "streamFn must not throw; failures are encoded as a final
//   AssistantMessage with stopReason error/aborted" contract means one event —
//   assistant-message-added — is the entire request/response lifecycle.
// - pi's steering queue (drained after each turn's tool calls, before the next
//   LLM call) and follow-up queue (drained when the run would otherwise stop)
//   are folded state, drained by the reducer at exactly pi's drain points.
// - pi keeps aborted partial output and synthesizes "No result provided" tool
//   results for orphaned tool calls at the LLM boundary (transform-messages);
//   the port does the same in buildPiLlmRequest, never in stored history.
// - pi's compaction summary re-enters context as a user message wrapped in
//   <summary> tags; here the cut point and summary are recorded in a
//   compaction-completed event and the fold splices history deterministically.
// =============================================================================

const DEFAULT_PI_MODEL = "claude-fable-5";
const DEFAULT_PI_CONTEXT_WINDOW = 200_000;

const DEFAULT_PI_SYSTEM_PROMPT = [
  "You are a coding agent. Work on the user's task using the tools available to you.",
  "Call tools when you need to read, run, or change anything; reply with plain text when the task is complete or you need input from the user.",
].join("\n");

/** How pi wraps a compaction summary when it re-enters model context (verbatim from pi's harness/messages.ts). */
export const PI_COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n`;
export const PI_COMPACTION_SUMMARY_SUFFIX = `\n</summary>`;

/** A tool invocation requested by the model inside an assistant message. */
export const PiToolCall = z.object({
  type: z.literal("toolCall"),
  arguments: z.record(z.string(), z.unknown()),
  id: z.string().min(1),
  name: z.string().min(1),
});
export type PiToolCall = z.infer<typeof PiToolCall>;

/** One content block of an assistant message: text, thinking, or a tool call. */
export const PiAssistantContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), thinking: z.string() }),
  PiToolCall,
]);
export type PiAssistantContent = z.infer<typeof PiAssistantContent>;

/**
 * Why the model stopped, pi's vocabulary verbatim. `error` and `aborted` are
 * terminal outcomes encoded in the message itself (pi's stream functions never
 * throw), which is what lets one event type carry the whole request lifecycle.
 */
const PiStopReason = z.enum(["stop", "length", "toolUse", "error", "aborted"]);
type PiStopReason = z.infer<typeof PiStopReason>;

/**
 * A completed (possibly failed or partial) assistant response. Mirrors pi's
 * AssistantMessage minus provider bookkeeping; `usage` feeds compaction's
 * token accounting when the provider reports it.
 */
export const PiAssistantMessage = z.object({
  role: z.literal("assistant"),
  content: z.array(PiAssistantContent),
  errorMessage: z.string().optional(),
  stopReason: PiStopReason,
  usage: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      totalTokens: z.number().nonnegative(),
    })
    .optional(),
});
export type PiAssistantMessage = z.infer<typeof PiAssistantMessage>;

/** A model-visible conversation message: pi's Message union plus the compaction summary pseudo-message. */
const PiMessage = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.string() }),
  PiAssistantMessage,
  z.object({
    role: z.literal("toolResult"),
    content: z.string(),
    isError: z.boolean(),
    toolCallId: z.string(),
    toolName: z.string(),
  }),
  z.object({ role: z.literal("compactionSummary"), summary: z.string() }),
]);
type PiMessage = z.infer<typeof PiMessage>;

/**
 * One history entry: a message tagged with the offset of the event that added
 * it. The offset is provenance, not identity — a queue drain records several
 * entries at one offset, and the compaction splice therefore addresses history
 * by array index (the fold's order is the identity), never by offset.
 */
export const PiHistoryEntry = z.object({
  message: PiMessage,
  offset: z.number().int().positive(),
});
export type PiHistoryEntry = z.infer<typeof PiHistoryEntry>;

/**
 * The run state machine, pi's loop position as data: `idle` between runs,
 * `streaming` while an LLM request is outstanding (the llmRequestId is the
 * offset of the llm-request-requested event), `executing-tools` while a tool
 * batch is outstanding. `allResultsTerminate` accumulates pi's rule that a
 * batch ends the turn only when every result set terminate: true.
 */
const PiRun = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("idle") }),
  z.object({ phase: z.literal("streaming"), llmRequestId: z.number().int().positive() }),
  z.object({
    phase: z.literal("executing-tools"),
    allResultsTerminate: z.boolean(),
    assistantOffset: z.number().int().positive(),
    pendingToolCallIds: z.array(z.string()),
  }),
]);
type PiRun = z.infer<typeof PiRun>;

/** Compaction thresholds, pi's CompactionSettings with pi's defaults. */
const PiCompactionSettings = z.object({
  enabled: z.boolean().default(true),
  /** Tokens reserved for summary prompt and output; compaction triggers above contextWindow - reserveTokens. */
  reserveTokens: z.number().int().positive().default(16_384),
  /** Approximate recent-context tokens kept verbatim after compaction. */
  keepRecentTokens: z.number().int().positive().default(20_000),
});
type PiCompactionSettings = z.infer<typeof PiCompactionSettings>;

/** Why a compaction was requested: proactive threshold crossing, or recovery from a provider context-overflow error. */
export const PiCompactionReason = z.enum(["threshold", "overflow"]);
export type PiCompactionReason = z.infer<typeof PiCompactionReason>;

export const PiProcessorContract = defineProcessorContract({
  slug: "pi",
  version: "0.1.0",
  description:
    "Port of the badlogic/pi coding-agent loop (turn taking, steering/follow-up queues, interruption, tool calls, compaction) as a single stream processor.",
  stateSchema: z.object({
    systemPrompt: z.string().default(DEFAULT_PI_SYSTEM_PROMPT),
    model: z.string().min(1).default(DEFAULT_PI_MODEL),
    contextWindow: z.number().int().positive().default(DEFAULT_PI_CONTEXT_WINDOW),
    compactionSettings: PiCompactionSettings.prefault({}),
    history: z.array(PiHistoryEntry).default([]),
    /** User messages queued while a run is active, injected after the current turn's tool results (pi's steering queue). */
    steeringQueue: z.array(z.string()).default([]),
    /** User messages queued for when the run would otherwise stop (pi's follow-up queue). */
    followUpQueue: z.array(z.string()).default([]),
    run: PiRun.default({ phase: "idle" }),
    /** An LLM request should be issued once the run is idle and no compaction is in flight. */
    pendingTrigger: z.boolean().default(false),
    /**
     * The staleness fence for LLM requests. It advances whenever a request
     * lifecycle finishes AND whenever a request event is invalidated (an abort,
     * or a request event that reduced to a stale no-op), so an
     * llm-request-requested idempotency key — `pi/llm-request@generation:N` —
     * is spent at most once and every re-derivation of the same trigger
     * collapses into one stream event at the append dedup layer.
     */
    generation: z.number().int().nonnegative().default(0),
    /** The in-flight compaction, if any; LLM requests wait for it. */
    compaction: z
      .object({
        reason: PiCompactionReason,
        requestedOffset: z.number().int().positive(),
        /** History tail offset at request time; failures park on it (see compactionFailedForTailOffset). */
        tailOffset: z.number().int().nonnegative(),
        /** The generation when compaction was requested. An overflow-recovery completion only retriggers the LLM when this still matches — an abort in between wins. */
        generation: z.number().int().nonnegative(),
      })
      .nullable()
      .default(null),
    /** Count of finished compactions; part of the compaction-requested idempotency key so each attempt gets a fresh key. */
    compactionEpoch: z.number().int().nonnegative().default(0),
    /** Set when a compaction failed for this history tail; a new compaction is only attempted once the tail moves past it. */
    compactionFailedForTailOffset: z.number().int().nullable().default(null),
    /** pi's one-shot guard: an overflow error triggers compact-and-retry at most once until a request succeeds. */
    overflowRecoveryAttempted: z.boolean().default(false),
  }),
  events: {
    "events.iterate.com/pi/config-updated": {
      description: "Agent configuration changed; applies to future LLM requests.",
      payloadSchema: z.object({
        compactionSettings: PiCompactionSettings.partial().optional(),
        contextWindow: z.number().int().positive().optional(),
        model: z.string().min(1).optional(),
        systemPrompt: z.string().optional(),
      }),
    },
    "events.iterate.com/pi/user-message-received": {
      description:
        "A user message reached the agent. Starts a run when idle; while a run is active, `whileRunning` picks pi's steering queue (inject before the next LLM call) or follow-up queue (inject when the run would stop).",
      payloadSchema: z.object({
        text: z.string(),
        whileRunning: z.enum(["steer", "follow-up"]).default("steer"),
      }),
    },
    "events.iterate.com/pi/abort-requested": {
      description:
        "The user interrupted the agent. Clears both queues, cancels in-flight LLM/tool work, and ends the run; partial assistant output is still recorded when the provider returns it.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/pi/llm-request-requested": {
      description:
        "An LLM request is due. The event offset is the llmRequestId; the request body is the fold of history at this offset.",
      payloadSchema: z.object({
        generation: z.number().int().nonnegative(),
      }),
    },
    "events.iterate.com/pi/assistant-message-added": {
      description:
        "The LLM request finished. The message encodes success, error, and aborted-with-partial-content alike (pi's stream functions never throw), so this one event is the whole request lifecycle.",
      payloadSchema: z.object({
        llmRequestId: z.number().int().positive(),
        message: PiAssistantMessage,
      }),
    },
    "events.iterate.com/pi/tool-result-added": {
      description:
        "One tool call finished (or failed, or was synthesized after a restart lost the execution). assistantOffset identifies the assistant message whose call this answers.",
      payloadSchema: z.object({
        assistantOffset: z.number().int().positive(),
        content: z.string(),
        isError: z.boolean(),
        terminate: z.boolean().optional(),
        toolCallId: z.string(),
        toolName: z.string(),
      }),
    },
    "events.iterate.com/pi/compaction-requested": {
      description:
        "History should be summarized: the context-token estimate crossed the threshold, or a provider overflow error demands recovery.",
      payloadSchema: z.object({
        reason: PiCompactionReason,
        /** History tail offset at request time; the request's idempotency key basis. */
        tailOffset: z.number().int().nonnegative(),
      }),
    },
    "events.iterate.com/pi/compaction-completed": {
      description:
        "Compaction finished. On success the fold replaces history before firstKeptIndex with a compactionSummary entry (index-addressed: history only ever appends at the tail while a compaction is in flight, so the index is stable); an overflow-recovery success re-triggers the failed request.",
      payloadSchema: z.object({
        requestedOffset: z.number().int().positive(),
        result: z.discriminatedUnion("status", [
          z.object({
            status: z.literal("success"),
            firstKeptIndex: z.number().int().nonnegative(),
            summary: z.string(),
            tokensBefore: z.number().int().nonnegative(),
          }),
          z.object({
            status: z.literal("failure"),
            error: z.object({ message: z.string() }),
          }),
        ]),
      }),
    },
  },
  consumes: [
    "events.iterate.com/pi/config-updated",
    "events.iterate.com/pi/user-message-received",
    "events.iterate.com/pi/abort-requested",
    "events.iterate.com/pi/llm-request-requested",
    "events.iterate.com/pi/assistant-message-added",
    "events.iterate.com/pi/tool-result-added",
    "events.iterate.com/pi/compaction-requested",
    "events.iterate.com/pi/compaction-completed",
  ],
  emits: [
    "events.iterate.com/pi/llm-request-requested",
    "events.iterate.com/pi/assistant-message-added",
    "events.iterate.com/pi/tool-result-added",
    "events.iterate.com/pi/compaction-requested",
    "events.iterate.com/pi/compaction-completed",
  ],
});
