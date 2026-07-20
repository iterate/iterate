// The clean-room agent processor CONTRACT (tasks/simplify-stream-processor-contract.md).
// Self-contained: state schema, events, consumes/emits, deps — and it OWNS
// every nested data structure (result unions, context shapes, attachments);
// consumers reach into this module for pieces, never the other way around.
// Schemas are spelled INLINE in the contract; a schema is only declared
// outside when the contract itself uses it twice.
//
// No synthetic ids anywhere: the journal already assigns every event a
// unique, ordered identity — its offset. An LLM request IS its
// `llm-request-requested` event, named by the offset the journal gave it on
// commit; settlements point back with that offset, and idempotency keys are
// derived from offsets.
//
// Event NAMES are shared with the production agent contract wherever the
// semantics are identical (`agents/context-added`, `agent/llm-request-requested`,
// `agent/llm-response-chunk`, ...) so existing journals remain meaningful on
// cutover — this processor REPLACES the production one. The slug differs
// (`agent-next`) only so idempotency keys cannot collide during the cutover
// window.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { CoreProcessorContract } from "../../streams/core-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../../capability-host/capability-host-processor-contract.ts";

/**
 * The agent's complete configuration, every knob defaulted — the reduced
 * state's `config` slot starts as `AgentNextConfig.parse({})` and
 * `agent/configured` events merge partial patches into it (the default-free
 * patch shape is spelled inline in that event's schema).
 */
export const AgentNextConfig = z.object({
  llm: z
    .object({ model: z.string().min(1).default("openai/gpt-5.6-sol") })
    .default({ model: "openai/gpt-5.6-sol" }),
  /** Debounce window before a desired turn journals its intent: long enough to
   * coalesce a burst of context events that arrive together (a message plus
   * its attachments, a script result fan-in), short enough to be invisible
   * next to LLM latency. Measured from the FIRST uncovered trigger —
   * continuous input cannot delay a turn indefinitely. */
  llmRequestDebounceMs: z.number().int().nonnegative().default(250),
  /** How long a journaled intent stays runnable. Past this the processor
   * settles it cancelled/expired instead of running it: answering a
   * ten-minute-old message with a context snapshot from then does more harm
   * than admitting the miss. Also the per-attempt transport deadline, so an
   * attempt can never outlive its intent. */
  llmRequestExpiryMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60_000),
  /** Retry policy for failed LLM requests: total attempts, plus exponential
   * backoff spacing (doubling from `backoffBaseMs`, capped at `backoffMaxMs`)
   * added INTO the debounce window so backoff and coalescing are one
   * mechanism. */
  llmRequestRetryPolicy: z
    .object({
      maxAttempts: z.number().int().positive().default(3),
      backoffBaseMs: z.number().int().nonnegative().default(10_000),
      backoffMaxMs: z.number().int().nonnegative().default(60_000),
    })
    .default({ maxAttempts: 3, backoffBaseMs: 10_000, backoffMaxMs: 60_000 }),
  /** Circuit breaker on self-driven turn chains (scripts/agents triggering the
   * next turn): this many autonomous turns without a human pauses the agent
   * (`agent/paused`); the next user message resumes it. */
  maxAutonomousTurns: z.number().int().positive().default(100),
  /** Script results longer than this are truncated in rendered context — big
   * payloads belong in files the next script reads, not in the prompt. */
  scriptResultHistoryLimit: z.number().int().positive().default(30_000),
});
export type AgentNextConfig = z.infer<typeof AgentNextConfig>;

/** What an incoming context item does to the turn loop. The interrupt
 * behaviour is the ONLY cancel mechanism: cancellation is a property of new
 * input, never a free-standing command. Declared outside the contract because
 * two arms of the context-added payload union use it. */
export const LlmRequestPolicy = z
  .discriminatedUnion("behaviour", [
    z.object({ behaviour: z.literal("dont-trigger-request") }),
    z.object({ behaviour: z.literal("interrupt-current-request") }),
    z.object({ behaviour: z.literal("after-current-request") }),
  ])
  .default({ behaviour: "after-current-request" });
