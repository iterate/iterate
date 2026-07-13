import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "../streams/processor-contracts.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";

export const DEFAULT_AGENT_MODEL = "openai/gpt-5.6-sol";
export const DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS = 250;
export const DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS = 100;

/**
 * Spacing between LLM retries after consecutive failures: base × 2^(n-1),
 * capped at 6× base — 10s, 20s, 60s. Without it a provider blip returning
 * instant errors (2026-07-09 prd: Workers AI 8008s in ~90ms) burns the whole
 * retry budget inside one second and the turn dies before the blip clears.
 * Rides the scheduled event's debounceMs, so it is derived from the fold
 * (consecutiveLlmFailures) and deterministic under refold.
 */
export const AGENT_LLM_RETRY_BACKOFF_BASE_MS = 10_000;

/**
 * Two horizons in one constant, deliberately equal:
 *
 * - How stale an llm-request-requested INTENT may be before the reconciler
 *   refuses to start an attempt and settles it as an expired failure instead.
 *   Recovery can deliver a requested event arbitrarily late (a host revived
 *   days after a crash loop); expiry is what makes late recovery safe — wake
 *   whenever, act only within the intent's validity horizon.
 * - The wall-clock cap on one attempt's whole vendor phase (dial + stream
 *   drain, enforced in workers-ai-transport.ts): an attempt that would still
 *   be legitimately running is worth starting; one whose whole lifetime has
 *   lapsed is not.
 */
export const DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS = 10 * 60_000;

/**
 * Last-resort deadline on a `requested` current request, enforced by the
 * scheduling reconciler. Normally dead code: the obligation reconciler
 * settles every open request well before this (attempts self-cap at
 * DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS, crashed attempts cancel, expired
 * intents fail). It exists for folds the normal lifecycle didn't produce —
 * hand-seeded checkpoints, raw-append journals — and as insurance against
 * reconciliation bugs. If it ever races a still-running attempt the outcomes
 * CONVERGE rather than conflict: the backstop failure and any late completion
 * carry idempotent keys, the reducer ignores completions for a request that
 * is no longer current, and the late attempt's output is gated on request
 * currency — the journal records both facts, the fold believes exactly one.
 */
export const AGENT_LLM_REQUEST_BACKSTOP_MS = 30 * 60_000;

/**
 * Compaction trigger: once a completed turn's reported context (input plus
 * output tokens) crosses this fraction of the model's window, the processor
 * summarizes the conversation into a history-reset. Halfway leaves room for
 * many more turns before the window actually fills, so a slow or failed
 * summary attempt never races an imminent context overflow.
 */
export const AGENT_COMPACTION_TRIGGER_FRACTION = 0.5;

/**
 * The default codemode system prompt for web-chat agents (child agents, MCP
 * session agents, and the onboarding agent build on it). Deliberately small:
 * it teaches the ACT contract, the turn loop, the config repo (the one lever
 * behind "update our homepage" / "make an app" / "configure iterate"), how to
 * FIND working code, and then SHOWS the surface as one annotated tour script
 * (delegation, tools, scheduling, files) rather than describing it — terse
 * incantations are safe because every call is expandable through `itx.docs`
 * (e2e-tested example scripts, every type declaration, mounted capabilities)
 * and `__describe()`, so nothing per-capability is front-loaded here.
 * agent-prompt-budgets.test.ts enforces the size ceiling.
 */
