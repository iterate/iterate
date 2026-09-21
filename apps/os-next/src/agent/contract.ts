// src/agent/contract.ts — AN AGENT: a domain object on the context at any path (`/agents/<name>` by
// convention) — a conversation driven by a model that acts by writing scripts against that
// context's `itx`. Its facts live on that path's log, and THIS FILE is the only place they are
// spelled. The rest of the folder derives from it: processor.ts reduces these events, runs the
// creation saga and THE LOOP, durable-object.ts is the processor's shell plus `message()`,
// collection.ts is `itx.agents` (`list`, `create`), library.ts hands out the handle
// (`itx.agents.get(path)`: the host's verbs plus the typed `append`). Every type is derived here,
// never hand-kept:
//   AgentState                        = ProcessorState<typeof AgentContract>  the reduced state below
//   ConsumedEvent<typeof AgentContract>                                        what reduce and processEvent see
//   EventInput<typeof AgentContract>                                           what `itx.agents.get(path).append(…)` takes
//
// apps/os's agent brought over LEAN — the same loop, nothing else. Its birth is the saga
// `itx.agents.create(path)` opens: `create-requested`, then `created` — the certificate,
// cross-posted to `/` for the project catalog (src/project/) — with the default system prompt
// beside it; an operator's instructions are their own `context-added` after. From then on
// everything is THE LOOP: a `context-added` from outside (a person) or from a script's result
// raises the ONE pending trigger; the loop records the request (`llm-request-requested`), runs the
// model, settles it (`llm-request-settled`) with the assistant's words as the next `context-added`.
// The answer is markdown prose plus at most one `<codemode status="…">` block (codemode-format.ts,
// mmkal's grammar): the prose is `web-message-sent` — what a person is shown — the status
// `summary-updated`, the body a script: the CONTEXT's own `context/run-requested` (the context runs
// it, iterate-context-durable-object.ts; a restart settles it `interrupted`, never re-run), whose
// `run-settled` result is the next developer `context-added`, which triggers the next turn; prose
// alone ends the turn. Bounded: an open request expires, N consecutive model failures pause, N
// consecutive self-triggered turns pause, and a person's next words resume. A request is DEBOUNCED
// as in apps/os: one window after the trigger (more words inside it move the trigger; one request
// answers them all), a failure's backoff folded into the same window. Dropped from apps/os on
// purpose: streaming chunks, interrupts, compaction, token accounting, summaries, mentions, and the
// capability host with its typecheck and preambles — the script runs against this context's `itx`
// as it is.
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/next/stream/processor";
import { CoreContract } from "../stream/core-processor.ts";

/** Who put words into the context: a person, a script's result, or the loop itself (a format
 *  correction). A script's or the loop's words are self-triggered input — the autonomous-turn
 *  breaker counts them; a person's are external and reset it. */
const Actor = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user") }),
  z.object({ type: z.literal("script"), requestOffset: z.number().int().positive() }),
  z.object({ type: z.literal("agent") }),
]);

const Role = z.enum(["system", "developer", "user", "assistant"]);

/** One message of the model's conversation, as the model call takes it: text, or the chat-completions
 *  parts a vision model reads — text and images as data: URLs. */
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content:
    | string
    | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
};

/** A file attached to a context item (apps/os's attachment record, minus its signed URL): the
 *  project file it was stored as (`itx.files`), its content type, original name and size. */
const FileAttachment = z.object({
  contentType: z.string().min(1),
  filename: z.string().min(1),
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
});
export type FileAttachment = z.infer<typeof FileAttachment>;

/** Where a request's trigger came from: a person (`external`) or the loop's own consequences. */
const TriggerSource = z.enum(["external", "agent-loop"]);

/** What a model call cost, normalized (apps/os's `AgentLlmUsage`): the provider's totals, and the
 *  cached/reasoning breakdowns when it reports them. */
const LlmUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().optional(),
});
export type LlmUsage = z.infer<typeof LlmUsage>;

