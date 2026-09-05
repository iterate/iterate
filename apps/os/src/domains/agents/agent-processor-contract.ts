// The agent processor CONTRACT (design: tasks/simplify-stream-processor-contract.md,
// cutover: tasks/agent-processor-replacement.md). Self-contained: state schema,
// events, consumes/emits, deps — and it OWNS every nested data structure;
// consumers reach into this module for pieces, never the other way around.
// Schemas are spelled INLINE in the contract; the few schemas the contract
// needs twice (the context-item payload, file attachments, normalized token
// usage) are hoisted functions defined below the contract, so the contract
// still opens the file.
//
// No synthetic ids anywhere: the stream already assigns every event a
// unique, ordered identity — its offset. An LLM request IS its
// `llm-request-requested` event, named by the offset the stream gave it on
// commit; settlements point back with that offset, and idempotency keys are
// derived from offsets.
//
// The context-added payload is ONE flat shape for every role, and its richer
// fields are live product features: `refs` carries coordinates for retrieving
// source material on demand, the actor union names every authoring lane
// (user, agent, script, integration, slack, telegram, email, github) and
// drives the prompt-time trust demotion, and `compaction` marks the
// structural history rewrite produced by context compaction.

import { z } from "zod";
import { AgentRuntime } from "@iterate-com/shared/agent-events";
import {
  AgentMessageAttachments,
  decodeAgentMessageAttachments,
} from "@iterate-com/shared/agent-message-attachments";
import {
  defineProcessorContract,
  type ConsumedInput,
  type ProcessorState,
} from "iterate/processors";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { AgentBinding, AgentSummary, AgentSummaryUpdated } from "./agent-presence.ts";

