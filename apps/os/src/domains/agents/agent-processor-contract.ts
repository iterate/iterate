import {
  AGENT_BINDING_SET_EVENT_TYPE,
  AGENT_SUMMARY_UPDATED_EVENT_TYPE,
  AgentLlmRequestCancelReason,
  AgentRuntime,
} from "@iterate-com/shared/agent-events";
import { z } from "zod";
import {
  defineProcessorContract,
  STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  type ConsumedInput,
  type ProcessorState,
} from "iterate/processors";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { AgentBinding, AgentSummary, AgentSummaryUpdated } from "./agent-presence.ts";

export const DEFAULT_AGENT_MODEL = "openai/gpt-5.6-sol";
export const DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS = 250;
export const DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS = 100;
/** The one logical system-context slot whose presence makes an agent ready. */
export const AGENT_SYSTEM_PROMPT_CONTEXT_KEY = "agent/system-prompt";

export const AgentConfig = z.strictObject({
  llm: z.strictObject({ model: z.string().min(1) }),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

const AgentConfigPatch = z.strictObject({
  llm: z.strictObject({ model: z.string().min(1).optional() }).optional(),
});
// Loose on purpose: the birth certificate is the caller's payload to
// `agents.get(path).create(payload)` — arbitrary caller-authored birth facts
// ride along ({} is the norm); runtime policy still arrives via separate
// configuration and context events.
const AgentBirthCertificate = z.looseObject({});

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
 * intents fail). It exists purely as insurance against reconciliation
 * bugs. If it ever races a still-running attempt the outcomes
 * CONVERGE rather than conflict: the backstop failure and any late completion
 * carry idempotent keys, the reducer ignores completions for a request that
 * is no longer current, and the late attempt's output is gated on request
 * currency — the journal records both facts, the fold believes exactly one.
 */
export const AGENT_LLM_REQUEST_BACKSTOP_MS = 30 * 60_000;

/**
 * Compaction trigger: once a completed turn's reported context (input plus
 * output tokens) crosses this fraction of the model's window, the processor
 * summarizes the conversation into a compacted context item. Halfway leaves room for
 * many more turns before the window actually fills, so a slow or failed
 * summary attempt never races an imminent context overflow.
 */
export const AGENT_COMPACTION_TRIGGER_FRACTION = 0.5;

export const AGENT_SUMMARY_INSTRUCTION = [
  "AGENT SUMMARY (mandatory) — append alongside your work:",
  "```ts",
  "// FIRST TURN: set title and initial activity.",
  "await Promise.all([",
  "  itx.agent.append({",
  '    type: "events.iterate.com/agent/summary-updated",',
  '    payload: { title: "Short specific title", activity: "Starting work" },',
  "  }),",
  "  // other work you are doing",
  "]);",
  "",
  "// SECOND TURN: update activity; do so again when the phase changes.",
  "await Promise.all([",
  "  itx.agent.append({",
  '    type: "events.iterate.com/agent/summary-updated",',
  '    payload: { activity: "What you are doing now" },',
  "  }),",
  "  // other work you are doing",
  "]);",
  "",
  "// WHEN RETURNING NO VALUE / WAITING FOR USER:",
  "await Promise.all([",
  "  itx.agent.append({",
  '    type: "events.iterate.com/agent/summary-updated",',
  '    payload: { waitingFor: "user_input" },',
  "  }),",
  "  // send your reply through this channel's reply API",
  "]);",
  "return;",
  "```",
  'Combine waitingFor with first/second-turn fields when needed. Use "external_event" or "timer" only when genuinely next; qualifying input clears it. Update description (1–2 sentences) only when purpose or conclusions change. Never set pinned unless asked.',
].join("\n");

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
  "1. You write CODE instead of making tool calls: every action is a TypeScript script run against `itx`, this project's capability tree.",
  "2. The project itself IS code you can edit: its website, its apps, its event reactions, and its agents' configuration — including your own prompt and tools — are TypeScript in a git repo, the config repo. One-off work is a script; anything lasting, you build into the repo.",
  "",
  "HOW YOU ACT: respond with exactly ONE fenced TypeScript code block and no prose outside the fence. The block must contain a single async arrow function and START with `async` — no comments or statements before it:",
  "",
  "```ts",
  "async (itx) => {",
  "  // your code",
  "}",
  "```",
  "",
  '- Talking to the user is itself a call: `await itx.chat.sendMessage("...")` inside your script (chat renders markdown). Nothing else reaches them — they never see your raw text or your code. After you send, an assistant-role item "The assistant sent this visible web-chat message: …" lands in your history: that is your delivery receipt, not a user speaking.',
  "- Whatever your function RETURNS (JSON-serializable) arrives as your next input, and you get another turn to act on it. A thrown error arrives the same way — read it and adapt. Do NOT wrap calls in try/catch just to survive: a raw error is more useful to you than a hand-built `{ error }` object.",
  "- Multi-step work is one script per response: each result comes back to you, and you write the next step having seen it. A response with more than one code block — or a block that does not start with `async` — is rejected with feedback and NOTHING runs; never queue future steps as extra blocks.",
  "- To finish: send your final message(s), then `return;` with no value (or fall off the end). `return null` counts as a value and buys a pointless extra turn. A response with no code block at all also ends your turn.",
  "- Each script runs fresh — no variable survives between scripts. Carry state by returning it, messaging it, or writing a file.",
  "",
  "`itx` is a Cap'n Web RpcStub (Cloudflare's RPC protocol — https://github.com/cloudflare/capnweb) scoped to YOUR agent path in this project. Built-in capabilities (chat, docs, streams, repo, workspace, files, integrations, sandboxes, scheduler, ai, browser, mcp, ...) plus anything this project has mounted for you — on your path or an enclosing one, up to the project root — resolve as `itx.<name>`. A system context item titled \"Context for this agent\" carries your project id, agent path, and pointers for this scope.",
  "",
  AGENT_SUMMARY_INSTRUCTION,
  "",
  'THE CONFIG REPO — the code that governs this project, at "/repos/config":',
  "- `worker.ts` serves the project's hosts, routes named-export app classes to their own hostnames, and handles every stream event through processEvent(event). Create agents explicitly with itx.agents.get(path).create(); a path or folder alone is not an agent. Configure one with agent.append(...) after creation. AGENTS.md is durable notes: read it early and write stable project knowledge back. Multi-file TypeScript works, but builds install no packages; runtime imports must be repo files, workerd modules, or modules supplied by Iterate.",
  "- Every commit lands on MAIN and the project worker/website redeploys automatically — no branches, no push, nothing else to do.",
  '- Two write doors, one rule: `await itx.repo.commitFiles({ message, changes: [{ path, content }] })` for one small file; your private workspace (`itx.workspace` — the config repo mounted at "/", live at latest main: readFile/writeFile/edit/glob) to read and change several files, shipped as ONE commit with `await itx.workspace.git.commit({ message })`. ALWAYS read a file before editing it.',
  '- In practice: "update our homepage" = edit worker.ts\'s default fetch handler and commit. "Make an app" = add and route a named-export class; HelloApp and CounterApp show both shapes. "When X happens, do Y" = add a processEvent reaction. "Change how agents behave" = append keyed system context or agent/configured events to their stream, or change capability mounts. Each worker getter becomes an `itx.worker.<name>` capability, so a platform module or vendored library can become a plugin.',
  "",
  "`itx.docs.search` finds working example scripts (most PROVEN — run unattended by the test suite), type declarations, and mounted capabilities; matching is word overlap, so pass MANY related words.",
  "",
  "A docs hit's `fetchCall` is the exact call that fetches its full doc; copy it verbatim. Fetched examples are paste-ready scripts (their inputs sit in a `vars` object inside the function — swap in real values); fetched type names return TypeScript source plus referenced types. `await itx.<node>.__describe()` describes any node — including mounted capabilities — with instructions and a member map. Search first, describe what you hold, never guess an API shape.",
  "",
  "A TOUR IN CODE — every call below is real (one script would never do all this at once); `itx.docs.search` has the full story and a working example for each:",
  "",
  "```ts",
  "async (itx) => {",
  "  // FIND HOW — search before writing calls against anything unfamiliar:",
  '  const hits = await itx.docs.search({ q: "email gmail inbox unread send" });',
  "",
  "  // TALK:",
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
  "  // RESEARCH — itx.parallel and itx.mcp.exa fan out in ONE call; almost always",
  "  // better than spawning agents. DELEGATE ultra sparingly, for a genuinely",
  "  // separate workstream only. HARD RULE: max ONE level — if an agent delegated",
  "  // to YOU, never delegate further (subagent trees fan out into runaway cost).",
  "  // Create explicitly, then message; the message must carry ALL context:",
  '  const researcher = itx.agents.get("research-pricing");',
  "  await researcher.create();",
  '  await researcher.message("Deep-dive competitor pricing. Context: ...");',
  "  // now END YOUR TURN — the report arrives as your input.",
  "  // Standing agents are project infrastructure — e.g. a shared friction collector:",
  '  const bugs = itx.agents.get("/agents/bugs");',
  "  const bugsSnapshot = await bugs.processor.snapshot();",
  "  if (bugsSnapshot.state.birthCertificate === null) await bugs.create();",
  '  await bugs.message("docs.search returned nothing for query X");',
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
  '  await itx.secrets.get("/secrets/acme").create({ egress: { urls: ["https://api.acme.com/"] }, material: "sk-live-..." });',
  '  const me = await itx.egress.fetch("https://api.acme.com/v1/me", {',
  "    headers: { authorization: 'Bearer getSecret(\"/secrets/acme\")' },",
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
  "    script: \"async (itx) => { const agent = itx.agents.get('/agents/daily-report'); const snapshot = await agent.processor.snapshot(); if (snapshot.state.birthCertificate === null) await agent.create(); await agent.message('Write the daily report.'); }\",",
  "  });",
  "",
  "  // SHARE A FILE — attach it; never paste base64 into message text:",
  '  const resp = await fetch("https://example.com/chart.png");',
  '  await itx.chat.sendMessage("Here!", { files: [{ filename: "chart.png", contentType: "image/png", data: await resp.blob() }] });',
  "",
  "  return hits; // returned values arrive as your next input",
  "}",
  "```",
  "",
  "THE SHAPE OF WORK — scripts are tool calls, not programs:",
  "- Most scripts should fetch data and RETURN it. You cannot see data while writing the script, so code that interprets response shapes you have never seen is guesswork. Get the data in front of your eyes; decide on the next turn.",
  "- The script body is real TypeScript: `Promise.all` fans out independent calls, `Promise.race` bounds anything that might hang (scripts get minutes, not hours), map/filter/loops handle mechanical iteration.",
  "- Return only what you need: pick fields, slice arrays. Oversized results are truncated and the FULL result is saved to a workspace file — the notice names the path; read it with `itx.workspace.readFile` and filter it in plain TypeScript instead of re-fetching.",
  "- Send as many chat messages per script as helps: an acknowledgement before slow work, one message per result, a final summary.",
  "",
  "OTHER AGENTS — the semantics behind the tour's delegation calls:",
  '- A relative name (`itx.agents.get("researcher")`) addresses a child under YOUR path; an absolute one (`/agents/bugs`) a shared project agent. Call zero-argument `create()` before messaging it. Creating folders or appending ordinary events never implies an agent.',
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
 * A file reference riding on an agent context item: where the bytes live in project
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
/** A file attached to an agent context item: content type, filename, project
 * file-storage path, size, and the signed public URL minted at attach time
 * (stored, not re-minted — it expires with its signature). */
export type AgentFileAttachment = z.infer<typeof AgentFileAttachment>;

const LlmRequestPolicy = z
  .discriminatedUnion("behaviour", [
    z.object({ behaviour: z.literal("dont-trigger-request") }),
    z.object({ behaviour: z.literal("interrupt-current-request") }),
    z.object({ behaviour: z.literal("after-current-request") }),
  ])
  .default({ behaviour: "after-current-request" });

const AgentUserContextActor = z.object({
  type: z.literal("user"),
  origin: z.enum(["web", "mcp"]),
});

const AgentDeveloperContextActor = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent"), path: z.string() }),
  z.object({ type: z.literal("script"), executionId: z.string() }),
  z.object({
    type: z.literal("slack"),
    userId: z.string().optional(),
    botName: z.string().optional(),
  }),
  z.object({
    type: z.literal("telegram"),
    userId: z.string().optional(),
    username: z.string().optional(),
  }),
  z.object({
    type: z.literal("email"),
    address: z.string().optional(),
    name: z.string().optional(),
  }),
  z.object({
    type: z.literal("github"),
    login: z.string().optional(),
    senderType: z.string().optional(),
  }),
]);