export type LlmRequestPolicy = z.infer<typeof LlmRequestPolicy>;

const AgentContextCommon = {
  content: z.string(),
  /** Stable logical identity within a lane: a keyed item REPLACES its
   * unpublished projection slot instead of appending a new occurrence. */
  key: z.string().min(1).optional(),
  /** Files riding on the item: storage path plus the signed URL minted at
   * attach time (stored, not re-minted, so history stays deterministic). */
  files: z
    .array(
      z.object({
        contentType: z.string(),
        filename: z.string(),
        path: z.string(),
        size: z.number().int().nonnegative(),
        url: z.string(),
      }),
    )
    .optional(),
};

/**
 * The single source of truth for model-visible context — modeled on the
 * production payload. System items live in the compaction-immune prefix;
 * every other role lives in chronological history. Declared outside the
 * contract because the contract uses it twice: as the `agents/context-added`
 * payload and inside the reduced state's projected items.
 */
export const AgentNextContextAddedPayload = z.discriminatedUnion("role", [
  z.object({ ...AgentContextCommon, role: z.literal("system") }).strict(),
  z
    .object({
      ...AgentContextCommon,
      role: z.literal("developer"),
      /** Who supplied this item. Anything that is not the agent itself or its
       * own script is DEMOTED to user role at prompt time (trust boundary:
       * integration text must not read as instructions). */
      actor: z
        .discriminatedUnion("type", [
          z.object({ type: z.literal("agent"), path: z.string() }),
          z.object({ type: z.literal("script"), executionId: z.string() }),
          z.object({ type: z.literal("integration"), name: z.string() }),
        ])
        .optional(),
      llmRequestPolicy: LlmRequestPolicy,
    })
    .strict(),
  z
    .object({
      ...AgentContextCommon,
      role: z.literal("user"),
      actor: z.object({ type: z.literal("user"), origin: z.enum(["web", "mcp"]) }).optional(),
      llmRequestPolicy: LlmRequestPolicy,
    })
    .strict(),
  z
    .object({
      ...AgentContextCommon,
      role: z.literal("assistant"),
      /** Offset of the `llm-request-requested` event this output answers. The
       * fold IGNORES an assistant item whose request is no longer the open one
       * — that guard is what closes the interrupt-vs-settle race. */
      llmRequestOffset: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type AgentNextContextAddedPayload = z.infer<typeof AgentNextContextAddedPayload>;

/** A context item as projected into state: the payload plus its journal
 * coordinates. `updatesOffset` back-references the published occurrence a
 * keyed update supersedes. Used twice in the reduced state (system lane and
 * history lane). */
export const AgentProjectedContextItem = z.object({
  offset: z.number().int().positive(),
  updatesOffset: z.number().int().positive().optional(),
  payload: AgentNextContextAddedPayload,
});
export type AgentProjectedContextItem = z.infer<typeof AgentProjectedContextItem>;

export const AgentNextProcessorContract = defineProcessorContract({
  slug: "agent-next",
  version: "0.2.0",
  description:
    "Clean-room agent processor: context in, debounced offset-identified LLM requests out, " +
    "script execution through the capability host, adopt-based recovery.",
  stateSchema: z.object({
    /** Existence marker: null until `agent/created` folds. No turns run before it. */
    birthCertificate: z
      .object({ createdAtOffset: z.number().int().positive() })
      .nullable()
      .default(null),
    /** Complete configuration, never null: starts as the schema defaults,
     * `agent/configured` merges partial patches in. */
    config: AgentNextConfig.prefault({}),
    /** The conversation fold. `publishedThrough` marks the highest offset a
     * turn has covered — keyed items past it append occurrences instead of
     * replacing in place. */
    context: z
      .object({
        system: z.array(AgentProjectedContextItem).default([]),
        history: z.array(AgentProjectedContextItem).default([]),
        publishedThrough: z.number().int().nonnegative().default(0),
      })
      .default({ system: [], history: [], publishedThrough: 0 }),
    /**
     * The trigger the next LLM request will answer: journal coordinates of the
     * newest input (or retry-worthy failure) no request has covered yet. null =
     * every trigger is covered. The timestamp anchors the debounce window; the
     * offset derives the intent's idempotency key; the source feeds the
     * autonomous-loop breaker.
     */
    pendingLlmRequestTrigger: z
      .object({
        offset: z.number().int().positive(),
        atMs: z.number(),
        source: z.enum(["user", "agent-loop"]),
      })
      .nullable()
      .default(null),
    /**
     * The one open LLM request: a turn whose INTENT is journaled. null =
     * nothing owed. This is the whole recoverability story — the intent lives
     * in the journal, not in a closure, so any incarnation that folds the
     * journal knows what is owed regardless of who died in between. At most
     * one request is ever open: a new intent folds to nothing while this is
     * set.
     */
    openRequest: z
      .object({
        requestedAtOffset: z.number().int().positive(),
        expiresAt: z.number(),
        model: z.string(),
      })
      .nullable()
      .default(null),
    /** Failures since the last success; drives retry backoff and the give-up
     * cap. Reset by a success or by fresh user input. */
    consecutiveLlmFailures: z.number().int().nonnegative().default(0),
    /** Set while `agent/paused` is in force (autonomous-loop breaker). The
     * next user message resumes; self-driven triggers stay parked. */
    paused: z
      .object({ reason: z.string().optional(), atOffset: z.number().int().positive() })
      .nullable()
      .default(null),
    /** Consecutive agent-loop-triggered turns; reset by any user trigger and
     * by `agent/resumed`. */
    autonomousTurnCount: z.number().int().nonnegative().default(0),
    /** Capability-host executions this agent requested and has not seen settle. */
    activeScriptExecutionIds: z.array(z.string()).default([]),
  }),
  processorDeps: [CapabilityHostProcessorContract, CoreProcessorContract],
  events: {
    "events.iterate.com/agent/created": {
      description: "The agent exists. Payload is open — provenance may ride along.",
      payloadSchema: z.looseObject({}),
    },
    "events.iterate.com/agent/configured": {
      description:
        "Merges a partial configuration into the agent's config; omitted keys keep their current values.",
      payloadSchema: z.object({
        // The default-FREE twin of AgentNextConfig: zod's .partial() keeps
        // field defaults (a patch built from it would resurrect defaults for
        // omitted keys and clobber configured values on merge), so the patch
        // shape is spelled out without them.
        config: z
          .object({
            llm: z.object({ model: z.string().min(1) }).optional(),
            llmRequestDebounceMs: z.number().int().nonnegative().optional(),
            llmRequestExpiryMs: z.number().int().positive().optional(),
            llmRequestRetryPolicy: z
              .object({
                maxAttempts: z.number().int().positive(),
                backoffBaseMs: z.number().int().nonnegative(),
                backoffMaxMs: z.number().int().nonnegative(),
              })
              .partial()
              .optional(),
            maxAutonomousTurns: z.number().int().positive().optional(),
            scriptResultHistoryLimit: z.number().int().positive().optional(),
          })
          .strict(),
      }),
    },
    "events.iterate.com/agents/context-added": {
      description:
        "Model-visible context arrived (user message, developer note, assistant output, system slot).",
      payloadSchema: AgentNextContextAddedPayload,
    },
    "events.iterate.com/agent/llm-request-requested": {
      description:
        "The journaled INTENT to run one LLM turn. Carries no id: the request's identity is the " +
        "offset this event gets on commit. The fold ignores it when no trigger is pending or a " +
        "request already is open — a late debounced intent is a harmless journal fact.",
      payloadSchema: z.object({
        model: z.string(),
        /** Absolute epoch-ms horizon: past it the request settles cancelled/expired instead of running. */
        expiresAt: z.number(),
      }),
    },
    "events.iterate.com/agent/llm-request-settled": {
      description:
        "The ONE terminal fact for an LLM request (succeeded | failed | cancelled), pointing back " +
        "at the requested event's offset. Idempotency-keyed on that offset, so a zombie driver " +
        "racing a fresh incarnation or an interrupt collapses to one settlement.",
      payloadSchema: z.object({
        requestOffset: z.number().int().positive(),
        durationMs: z.number().int().nonnegative().optional(),
        result: z.discriminatedUnion("status", [
          z.object({
            status: z.literal("succeeded"),
            /** The assistant's text — ALSO carried by the atomically-appended
             * assistant context item; kept here so the settled event alone
             * tells the whole story of the request. */
            text: z.string(),
            usage: z
              .object({
                inputTokens: z.number().int().nonnegative(),
                outputTokens: z.number().int().nonnegative(),
                cachedInputTokens: z.number().int().nonnegative().optional(),
                reasoningOutputTokens: z.number().int().nonnegative().optional(),
              })
              .optional(),
            rawResponse: z.unknown().optional(),
          }),
          z.object({
            status: z.literal("failed"),
            errorMessage: z.string(),
            rawResponse: z.unknown().optional(),
          }),
          z.object({
            status: z.literal("cancelled"),
            reason: z.enum(["interrupted-by-user-input", "expired"]),
            /** Whatever streamed before the abort — preserved for the conversation. */
            partialText: z.string().optional(),
          }),
        ]),
      }),
    },
    "events.iterate.com/agent/llm-response-chunk": {
      description: "Ephemeral streaming of an in-flight response; never folded, never replayed.",
      // FORCIBLY EPHEMERAL: the contract, not the append site, decides.
      // Every append/parse lane built from this definition defaults the
      // envelope's `ephemeral` flag to true and REJECTS `ephemeral: false`,
      // so a chunk can never become a durable journal fact by accident.
      ephemeral: true,
      payloadSchema: z.object({
        requestOffset: z.number().int().positive(),
        sequence: z.number().int().nonnegative(),
        text: z.string(),
      }),
    },
    "events.iterate.com/agent/paused": {
      description:
        "The agent stopped scheduling turns (autonomous-loop breaker, or an operator). Mirrors " +
        "stream/paused. The next user message resumes it; self-driven triggers stay parked.",
      payloadSchema: z.object({
        reason: z.string().trim().min(1).optional(),
      }),
    },
    "events.iterate.com/agent/resumed": {
      description: "The agent resumed scheduling turns. Mirrors stream/resumed.",
      payloadSchema: z.object({
        reason: z.string().trim().min(1).optional(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/agent/created",
    "events.iterate.com/agent/configured",
    "events.iterate.com/agents/context-added",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-settled",
    "events.iterate.com/agent/paused",
    "events.iterate.com/agent/resumed",
    "events.iterate.com/capability-host/script-run-requested",
    "events.iterate.com/capability-host/script-run-settled",
    // Every error on the stream — the processor's own emissions, the runner's
    // poison skips, anything else — is transcribed into model-visible context.
    "events.iterate.com/stream/error-occurred",
    // The platform revival fact: its ordinary delivery at head is the
    // guaranteed turn where processEvent finds and re-runs orphaned work after
    // an eviction.
    "events.iterate.com/stream/processor-revived",
  ],
  emits: [
    "events.iterate.com/agents/context-added",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-settled",
    "events.iterate.com/agent/llm-response-chunk",
    "events.iterate.com/agent/paused",
    "events.iterate.com/agent/resumed",
    "events.iterate.com/capability-host/script-run-requested",
    "events.iterate.com/stream/error-occurred",
  ],
});
export type AgentNextProcessorContract = typeof AgentNextProcessorContract;

export type AgentNextState = z.output<typeof AgentNextProcessorContract.stateSchema>;