export const DEFAULT_AGENT_SYSTEM_PROMPT = [
  "You are a general-purpose agent on the iterate platform. You live at an agent stream path inside a project; the transcript you see is that stream's history, and everything you do is an event on it.",
  "",
  "Two ideas govern everything you do:",
  "1. You write CODE instead of making tool calls: every action is a JavaScript script run against `itx`, this project's capability tree.",
  "2. The project itself IS code you can edit: its website, its apps, its event reactions, and its agents' configuration — including your own prompt and tools — are TypeScript in a git repo, the config repo. One-off work is a script; anything lasting, you build into the repo.",
  "",
  "HOW YOU ACT: respond with exactly ONE fenced JavaScript code block and no prose outside the fence. The block must contain a single async arrow function and START with `async` — no comments or statements before it:",
  "",
  "```js",
  "async (itx) => {",
  "  // your code",
  "}",
  "```",
  "",
  '- Talking to the user is itself a call: `await itx.chat.sendMessage("...")` inside your script (chat renders markdown). Nothing else reaches them — they never see your raw text or your code. After you send, a confirmation input "The assistant sent this visible web-chat message: …" lands in your history: that is your delivery receipt, not a user speaking.',
  "- Whatever your function RETURNS (JSON-serializable) arrives as your next input, and you get another turn to act on it. A thrown error arrives the same way — read it and adapt. Do NOT wrap calls in try/catch just to survive: a raw error is more useful to you than a hand-built `{ error }` object.",
  "- Multi-step work is one script per response: each result comes back to you, and you write the next step having seen it. A response with more than one code block — or a block that does not start with `async` — is rejected with feedback and NOTHING runs; never queue future steps as extra blocks.",
  "- To finish: send your final message(s), then `return;` with no value (or fall off the end). `return null` counts as a value and buys a pointless extra turn. A response with no code block at all also ends your turn.",
  "- Each script runs fresh — no variable survives between scripts. Carry state by returning it, messaging it, or writing a file.",
  "",
  "`itx` is a Cap'n Web RpcStub (Cloudflare's RPC protocol — https://github.com/cloudflare/capnweb) scoped to YOUR agent path in this project. Built-in capabilities (chat, docs, streams, repo, workspace, files, integrations, sandboxes, scheduler, ai, browser, mcp, ...) plus anything this project has mounted for you — on your path or an enclosing one, up to the project root — resolve as `itx.<name>`. An input titled \"Platform context for this agent\" (usually your first, though a fast user message may precede it) carries your project id, agent path, and pointers for this scope.",
  "",
  'THE CONFIG REPO — the code that governs this project, at "/repos/config":',
  "- `worker.ts` is the whole project worker. Its default export serves HTTP for the project's hosts (the homepage and website), routes each named-export app class to its own hostname, reacts to every committed event on every project stream through processEvent(event), and configures every new agent — system prompt, model, capability mounts — via its itx.agents.defaults.forPath reaction. AGENTS.md is durable notes for agents: read it early, write stable project knowledge back. npm dependencies in package.json install at build time; multi-file TypeScript works.",
  "- Every commit lands on MAIN and the project worker/website redeploys automatically — no branches, no push, nothing else to do.",
  "- Two write doors, one rule: `await itx.repo.commitFiles({ message, changes: [{ path, content }] })` for one small file; your private workspace (`itx.workspace`, a live overlay of latest main — readFile/writeFile/edit/glob) to read and change several files, shipped as ONE commit with `await itx.workspace.git.commit({ message })`. ALWAYS read a file before editing it.",
  '- What this means in practice: "update our homepage" = edit the HTML in worker.ts\'s default fetch handler and commit. "Make an app" = add a named-export class to worker.ts and route it — the seeded HelloApp and CounterApp show the stateless and stateful shapes, and each app gets its own hostname. "When X happens, do Y" = add a reaction in processEvent. "Configure iterate" or "change how agents behave" = edit the agent-defaults reaction: override systemPrompt or model, mount new capabilities. That includes YOUR OWN behaviour — like a coding agent working on itself, you can rewrite the instructions agents are born with, or make new tools: any getter you add on the worker class becomes an `itx.worker.<name>` capability, so installing an npm SDK and handing it back whole is a plugin.',
  "",
  "FIND WORKING CODE FIRST — `itx.docs`. Everything is searchable: the platform's catalogue of working example scripts (most are PROVEN — the platform's own test suite runs them unattended against a live project on every change), every type declaration, and this project's mounted capabilities. Before writing calls against anything unfamiliar:",
  "",
  "```js",
  "async (itx) => {",
  "  // Matching is dumb word overlap — pass MANY related words; synonyms buy recall.",
  '  const hits = await itx.docs.search({ q: "email gmail inbox unread messages send" });',
  '  return hits; // [{ kind: "example" | "type" | "capability", name, summary, fetchCall }]',
  "}",
  "```",
  "",
  'Every hit carries a `fetchCall` string — the exact call that fetches its full doc, e.g. `await itx.docs.get({ name: "gmail-search-inbox" })`; copy it verbatim as your next call. Fetched examples are paste-ready scripts (their inputs sit in a `vars` object inside the function — swap in real values); fetched type names return TypeScript source plus referenced types. `await itx.<node>.__describe()` describes any node — including mounted capabilities — with instructions and a member map. Search first, describe what you hold, never guess an API shape.',
  "",
  "A TOUR IN CODE — every call below is real (one script would never do all this at once); `itx.docs.search` has the full story and a working example for each:",
  "",
  "```js",
  "async (itx) => {",
  "  // FIND HOW — search before writing calls against anything unfamiliar:",
  '  const hits = await itx.docs.search({ q: "email gmail inbox unread send" });',
  "",
  "  // TALK — and run slow work in parallel alongside (your parallel tool calling):",
  "  const [, page] = await Promise.all([",
  '    itx.chat.sendMessage("Reading the docs now..."),',
  '    itx.browser.quickAction("markdown", { url: "https://developers.cloudflare.com/workers/" }),',
  "  ]);",
  "",
  "  // SEARCH THE WEB; read any public repo raw:",
  '  const found = await itx.mcp.exa.web_search_exa({ query: "capnweb promise pipelining", numResults: 5 });',
  '  const readme = await (await fetch("https://raw.githubusercontent.com/cloudflare/capnweb/main/README.md")).text();',
  "",
  "  // CHANGE THE PROJECT — read, edit, commit; lands on main and auto-redeploys:",
  '  const worker = await itx.repo.readFile({ path: "worker.ts" });',
  "  await itx.repo.commitFiles({",
  '    message: "homepage: add tagline",',
  '    changes: [{ path: "worker.ts", content: worker.content.replace("</h1>", "</h1><p>Hi!</p>") }],',
  "  });",
  "  // (several files? itx.workspace is your private overlay — readFile/writeFile/edit/glob —",
  "  //  shipped as ONE commit: await itx.workspace.git.commit({ message }))",
  "",
  "  // DELEGATE — messaging a path births an agent there; the message must carry ALL context:",
  "  await Promise.all([",
  '    itx.agents.get("research-pricing").message("Deep-dive competitor pricing. Context: ..."),',
  '    itx.agents.get("research-reviews").message("Summarize what customers say. Context: ..."),',
  "  ]); // now END YOUR TURN — their reports arrive as your inputs; synthesize then",
  "  // Standing agents are project infrastructure — e.g. report friction to a shared collector:",
  '  await itx.agents.get("/agents/bugs").message("docs.search returned nothing for query X");',
  "",
  "  // CONNECT AN API — MCP servers and OpenAPI specs become callable in one expression:",
  "  const pets = await itx.openapi",
  '    .connect({ specUrl: "https://petstore3.swagger.io/api/v3/openapi.json" })',
  '    .findPetsByStatus({ status: "available" }); // the spec\'s operationIds are methods',
  "  // (itx.mcp.connect({ url }).some_tool({ ... }) works the same — MCP tools are methods)",
  "",
  "  // MAKE A TOOL — mount any such recipe as a named, durable capability; streams",
  '  // (["streams", ["get", "/memos"]]) and dynamic workers (["workers", ["get", ref]]) mount the same way:',
  "  await itx.provideCapability({",
  '    path: ["petstore"],',
  '    type: "itx-expression",',
  '    expression: ["openapi", ["connect", { specUrl: "https://petstore3.swagger.io/api/v3/openapi.json" }]],',
  '    instructions: "Swagger Petstore: itx.petstore.findPetsByStatus({ status }) — any operationId from the spec.",',
  "  });",
  "  // ...that mounts on YOUR scope (you + your child agents). For the WHOLE project:",
  '  //   await itx.capabilityHosts.get("/").provideCapability({ ... })',
  '  // A tool with a DATABASE = a stateful dynamic worker: await itx.docs.get({ name: "dynamic-worker-stateful" })',
  "",
  "  // SECRETS — store once with an egress allowlist; the value is NEVER readable, it",
  "  // substitutes server-side into matching egress requests via a placeholder:",
  '  await itx.secrets.get("/secrets/acme").update({ egress: { urls: ["https://api.acme.com/"] }, material: "sk-live-..." });',
  '  const me = await itx.egress.fetch("https://api.acme.com/v1/me", {',
  "    headers: { authorization: 'Bearer getSecret({ path: \"/secrets/acme\" })' },",
  "  });",
  "  // Only the USER has the key? NEVER ask for it in chat — mint a form page; when they",
  "  // submit, the secret exists and a message wakes you (full flow: `secret-collect-from-user`):",
  '  const link = await itx.secrets.collectFromUser({ path: "/secrets/acme", egress: { urls: ["https://api.acme.com/"] }, description: "Acme API key" });',
  "  await itx.chat.sendMessage(`[Enter your Acme API key here](${link.url})`);",
  "  // If the user pastes a key into chat anyway, that is fine: store it and proceed —",
  "  // unblocking them comes first. But a pasted key sat in the transcript, so advise them",
  "  // to roll it and collect the replacement through the same link (it updates existing secrets too).",
  "  // MCP server needs OAuth (connect 401s with WWW-Authenticate, e.g. Cloudflare's)? itx.mcp.beginOAuth({ url, path })",
  '  // returns a sign-in link; after the user signs in, connect with field "accessToken". Full flow: `connect-mcp-oauth`.',
  "",
  "  // LATER / RECURRING — the script string runs later with full project access:",
  "  await itx.scheduler.set({",
  '    key: "daily-report",',
  '    recurrence: { cron: "0 9 * * *", timezone: "Europe/London" },',
  "    script: \"async (itx) => { await itx.agents.get('/agents/daily-report').message('Write the daily report.'); }\",",
  "  });",
  "",
  "  // SHARE A FILE — attach it; never paste base64 into message text:",
  '  const resp = await fetch("https://example.com/chart.png");',
  '  await itx.chat.sendMessage("Here!", { files: [{ filename: "chart.png", contentType: "image/png", data: await resp.blob() }] });',
  "",
  "  return hits; // whatever you return arrives as your next input",
  "}",
  "```",
  "",
  "THE SHAPE OF WORK — scripts are tool calls, not programs:",
  "- Most scripts should fetch data and RETURN it. You cannot see data while writing the script, so code that interprets response shapes you have never seen is guesswork. Get the data in front of your eyes; decide on the next turn.",
  "- The script body is real JavaScript: `Promise.all` fans out independent calls, `Promise.race` bounds anything that might hang (scripts get minutes, not hours), map/filter/loops handle mechanical iteration.",
  "- Return only what you need: pick fields, slice arrays. Oversized results are truncated and the FULL result is saved to a workspace file — the notice names the path; read it with `itx.workspace.readFile` and filter it in plain JavaScript instead of re-fetching.",
  "- Send as many chat messages per script as helps: an acknowledgement before slow work, one message per result, a final summary.",
  "",
  "OTHER AGENTS — the semantics behind the tour's delegation calls:",
  '- A relative name (`itx.agents.get("researcher")`) addresses a child under YOUR path; an absolute one (`/agents/bugs`) a shared project agent. There is no separate create step or subagent machinery — the first message births the agent.',
  "- The receiver cannot see your conversation; its report arrives as your input, labeled with the sender's path and how to reply. For a quick question `ask({ message, timeoutMs })` is send-and-wait; prefer message() plus end-turn for real delegated work — a report can outlive ask's timeout.",
  "",
  "FILES:",
  "- You cannot see image pixels: every file — yours or the user's — reaches you as a hint line with the path, type, and recipes. To find out what an image or document CONTAINS, convert it to text: `const doc = await itx.ai.toMarkdown({ name, blob: new Blob([await itx.files.get(path).bytes()]) });`.",
  '- To keep a file from a URL at hand across turns, attach it to yourself: fetch it, then `itx.agent.addFiles({ files: [{ filename, contentType, data }], llmRequestPolicy: { behaviour: "dont-trigger-request" } })` (the option keeps the upload from waking you). Attached images render inline for the user and become visible to YOU on later turns.',
  "",
  "GOTCHAS:",
  "- Some handles must be awaited before you call through them: if `itx.x.get(...).method(...)` fails oddly, split it — `const h = await itx.x.get(...); await h.method(...)`.",
  "- Never tell the user you lack access before checking: `await itx.integrations.list()` shows connections (Gmail, GitHub, Slack, ...); mounted capabilities appear in `itx.docs.search` and `itx.__describe()`.",
  '- Project-specific tools and data live in MOUNTED CAPABILITIES and integrations, not in the repo\'s files — when hunting for "something this project can do", search docs and __describe before reading worker.ts.',
  "- The platform you run on is open source: https://github.com/iterate/iterate — `apps/os/src/itx/examples.ts` is the whole example catalogue, `apps/os/src/rpc-targets.ts` every capability's real behavior; AI-written architecture summaries at https://deepwiki.com/iterate/iterate.",
].join("\n");

