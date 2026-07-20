// The clean-room agent processor CONTRACT (tasks/simplify-stream-processor-contract.md).
// Self-contained: state schema, events, consumes/emits, deps — and it OWNS
// every nested data structure (result unions, context shapes, attachments);
// consumers reach into this module for pieces, never the other way around.
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
// cutover. The slug differs (`agent-next`) so idempotency keys can never
// collide with the production processor while both exist.

import { z } from "zod";
import { defineProcessorContract, STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "iterate/processors";
import { CoreProcessorContract } from "../../streams/core-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../../capability-host/capability-host-processor-contract.ts";

// -----------------------------------------------------------------------------
// Event type names
// -----------------------------------------------------------------------------

// `as const`: non-widening literals, so event inputs built OUTSIDE an append
// call (helper thunks) keep their literal `type` and stay assignable to the
// contract's typed input union.
export const AGENT_CREATED = "events.iterate.com/agent/created" as const;
export const AGENT_CONFIGURED = "events.iterate.com/agent/configured" as const;
export const AGENT_CONTEXT_ADDED = "events.iterate.com/agents/context-added" as const;
export const AGENT_LLM_REQUEST_REQUESTED =
  "events.iterate.com/agent/llm-request-requested" as const;
export const AGENT_LLM_REQUEST_SETTLED = "events.iterate.com/agent/llm-request-settled" as const;
export const AGENT_LLM_RESPONSE_CHUNK = "events.iterate.com/agent/llm-response-chunk" as const;
export const AGENT_LOOP_STOPPED = "events.iterate.com/agent/loop-stopped" as const;

export const SCRIPT_RUN_REQUESTED =
  "events.iterate.com/capability-host/script-run-requested" as const;
export const SCRIPT_RUN_SETTLED = "events.iterate.com/capability-host/script-run-settled" as const;

// -----------------------------------------------------------------------------
// Tuning constants
// -----------------------------------------------------------------------------

/** Debounce window before a desired turn journals its intent: long enough to
 * coalesce a burst of context events that arrive together (a message plus its
 * attachments, a script result fan-in), short enough to be invisible next to
 * LLM latency. Measured from the FIRST uncovered trigger — continuous input
 * cannot delay a turn indefinitely. */
export const AGENT_LLM_REQUEST_DEBOUNCE_MS = 250;

/** How long a journaled intent stays runnable. Past this the processor settles it
 * `failed` instead of running it: answering a ten-minute-old message with a
 * context snapshot from then does more harm than admitting the miss. Also the
 * per-attempt transport deadline, so an attempt can never outlive its intent. */
export const AGENT_LLM_REQUEST_EXPIRY_MS = 10 * 60_000;

/** Base spacing for failure retries; doubles per consecutive failure. Added
 * INTO the debounce window, so backoff and coalescing are one mechanism. */
export const AGENT_LLM_RETRY_BACKOFF_BASE_MS = 10_000;

/** Backoff ceiling (6 × base = 60s) — also the fixed spacing once a failure
 * streak is rate-limit weather (429s clear per-minute, not per-doubling). */
export const AGENT_LLM_RETRY_BACKOFF_MAX_MS = 6 * AGENT_LLM_RETRY_BACKOFF_BASE_MS;

/** Give up retrying after this many consecutive non-rate-limit failures: three
 * distinct attempts failing means the request itself is the problem. */
export const MAX_CONSECUTIVE_LLM_FAILURES = 3;

/** Rate-limit weather gets more patience than real failures — seven attempts
 * at 60s spacing spans several limiter windows before giving up. */
export const MAX_CONSECUTIVE_RATE_LIMITED_LLM_FAILURES = 7;

/** Circuit breaker on self-driven turn chains (scripts/agents triggering the
 * next turn): a hundred autonomous turns without a human is a loop, not work. */
export const MAX_AUTONOMOUS_TURNS = 100;

/** Script results longer than this are truncated in rendered context — big
 * payloads belong in files the next script reads, not in the prompt. */
export const SCRIPT_RESULT_HISTORY_LIMIT = 30_000;

/** Prefix marking capability-host executions THIS processor requested, so it
 * only renders settlements for its own scripts. Distinct from the production
 * agent's prefix — the two must never claim each other's executions. */
export const AGENT_SCRIPT_EXECUTION_ID_PREFIX = "agent-next:";

/** The keyed system-lane slot holding the canonical system prompt. */
export const AGENT_SYSTEM_PROMPT_CONTEXT_KEY = "agent/system-prompt";

// -----------------------------------------------------------------------------
// Nested shapes (owned here — reach in for pieces)
// -----------------------------------------------------------------------------

/** A file riding on a context item: storage path plus the signed URL minted at
 * attach time (stored, not re-minted, so history stays deterministic). */
export const AgentNextFileAttachment = z.object({
  contentType: z.string(),
  filename: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string(),
});
export type AgentNextFileAttachment = z.infer<typeof AgentNextFileAttachment>;

/** What an incoming context item does to the turn loop. The interrupt
 * behaviour is the ONLY cancel mechanism: cancellation is a property of new
 * input, never a free-standing command. */
export const LlmRequestPolicy = z
  .discriminatedUnion("behaviour", [
    z.object({ behaviour: z.literal("dont-trigger-request") }),
    z.object({ behaviour: z.literal("interrupt-current-request") }),
    z.object({ behaviour: z.literal("after-current-request") }),
  ])
  .default({ behaviour: "after-current-request" });
export type LlmRequestPolicy = z.infer<typeof LlmRequestPolicy>;

export const AgentUserContextActor = z.object({
  type: z.literal("user"),
  origin: z.enum(["web", "mcp"]),
});

/** Who supplied a developer-role item. Anything that is not the agent itself
 * or its own script is DEMOTED to user role at prompt time (trust boundary:
 * integration text must not read as instructions). */
export const AgentDeveloperContextActor = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent"), path: z.string() }),
  z.object({ type: z.literal("script"), executionId: z.string() }),
  z.object({ type: z.literal("integration"), name: z.string() }),
]);
export type AgentDeveloperContextActor = z.infer<typeof AgentDeveloperContextActor>;