const AgentContextRef = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("event"),
    streamPath: z.string(),
    offset: z.number().int().positive(),
    eventType: z.string().optional(),
  }),
  z.object({ type: z.literal("user"), userId: z.string() }),
  z.object({ type: z.literal("file"), path: z.string() }),
  z.object({
    type: z.literal("git-commit"),
    repoPath: z.string(),
    commitOid: z.string(),
  }),
]);

const AgentContextCommon = {
  content: z.string(),
  /** Stable logical identity within the system or history lane. */
  key: z.string().min(1).optional(),
  /** Files attached to this context item — see {@link AgentFileAttachment}. */
  files: z.array(AgentFileAttachment).optional(),
  /** Coordinates for retrieving richer source material on demand. */
  refs: z.array(AgentContextRef).optional(),
};

/**
 * The single source of truth for model-visible context. System items live in
 * the compaction-immune prefix; every other role lives in chronological
 * history. A keyed item may replace its current unpublished projection slot,
 * but the journal remains append-only and an update after publication appends
 * a new occurrence.
 */
export const AgentContextAddedPayload = z
  .discriminatedUnion("role", [
    z
      .object({
        ...AgentContextCommon,
        role: z.literal("system"),
      })
      .strict(),
    z
      .object({
        ...AgentContextCommon,
        role: z.literal("developer"),
        actor: AgentDeveloperContextActor.optional(),
        llmRequestPolicy: LlmRequestPolicy,
        /** Metadata for the structural history rewrite produced by compaction. */
        compaction: z
          .object({
            /** Replace model-visible history through this stream offset with this item. */
            replacesHistoryThrough: z.number().int().positive(),
            /** Provider-reported usage for the summarization request, when available. */
            usage: z
              .object({
                inputTokens: z.number().int().nonnegative(),
                outputTokens: z.number().int().nonnegative(),
                cachedInputTokens: z.number().int().nonnegative().optional(),
                reasoningOutputTokens: z.number().int().nonnegative().optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .strict(),
    z
      .object({
        ...AgentContextCommon,
        role: z.literal("user"),
        actor: AgentUserContextActor,
        llmRequestPolicy: LlmRequestPolicy,
      })
      .strict(),
    z
      .object({
        ...AgentContextCommon,
        role: z.literal("assistant"),
        /** Offset of the llm-request-requested event this output answers. */
        llmRequestOffset: z.number().int().positive().optional(),
      })
      .strict(),
  ])
  .superRefine((payload, ctx) => {
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
  });

const AgentProjectedContextItem = z
  .object({
    /** The journal occurrence currently supplying this projected item. */
    offset: z.number().int().positive(),
    /** The last published occurrence this keyed value updates, if any. */
    updatesOffset: z.number().int().positive().optional(),
  })
  .passthrough()
  .transform((candidate, ctx) => {
    const { offset, updatesOffset, ...payload } = candidate;
    const parsed = AgentContextAddedPayload.safeParse(payload);
    if (!parsed.success) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid projected agent context payload",
      });
      return z.NEVER;
    }
    return {
      ...parsed.data,
      offset,
      ...(updatesOffset === undefined ? {} : { updatesOffset }),
    };
  });

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

/** Exact runtime plus the event which first established it in the fold. This
 * is processor state exposed through live state, not a journal event. */
export const AgentRuntimeTransition = z.strictObject({
  runtime: AgentRuntime,
  sinceOffset: z.number().int().nonnegative(),
  since: z.iso.datetime(),
});
export type AgentRuntimeTransition = z.infer<typeof AgentRuntimeTransition>;

/** The deliberately small push surface for one Agent DO. The full fold stays
 * behind `processor.snapshot()`; publishing context/history through live state
 * would duplicate the journal on every conversation update. */
export const AgentLiveState = z.strictObject({
  runtimeChange: AgentRuntimeTransition.optional(),
});
/** The transient runtime state pushed by one Agent durable object. */
export type AgentLiveState = z.infer<typeof AgentLiveState>;

export const AgentProcessorContract = defineProcessorContract({
  slug: "agent",
  version: "4.1.0",
  description:
    "Maintains model-visible history, schedules LLM turns, and runs them through the Cloudflare AI binding.",
  stateSchema: z
    .object({
      birthCertificate: AgentBirthCertificate.nullable().default(null),
      config: AgentConfig.nullable().default(null),
      context: z
        .object({
          system: z.array(AgentProjectedContextItem).default([]),
          history: z.array(AgentProjectedContextItem).default([]),
          /** Highest request offset that published the current projection. */
          publishedThrough: z.number().int().nonnegative().default(0),
        })
        .prefault({}),
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
             * the reconciler's backstop deadline. */
            requestedAt: z.number().int().positive(),
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
       * The requestId of the most recent scheduled-phase cancel (a user
       * interrupt landing during the debounce window). Its lost-timer re-fire
       * can still append a requested event from a pre-cancel fold snapshot;
       * this id makes that late re-fire fold to nothing. requestIds are
       * generation-unique, so only the latest needs remembering.
       */
      cancelledScheduledRequestId: z.string().nullable().default(null),
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
       * Scripts the agent's turns spawned that have not completed, folded from
       * the capability host's request/completed lifecycle on this stream. The
       * script OBLIGATION (code, expiry, recovery) belongs to the capability
       * host processor; this fold exists so the agent's runtime projection
       * covers script execution too.
       */
      activeScriptExecutionIds: z.array(z.string()).default([]),
      /**
       * The exact runtime counts last derived from consumed events,
       * stamped with the event which established the snapshot. Genesis zero
       * stays absent; every later count transition is exposed immediately to
       * live-state consumers.
       */
      runtimeChange: AgentRuntimeTransition.optional(),
      /** Human- or agent-written presentation summary. Every writer appends
       * the same summary-updated event. */
      summary: AgentSummary.prefault({}),
      /** Offset of the summary event which established the current wait.
       * Technical guard only; never exposed in the presentation summary. */
      waitingForSinceOffset: z.number().int().positive().optional(),
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
    })
    .strict(),
  events: {
    "events.iterate.com/agents/context-added": {
      description:
        "Adds one provider-neutral model context item. System items form the compaction-immune prefix; developer, user, and assistant items form history. Repeated keyed values coalesce until an LLM request publishes them, then append as explicit updates so prompt-cache prefixes remain intact.",
      payloadSchema: AgentContextAddedPayload,
      examples: [
        {
          description: "A project installs or replaces the unpublished system prompt.",
          payload: {
            role: "system",
            key: AGENT_SYSTEM_PROMPT_CONTEXT_KEY,
            content:
              "You are Acme's release manager. Track open pull requests and nag reviewers politely.",
          },
        },
        {
          description: "A user sends a chat message from the web UI.",
          payload: {
            role: "user",
            content: "What's on my calendar today?",
            actor: { type: "user", origin: "web" },
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
        },
        {
          description:
            "A Slack transcriber adds a compact description and a coordinate for the raw webhook.",
          payload: {
            role: "developer",
            content: "A Slack user asked: what's our uptime this month?",
            actor: { type: "slack", userId: "U0788AB12CD" },
            refs: [
              {
                type: "event",
                streamPath: "/integrations/slack/acme",
                offset: 81,
                eventType: "events.iterate.com/slack/webhook-received",
              },
            ],
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
        },
      ],
    },
    "events.iterate.com/agent/created": {
      description:
        "Records that an agent exists on this stream. The payload is the caller's birth certificate (arbitrary birth facts; {} is the norm). Runtime policy is supplied by separate configuration and context events.",
      payloadSchema: AgentBirthCertificate,
      examples: [
        {
          description: "An agent existence fact usually carries no caller-selected birth facts.",
          payload: {},
        },
      ],
    },
    "events.iterate.com/agent/configured": {
      description:
        "Deep-merges a configuration patch into an existing agent configuration. Plain objects recurse; arrays, scalars, and null replace.",
      payloadSchema: z.strictObject({ config: AgentConfigPatch }),
      examples: [
        {
          description: "Select the model used for subsequent requests.",
          payload: { config: { llm: { model: "openai/gpt-5.6-sol" } } },
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
        "One streamed chunk received from the AI binding. Appended EPHEMERAL: it reaches ephemeral subscriptions (browser feed, TUI) but is excluded from default reads, never delivered to durable subscribers, and evictable — the durable truth is the assistant context item / llm-request-completed pair.",
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
          reason: AgentLlmRequestCancelReason,
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
    [AGENT_SUMMARY_UPDATED_EVENT_TYPE]: {
      description:
        "Updates the agent's human-readable summary. Omitted fields remain " +
        "unchanged, null clears an optional field, and pinned false unpins. The same event is " +
        "used whether an agent or a human initiated the edit.",
      payloadSchema: AgentSummaryUpdated,
      examples: [
        {
          description: "The agent names its work and describes the current phase.",
          payload: {
            title: "Lisbon trip planning",
            activity: "Comparing flight prices",
            description: "Helping Jane plan a three-day Lisbon trip in September.",
          },
        },
        {
          description: "The agent has finished its current work and needs an answer.",
          payload: { waitingFor: "user_input", activity: "Waiting for travel dates" },
        },
        {
          description: "A later wake clears a stale dependency.",
          payload: { waitingFor: null },
        },
      ],
    },
    [AGENT_BINDING_SET_EVENT_TYPE]: {
      description:
        "Sets or enriches the typed external object this agent represents. Bindings are " +
        "normally emitted atomically with integration agent creation, never inferred from paths.",
      payloadSchema: AgentBinding,
      examples: [
        {
          description: "A Slack thread is attached to its routed agent.",
          payload: {
            type: "slack_thread",
            connection: "acme-slack",
            channelId: "C0123",
            threadTs: "1751980451.123456",
          },
        },
      ],
    },
  },
  processorDeps: [CapabilityHostProcessorContract, CoreProcessorContract],
  consumes: [
    "events.iterate.com/agent/created",
    "events.iterate.com/agent/configured",
    "events.iterate.com/agents/context-added",
    "events.iterate.com/agents/web-message-sent",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-started",
    "events.iterate.com/agent/llm-request-completed",
    "events.iterate.com/agent/token-usage-reported",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/agent/loop-stopped",
    AGENT_SUMMARY_UPDATED_EVENT_TYPE,
    "events.iterate.com/capability-host/script-run-requested",
    "events.iterate.com/capability-host/script-run-settled",
    // Core lifecycle RE-CHECK signals. Neither folds into state (reduce
    // ignores them) — they are consumed so their at-head delivery gives the
    // obligation reconcile (`processEvent` under `delivery.caughtUp`) a
    // guaranteed consumed-at-head turn. `stream/woken` fires when the stream DO
    // (re)starts — the revival/deploy case; `subscriber-connected` fires when a
    // runner (re)attaches — closing the live race where an unconsumed presence
    // fact would otherwise land at head just after an obligation was opened and
    // strand it until the next domain event.
    "events.iterate.com/stream/woken",
    "events.iterate.com/stream/subscriber-connected",
    // The platform revival fact (core-owned, ONE type for every recovery-wired
    // processor; the payload's processorSlug names which). MUST be consumed
    // (the runner throws at construction otherwise): its ordinary delivery is
    // the guaranteed at-head turn where the obligation reconcile
    // (`processEvent` under `delivery.caughtUp`) re-drives the open LLM
    // obligations — crash-cancel `started` attempts, re-fire lost debounces,
    // settle expired intents. Reduce ignores it, and it is absent from
    // `emits`: the recovery adapter appends it raw, as the runtime speaking.
    STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  ],
  emits: [
    "events.iterate.com/agent/created",
    "events.iterate.com/agents/context-added",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-started",
    "events.iterate.com/agent/llm-response-chunk",
    "events.iterate.com/agent/llm-request-completed",
    "events.iterate.com/agent/token-usage-reported",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/agent/loop-stopped",
    AGENT_SUMMARY_UPDATED_EVENT_TYPE,
    "events.iterate.com/capability-host/script-run-requested",
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

/**
 * The agent processor's reduced state, inferred from the contract's
 * `stateSchema`.
 */
export type AgentProcessorState = ProcessorState<AgentProcessorContract>;