/**
 * A file reference riding on an agent input: where the bytes live in project
 * file storage plus the signed public URL minted when it was attached. The
 * URL is stored (not re-minted per read) so history stays deterministic;
 * links in old conversations expire with the signature (default 7 days).
 */
export const AgentFileAttachment = z.object({
  contentType: z.string(),
  filename: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string(),
});
/** A file attached to an agent input: content type, filename, project
 * file-storage path, size, and the signed public URL minted at attach time
 * (stored, not re-minted — it expires with its signature). */
export type AgentFileAttachment = z.infer<typeof AgentFileAttachment>;

/**
 * One model-visible history item as the LLM turn receives it: a user or
 * assistant turn, plus any file attachments. `history-reset` payloads are
 * arrays of these, so a reset can rebuild any history shape — summary-only,
 * or summary plus recent turns kept verbatim.
 */
const AgentInputItem = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  files: z.array(AgentFileAttachment).optional(),
});

const LlmRequestPolicy = z
  .discriminatedUnion("behaviour", [
    z.object({ behaviour: z.literal("dont-trigger-request") }),
    z.object({ behaviour: z.literal("interrupt-current-request") }),
    z.object({ behaviour: z.literal("after-current-request") }),
  ])
  .default({ behaviour: "after-current-request" });

/**
 * WHO sent an inbound message — the discriminant every consumer keys on:
 * the reducer picks the trigger source ("agent" mail counts against the
 * autonomous turn budget instead of refilling it; humans refill it), the UI
 * picks the bubble label, and transcribers record the sender facts they
 * have in hand. One inbound message event for every source is the point:
 * web chat, MCP, another agent, and the domain transcribers all go through
 * the same door.
 */
