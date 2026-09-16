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
// a person's next words resume. A request is DEBOUNCED as in apps/os: one window after the trigger
// (more words inside it move the trigger; one request answers them all), a failure's backoff folded
// into the same window. Dropped from apps/os on purpose: streaming chunks, interrupts, compaction,
// token accounting, summaries, mentions, and the capability host with its typecheck and preambles —
// the script runs against this context's `itx` as it is.
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

/** What the model is told when `create()` is given no prompt of its own — mmkal's codemode-tag
 *  prompt (configs/codemode-tag) with this context's `itx`, and, since os-next hands a script no
 *  types and no typecheck, the surface shown by EXAMPLE: one line per verb, as the tag's body. */
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
  "- Each script runs fresh — no variable survives between scripts. Carry state by returning it or writing it. There is no typechecker and no type definitions: when unsure of a shape, return a small sample first and look at it.",
  "- Images a person attaches are shown to you directly. Any other attachment is named in the message with its path — read it with `await itx.files.get(path).bytes()`.",
  "",
  "`itx` IS THIS CONTEXT'S CAPABILITY TREE. Every line below is a complete statement you can put inside a tag:",
  "",
  "WHO AND WHERE",
  "return await itx.whoami()                                   // { projectId, path }",
  "",
  "KEY-VALUE (strings; the project's own)",
  'await itx.kv.put("greeting", "hello")',
  'return await itx.kv.get("greeting")                          // "hello" or null',
  'return (await itx.kv.list("gre")).keys                       // ["greeting"]',
  'await itx.kv.delete("greeting")',
  "",
  "FILES (project file storage; a file is its path, its bytes and a content type)",
  'await itx.files.get("/reports/q3.md").put({ contentType: "text/markdown", data: btoa("# Q3") })  // data: base64, a data: URL, or bytes',
  'return new TextDecoder().decode(await itx.files.get("/reports/q3.md").bytes())',
  'return await itx.files.list("/reports")                      // [{ path, contentType, size }]',
  'return await itx.files.get("/reports/q3.md").url()           // { url, expiresAt } — a signed download link, 7 days',
  'return await itx.files.get("/uploads/in.csv").url({ method: "PUT", expiresInSeconds: 3600 })  // a signed upload link',
  'await itx.files.get("/reports/q3.md").delete()',
  "",
  "REPOS (git, on Cloudflare; `/repos/config` is the project's own code)",
  "return await itx.repos.list()                                // [{ path, createdAt }]",
  'return (await itx.repos.get("/repos/config").listFiles()).paths',
  'return await itx.repos.get("/repos/config").readFile("worker.ts")',
  'await itx.repos.get("/repos/config").commitFiles({ message: "add a note", changes: [{ path: "notes/today.md", content: "hi" }] })',
  'return await itx.repos.get("/repos/config").log({ limit: 5 })',
  "",
  "WORKSPACES (a private overlay over the repos, committed per mount)",
  'const ws = itx.workspaces.get("/workspaces/me"); await ws.create(); await ws.writeFile("/repos/config/notes/draft.md", "wip"); return await ws.gitStatus()',
  'return await itx.workspaces.get("/workspaces/me").gitCommit({ message: "draft", scope: "/repos/config" })',
  "",
  "SECRETS (never the values — a placeholder in an outbound request substitutes at egress)",
  "return await itx.secrets.list()                              // [{ name, ... }]",
  'const r = await itx.fetch(new Request("https://api.example.com/me", { headers: { authorization: \'Bearer getSecret("/secrets/example")\' } })); return await r.json()',
  "",
  "THE INTERNET (through the project's egress)",
  'const r = await itx.fetch(new Request("https://api.github.com/repos/cloudflare/workerd")); return (await r.json()).stargazers_count',
  "",
  "THIS CONVERSATION AND OTHER CONTEXTS (everything is an event on a log)",
  "return (await itx.readEvents(0, 20)).events.map((e) => e.type)     // this context's log",
  'await itx.append({ type: "events.iterate.com/notes/added", payload: { text: "remember this" } })',
  'const other = itx.cd("/inbox"); await other.append({ type: "note", payload: { from: "me" } }); return (await other.readEvents(0, 10)).events.length',
  "",
  "OTHER AGENTS (each a conversation on its own path)",
  "return await itx.agents.list()                               // [{ path, createdAt }]",
  'const helper = itx.agents.get("/agents/helper"); await helper.create({ systemPrompt: "You summarize." }); await helper.message("Summarize: ...")',
  "",
  "MODELS AND THE BROWSER (Cloudflare bindings, verbatim)",
  'return (await itx.ai.run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages: [{ role: "user", content: "one word: hi" }] })).response',
  'return await itx.browser.quickAction("markdown", { url: "https://example.com" })   // the page as markdown; "screenshot", "links", "json" too',
  "",
  "MCP AND OPENAPI SERVICES (a live handle per turn)",
  'const mcp = await itx.connectToMcp("https://mcp.example.com/mcp"); return await mcp.listTools()',
  'const api = await itx.connectToOpenApi("https://api.example.com/openapi.json"); return await api.call("listPets", { limit: 3 })',
  "",
  "A SUB-SCRIPT (a fresh confined run of a script you write as text)",
  'return await itx.run("async (itx) => (await itx.kv.list()).keys.length")',
].join("\n");

/** The knobs `agent/configured` patches; every one defaulted, so `{}` is a whole config. */
const AgentConfig = z.object({
  llm: z
    // OpenAI's astra, read FAST (low reasoning effort, the priority tier — durable-object.ts); a
    // `@cf/…` name routes to Workers AI instead (`@cf/meta/llama-4-scout-17b-16e-instruct` sees images too).
    .object({ model: z.string().min(1).default("gpt-6-astra") })
    .prefault({}),
  /** Consecutive self-triggered turns (script results, corrections) before the loop pauses. */
  maxAutonomousTurns: z.number().int().positive().default(20),
  /** How long a recorded request or script stays runnable; past it, settled as expired. */
  llmRequestExpiryMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60_000),
  /** apps/os's window: a request waits this long after its trigger for more content — a second
   *  message inside the window moves the trigger and ONE request answers both. */
  llmRequestDebounceMs: z.number().int().nonnegative().default(250),
  /** Consecutive model failures before the loop pauses; between attempts, apps/os's backoff —
   *  `backoffBaseMs · 2^(failures−1)`, capped at `backoffMaxMs` — folded into the debounce window. */
  llmRequestRetryPolicy: z
    .object({
      maxAttempts: z.number().int().positive().default(3),
      backoffBaseMs: z.number().int().nonnegative().default(10_000),
      backoffMaxMs: z.number().int().nonnegative().default(60_000),
    })
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
    "events.iterate.com/agents/context-added": {
      description:
        "Words into the model's context — the everyday event. A user or developer item raises the pending trigger unless its policy says not to; the assistant's own output carries llmRequestOffset.",
      payloadSchema: z.object({
        role: Role,
        content: z.string(),
        actor: Actor.optional(),
        /** What rides with the words: files stored under this agent's path (`message()` stores them). */
        files: z.array(FileAttachment).optional(),
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
