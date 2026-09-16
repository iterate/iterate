// src/agent/contract.ts — the agent's vocabulary and view (the triplet's first: processor.ts is the
// pure loop, durable-object.ts the loadable host). An agent is a domain object with its OWN stream,
// the context at any path (`/agents/<name>` by convention): apps/os's agent brought over LEAN — the
// same event names, the loop, nothing else. Its birth is `agent/created` — the certificate,
// cross-posted to `/` for the project catalog (src/project/) — landed by the host's `create()` with
// the system prompt beside it. From then on everything is THE LOOP: a `context-added` from outside
// (a person) or from a script's result raises the ONE pending trigger; the loop records the request
// (`llm-request-requested`), runs the model, settles it (`llm-request-settled`) with the assistant's
// words as the next `context-added`. The answer is markdown prose plus at most one `<codemode
// status="…">` block (codemode-format.ts, mmkal's grammar): the prose is `web-message-sent` — what a
// person is shown — the status `summary-updated`, the body a script: `script-run-requested`, run
// through `itx.run`, `script-run-settled`, its result the next developer `context-added`, which
// triggers the next turn; prose alone ends the turn. Bounded: an open request or
// script expires, N consecutive model failures pause, N consecutive self-triggered turns pause, and
// a person's next words resume. Dropped from apps/os on purpose: streaming chunks, debounce and
// backoff, interrupts, compaction, token accounting, summaries, mentions, files, and the capability
// host with its typecheck and preambles — the script runs against this context's `itx` as it is.
import { z } from "zod";
import { defineProcessorContract } from "../stream/processor.ts";

/** The agent's identity — the certificate's payload: its context path. An agent IS its path. */
const AgentIdentity = z.object({ path: z.string().min(1) });

/** Who put words into the context: a person, a script's result, or the loop itself (a format
 *  correction). A script's or the loop's words are self-triggered input — the autonomous-turn
 *  breaker counts them; a person's are external and reset it. */
const Actor = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user") }),
  z.object({ type: z.literal("script"), executionId: z.string().min(1) }),
  z.object({ type: z.literal("agent") }),
]);
export type Actor = z.infer<typeof Actor>;

const Role = z.enum(["system", "developer", "user", "assistant"]);

/** One message of the model's conversation, as the model call takes it. */
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** What the model is told when `create()` is given no prompt of its own — mmkal's codemode-tag
 *  prompt (configs/codemode-tag), with this context's `itx` in place of apps/os's. */
export const DEFAULT_AGENT_SYSTEM_PROMPT = [
  "You are an agent on the iterate platform. You live at a context path inside a project; the conversation you see is that context's history, and everything you do is an event on it.",
  "HOW YOU ACT: respond with markdown, and embed AT MOST ONE `<codemode>` block when you want to run code:",
  "",
  "Good question! Let me look into it.",
  "",
  '<codemode status="Checking the files">',
  'const files = await itx.repos.get("/repos/config").listFiles()',
  "return { count: files.paths.length }",
  "</codemode>",
  "",
  "- Markdown OUTSIDE the tag is delivered to the person as your message — that is how you talk. Text inside the tag is TypeScript statements (top-level `await` and `return` allowed); the opening `<codemode ...>` and closing `</codemode>` must each sit alone on their own line.",
  '- The `status` attribute is a short present-tense label ("Checking the files", "Writing the report") shown while your code runs. Set it whenever you include a tag; update it each turn as the phase changes.',
  "- Whatever your code RETURNS (JSON-serializable) arrives as your next input, and you get another turn to act on it. A thrown error arrives the same way — read it and adapt. Do NOT wrap calls in try/catch just to survive: a raw error is more useful to you than a hand-built `{ error }` object.",
  "- Multi-step work is one tag per response: each result comes back to you, and you write the next step having seen it. A response with more than one `<codemode>` tag — or an unclosed one — is rejected with feedback and NOTHING runs; never queue future steps as extra tags.",
  "- To finish: write your final message with NO tag — prose alone ends your turn. Inside a tag, `return;` with no value (or falling off the end) also ends the loop; `return null` counts as a value and buys a pointless extra turn.",
  "- Each script runs fresh — no variable survives between scripts. Carry state by returning it or writing it.",
  "- `itx` is this context's capability tree: `whoami()`, `kv.get(key)` / `kv.put(key, value)` / `kv.list()`, `repos.list()` and `repos.get(path).readFile(p)` / `.listFiles()` / `.commitFiles({ message, changes })` / `.log()`, `workspaces.list()`, `secrets.list()`, `fetch(url, init)` (the internet, through the project's egress), `cd(path)` (a sibling context: `append(event)`, `readEvents(after, limit)`), and `readEvents(after, limit)` (this conversation's log).",
].join("\n");