const AgentMessageFrom = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), origin: z.enum(["web", "mcp"]) }),
  z.object({ kind: z.literal("agent"), path: z.string() }),
  z.object({
    kind: z.literal("slack"),
    userId: z.string().optional(),
    botName: z.string().optional(),
  }),
  z.object({
    kind: z.literal("telegram"),
    userId: z.string().optional(),
    username: z.string().optional(),
  }),
  z.object({
    kind: z.literal("email"),
    address: z.string().optional(),
    name: z.string().optional(),
  }),
  z.object({
    kind: z.literal("github"),
    login: z.string().optional(),
    senderType: z.string().optional(),
  }),
]);

const LlmRequestResult = z.discriminatedUnion("status", [
  z.object({
    rawResponse: z.unknown().optional(),
    status: z.literal("success"),
    usage: z.unknown().optional(),
  }),
  z.object({
    error: z.object({ message: z.string() }),
    rawResponse: z.unknown().optional(),
    status: z.literal("failure"),
  }),
]);

export const AgentProcessorContract = defineProcessorContract({
  slug: "agent",
  version: "0.8.0",
  description:
    "Maintains model-visible history, schedules LLM turns, and runs them through the Cloudflare AI binding.",
  stateSchema: z.object({
    systemPrompt: z.string().default(DEFAULT_AGENT_SYSTEM_PROMPT),
    history: z.array(AgentInputItem).default([]),
    llmConfig: z
      .object({
        model: z.string().min(1),
      })
      .default({ model: DEFAULT_AGENT_MODEL }),
    llmConfigConfigured: z.boolean().default(false),
    currentRequest: z
      .discriminatedUnion("phase", [
        z.object({
          phase: z.literal("scheduled"),
          requestId: z.string(),
          scheduledOffset: z.number().int().positive(),
        }),
        z.object({
          phase: z.literal("requested"),
          /** The llm-request-requested event's own stream offset — the handle
           * every later lifecycle event (started/chunk/completed/cancelled)
           * carries. */
          llmRequestOffset: z.number().int().positive(),
          /** Epoch ms the requested event committed (its createdAt), driving
           * the reconciler's backstop deadline. Optional: raw appends and
           * pre-backstop checkpoints lack it, and the backstop then skips. */
          requestedAt: z.number().int().positive().optional(),
        }),
      ])
      .nullable()
      .default(null),
    pendingTriggerOffset: z.number().int().positive().nullable().default(null),
    pendingTriggerSource: z.enum(["user", "agent-loop"]).nullable().default(null),
    autonomousTurnCount: z.number().int().nonnegative().default(0),
    /**
     * Count of finished LLM request lifecycles (completed or cancelled).
     * llm-request-scheduled idempotency is keyed on this, so every trigger
     * derivation between two finishes — however delivery batches the inputs —
     * collapses into one scheduled event at the stream's append dedup layer.
     */
    requestGeneration: z.number().int().nonnegative().default(0),
    /**
     * Failed llm-request-completed events since the last success. Governs
     * whether a failure's error input auto-retries (below the cap) or sits in
     * context untriggered (at the cap) — a persistent provider failure must
     * not retry-loop forever.
     */
    consecutiveLlmFailures: z.number().int().nonnegative().default(0),
    /**
     * Whether the most recent LLM failure was the vendor's rate limit
     * (Workers AI 3021). Rate limits are TIME-gated — quota refills on a
     * per-minute window — so a REPEAT rate-limited failure jumps the retry
     * backoff to the ladder cap instead of burning the last attempt inside
     * the same hot minute. Cleared by any success (with
     * consecutiveLlmFailures).
     */
    lastLlmFailureRateLimited: z.boolean().default(false),
    /**
     * Open LLM obligations: every request that has not reached a terminal
     * event, keyed by the llm-request-requested event's offset (as a string).
     * The reconcile pass compares this fold against the incarnation's live
     * execution set. Entries carry model + expiresAt so recovery can START an
     * attempt from state alone. Terminal events delete the entry (not mark
     * completed).
     */
    llmRequests: z
      .record(
        z.string(),
        z.object({
          status: z.enum(["requested", "started"]),
          model: z.string().min(1),
          /** Epoch ms past which no attempt may START; stale intent settles
           * as an expired failure instead. */
          expiresAt: z.number().int().positive(),
        }),
      )
      .default({}),
    /**
     * Lifetime token totals, folded from token-usage-reported. Cost/observability
     * data, not loop-control state: nothing in the agent loop branches on it.
     * The compaction trigger reads each report's own payload instead (the
     * report carries `maxContextTokens` for exactly that).
     */
    tokenUsage: z
      .object({
        totalInputTokens: z.number().int().nonnegative().default(0),
        totalOutputTokens: z.number().int().nonnegative().default(0),
        totalCachedInputTokens: z.number().int().nonnegative().default(0),
        totalReasoningOutputTokens: z.number().int().nonnegative().default(0),
      })
      .prefault({}),
  }),
  events: {
    "events.iterate.com/agent/config-updated": {
      description: "Project-authored agent setup/configuration.",
      payloadSchema: z.object({
        systemPrompt: z.string().optional(),
      }),
      examples: [
        {
          description: "A project configures the agent with a custom system prompt at setup time.",
          payload: {
            systemPrompt:
              "You are the support agent for Acme Corp. Answer billing questions concisely and escalate refund requests to a human.",
          },
        },
      ],
    },
    "events.iterate.com/agent/system-prompt-updated": {
      description: "Updates the system prompt used for future LLM requests.",
      payloadSchema: z.object({
        systemPrompt: z.string(),
      }),
      examples: [
        {
          description: "The system prompt is replaced for every LLM request from here on.",
          payload: {
            systemPrompt:
              "You are Acme's release manager. Track open pull requests and nag reviewers politely.",
          },
        },
      ],
    },
    "events.iterate.com/agent/input-added": {
      description: "A normalized model-visible input was added.",
      payloadSchema: z.object({
        content: z.string(),
        /** Files attached to this input — see {@link AgentFileAttachment}. */
        files: z.array(AgentFileAttachment).optional(),
        llmRequestPolicy: LlmRequestPolicy,
      }),
      examples: [
        {
          description:
            "A script result becomes a model-visible input; the next LLM turn starts once the current request (if any) finishes.",
          payload: {
            content: 'Script result:\n```json\n{ "unread": 4 }\n```',
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
        },
        {
          description:
            "A file lands in the conversation as an attachment, recorded without triggering an LLM turn.",
          payload: {
            content: "[Files attached: report.pdf]",
            files: [
              {
                contentType: "application/pdf",
                filename: "report.pdf",
                path: "/uploads/2026-07-09/report.pdf",
                size: 482133,
                url: "https://iterate-files--acme.iterate.app/uploads/2026-07-09/report.pdf?exp=1783555200&sig=8c1f2ab9d4e7c0a3",
              },
            ],
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
          },
        },
      ],
    },
    "events.iterate.com/agents/message-received": {
      description:
        "A message reached the agent. THE inbound message event for every source — `from` says who sent it: a user (web UI or MCP client), another agent (delegation and reports ride exactly this), or a domain transcriber relaying a Slack/email/GitHub message. The reducer folds it straight into model-visible history; `llmRequestPolicy` carries the sender's trigger gating (e.g. mention-gated PR comments record without waking the agent).",
      payloadSchema: z.object({
        content: z.string(),
        from: AgentMessageFrom,
        /** Files attached to the message — see {@link AgentFileAttachment}. */
        files: z.array(AgentFileAttachment).optional(),
        llmRequestPolicy: LlmRequestPolicy,
      }),
      examples: [
        {
          description: "A user sends a chat message from the web UI.",
          payload: {
            content: "What's on my calendar today?",
            from: { kind: "user", origin: "web" },
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
        },
        {
          description: "One agent sends work to another agent.",
          payload: {
            content:
              "Find every place we retry failed webhook deliveries and summarize the backoff policy.",
            from: { kind: "agent", path: "/agents/main" },
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
        },
        {
          description:
            "The slack-agent transcriber relays a thread message; a reaction or join would carry dont-trigger-request instead.",
          payload: {
            content:
              "`events.iterate.com/slack/webhook-received` event received\n\n```yaml\nevent:\n  type: message\n  text: what's our uptime this month?\n```",
            from: { kind: "slack", userId: "U0788AB12CD" },
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
        },
      ],
    },
    "events.iterate.com/agents/web-message-sent": {
      description: "A visible agent message was sent to the web UI.",
      payloadSchema: z.object({
        message: z.string(),
        /** Files attached to the message — see {@link AgentFileAttachment}. */
        files: z.array(AgentFileAttachment).optional(),
      }),
      examples: [
        {
          description: "The agent sends a visible chat reply to the web UI.",
          payload: {
            message:
              "You have 4 unread emails. The two that look important are from Dana (contract renewal) and GitHub (a failing build on main).",
          },
        },
      ],
    },
    "events.iterate.com/agent/output-added": {
      description: "The LLM produced assistant output.",
      payloadSchema: z.object({
        content: z.string(),
        /** Offset of the llm-request-requested event this output answers. */
        llmRequestOffset: z.number().int().positive().optional(),
      }),
      examples: [
        {
          description:
            "The model answered with a codemode script; llmRequestOffset is the offset of the llm-request-requested event it answers.",
          payload: {
            content:
              '```js\nasync (itx) => {\n  await itx.chat.sendMessage("Checking your email now...");\n}\n```',
            llmRequestOffset: 57,
          },
        },
      ],
    },
    "events.iterate.com/agent/llm-provider-selected": {
      description: "Selects the model for future LLM requests.",
      payloadSchema: z.object({
        ifUnset: z.boolean().optional(),
        model: z.string().min(1),
      }),
      examples: [
        {
          description:
            "Agent birth applies the platform default model unless something already chose one.",
          payload: {
            ifUnset: true,
            model: "openai/gpt-5.6-sol",
          },
        },
        {
          description: "The project explicitly selects a Workers AI model.",
          payload: { model: "openai/gpt-5.6-sol" },
        },
      ],
    },
    "events.iterate.com/agent/llm-request-scheduled": {
      description: "An LLM request was scheduled after a trigger.",
      payloadSchema: z.object({
        debounceMs: z.number().int().nonnegative(),
        model: z.string().min(1),
        requestId: z.string(),
      }),
      examples: [
        {
          description:
            "A user input triggered a request, debounced 250ms so rapid-fire inputs collapse into one turn.",
          payload: {
            debounceMs: 250,
            model: "openai/gpt-5.6-sol",
            requestId: "llm-request:gen-3",
          },
        },
      ],
    },
    "events.iterate.com/agent/llm-request-requested": {
      description:
        "The agent has prepared an LLM request. The event's own offset is the llmRequestOffset every later lifecycle event references; the processor rebuilds the prompt from history.",
      payloadSchema: z.object({
        model: z.string().min(1),
        requestId: z.string(),
        /** Epoch ms past which no attempt may START; stale intent settles as
         * an expired failure instead. Absent (raw appends), reconciliation
         * defaults to createdAt + DEFAULT_AGENT_LLM_REQUEST_EXPIRY_MS. */
        expiresAt: z.number().int().positive().optional(),
      }),
      examples: [
        {
          description:
            "The debounce elapsed and the request went out; this event's own offset becomes the llmRequestOffset the processor answers to.",
          payload: {
            model: "openai/gpt-5.6-sol",
            requestId: "llm-request:gen-3",
          },
        },
      ],
    },
    "events.iterate.com/agent/llm-request-started": {
      description: "The agent processor started an LLM request through the AI binding.",
      payloadSchema: z.object({
        llmRequestOffset: z.number().int().positive(),
        model: z.string().min(1),
      }),
      examples: [
        {
          description: "The agent picks up a prepared request and dials the AI binding.",
          payload: { llmRequestOffset: 57, model: "openai/gpt-5.6-sol" },
        },
      ],
    },
    "events.iterate.com/agent/llm-response-chunk": {
      description:
        "One streamed chunk received from the AI binding. Appended EPHEMERAL: it reaches ephemeral subscriptions (browser feed, TUI) but is excluded from default reads, never delivered to durable subscribers, and evictable — the durable truth is the output-added / llm-request-completed pair.",
      payloadSchema: z.object({
        chunk: z.unknown(),
        llmRequestOffset: z.number().int().positive(),
        sequence: z.number().int().nonnegative(),
      }),
      examples: [
        {
          description: "The first streamed text delta of a response.",
          payload: {
            chunk: { choices: [{ delta: { content: "Hello" } }] },
            llmRequestOffset: 57,
            sequence: 0,
          },
        },
      ],
    },
    "events.iterate.com/agent/llm-request-completed": {
      description: "The agent processor finished an LLM request.",
      payloadSchema: z.object({
        durationMs: z.number().int().nonnegative(),
        llmRequestOffset: z.number().int().positive(),
        result: LlmRequestResult,
      }),
      examples: [
        {
          description:
            "The LLM returned assistant output, with token usage as the model reported it.",
          payload: {
            durationMs: 2340,
            llmRequestOffset: 57,
            result: {
              status: "success",
              usage: { completion_tokens: 118, prompt_tokens: 4096, total_tokens: 4214 },
            },
          },
        },
        {
          description:
            "The LLM call failed; the error becomes a model-visible input so the agent can react.",
          payload: {
            durationMs: 30012,
            llmRequestOffset: 61,
            result: {
              error: { message: "LLM request timed out after 30000ms" },
              status: "failure",
            },
          },
        },
      ],
    },
    "events.iterate.com/agent/token-usage-reported": {
      description:
        "Normalized token counts and the model's context window for a successfully completed " +
        "LLM request. The processor translates vendor usage dialects (input_tokens vs " +
        "prompt_tokens) at source, so consumers — the state tally, cost views, and compaction — " +
        "see one shape.",
      payloadSchema: z.object({
        /** The llm-request-requested event this request ran under — the same
         * handle the lifecycle events carry. */
        llmRequestOffset: z.number().int().positive(),
        model: z.string().min(1),
        /** The model's context window, so a consumer can judge fullness from the event alone. */
        maxContextTokens: z.number().int().positive(),
        /** Total input tokens, including cached ones. */
        inputTokens: z.number().int().nonnegative(),
        /** Total output tokens, including reasoning ones. */
        outputTokens: z.number().int().nonnegative(),
        /** Prompt-cache hits, where the model reports them. */
        cachedInputTokens: z.number().int().nonnegative().optional(),
        /** Reasoning/thinking tokens, where the model reports them. */
        reasoningOutputTokens: z.number().int().nonnegative().optional(),
      }),
      examples: [
        {
          description:
            "An OpenAI model reports a mostly-cache-hit request at about a tenth of the model's window.",
          payload: {
            llmRequestOffset: 57,
            model: "openai/gpt-5.6-sol",
            maxContextTokens: 272000,
            inputTokens: 29295,
            outputTokens: 111,
            cachedInputTokens: 28416,
            reasoningOutputTokens: 0,
          },
        },
      ],
    },
    "events.iterate.com/agent/history-reset": {
      description:
        "Replaces the agent's model-visible history and system prompt wholesale. The " +
        "processor's compaction lane appends it when a turn's context crosses the window " +
        "threshold; anything else may append one too (userspace history management).",
      payloadSchema: z.object({
        systemPrompt: z.string(),
        history: z.array(AgentInputItem),
        reason: z.string().optional(),
      }),
      examples: [
        {
          description:
            "A userspace compaction reaction replaces a near-full history with a summary; the offset in the reason is the token-usage-reported event that triggered it.",
          payload: {
            systemPrompt: "You are a helpful assistant.",
            history: [
              {
                role: "user",
                content:
                  "[Earlier conversation history was compacted. Summary:]\n\nThe user is debugging a failing deploy...",
              },
            ],
            reason: "compaction@1042: ~180000 tokens > 136000",
          },
        },
      ],
    },
    "events.iterate.com/agent/llm-request-cancelled": {
      description: "The current scheduled or requested LLM request was cancelled.",
      payloadSchema: z.discriminatedUnion("phase", [
        z.object({
          phase: z.literal("scheduled"),
          reason: z.literal("interrupted-by-user-input"),
          requestId: z.string(),
        }),
        z.object({
          phase: z.literal("requested"),
          reason: z.enum(["interrupted-by-user-input", "durable-object-crashed"]),
          llmRequestOffset: z.number().int().positive(),
        }),
      ]),
      examples: [
        {
          description: "New user input interrupted a request still in its debounce window.",
          payload: {
            phase: "scheduled",
            reason: "interrupted-by-user-input",
            requestId: "llm-request:gen-4",
          },
        },
        {
          description: "New user input interrupted a request already running at the model.",
          payload: {
            phase: "requested",
            reason: "interrupted-by-user-input",
            llmRequestOffset: 58,
          },
        },
        {
          description:
            "The Durable Object incarnation died mid-attempt (kill/reset/eviction); the reconciler cancelled the in-flight request and the turn reschedules.",
          payload: {
            phase: "requested",
            reason: "durable-object-crashed",
            llmRequestOffset: 61,
          },
        },
      ],
    },
    "events.iterate.com/agent/loop-stopped": {
      description:
        "The agent circuit breaker stopped an autonomous tool-result loop without pausing the stream.",
      payloadSchema: z.object({
        maxAutonomousTurns: z.number().int().positive(),
        reason: z.string().trim().min(1),
        triggerOffset: z.number().int().positive(),
      }),
      examples: [
        {
          description:
            "The circuit breaker halted an agent that chained 100 autonomous script turns without human input.",
          payload: {
            maxAutonomousTurns: 100,
            reason: "Agent circuit breaker stopped after 100 consecutive autonomous turns.",
            triggerOffset: 143,
          },
        },
      ],
    },
  },
  processorDeps: [CapabilityHostProcessorContract, CoreProcessorContract],
  consumes: [
    "events.iterate.com/agent/config-updated",
    "events.iterate.com/agent/system-prompt-updated",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agents/message-received",
    "events.iterate.com/agents/web-message-sent",
    "events.iterate.com/agent/output-added",
    "events.iterate.com/agent/llm-provider-selected",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-started",
    "events.iterate.com/agent/llm-request-completed",
    "events.iterate.com/agent/token-usage-reported",
    "events.iterate.com/agent/history-reset",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/agent/loop-stopped",
    "events.iterate.com/capability-host/script-execution-completed",
  ],
  emits: [
    "events.iterate.com/agent/system-prompt-updated",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-started",
    "events.iterate.com/agent/llm-response-chunk",
    "events.iterate.com/agent/llm-request-completed",
    "events.iterate.com/agent/token-usage-reported",
    "events.iterate.com/agent/history-reset",
    "events.iterate.com/agent/output-added",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/agent/loop-stopped",
    "events.iterate.com/capability-host/script-execution-requested",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<AgentProcessorContract>`,
 * `ConsumedEvent<AgentProcessorContract>`, `ProcessorEvent<AgentProcessorContract, T>`.
 */
export type AgentProcessorContract = typeof AgentProcessorContract;

/**
 * The agent processor's reduced state, inferred from the contract's
 * `stateSchema`.
 */
export type AgentProcessorState = ProcessorState<AgentProcessorContract>;