export const AgentContract = defineProcessorContract({
  slug: "agent",
  // 2: the script obligation moved to the context (core state `runs`); the state lost its slot.
  // 3: `path` became `creation` (the saga's offset); `agents/…` events became `agent/…`.
  version: "3",
  description:
    "An agent: a conversation on its own context, driven by a model that acts by writing scripts against itx.",
  /** THE REDUCED STATE — what the reduce keeps between events: where creation stands (as the OFFSET
   *  of the event that says so — the request, the certificate, or the failure; read that event for
   *  the error), the conversation as the model will read it, and the loop's obligations — the one
   *  pending trigger, the one open request, the breakers' counts, a pause (a script it asked for is
   *  the CONTEXT's obligation: core state `runs`). It is the checkpoint the facet stores, what
   *  `snapshot()` and `liveSnapshot()` answer, the guard `message()` reads before it speaks, and
   *  what the agents app renders as the live status beside the log. */
  stateSchema: z.object({
    creation: z
      .object({
        status: z.enum(["requested", "created", "failed"]),
        offset: z.number().int().positive(),
      })
      .nullable()
      .default(null),
    /** The knobs `agent/configured` patches; every one defaulted, so `{}` is a whole config. */
    config: z
      .object({
        llm: z
          // OpenAI's astra, read FAST (low reasoning effort, the priority tier — processor.ts); a
          // `@cf/…` name routes to Workers AI instead (`@cf/meta/llama-4-scout-17b-16e-instruct` sees images too).
          .object({ model: z.string().min(1).default("gpt-6-astra") })
          .prefault({}),
        /** Consecutive self-triggered turns (script results, corrections) before the loop pauses. */
        maxAutonomousTurns: z.number().int().positive().default(20),
        /** How long a recorded request stays runnable; past it, settled as expired. */
        llmRequestExpiryMs: z
          .number()
          .int()
          .positive()
          .default(10 * 60_000),
        /** apps/os's window: a request waits this long after its trigger for more content — a second
         *  message inside the window moves the trigger and ONE request answers both. */
        llmRequestDebounceMs: z.number().int().nonnegative().default(250),
        /** THE PLAIN-RESPONSE HANDLER: an itx expression (a callable, dotted) invoked with a response
         *  that carries no `<codemode>` block — the whole point being that the agent only ever writes
         *  code, and a bare-prose reply is sugar for `<codemode>await <this>(<the prose>)</codemode>`.
         *  The default sends the text to web chat; a Slack-connected agent points it at its Slack
         *  reply instead. Blank drops a bare reply (an agent that only acts). */
        plainResponse: z.string().default("itx.chat.sendMessage"),
        /** Consecutive model failures before the loop pauses; between attempts, apps/os's backoff —
         *  `backoffBaseMs · 2^(failures−1)`, capped at `backoffMaxMs` — folded into the debounce window. */
        llmRequestRetryPolicy: z
          .object({
            maxAttempts: z.number().int().positive().default(3),
            backoffBaseMs: z.number().int().nonnegative().default(10_000),
            backoffMaxMs: z.number().int().nonnegative().default(60_000),
          })
          .prefault({}),
      })
      .prefault({}),
    /** Every model-visible item, in offset order — the conversation the next request is built from. */
    contextItems: z
      .array(
        z.object({
          offset: z.number().int().positive(),
          role: Role,
          content: z.string(),
          actor: Actor.optional(),
          llmRequestOffset: z.number().int().positive().optional(),
          files: z.array(FileAttachment).optional(),
        }),
      )
      .default([]),
    /** The ONE trigger the next request answers; null once a request has been recorded for it. */
    pendingLlmRequestTrigger: z
      .object({ offset: z.number().int().positive(), atMs: z.number(), source: TriggerSource })
      .nullable()
      .default(null),
    /** The one recorded request not yet settled: the loop's obligation, whichever incarnation runs it. */
    openRequest: z
      .object({
        requestedAtOffset: z.number().int().positive(),
        expiresAt: z.number(),
        model: z.string(),
        triggerSource: TriggerSource,
      })
      .nullable()
      .default(null),
    consecutiveLlmFailures: z.number().int().nonnegative().default(0),
    autonomousTurnCount: z.number().int().nonnegative().default(0),
    /** Set by `agent/paused` (the breakers, or an operator); cleared by `agent/resumed`. */
    paused: z
      .object({ reason: z.string(), atOffset: z.number().int().positive() })
      .nullable()
      .default(null),
  }),
  events: {
    "events.iterate.com/agent/create-requested": {
      description:
        "Someone asked for this agent (`itx.agents.create(path)`). No payload: the context it lands on IS the agent. The processor lands created (with the default system prompt beside it) or create-failed; a request after a failure is a new attempt, one after the certificate a harmless fact.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/agent/created": {
      description:
        "The birth certificate: on the agent's path, and cross-posted to / for the project catalog — hence it names the path.",
      payloadSchema: z.object({ path: z.string().min(1) }),
    },
    "events.iterate.com/agent/create-failed": {
      description: "What the birth reported. Terminal until a new request.",
      payloadSchema: z.object({ error: z.string() }),
    },
    "events.iterate.com/agent/configured": {
      description:
        "Merges a partial configuration into the agent's config; omitted keys keep their values.",
      payloadSchema: z.object({
        config: z.object({
          llm: z.object({ model: z.string().min(1).optional() }).optional(),
          maxAutonomousTurns: z.number().int().positive().optional(),
          plainResponse: z.string().optional(),
          llmRequestExpiryMs: z.number().int().positive().optional(),
          llmRequestDebounceMs: z.number().int().nonnegative().optional(),
          llmRequestRetryPolicy: z
            .object({
              maxAttempts: z.number().int().positive().optional(),
              backoffBaseMs: z.number().int().nonnegative().optional(),
              backoffMaxMs: z.number().int().nonnegative().optional(),
            })
            .optional(),
        }),
      }),
    },
    "events.iterate.com/agent/context-added": {
      description:
        "Words into the model's context — the everyday event. A user or developer item raises the pending trigger unless its policy says not to; the assistant's own output carries llmRequestOffset.",
      payloadSchema: z.object({
        role: Role,
        content: z.string(),
        actor: Actor.optional(),
        /** What rides with the words: files stored under this agent's path (`message()` stores them). */
        files: z.array(FileAttachment).optional(),
        /** apps/os's policies: `dont-trigger-request` (words that raise no turn), `after-current-request`
         *  (the default: the next turn), `interrupt-current-request` (cut the running answer short —
         *  the request settles cancelled with what streamed so far, and these words start the next). */
        llmRequestPolicy: z
          .object({
            behaviour: z.enum([
              "dont-trigger-request",
              "after-current-request",
              "interrupt-current-request",
            ]),
          })
          .optional(),
        llmRequestOffset: z.number().int().positive().optional(),
      }),
    },
    "events.iterate.com/agent/web-message-sent": {
      description:
        "THE assistant-message fact: the markdown outside the tag, what a person is shown; llmRequestOffset names the answer it came from.",
      payloadSchema: z.object({
        message: z.string().min(1),
        llmRequestOffset: z.number().int().positive().optional(),
      }),
    },
    "events.iterate.com/agent/summary-updated": {
      description:
        "The tag's status attribute as the live activity label — apps/os's summary vocabulary, the one field this loop speaks.",
      payloadSchema: z.object({ activity: z.string().min(1) }),
    },
    "events.iterate.com/agent/llm-request-requested": {
      description:
        "The loop recorded its intent to run the model for ONE trigger (the offset it names); the event's offset is the request's identity. An intent whose trigger has moved on is a harmless fact.",
      payloadSchema: z.object({
        model: z.string().min(1),
        expiresAt: z.number(),
        triggerOffset: z.number().int().positive(),
      }),
    },
    "events.iterate.com/agent/llm-response-chunks": {
      description:
        "EPHEMERAL, never stored: one coalescing window of the provider's streamed events for the request it names — what a feed renders as the answer being written. The settled event carries the durable text.",
      payloadSchema: z.object({
        llmRequestOffset: z.number().int().positive(),
        chunks: z.array(z.unknown()).min(1),
        /** The window's ordinal within the response — a redelivered window is told from a new one. */
        sequence: z.number().int().nonnegative(),
      }),
    },
    "events.iterate.com/agent/llm-request-settled": {
      description:
        "The request's terminal fact: the model's text (and what it cost), its failure, its expiry, or the person's interruption — the two last with whatever streamed before.",
      payloadSchema: z.object({
        requestOffset: z.number().int().positive(),
        durationMs: z.number().nonnegative().optional(),
        result: z.discriminatedUnion("status", [
          z.object({
            status: z.literal("succeeded"),
            text: z.string(),
            usage: LlmUsage.optional(),
          }),
          z.object({
            status: z.literal("failed"),
            errorMessage: z.string(),
            partialText: z.string().optional(),
          }),
          z.object({
            status: z.literal("cancelled"),
            reason: z.enum(["expired", "interrupted-by-user-input"]),
            partialText: z.string().optional(),
          }),
        ]),
      }),
    },
    "events.iterate.com/agent/token-usage-reported": {
      description:
        "What the last successful request cost against the model's context window (apps/os's vocabulary; a feed shows the context's fullness).",
      payloadSchema: z.object({
        model: z.string().min(1),
        maxContextTokens: z.number().int().positive(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      }),
    },
    "events.iterate.com/agent/paused": {
      description:
        "New turns stay parked until agent/resumed: a breaker tripped, or an operator paused.",
      payloadSchema: z.object({
        reason: z.string(),
        triggerOffset: z.number().int().positive().optional(),
      }),
    },
    "events.iterate.com/agent/resumed": {
      description: "Turns run again; the breakers' counts start over.",
      payloadSchema: z.object({ reason: z.string().optional() }),
    },
  },
  // The script events are the CONTEXT's (`context/run-requested` / `run-settled`): the agent asks,
  // the context runs, the agent reads the settlement as the next developer item.
  processorDeps: [CoreContract],
  consumes: [
    "events.iterate.com/agent/create-requested",
    "events.iterate.com/agent/created",
    "events.iterate.com/agent/create-failed",
    "events.iterate.com/agent/configured",
    "events.iterate.com/agent/context-added",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-settled",
    "events.iterate.com/agent/paused",
    "events.iterate.com/agent/resumed",
    "events.iterate.com/context/run-settled",
  ],
  emits: [
    "events.iterate.com/agent/created",
    "events.iterate.com/agent/create-failed",
    "events.iterate.com/agent/context-added",
    "events.iterate.com/agent/web-message-sent",
    "events.iterate.com/agent/summary-updated",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-response-chunks",
    "events.iterate.com/agent/llm-request-settled",
    "events.iterate.com/agent/token-usage-reported",
    "events.iterate.com/agent/paused",
    "events.iterate.com/agent/resumed",
    "events.iterate.com/context/run-requested",
  ],
});

/** The agent's reduced state: where its creation stands, the conversation, and the loop's
 *  obligations (the contract's `stateSchema`). */
export type AgentState = ProcessorState<typeof AgentContract>;