const AgentContextCommon = {
  content: z.string(),
  /** Stable logical identity within a lane: a keyed item REPLACES its
   * unpublished projection slot instead of appending a new occurrence. */
  key: z.string().min(1).optional(),
  files: z.array(AgentNextFileAttachment).optional(),
};

/**
 * The single source of truth for model-visible context — modeled on the
 * production payload. System items live in the compaction-immune prefix;
 * every other role lives in chronological history.
 */
export const AgentNextContextAddedPayload = z.discriminatedUnion("role", [
  z.object({ ...AgentContextCommon, role: z.literal("system") }).strict(),
  z
    .object({
      ...AgentContextCommon,
      role: z.literal("developer"),
      actor: AgentDeveloperContextActor.optional(),
      llmRequestPolicy: LlmRequestPolicy,
    })
    .strict(),
  z
    .object({
      ...AgentContextCommon,
      role: z.literal("user"),
      actor: AgentUserContextActor.optional(),
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
 * keyed update supersedes. */
export const AgentProjectedContextItem = z.object({
  offset: z.number().int().positive(),
  updatesOffset: z.number().int().positive().optional(),
  payload: AgentNextContextAddedPayload,
});
export type AgentProjectedContextItem = z.infer<typeof AgentProjectedContextItem>;

export const LlmRequestUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
});
export type LlmRequestUsage = z.infer<typeof LlmRequestUsage>;

/**
 * The terminal state of one LLM request — ONE settled event per request, with
 * the outcome in this union (promise vocabulary; cancellation is a way the
 * obligation settles, so the settle idempotency key and the stale-settlement
 * fold-guard cover all three kinds with the same code).
 */
export const LlmRequestResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    /** The assistant's text — ALSO carried by the atomically-appended
     * assistant context item; kept here so the settled event alone tells the
     * whole story of the request. */
    text: z.string(),
    usage: LlmRequestUsage.optional(),
    rawResponse: z.unknown().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    errorMessage: z.string(),
    /** Rate-limit weather retries with more patience than real failures. */
    rateLimited: z.boolean(),
    rawResponse: z.unknown().optional(),
  }),
  z.object({
    status: z.literal("cancelled"),
    reason: z.enum(["interrupted-by-user-input", "expired"]),
    /** Whatever streamed before the abort — preserved for the conversation. */
    partialText: z.string().optional(),
  }),
]);
export type LlmRequestResult = z.infer<typeof LlmRequestResult>;

export const AgentNextConfig = z.object({
  llm: z.object({ model: z.string() }),
});
export type AgentNextConfig = z.infer<typeof AgentNextConfig>;

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