/** The knobs `agent/configured` patches; every one defaulted, so `{}` is a whole config. */
const AgentConfig = z.object({
  llm: z
    .object({ model: z.string().min(1).default("@cf/meta/llama-3.3-70b-instruct-fp8-fast") })
    .prefault({}),
  /** Consecutive self-triggered turns (script results, corrections) before the loop pauses. */
  maxAutonomousTurns: z.number().int().positive().default(20),
  /** How long a recorded request or script stays runnable; past it, settled as expired. */
  llmRequestExpiryMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60_000),
  /** Consecutive model failures before the loop pauses (no backoff: the retry is the next pass). */
  llmRequestRetryPolicy: z
    .object({ maxAttempts: z.number().int().positive().default(3) })
    .prefault({}),
});

/** Where a request's trigger came from: a person (`external`) or the loop's own consequences. */
const TriggerSource = z.enum(["external", "agent-loop"]);

export const AgentView = z.object({
  /** The agent's context path, from the certificate; null until it is born — nothing runs before. */
  path: z.string().nullable().default(null),
  config: AgentConfig.prefault({}),
  /** Every model-visible item, in offset order — the conversation the next request is built from. */
  contextItems: z
    .array(
      z.object({
        offset: z.number().int().positive(),
        role: Role,
        content: z.string(),
        actor: Actor.optional(),
        llmRequestOffset: z.number().int().positive().optional(),
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
  /** Scripts requested and not yet settled, by executionId: the loop's other obligation. */
  activeScriptExecutions: z
    .record(
      z.string(),
      z.object({
        code: z.string(),
        requestedAtOffset: z.number().int().positive(),
        expiresAt: z.number(),
      }),
    )
    .default({}),
});
/** The agent's reduced state: the conversation and the loop's two obligations. */
export type AgentView = z.infer<typeof AgentView>;

export const AgentContract = defineProcessorContract({
  slug: "agent",
  version: "1",
  description:
    "An agent: a conversation on its own context, driven by a model that acts by writing scripts against itx.",
  stateSchema: AgentView,
  events: {
    "events.iterate.com/agent/created": {
      description:
        "The agent's birth certificate, cross-posted to / for the project catalog first and landed on its own path last.",
      payloadSchema: AgentIdentity,
    },
    "events.iterate.com/agent/configured": {
      description:
        "Merges a partial configuration into the agent's config; omitted keys keep their values.",
      payloadSchema: z.object({
        config: z.object({
          llm: z.object({ model: z.string().min(1).optional() }).optional(),
          maxAutonomousTurns: z.number().int().positive().optional(),
          llmRequestExpiryMs: z.number().int().positive().optional(),
          llmRequestRetryPolicy: z
            .object({ maxAttempts: z.number().int().positive().optional() })
            .optional(),
        }),
      }),
    },
    "events.iterate.com/agents/context-added": {
      description:
        "Words into the model's context — the everyday event. A user or developer item raises the pending trigger unless its policy says not to; the assistant's own output carries llmRequestOffset.",
      payloadSchema: z.object({
        role: Role,
        content: z.string(),
        actor: Actor.optional(),
        llmRequestPolicy: z
          .object({ behaviour: z.enum(["dont-trigger-request", "after-current-request"]) })
          .optional(),
        llmRequestOffset: z.number().int().positive().optional(),
      }),
    },
    "events.iterate.com/agents/web-message-sent": {
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
        "The loop recorded its intent to run the model; the event's offset is the request's identity.",
      payloadSchema: z.object({ model: z.string().min(1), expiresAt: z.number() }),
    },
    "events.iterate.com/agent/llm-request-settled": {
      description: "The request's terminal fact: the model's text, its failure, or its expiry.",
      payloadSchema: z.object({
        requestOffset: z.number().int().positive(),
        durationMs: z.number().nonnegative().optional(),
        result: z.discriminatedUnion("status", [
          z.object({ status: z.literal("succeeded"), text: z.string() }),
          z.object({ status: z.literal("failed"), errorMessage: z.string() }),
          z.object({ status: z.literal("cancelled"), reason: z.literal("expired") }),
        ]),
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
    "events.iterate.com/capability-host/script-run-requested": {
      description:
        "The tag's body, to run against this context's itx (apps/os's capability-host vocabulary; here the agent runs it itself).",
      payloadSchema: z.object({
        code: z.string().min(1),
        executionId: z.string().min(1),
        expiresAt: z.number(),
      }),
    },
    "events.iterate.com/capability-host/script-run-settled": {
      description:
        "What the script returned, or how it failed; its rendering is the next developer item.",
      payloadSchema: z.object({
        executionId: z.string().min(1),
        settlement: z.discriminatedUnion("status", [
          z.object({ status: z.literal("succeeded"), result: z.unknown().optional() }),
          z.object({
            status: z.literal("failed"),
            error: z.string(),
            failureKind: z.enum(["runtime", "expired"]),
          }),
        ]),
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
  ],
  emits: [
    "events.iterate.com/agents/context-added",
    "events.iterate.com/agents/web-message-sent",
    "events.iterate.com/agent/summary-updated",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-settled",
    "events.iterate.com/agent/paused",
    "events.iterate.com/agent/resumed",
    "events.iterate.com/capability-host/script-run-requested",
    "events.iterate.com/capability-host/script-run-settled",
  ],
});