export const AgentProcessorContract = defineProcessorContract({
  slug: "agent",
  version: "7.0.0",
  description:
    "Maintains model-visible history, schedules debounced offset-identified LLM turns, runs " +
    "them through the Workers AI transport, and executes scripts through the capability host. " +
    "Response interpretation is a config flag (interpretResponses) — off, project " +
    "code parses assistant output and appends the consequences itself.",
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
        description: "Existence marker: null until agent/created reduces. No turns run before it.",
      }),
    // The complete configuration, every knob defaulted. `.prefault({})` is
    // core zod 4 (not a patch): unlike `.default(value)`, which returns the
    // value AS-IS when the input is absent, prefault PARSES it — so the empty
    // reduction runs `{}` through the schema and every nested knob default fills
    // in. `agent/configured` merges partial patches (omitted keys keep their
    // values); the implementation re-validates merges through
    // `AgentProcessorContract.stateSchema.shape.config`.
    config: z
      .object({
        llm: z
          .object({
            model: z
              .string()
              .min(1)
              .default("openai/gpt-5.6-terra")
              .meta({ description: "Model identifier passed to the LLM transport." }),
          })
          .default({ model: "openai/gpt-5.6-terra" })
          .meta({ description: "LLM transport selection." }),
        llmRequestDebounceMs: z
          .number()
          .int()
          .nonnegative()
          .default(250)
          .meta({
            description:
              "Debounce window before a pending trigger records its turn intent: long enough " +
              "to coalesce a burst of context events that arrive together (a message plus its " +
              "attachments, a script result fan-in), short enough to be invisible next to LLM " +
              "latency. Anchored at the NEWEST uncovered trigger (each new input re-opens the " +
              "window). Agents are born with this set high (60s) so the project's config " +
              "worker can react to agent/created and append its overrides before the first " +
              "turn; the worker lowers it to the ordinary 250ms as its done-configuring " +
              "signal, which also releases any held first turn immediately.",
          }),
        llmRequestExpiryMs: z
          .number()
          .int()
          .positive()
          .default(10 * 60_000)
          .meta({
            description:
              "How long a recorded intent stays runnable, measured from its trigger. Past " +
              "this the processor settles it cancelled/expired instead of running it: " +
              "answering a ten-minute-old message with a context snapshot from then does more " +
              "harm than admitting the miss. Also the per-attempt transport deadline, so an " +
              "attempt can never outlive its intent — and the expiry horizon for scripts " +
              "extracted from assistant output.",
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
              "turn): this many autonomous turns without external input records agent/paused; " +
              "the next external message resumes.",
          }),
        scriptResultHistoryLimit: z
          .number()
          .int()
          .positive()
          .default(30_000)
          .meta({
            description:
              "Script results longer than this are truncated in rendered context (the full " +
              "result spills to a workspace file when the host can write one) — big payloads " +
              "belong in files the next script reads, not in the prompt.",
          }),
        compactionTriggerFraction: z
          .number()
          .positive()
          .max(1)
          .default(0.5)
          .meta({
            description:
              "Compaction trigger: once a turn's reported context (input plus output tokens) " +
              "crosses this fraction of the model's window, the processor summarizes the " +
              "conversation into a compacted context item. Halfway leaves room for many more " +
              "turns before the window actually fills, so a slow or failed summary attempt " +
              "never races an imminent context overflow.",
          }),
        interpretResponses: z
          .boolean()
          .default(true)
          .meta({
            description:
              "Whether the platform interprets assistant output (codemode extraction, slash " +
              "commands, settlement rendering — the AgentCodemode component). Off, assistant " +
              "output lands on the stream as raw context and nothing platform-side parses " +
              "it: project code consumes the response events and appends the consequences " +
              "itself (script-run-requested, web-message-sent, corrective feedback). " +
              "Format-agnostic on purpose: what a raw response MEANS is decided in " +
              "userland, never here.",
          }),
      })
      .prefault({})
      .meta({ description: "The agent's complete configuration, every knob defaulted." }),
    contextItems: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("request").meta({
              description:
                "A send stamp: the llm-request-requested event, rendered permanently at " +
                'its position as the "Requested at:" line.',
            }),
            offset: z.number().int().positive().meta({
              description: "Stream offset of the llm-request-requested event.",
            }),
            requestedAt: z.iso.datetime().meta({
              description: "The requested event's own journaled createdAt.",
            }),
          }),
          z.object({
            kind: z.literal("section").meta({
              description:
                "A keyed section occurrence. The STANDING DOCUMENT is derived at render: " +
                "the collection's leading run of section items (up to the first message, " +
                "request stamp, or superseding occurrence) merges into ONE tagged system " +
                "message; every later section item renders at its position as a " +
                "<section key> block.",
            }),
            offset: z
              .number()
              .int()
              .positive()
              .meta({
                description:
                  "Stream offset of the event whose content this occurrence holds — updated " +
                  "in place when an un-sent occurrence coalesces.",
              }),
            key: z
              .string()
              .min(1)
              .meta({
                description:
                  "The section's stable identity — an arbitrary string the kernel never " +
                  "interprets. Re-adding a key IS the update; agents/context-rewritten " +
                  "addresses it for deliberate rewrites.",
              }),
            supersedes: z
              .number()
              .int()
              .positive()
              .optional()
              .meta({
                description:
                  "Offset of the key's prior occurrence — stamped by the fold when an " +
                  "update lands after the prior occurrence was sent; absent on a first " +
                  "occurrence. Everything above a superseding occurrence visibly predates " +
                  "it, and the whole prefix stays byte-stable.",
              }),
            payload: agentContextItemSchema(),
          }),
          z.object({
            kind: z.literal("message").meta({
              description: "A plain conversation item at its offset.",
            }),
            offset: z.number().int().positive().meta({
              description: "Stream offset of the context-added event this item reduced from.",
            }),
            payload: agentContextItemSchema(),
          }),
        ]),
      )
      .default([])
      .meta({
        description:
          "Every model-visible item, one offset-ordered collection: section occurrences, " +
          "conversation messages, and the permanent per-request send stamps. A keyed add " +
          "whose latest occurrence no request has sent yet edits that item in place (the " +
          "birth window — free); otherwise it appends at the tail with `supersedes` " +
          "pointing at the prior occurrence. On an unforked project the derived standing " +
          "document is byte-identical to the authored prompt file, whose sections keep " +
          "their file order. Keys are arbitrary strings; authors control placement through " +
          "append order (a worker's hot content, e.g. AGENTS.md, lands after the birth " +
          "batch and so renders last in the document). Compaction rebuilds the collection: " +
          "each key's newest occurrence in first-appearance order, unkeyed system facts, " +
          "the summary, then everything after the barrier.",
      }),
    lastLlmRequestOffset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .meta({
        description:
          "Offset of the newest llm-request-requested event (bumped at least to the barrier " +
          "by a compaction item) — barrier bookkeeping. Its one remaining behavioral job is " +
          "the legacy keyed-vocabulary mapping: a keyed update to a section whose latest " +
          "occurrence a request has covered appends as latest instead of collapsing.",
      }),
    latestExternalTriggerOffset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .meta({
        description:
          "Offset of the newest external context trigger. A delayed autonomous-breaker pause " +
          "whose causal trigger is older than this input is stale and reduces to nothing.",
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
            "= the agent's own notes/scripts and platform feedback about its output. Feeds " +
            "the autonomous-turn breaker.",
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
          "The one open LLM request: a turn whose INTENT is recorded. null = nothing owed. " +
          "This is the whole recoverability story — the intent lives in the stream, not in a " +
          "closure, so any incarnation that reduces the stream knows what is owed regardless " +
          "of who died in between. At most one request is ever open: a new intent reduces to " +
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
    activeScriptExecutions: z
      .array(
        z.object({
          executionId: z.string().meta({ description: "The capability-host execution." }),
          requestedAt: z.iso.datetime().meta({
            description:
              "The script-run-requested event's own journaled createdAt. Settlement " +
              "rendering derives the script's duration from this and the settled event's " +
              "createdAt — deterministic (both journaled), never wall clock — so slow " +
              "operations become knowable to the model.",
          }),
        }),
      )
      .default([])
      .meta({
        description: "Capability-host executions this agent requested and has not seen settle.",
      }),
    summary: AgentSummary.prefault({}).meta({
      description:
        "Human- or agent-written presentation summary. Every writer appends the same " +
        "agent/summary-updated event.",
    }),
    waitingForSinceOffset: z
      .number()
      .int()
      .positive()
      .optional()
      .meta({
        description:
          "Offset of the summary event which established the current wait. Technical guard " +
          "for the conditional waiting clear only; never exposed in the presentation summary.",
      }),
    tokenUsage: z
      .object({
        totalInputTokens: z.number().int().nonnegative().default(0),
        totalOutputTokens: z.number().int().nonnegative().default(0),
        totalCachedInputTokens: z.number().int().nonnegative().default(0),
        totalReasoningOutputTokens: z.number().int().nonnegative().default(0),
      })
      .prefault({})
      .meta({
        description:
          "Lifetime token totals, reduced from token-usage-reported. Cost/observability data, " +
          "not loop-control state: nothing in the agent loop branches on it. The compaction " +
          "trigger reads each report's own payload instead (the report carries " +
          "maxContextTokens for exactly that).",
      }),
    runtimeChange: agentRuntimeTransitionSchema()
      .optional()
      .meta({
        description:
          "The exact runtime counts last derived from consumed events, stamped with the event " +
          "which established the snapshot. Genesis zero stays absent; every later count " +
          "transition is exposed immediately to live-state consumers.",
      }),
  }),
  processorDeps: [CapabilityHostProcessorContract, CoreProcessorContract],
  events: {
    // FIRST on purpose: the public docs path derives from the first owned
    // event's namespace ("agents"), and the docs URLs must not move.
    "events.iterate.com/agents/context-added": {
      description:
        "Model-visible context arrived (user message, developer note, assistant output, system " +
        "item) — the everyday event, the only one most authors ever use. With `key`: keyed " +
        "standing content, one event per section, and RE-ADDING A KEY IS THE UPDATE — an " +
        "occurrence no request has sent yet coalesces in place (free; the whole birth " +
        "window), a sent one appends at the tail at its moment in time with `supersedes` " +
        "stamped by the fold. A multi-section write (a parsed prompt file) is a BATCH of " +
        "these, one per section: the batch commits atomically in input order, so file order " +
        "becomes offset order becomes document order. Without a key: one turn at its offset.",
      payloadSchema: agentContextItemSchema(),
    },
    "events.iterate.com/agents/context-rewritten": {
      description:
        "Deliberate HISTORY REWRITING — rare, audited, named to discourage casual use: it " +
        "changes what PAST render positions contain, busting the provider cache from the " +
        "standing document down, and a replaced covered behavioral rule leaves visible " +
        "history contradicting the instruction (the scenario-3a anti-pattern in " +
        "docs/prompt-sections-demo.html). For redaction (the author supplies the replacement " +
        "text) and un-saying; the everyday update is re-adding the key on " +
        'agents/context-added. `key: "*"` with delete removes EVERYTHING — standing ' +
        "document and timeline both — " +
        "(guidance: don't, unless you want a lobotomised agent; the event's audit trail is " +
        "the safeguard). Never triggers a turn by itself.",
      payloadSchema: z
        .strictObject({
          op: z.enum(["replace", "delete"]).meta({ description: "The operation." }),
          key: z
            .string()
            .min(1)
            .meta({ description: 'The section to rewrite, or "*" (delete only) for everything.' }),
          content: z
            .string()
            .optional()
            .meta({ description: "Replacement content (replace only)." }),
        })
        .superRefine((payload, ctx) => {
          if (payload.op === "replace") {
            if (payload.content === undefined) {
              ctx.addIssue({ code: "custom", path: ["content"], message: "replace needs content" });
            }
            if (payload.key === "*") {
              ctx.addIssue({
                code: "custom",
                path: ["key"],
                message: 'replace targets one section; "*" is delete-only',
              });
            }
          }
          if (payload.op === "delete" && payload.content !== undefined) {
            ctx.addIssue({ code: "custom", path: ["op"], message: "delete carries no content" });
          }
        }),
    },
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
            llm: z.object({ model: z.string().min(1).optional() }).optional(),
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
            compactionTriggerFraction: z.number().positive().max(1).optional(),
            interpretResponses: z.boolean().optional(),
          })
          .strict()
          .meta({ description: "Partial patch, deep-merged into the current config." }),
      }),
    },
    "events.iterate.com/agents/web-message-sent": {
      description:
        "A visible agent message was sent to the web UI — by a script (itx.chat.sendMessage), " +
        "or by a userland response interpreter delivering prose extracted straight from an " +
        "assistant output. The processor mirrors script-sent messages back into context as " +
        "assistant history so the model sees what it sent; extracted messages carry " +
        "llmRequestOffset and are NOT mirrored — their raw text is already in history as the " +
        "assistant context item.",
      payloadSchema: z.object({
        message: z.string().meta({ description: "The visible chat message (markdown)." }),
        files: z
          .array(agentFileAttachmentSchema())
          .optional()
          .meta({ description: "Files attached to the message." }),
        llmRequestOffset: z
          .number()
          .int()
          .positive()
          .optional()
          .meta({
            description:
              "Present when the message was extracted from the identified LLM response rather " +
              "than sent by a script. Suppresses the assistant-history mirror.",
          }),
      }),
    },
    "events.iterate.com/agent/llm-request-requested": {
      description:
        "The recorded INTENT to run one LLM turn. Carries no id: the request's identity is the " +
        "offset this event gets on commit. The reduce ignores it when no trigger is pending or a " +
        "request already is open — a late debounced intent is a harmless stream fact.",
      payloadSchema: z.object({
        model: z.string().meta({ description: "Model pinned for this turn." }),
        contractVersion: z
          .string()
          .optional()
          .meta({
            description:
              "The agent contract version whose fold built (and will rebuild) this request. " +
              "A replay under a DIFFERENT current version is a reconstruction under the " +
              "current fold, not byte-exact — the inspector labels it so. Absent on " +
              "pre-7.0.0 requests, which are reconstructions by definition.",
          }),
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
              usage: llmTokenUsageSchema()
                .optional()
                .meta({ description: "Normalized provider-reported token usage." }),
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
    "events.iterate.com/agent/llm-response-chunks": {
      description:
        "A coalescing window of streamed chunks received from the transport, verbatim and in " +
        "provider order. One event per flush (~150ms of streaming), not per chunk: journaling " +
        "each chunk individually awaited a Durable Object commit per token and capped " +
        "streaming at the append round-trip (~17 tok/s). Ephemeral: it reaches open " +
        "browser/TUI connections but is excluded from default reads and durable " +
        "subscriptions, and may be evicted — the durable truth is the assistant context " +
        "item / llm-request-settled pair.",
      // FORCIBLY EPHEMERAL: the contract, not the append site, decides.
      // Every append/parse lane built from this definition defaults the
      // envelope's `ephemeral` flag to true and REJECTS `ephemeral: false`,
      // so a chunk can never become a durable stream fact by accident.
      ephemeral: true,
      payloadSchema: z.object({
        chunks: z
          .array(z.unknown())
          .min(1)
          .meta({ description: "The window's provider chunk objects, verbatim, in order." }),
        llmRequestOffset: z
          .number()
          .int()
          .positive()
          .meta({ description: "The in-flight request these chunks belong to." }),
        sequence: z
          .number()
          .int()
          .nonnegative()
          .meta({ description: "Flush ordinal within the response." }),
      }),
    },
    "events.iterate.com/agent/token-usage-reported": {
      description:
        "Normalized token counts and the model's context window for a successful LLM request. " +
        "The processor translates vendor usage dialects (input_tokens vs prompt_tokens) at " +
        "source, so consumers — the state tally, cost views, and compaction — see one shape.",
      payloadSchema: z.object({
        llmRequestOffset: z
          .number()
          .int()
          .positive()
          .meta({
            description:
              "The llm-request-requested event this request ran under — the same handle the " +
              "settlement carries.",
          }),
        model: z.string().min(1).meta({ description: "The model that saw this exact request." }),
        maxContextTokens: z.number().int().positive().meta({
          description:
            "The model's context window, so a consumer can judge fullness from the event alone.",
        }),
        inputTokens: z
          .number()
          .int()
          .nonnegative()
          .meta({ description: "Total input tokens, including cached ones." }),
        outputTokens: z
          .number()
          .int()
          .nonnegative()
          .meta({ description: "Total output tokens, including reasoning ones." }),
        cachedInputTokens: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .meta({ description: "Prompt-cache hits, where the model reports them." }),
        reasoningOutputTokens: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .meta({ description: "Reasoning/thinking tokens, where the model reports them." }),
      }),
    },
    "events.iterate.com/agent/summary-updated": {
      description:
        "Updates the agent's human-readable summary. Omitted fields remain unchanged, null " +
        "clears an optional field, and pinned false unpins. The same event is used whether an " +
        "agent or a human initiated the edit; the processor's own conditional waiting clear " +
        "({ waitingFor: null, clearWaitingForThroughOffset }) only clears a wait established " +
        "at or before the waking input's offset.",
      payloadSchema: AgentSummaryUpdated,
    },
    "events.iterate.com/agent/binding-set": {
      description:
        "Sets or enriches the typed external object this agent represents. Bindings are " +
        "normally emitted atomically with integration agent creation, never inferred from " +
        "paths. Contract-owned but reduced by integration processors, not by the agent.",
      payloadSchema: AgentBinding,
    },
    "events.iterate.com/agent/paused": {
      description:
        "The agent stopped scheduling turns (autonomous-loop breaker, or an operator). Mirrors " +
        "stream/paused. A breaker pause names its causal trigger and reduces to nothing if newer " +
        "external input already superseded it. The next external message resumes an applied pause; " +
        "self-driven triggers stay parked.",
      payloadSchema: z.object({
        reason: z.string().trim().min(1).optional().meta({ description: "Why the loop paused." }),
        triggerOffset: z
          .number()
          .int()
          .positive()
          .optional()
          .meta({
            description:
              "Self-driven context offset that tripped the autonomous breaker; absent for an " +
              "operator-authored pause.",
          }),
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
    "events.iterate.com/agents/context-rewritten",
    "events.iterate.com/agents/web-message-sent",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-settled",
    "events.iterate.com/agent/token-usage-reported",
    "events.iterate.com/agent/summary-updated",
    "events.iterate.com/agent/paused",
    "events.iterate.com/agent/resumed",
    "events.iterate.com/capability-host/script-run-requested",
    "events.iterate.com/capability-host/script-run-settled",
    // Preamble changes on the agent's own scope transcribe into model-visible
    // context (the model must know which symbols its scripts can reference).
    "events.iterate.com/capability-host/preamble-set",
    "events.iterate.com/capability-host/preamble-removed",
    // Every error on the stream — the processor's own emissions, the runner's
    // repeatedly failing events that were skipped, anything else — is transcribed into model-visible context.
    "events.iterate.com/stream/error-occurred",
    // Recovery relies on the eventless at-head pass, not consumption of the
    // platform revival fact, to find and re-run orphaned work after eviction.
  ],
  emits: [
    "events.iterate.com/agents/context-added",
    // Emitted by userland response interpreters through this vocabulary (the
    // platform components never emit it themselves today); listed so variant
    // hosts and tests can validate the full loop's appends in one place.
    "events.iterate.com/agents/web-message-sent",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-settled",
    "events.iterate.com/agent/llm-response-chunks",
    "events.iterate.com/agent/token-usage-reported",
    "events.iterate.com/agent/summary-updated",
    "events.iterate.com/agent/paused",
    "events.iterate.com/agent/resumed",
    "events.iterate.com/capability-host/script-run-requested",
    "events.iterate.com/stream/error-occurred",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<AgentProcessorContract>`,
 * `ConsumedEvent<AgentProcessorContract>`.
 */
export type AgentProcessorContract = typeof AgentProcessorContract;

/** Append input accepted by the Agent processor, derived from its `consumes` contract. */
export type AgentEventInput = ConsumedInput<AgentProcessorContract>;

/** The agent processor's reduced state, inferred from the contract's `stateSchema`. */
export type AgentProcessorState = ProcessorState<AgentProcessorContract>;

/** One model-visible context item's payload — the wire contract for every
 * committed `agents/context-added` event. */
export type AgentContextAddedPayload = z.infer<typeof AgentContextAddedPayload>;

/** One shared schema instance, so the payload type above infers by plain
 * z.infer (the itx-api generator resolves that; type-level indexing into the
 * state union does not travel). */
const AgentContextAddedPayload = agentContextItemSchema();

/** One reduced context item: a keyed section occurrence, a plain
 * conversation item, or a permanent send stamp. */
export type AgentContextItem = AgentProcessorState["contextItems"][number];

/** A file attached to an agent context item: content type, filename, project
 * file-storage path, size, and the signed public URL minted at attach time
 * (stored, not re-minted — it expires with its signature). */
export type AgentFileAttachment = NonNullable<AgentContextAddedPayload["files"]>[number];

/** Exact runtime plus the event which first established it in reduced state.
 * This is processor state exposed through live state, not a stream event. */
export const AgentRuntimeTransition = agentRuntimeTransitionSchema();
export type AgentRuntimeTransition = z.infer<typeof AgentRuntimeTransition>;

/** The deliberately small push surface for one Agent DO. The full reduced state stays
 * behind `processor.snapshot()`; publishing context/history through live state
 * would duplicate the stream on every conversation update. */
export const AgentLiveState = z.strictObject({
  runtimeChange: AgentRuntimeTransition.optional(),
});
/** The transient runtime state pushed by one Agent durable object. */
export type AgentLiveState = z.infer<typeof AgentLiveState>;

/**
 * The context-item payload — used repeatedly in the contract (the
 * `agents/context-added` event and the state's context items), so it
 * lives in this hoisted function instead of inline. One flat object for every role; the
 * role-specific fields are optional and documented per-field. `refs` and the
 * actor union are how the slack/telegram/email/github integrations attach
 * provenance and source coordinates; `compaction` marks the structural
 * history rewrite produced by context compaction. Parse failure means the
 * item silently drops from reduced state, i.e. conversation loss.
 */
function agentContextItemSchema() {
  return z
    .strictObject({
      role: z
        .enum(["system", "developer", "user", "assistant"])
        .meta({ description: "The LLM message role this item renders as." }),
      content: z.string().meta({ description: "The model-visible text." }),
      attachments: AgentMessageAttachments.optional().meta({
        description: "Typed resources addressed by Markdown-like attachment links in content.",
      }),
      referenceResolution: z.unknown().optional().meta({
        description:
          "Processor-authored, bounded resolution metadata for a prior message's attachments.",
      }),
      key: z
        .string()
        .min(1)
        .optional()
        .meta({
          description:
            "The section's stable identity — THE addressing mechanism: re-adding a key IS " +
            "the update. An occurrence no request has sent yet is edited in place " +
            "(coalesced, free); a sent one appends at the tail of the timeline with " +
            "`supersedes` stamped by the fold. Existing streams' keyed events already mean " +
            "exactly this.",
        }),
      files: z
        .array(agentFileAttachmentSchema())
        .optional()
        .meta({ description: "Files riding on this item." }),
      refs: z
        .array(
          z
            .discriminatedUnion("type", [
              z.object({
                type: z.literal("event"),
                streamPath: z.string().meta({ description: "The referenced stream's path." }),
                offset: z
                  .number()
                  .int()
                  .positive()
                  .meta({ description: "The referenced event's offset on that stream." }),
                eventType: z
                  .string()
                  .optional()
                  .meta({ description: "The referenced event's type, when known." }),
              }),
              z.object({
                type: z.literal("user"),
                userId: z.string().meta({ description: "The referenced platform user." }),
              }),
              z.object({
                type: z.literal("file"),
                path: z.string().meta({ description: "Project file-storage path." }),
              }),
              z.object({
                type: z.literal("git-commit"),
                repoPath: z.string().meta({ description: "The repo's mount path." }),
                commitOid: z.string().meta({ description: "The commit id." }),
              }),
              z.object({
                type: z.literal("repo-file"),
                repoPath: z.string().meta({ description: "The repo's mount path." }),
                path: z.string().meta({ description: "The committed file path at latest HEAD." }),
              }),
            ])
            .meta({ description: "One coordinate for richer source material." }),
        )
        .optional()
        .meta({ description: "Coordinates for retrieving richer source material on demand." }),
      actor: z
        .discriminatedUnion("type", [
          z.object({
            type: z.literal("user"),
            origin: z
              .enum(["web", "mcp"])
              .meta({ description: "Which surface the user wrote from." }),
            userId: z
              .string()
              .optional()
              .meta({
                description:
                  "The authenticated principal who wrote the message — the same identity " +
                  "device enrollments record as ownerId, so a chat-reply push can be " +
                  "addressed to the sender's devices only.",
              }),
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
          z.object({
            type: z.literal("slack"),
            userId: z
              .string()
              .optional()
              .meta({ description: "The Slack user who wrote the source message." }),
            botName: z
              .string()
              .optional()
              .meta({ description: "The Slack bot that wrote the source message." }),
          }),
          z.object({
            type: z.literal("telegram"),
            userId: z
              .string()
              .optional()
              .meta({ description: "The Telegram user who wrote the source message." }),
            username: z
              .string()
              .optional()
              .meta({ description: "The Telegram username, when known." }),
          }),
          z.object({
            type: z.literal("email"),
            address: z.string().optional().meta({ description: "The sender's email address." }),
            name: z.string().optional().meta({ description: "The sender's display name." }),
          }),
          z.object({
            type: z.literal("github"),
            login: z.string().optional().meta({ description: "The GitHub login of the sender." }),
            senderType: z
              .string()
              .optional()
              .meta({ description: "GitHub's sender classification (User, Bot, ...)." }),
          }),
        ])
        .optional()
        .meta({
          description:
            "Who supplied this item. Trust boundary at prompt time: a developer-role item " +
            "keeps developer precedence only when platform-authored (no actor) or authored " +
            "by an agent or its own script; every integration-lane author (slack, telegram, " +
            "email, github, integration) is DEMOTED to user role — third-party text must " +
            "not read as instructions.",
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
            "answers. The reduce IGNORES an assistant item whose request is no longer the open " +
            "one — that guard is what closes the interrupt-vs-settle race.",
        }),
      compaction: z
        .object({
          replacesHistoryThrough: z.number().int().positive().meta({
            description: "Replace model-visible history through this stream offset with this item.",
          }),
          usage: llmTokenUsageSchema()
            .optional()
            .meta({ description: "Provider-reported usage for the summarization request." }),
        })
        .optional()
        .meta({
          description:
            "Metadata for the structural history rewrite produced by compaction (developer " +
            "role only): this item replaces every non-system item at or below the barrier.",
        }),
    })
    .superRefine((payload, ctx) => {
      if (
        payload.attachments !== undefined &&
        decodeAgentMessageAttachments(payload.content, payload.attachments) === null
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["attachments"],
          message: "each attachment must have a unique id and a matching inline attachment link",
        });
      }
      if (payload.role !== "developer" || payload.compaction === undefined) return;
      if (payload.key !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["key"],
          message: "compaction is a structural history rewrite and cannot be keyed",
        });
      }
      if (payload.llmRequestPolicy.behaviour !== "dont-trigger-request") {
        ctx.addIssue({
          code: "custom",
          path: ["llmRequestPolicy", "behaviour"],
          message: "compaction cannot trigger an LLM request",
        });
      }
    })
    .meta({
      description:
        "One model-visible context item. The single source of truth for what the LLM sees.",
    });
}

/**
 * A file reference riding on an agent context item or web message — used by
 * both, so hoisted. Deliberately NOT strict: an attachment with extra keys
 * still parses (dropping a conversation item over an unknown attachment key
 * would be silent conversation loss). The URL is stored at attach time, not
 * re-minted per read, so history stays deterministic; links in old
 * conversations expire with the signature.
 */
function agentFileAttachmentSchema() {
  return z.object({
    contentType: z.string().meta({ description: "MIME type." }),
    filename: z.string().meta({ description: "Original filename." }),
    path: z.string().meta({ description: "Project file-storage path." }),
    size: z.number().int().nonnegative().meta({ description: "Size in bytes." }),
    url: z.string().meta({
      description:
        "Signed URL minted at attach time (stored, not re-minted, so history stays " +
        "deterministic).",
    }),
  });
}

/** Normalized token usage — used by the settled result and by compaction
 * metadata, so hoisted. */
function llmTokenUsageSchema() {
  return z.object({
    inputTokens: z
      .number()
      .int()
      .nonnegative()
      .meta({ description: "Total input tokens, including cached ones." }),
    outputTokens: z
      .number()
      .int()
      .nonnegative()
      .meta({ description: "Total output tokens, including reasoning ones." }),
    cachedInputTokens: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .meta({ description: "Prompt-cache hits, where the model reports them." }),
    reasoningOutputTokens: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .meta({ description: "Reasoning/thinking tokens, where the model reports them." }),
  });
}

/** The runtime-transition stamp — used by the state schema and the exported
 * `AgentRuntimeTransition`/`AgentLiveState` pair, so hoisted. */
function agentRuntimeTransitionSchema() {
  return z.strictObject({
    runtime: AgentRuntime,
    sinceOffset: z
      .number()
      .int()
      .nonnegative()
      .meta({ description: "Offset of the event which established this runtime snapshot." }),
    since: z.iso
      .datetime()
      .meta({ description: "createdAt of the event which established this runtime snapshot." }),
  });
}