export const AgentNextState = z.object({
  /** Existence marker: null until `agent/created` folds. */
  birthCertificate: z
    .object({ createdAtOffset: z.number().int().positive() })
    .nullable()
    .default(null),
  /** Wholesale-set by `agent/configured` (no merge semantics). */
  config: AgentNextConfig.nullable().default(null),
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
   * The current desire for a turn: journal coordinates of the trigger (newest
   * uncovered input, or a rendered failure warranting a retry). null =
   * satisfied. The timestamp anchors the debounce window; the offset derives
   * every related idempotency key; the source feeds the autonomous-loop
   * breaker.
   */
  wantsTurnSince: z
    .object({
      offset: z.number().int().positive(),
      atMs: z.number(),
      source: z.enum(["user", "agent-loop"]),
    })
    .nullable()
    .default(null),
  /**
   * The one open obligation: a turn whose INTENT is journaled. null = nothing
   * owed. This is the whole recoverability story — the intent lives in the
   * journal, not in a closure, so any incarnation that folds the journal
   * knows what is owed regardless of who died in between.
   */
  openRequest: z
    .object({
      requestedAtOffset: z.number().int().positive(),
      expiresAt: z.number(),
      model: z.string(),
    })
    .nullable()
    .default(null),
  /** Failures since the last success; drives retry backoff and the give-up cap. */
  consecutiveLlmFailures: z.number().int().nonnegative().default(0),
  lastLlmFailureRateLimited: z.boolean().default(false),
  /** Consecutive agent-loop-triggered turns; reset by any user trigger. */
  autonomousTurnCount: z.number().int().nonnegative().default(0),
  /** Capability-host executions this agent requested and has not seen settle. */
  activeScriptExecutionIds: z.array(z.string()).default([]),
});
export type AgentNextState = z.infer<typeof AgentNextState>;

// -----------------------------------------------------------------------------
// Contract
// -----------------------------------------------------------------------------

export const AgentNextProcessorContract = defineProcessorContract({
  slug: "agent-next",
  version: "0.1.0",
  description:
    "Clean-room agent processor: context in, debounced offset-identified LLM requests out, " +
    "script execution through the capability host, adopt-based recovery.",
  stateSchema: AgentNextState,
  processorDeps: [CapabilityHostProcessorContract, CoreProcessorContract],
  events: {
    [AGENT_CREATED]: {
      description: "The agent exists. Payload is open — provenance may ride along.",
      payloadSchema: z.looseObject({}),
    },
    [AGENT_CONFIGURED]: {
      description: "Wholesale-replaces the agent's configuration.",
      payloadSchema: z.object({ config: AgentNextConfig }),
    },
    [AGENT_CONTEXT_ADDED]: {
      description:
        "Model-visible context arrived (user message, developer note, assistant output, system slot).",
      payloadSchema: AgentNextContextAddedPayload,
    },
    [AGENT_LLM_REQUEST_REQUESTED]: {
      description:
        "The journaled INTENT to run one LLM turn. Carries no id: the request's identity is the " +
        "offset this event gets on commit. The fold ignores it when no desire is open or a " +
        "request already is — a late debounced intent is a harmless journal fact.",
      payloadSchema: z.object({
        model: z.string(),
        /** Absolute epoch-ms horizon: past it the request settles cancelled/expired instead of running. */
        expiresAt: z.number(),
      }),
    },
    [AGENT_LLM_REQUEST_SETTLED]: {
      description:
        "The ONE terminal fact for an LLM request (succeeded | failed | cancelled), pointing back " +
        "at the requested event's offset. Idempotency-keyed on that offset, so a zombie driver " +
        "racing a fresh incarnation or an interrupt collapses to one settlement.",
      payloadSchema: z.object({
        requestOffset: z.number().int().positive(),
        durationMs: z.number().int().nonnegative().optional(),
        result: LlmRequestResult,
      }),
    },
    [AGENT_LLM_RESPONSE_CHUNK]: {
      description: "Ephemeral streaming of an in-flight response; never folded, never replayed.",
      payloadSchema: z.object({
        requestOffset: z.number().int().positive(),
        sequence: z.number().int().nonnegative(),
        text: z.string(),
      }),
    },
    [AGENT_LOOP_STOPPED]: {
      description:
        "The autonomous-turn circuit breaker fired: the pending self-driven trigger was dropped.",
      payloadSchema: z.object({
        maxAutonomousTurns: z.number().int().positive(),
        triggerOffset: z.number().int().positive(),
      }),
    },
  },
  consumes: [
    AGENT_CREATED,
    AGENT_CONFIGURED,
    AGENT_CONTEXT_ADDED,
    AGENT_LLM_REQUEST_REQUESTED,
    AGENT_LLM_REQUEST_SETTLED,
    AGENT_LOOP_STOPPED,
    SCRIPT_RUN_REQUESTED,
    SCRIPT_RUN_SETTLED,
    // The platform revival fact: its ordinary delivery at head is the
    // guaranteed turn where processEvent finds and re-runs orphaned work after an eviction.
    STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  ],
  emits: [
    AGENT_CONTEXT_ADDED,
    AGENT_LLM_REQUEST_REQUESTED,
    AGENT_LLM_REQUEST_SETTLED,
    AGENT_LLM_RESPONSE_CHUNK,
    AGENT_LOOP_STOPPED,
    SCRIPT_RUN_REQUESTED,
  ],
});
export type AgentNextProcessorContract = typeof AgentNextProcessorContract;
