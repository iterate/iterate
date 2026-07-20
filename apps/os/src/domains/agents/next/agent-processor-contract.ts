// The clean-room agent processor CONTRACT (tasks/simplify-stream-processor-contract.md).
// Self-contained: state schema, events, consumes/emits, deps — and it OWNS
// every nested data structure; consumers reach into this module for pieces,
// never the other way around. Schemas are spelled INLINE in the contract; the
// ONE schema the contract needs twice (the context-item payload, used by the
// `agents/context-added` event and by the reduced state's projected items) is
// a hoisted function defined below the contract, so the contract still opens
// the file.
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

export const AgentNextProcessorContract = defineProcessorContract({
  slug: "agent-next",
  version: "0.3.0",
  description:
    "Clean-room agent processor: context in, debounced offset-identified LLM requests out, " +
    "script execution through the capability host, adopt-based recovery.",
  stateSchema: z.object({
    birthCertificate: z
      .object({
        createdAtOffset: z
          .number()
          .int()
          .positive()
          .meta({ description: "Offset of the agent/created event." }),
      })
      .nullable()
      .default(null)
      .meta({
        description: "Existence marker: null until agent/created folds. No turns run before it.",
      }),
    // The complete configuration, every knob defaulted. `.prefault({})` is
    // core zod 4 (not a patch): unlike `.default(value)`, which returns the
    // value AS-IS when the input is absent, prefault PARSES it — so the empty
    // fold runs `{}` through the schema and every nested knob default fills
    // in. `agent/configured` merges partial patches (omitted keys keep their
    // values); the implementation re-validates merges through
    // `AgentNextProcessorContract.stateSchema.shape.config`.
    config: z
      .object({
        llm: z
          .object({
            model: z
              .string()
              .min(1)
              .default("openai/gpt-5.6-sol")
              .meta({ description: "Model identifier passed to the LLM transport." }),
          })
          .default({ model: "openai/gpt-5.6-sol" })
          .meta({ description: "LLM transport selection." }),
        llmRequestDebounceMs: z
          .number()
          .int()
          .nonnegative()
          .default(250)
          .meta({
            description:
              "Debounce window before a pending trigger journals its turn intent: long enough " +
              "to coalesce a burst of context events that arrive together (a message plus its " +
              "attachments, a script result fan-in), short enough to be invisible next to LLM " +
              "latency. Measured from the FIRST uncovered trigger — continuous input cannot " +
              "delay a turn indefinitely.",
          }),
        llmRequestExpiryMs: z
          .number()
          .int()
          .positive()
          .default(10 * 60_000)
          .meta({
            description:
              "How long a journaled intent stays runnable, measured from its trigger. Past " +
              "this the processor settles it cancelled/expired instead of running it: " +
              "answering a ten-minute-old message with a context snapshot from then does more " +
              "harm than admitting the miss. Also the per-attempt transport deadline, so an " +
              "attempt can never outlive its intent.",
          }),
        llmRequestRetryPolicy: z
          .object({
            maxAttempts: z
              .number()
              .int()
              .positive()
              .default(3)
              .meta({ description: "Total attempts before giving up on a turn." }),
            backoffBaseMs: z.number().int().nonnegative().default(10_000).meta({
              description: "Backoff spacing after the first failure; doubles per failure.",
            }),
            backoffMaxMs: z
              .number()
              .int()
              .nonnegative()
              .default(60_000)
              .meta({ description: "Backoff ceiling." }),
          })
          .default({ maxAttempts: 3, backoffBaseMs: 10_000, backoffMaxMs: 60_000 })
          .meta({
            description:
              "Retry policy for failed LLM requests. Backoff is added INTO the debounce " +
              "window, so backoff and coalescing are one mechanism.",
          }),
        maxAutonomousTurns: z
          .number()
          .int()
          .positive()
          .default(100)
          .meta({
            description:
              "Circuit breaker on self-driven turn chains (scripts/agents triggering the next " +
              "turn): this many autonomous turns without external input journals agent/paused; " +
              "the next external message resumes.",
          }),
        scriptResultHistoryLimit: z
          .number()
          .int()
          .positive()
          .default(30_000)
          .meta({
            description:
              "Script results longer than this are truncated in rendered context — big " +
              "payloads belong in files the next script reads, not in the prompt.",
          }),
      })
      .prefault({})
      .meta({ description: "The agent's complete configuration, every knob defaulted." }),
    contextItems: z
      .array(
        z.object({
          offset: z.number().int().positive().meta({
            description: "Journal offset of the context-added event this item folded from.",
          }),
          payload: agentContextItemSchema(),
        }),
      )
      .default([])
      .meta({
        description:
          "The conversation fold: ONE ordered list of every model-visible item (system items " +
          "sit in place — providers accept system/developer content mid-history). A keyed item " +
          "no request has covered yet is replaced in place by an update with the same key; a " +
          "covered one appends a new occurrence (see lastLlmRequestOffset).",
      }),
    lastLlmRequestOffset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .meta({
        description:
          "Offset of the newest llm-request-requested event. Context items at or below it " +
          "have been covered by a request: a keyed update to a covered item appends instead " +
          "of replacing in place, keeping every covered prompt reconstructible.",
      }),
    pendingLlmRequestTrigger: z
      .object({
        offset: z.number().int().positive().meta({
          description: "Offset of the triggering event; derives the intent's idempotency key.",
        }),
        atMs: z.number().meta({
          description: "Trigger time (epoch ms); anchors the debounce window and expiry.",
        }),
        source: z.enum(["external", "agent-loop"]).meta({
          description:
            "external = anything outside the loop (user, webhook, integration); agent-loop " +
            "= the agent's own notes/scripts. Feeds the autonomous-turn breaker.",
        }),
      })
      .nullable()
      .default(null)
      .meta({
        description:
          "The trigger the next LLM request will answer: coordinates of the newest input (or " +
          "retry-worthy failure) no request has covered yet. null = every trigger is covered.",
      }),
    openRequest: z
      .object({
        requestedAtOffset: z.number().int().positive().meta({
          description: "The request's identity: the offset of its llm-request-requested event.",
        }),
        expiresAt: z.number().meta({
          description: "Epoch-ms horizon; past it the request settles cancelled/expired.",
        }),
        model: z.string().meta({ description: "Model pinned at intent time." }),
      })
      .nullable()
      .default(null)
      .meta({
        description:
          "The one open LLM request: a turn whose INTENT is journaled. null = nothing owed. " +
          "This is the whole recoverability story — the intent lives in the journal, not in a " +
          "closure, so any incarnation that folds the journal knows what is owed regardless " +
          "of who died in between. At most one request is ever open: a new intent folds to " +
          "nothing while this is set.",
      }),
    consecutiveLlmFailures: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .meta({
        description:
          "Failures since the last success; drives retry backoff and the give-up cap. Reset " +
          "by a success or by fresh external input.",
      }),
    paused: z
      .object({
        reason: z.string().optional().meta({ description: "Why the loop paused." }),
        atOffset: z
          .number()
          .int()
          .positive()
          .meta({ description: "Offset of the agent/paused event." }),
      })
      .nullable()
      .default(null)
      .meta({
        description:
          "Set while agent/paused is in force (autonomous-loop breaker, or an operator). The " +
          "next external message resumes; self-driven triggers stay parked.",
      }),
    autonomousTurnCount: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .meta({
        description:
          "Consecutive agent-loop-triggered turns; reset by any external trigger and by " +
          "agent/resumed.",
      }),
    activeScriptExecutionIds: z.array(z.string()).default([]).meta({
      description: "Capability-host executions this agent requested and has not seen settle.",
    }),
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
        // The default-FREE twin of the state's config schema: zod's
        // `.partial()` keeps field defaults (a patch built from it would
        // resurrect defaults for omitted keys and clobber configured values
        // on merge), so the patch shape is spelled out without them. Per-knob
        // docs live on the state schema's config.
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
          .strict()
          .meta({ description: "Partial patch, deep-merged into the current config." }),
      }),
    },
    "events.iterate.com/agents/context-added": {
      description:
        "Model-visible context arrived (user message, developer note, assistant output, system item).",
      payloadSchema: agentContextItemSchema(),
    },
    "events.iterate.com/agent/llm-request-requested": {
      description:
        "The journaled INTENT to run one LLM turn. Carries no id: the request's identity is the " +
        "offset this event gets on commit. The fold ignores it when no trigger is pending or a " +
        "request already is open — a late debounced intent is a harmless journal fact.",
      payloadSchema: z.object({
        model: z.string().meta({ description: "Model pinned for this turn." }),
        expiresAt: z.number().meta({
          description:
            "Absolute epoch-ms horizon (trigger time + llmRequestExpiryMs — deterministic, " +
            "so concurrent schedulings of the same trigger dedupe on the idempotency key): " +
            "past it the request settles cancelled/expired instead of running.",
        }),
      }),
    },
    "events.iterate.com/agent/llm-request-settled": {
      description:
        "The ONE terminal fact for an LLM request (succeeded | failed | cancelled), pointing back " +
        "at the requested event's offset. Idempotency-keyed on that offset, so a zombie driver " +
        "racing a fresh incarnation or an interrupt collapses to one settlement.",
      payloadSchema: z.object({
        requestOffset: z.number().int().positive().meta({
          description: "The settled request: the offset of its llm-request-requested event.",
        }),
        durationMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .meta({ description: "Wall-clock duration of the settling attempt." }),
        result: z
          .discriminatedUnion("status", [
            z.object({
              status: z.literal("succeeded"),
              text: z.string().meta({
                description:
                  "The assistant's text — ALSO carried by the atomically-appended assistant " +
                  "context item; kept here so the settled event alone tells the whole story.",
              }),
              usage: z
                .object({
                  inputTokens: z.number().int().nonnegative(),
                  outputTokens: z.number().int().nonnegative(),
                  cachedInputTokens: z.number().int().nonnegative().optional(),
                  reasoningOutputTokens: z.number().int().nonnegative().optional(),
                })
                .optional()
                .meta({ description: "Provider-reported token usage." }),
              rawResponse: z
                .unknown()
                .optional()
                .meta({ description: "Provider response verbatim." }),
            }),
            z.object({
              status: z.literal("failed"),
              errorMessage: z.string().meta({ description: "What the transport reported." }),
              rawResponse: z
                .unknown()
                .optional()
                .meta({ description: "Provider response verbatim." }),
            }),
            z.object({
              status: z.literal("cancelled"),
              reason: z
                .enum(["interrupted-by-user-input", "expired"])
                .meta({ description: "Why the request was cancelled." }),
              partialText: z.string().optional().meta({
                description: "Whatever streamed before the abort — preserved for the conversation.",
              }),
            }),
          ])
          .meta({ description: "How the request settled." }),
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
        requestOffset: z
          .number()
          .int()
          .positive()
          .meta({ description: "The in-flight request this chunk belongs to." }),
        sequence: z
          .number()
          .int()
          .nonnegative()
          .meta({ description: "Chunk ordinal within the response." }),
        text: z.string().meta({ description: "The streamed text delta." }),
      }),
    },
    "events.iterate.com/agent/paused": {
      description:
        "The agent stopped scheduling turns (autonomous-loop breaker, or an operator). Mirrors " +
        "stream/paused. The next external message resumes it; self-driven triggers stay parked.",
      payloadSchema: z.object({
        reason: z.string().trim().min(1).optional().meta({ description: "Why the loop paused." }),
      }),
    },
    "events.iterate.com/agent/resumed": {
      description: "The agent resumed scheduling turns. Mirrors stream/resumed.",
      payloadSchema: z.object({
        reason: z.string().trim().min(1).optional().meta({ description: "Why the loop resumed." }),
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
export type AgentNextContextAddedPayload = AgentNextState["contextItems"][number]["payload"];

/**
 * The context-item payload — the ONE schema the contract uses twice (the
 * `agents/context-added` event and the state's `contextItems`), so it lives in
 * this hoisted function instead of inline. One flat object for every role; the
 * role-specific fields are optional and documented per-field.
 */
function agentContextItemSchema() {
  return z
    .strictObject({
      role: z
        .enum(["system", "developer", "user", "assistant"])
        .meta({ description: "The LLM message role this item renders as." }),
      content: z.string().meta({ description: "The model-visible text." }),
      key: z
        .string()
        .min(1)
        .optional()
        .meta({
          description:
            "Stable logical identity: a keyed item no request has covered is REPLACED in " +
            "place by an update with the same key; a covered one appends a new occurrence.",
        }),
      files: z
        .array(
          z.strictObject({
            contentType: z.string().meta({ description: "MIME type." }),
            filename: z.string().meta({ description: "Original filename." }),
            path: z.string().meta({ description: "Storage path." }),
            size: z.number().int().nonnegative().meta({ description: "Size in bytes." }),
            url: z.string().meta({
              description:
                "Signed URL minted at attach time (stored, not re-minted, so history stays " +
                "deterministic).",
            }),
          }),
        )
        .optional()
        .meta({ description: "Files riding on this item." }),
      actor: z
        .discriminatedUnion("type", [
          z.object({
            type: z.literal("user"),
            origin: z
              .enum(["web", "mcp"])
              .meta({ description: "Which surface the user wrote from." }),
          }),
          z.object({
            type: z.literal("agent"),
            path: z.string().meta({ description: "The authoring agent's stream path." }),
          }),
          z.object({
            type: z.literal("script"),
            executionId: z
              .string()
              .meta({ description: "The capability-host execution that produced it." }),
          }),
          z.object({
            type: z.literal("integration"),
            name: z.string().meta({ description: "Which integration supplied it." }),
          }),
        ])
        .optional()
        .meta({
          description:
            "Who supplied this item. A developer-role item from anyone but the agent itself " +
            "or its own script is DEMOTED to user role at prompt time (trust boundary: " +
            "integration text must not read as instructions).",
        }),
      llmRequestPolicy: z
        .discriminatedUnion("behaviour", [
          z.object({ behaviour: z.literal("dont-trigger-request") }),
          z.object({ behaviour: z.literal("interrupt-current-request") }),
          z.object({ behaviour: z.literal("after-current-request") }),
        ])
        .default({ behaviour: "after-current-request" })
        .meta({
          description:
            "What this item does to the turn loop (ignored on system/assistant items). The " +
            "interrupt behaviour is the ONLY cancel mechanism: cancellation is a property of " +
            "new input, never a free-standing command.",
        }),
      llmRequestOffset: z
        .number()
        .int()
        .positive()
        .optional()
        .meta({
          description:
            "On assistant items: offset of the llm-request-requested event this output " +
            "answers. The fold IGNORES an assistant item whose request is no longer the open " +
            "one — that guard is what closes the interrupt-vs-settle race.",
        }),
    })
    .meta({
      description:
        "One model-visible context item. The single source of truth for what the LLM sees.",
    });
}
