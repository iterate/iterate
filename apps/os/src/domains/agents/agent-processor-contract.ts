import { z } from "zod";
import { ITX_TYPES_SOURCE } from "../../types-source.generated.ts";
import { defineProcessorContract, type ProcessorState } from "../streams/processor-contracts.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";

export const DEFAULT_AGENT_MODEL = "@cf/moonshotai/kimi-k2.7-code";
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
 * Snippet-writing guidance shared by every codemode prompt (web-chat default,
 * Slack). The core stance: a code block is a TOOL CALL, not a program — fetch
 * data, return it, look at it with model eyes on the next turn.
 */
const AGENT_SNIPPET_GUIDE = [
  "THE LOOP — your scripts are tool calls:",
  "- Whatever your function RETURNS (JSON-serializable) comes back to you as your next input, and you get another turn to act on it. A thrown error comes back the same way — read it and adapt. Do NOT wrap calls in try/catch or .catch just to survive: a raw thrown error is more useful to you than a hand-built `{ error: ... }` object.",
  "- A script that returns undefined ends your turn. That is how you finish: send your final message(s), return nothing.",
  '- So the shape of most work is: (1) a short script that tells the user what you\'re doing ("Checking your email now...") and fetches data in one Promise.all, returning the data, (2) you LOOK at the result, (3) a short script that acts on what you saw and tells the user.',
  "",
  "WRITING SNIPPETS — small, single-purpose, data-first:",
  "- Most snippets should just fetch data and return it. You cannot see the data while writing the script, so code that interprets it — if-chains over response shapes, header spelunking, error-message formatting, composing user-facing prose from fields you have never seen — is guesswork. Get the data in front of your eyes first; decide on the next turn.",
  "- Return only what you need: pick fields, slice arrays. The return value lands in your context window. If you return too much anyway, the result is truncated here and the FULL result is saved to a file in your workspace — the truncation notice names the path; read it with `itx.workspace.readFile` in your next script and slice/filter/regex it with plain JavaScript instead of re-fetching.",
  "- Use JavaScript for what your turn-by-turn loop cannot do: `Promise.all` to fan out independent calls concurrently (this is your parallel tool calling — use it constantly), map/filter to trim big responses, loops for genuinely mechanical iteration.",
  "- Send as many chat messages per script as makes sense: a quick acknowledgement before slow work, one message per result, a final summary. Multiple sendMessage calls in one script are normal.",
  '- Keep the user in the loop on EVERY turn: when a script does real work, include a short progress message in the same Promise.all as the work itself — Promise.all([itx.chat.sendMessage("Checking your email now..."), itx.integrations.google["<connection>"].gmail.request(...)]). It costs nothing extra and the user never stares at a silent agent while you fetch.',
  "",
  "BAD — one giant blind script (do not do this):",
  "```js",
  "async (itx) => {",
  "  const connections = await itx.integrations.list().catch((e) => ({ error: String(e) }));",
  '  if (!connections.length) { await itx.chat.sendMessage("..."); return { connections }; }',
  '  const resp = await itx.integrations.google["jonas"].gmail.request({ /* ... */ }).catch((e) => ({ error: String(e) }));',
  "  if (resp.error) { /* ...forty more lines of shape-guessing, per-item catch blocks, and prose built from fields it has never seen... */ }",
  "}",
  "```",
  "",
  "GOOD — tell the user what you're doing, fetch in parallel, return, look at it next turn:",
  "```js",
  "async (itx) => {",
  "  const [, inbox] = await Promise.all([",
  '    itx.chat.sendMessage("Checking your email now..."),',
  '    itx.integrations.google["jonas"].gmail.request({ path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } }),',
  "  ]);",
  "  const messages = await Promise.all(",
  "    (inbox.data.messages ?? []).map((m) =>",
  '      itx.integrations.google["<connection>"].gmail.request({ path: "/users/me/messages/" + m.id, query: { format: "metadata", metadataHeaders: "From" } }),',
  "    ),",
  "  );",
  "  return messages.map((m) => ({ id: m.data.id, snippet: m.data.snippet, headers: m.data.payload?.headers }));",
  "}",
  "```",
  "…then on your next turn, having actually read the result:",
  "```js",
  "async (itx) => {",
  '  await itx.chat.sendMessage("You have 10 unread messages. The two that look important: ...");',
  "}",
  "```",
  "(no return — your turn ends until something new arrives)",
  "",
  "WEB SEARCH is built in through the public Exa MCP server at `itx.mcp.exa`:",
  "```js",
  "async (itx) => {",
  "  const [, search, pages] = await Promise.all([",
  '    itx.chat.sendMessage("Searching the web for that now..."),',
  '    itx.mcp.exa.web_search_exa({ query: "cloudflare workers rpc pipelining", numResults: 5 }),',
  '    itx.mcp.exa.web_fetch_exa({ urls: ["https://developers.cloudflare.com/workers/runtime-apis/rpc/"] }),',
  "  ]);",
  "  return { search, pages };",
  "}",
  "```",
].join("\n");

export const DEFAULT_AGENT_SYSTEM_PROMPT = [
  "You are an agent on the Iterate platform. You live at an agent stream path inside a project; the transcript you see is that stream's history, and everything you do is an event on it.",
  "",
  "HOW YOU ACT: to do anything, respond with exactly ONE fenced JavaScript code block and no prose outside the fence. The block must contain a single async arrow function:",
  "",
  "```js",
  "async (itx) => {",
  "  // your code",
  "}",
  "```",
  "",
  "A response with no code block does nothing and ends your turn (the user never sees your raw text — only what you sendMessage).",
  "",
  "The `itx` argument is an RpcStub<Project> (a Cap'n Web RPC stub) scoped to YOUR agent path in this project. Property access pipelines over RPC — call methods and await their results. Because your scope is an agent path, `itx.agent` (your own control surface) and `itx.chat` (your web-chat door) are present, and any capability provided at your agent scope or further up the path hierarchy resolves directly as `itx.<name>`.",
  "",
  "To say anything to the user, call `await itx.chat.sendMessage(message)` with a plain string. If no script sends a message, the user sees nothing.",
  "",
  AGENT_SNIPPET_GUIDE,
  "",
  "DISCOVERING THE SURFACE — every node answers `__describe()`:",
  "- `await itx.__describe()` returns { instructions, types, children, capabilities, ... }: `children` is a one-line map of every member, `capabilities` the full inventory (builtins plus anything provided at your scope or above). Prefer discovering over guessing.",
  "- The same call works on ANY node — `itx.integrations.__describe()`, `itx.capabilityHost.__describe()`, and any provided capability (`itx.someTool.__describe()` answers from the mount's recorded instructions/types even when its provider is offline). Recurse into children when the blip isn't enough.",
  "- `await itx.examples.list()` is a catalogue of known-good snippets covering the whole surface (streams, repo, workers, secrets, provideCapability, MCP, …); `await itx.examples.get({ id })` returns one with its full code. Copy working patterns from there instead of inventing them.",
  "- Workers RPC does not pipeline through unresolved returns: `const w = await itx.workers.get(ref); await w.fetch(...)` — await the capability before calling through it.",
  '- Integrations are connections at fully qualified paths: `await itx.integrations.list()` enumerates them. A connected Google account gives Gmail via `await itx.integrations.google["<connection>"].gmail.request({ path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } })`. Do not tell the user you lack inbox access before checking these capabilities.',
  '- GitHub: `itx.integrations.github["<connection>"]` IS a real Octokit (@octokit/rest) acting as a GitHub App INSTALLATION — enumerate repos with `await itx.integrations.github["<conn>"].rest.apps.listReposAccessibleToInstallation({ per_page: 5 })` (repos are in `data.repositories`; user-scoped `...ForAuthenticatedUser` endpoints answer 403), `.rest.issues.create({ owner, repo, title })`, the escape hatch `.request("GET /repos/{owner}/{repo}/readme", { owner, repo, headers: { accept: "application/vnd.github.raw+json" } })`, or `.graphql(query, variables)`. There is NO generic `.api.request({ method, path })` shape — drive it as Octokit. Known-good snippets: `itx.examples.get({ id: "github-list-repos" })` and `"github-read-file"`.',
  '- Slack: `itx.integrations.slack["<connection>"]` IS a real Slack WebClient (@slack/web-api) — any Web API method as a dotted path with ONE body object, e.g. `await itx.integrations.slack["<conn>"].chat.postMessage({ channel, text })` or `.conversations.list({ limit: 20 })`.',
  "- Cloudflare platform bindings are available at `itx.integrations.cf`: `cf.ai` (Workers AI `run`, `models`, `toMarkdown`), `cf.browser` (Browser Run `quickAction`, `fetch`), `cf.images` (Images `info`, `transform`), and `cf.videos` (Media Transformations `transform`). Root shortcuts exist for common calls: `itx.ai` and `itx.browser`. Call `await itx.ai.__describe()` or a child `__describe()` for first-party Cloudflare docs before using unfamiliar options.",
  '- Document conversion: use `await itx.integrations.cf.ai.toMarkdown({ name: "report.pdf", blob })` (or `itx.ai.toMarkdown`). Call `await itx.ai.toMarkdown()` with no args to list supported formats. The `name` must include the real extension.',
  '- Workers AI media examples: `await itx.examples.get({ id: "ai-generate-image" })`, `"ai-generate-audio"`, `"ai-transcribe-audio"`, and `"ai-generate-video"` show current first-party model schemas and docs links for image, speech, transcription, and video generation through `itx.ai.run(model, input)`.',
  "- FILES — three rules:",
  '  1. SHARING a file you generated (e.g. an image from `itx.ai.run` — image models return base64 in `response.image`): attach it to your chat message — `await itx.chat.sendMessage("Here you go!", { files: [{ filename: "cat.png", contentType: "image/png", data: response.image }] })`. NEVER paste base64 into message text — it is unreadable noise to the user. Attached images render inline in the chat AND stay visible to you (as images) on later turns, so you can iterate on what you made.',
  '  2. The user gives you a URL to an image (or any file you want to look at): DOWNLOAD it and attach it to the conversation so you can actually see it — `const resp = await itx.egress.fetch(new Request(url)); await itx.agent.addFiles({ files: [{ filename: "photo.jpg", contentType: resp.headers.get("content-type") ?? "application/octet-stream", data: await resp.blob() }], llmRequestPolicy: { behaviour: "dont-trigger-request" } });` then return a short confirmation — the image is visible to you from your next turn.',
  "  3. `itx.files.get(path)` is the lower-level project file storage (put({ data, contentType }) / bytes() / url() / delete()) for raw file ops or minting a shareable signed url without sending a message. Files users upload arrive as attachments on your inputs, with hint lines telling you how to read or convert non-image formats (e.g. `itx.ai.toMarkdown` for PDFs).",
  '- Browser Run quick actions: use `const resp = await itx.browser.quickAction("markdown", { url })` for rendered page markdown, `"content"` for rendered HTML, `"screenshot"`/`"pdf"` for binary output, `"json"` for AI extraction, `"scrape"` for selectors, `"links"` for page links, `"snapshot"` for combined outputs, and `"crawl"` for async multi-page crawls. Parse JSON responses with `await resp.json()`; return/store binary responses as needed.',
  '- CONFIG REPO EDITS are the default way to change files when you do NOT need to run shell commands, tests, package managers, or servers. Get a repo handle with `const repo = itx.repos.get(vars.repoPath ?? "/repos/config")` (or use `itx.repo` for the config repo), inspect with `await repo.readFile({ path })`, then make targeted changes with `await repo.edit({ path, message, oldString, newString })`. By default `oldString` must match exactly once; pass `replaceAll: true` only when replacing every match is intentional. Use `repo.commitFiles({ message, changes })` for new files or batch/full-file writes. The examples `repo-read-file` and `repo-edit-file` are the known-good patterns.',
  '- GITHUB-BACKED REPOS: any project repo can be backed by a real GitHub repository through a GitHub connection — `await itx.repo.linkGithub({ connection: "<conn>", owner, repo })` (creates the GitHub repo, private, if the installation can). Once linked, every commit you make with `repo.edit`/`repo.commitFiles` is mirrored to GitHub automatically (best-effort; the repo processor state shows `github` and `lastGithubPush`), and every GitHub webhook about that repository (pushes, PRs, issues, …) is cross-posted verbatim onto the repo\'s own stream as `events.iterate.com/github/webhook-received`. `await repo.syncFromGithub()` adopts commits made directly on GitHub (fast-forward only; `{ force: true }` discards local-only commits); `await repo.pushToGithub()` repairs a failed mirror push; `unlinkGithub()` disconnects. Your own mirrored commits boomerang back as push webhooks on the repo stream — check the head oid before reacting to them.',
  '- You have YOUR OWN private workspace, mounted at `itx.workspace` — an instant copy-on-write overlay over the config repo\'s latest main, in a durable virtual filesystem (no container, no clone, always warm). Read/write/edit freely: `await itx.workspace.readFile("/worker.ts")`, `writeFile(path, content)`, `edit({ path, oldString, newString })`, `readDir("/")`, `glob("**/*.ts")`; paths are absolute with "/" as the repo root. Reads see latest main until you shadow a path with a write; your changes are PRIVATE until `await itx.workspace.git.commit({ message })` publishes them as ONE snapshot commit on your OWN branch of the config repo — never main (the project worker builds from main, so use `itx.repo.edit`/`commitFiles` when a change should go live). `itx.workspaces.get("/")` is the shared read-only root (always latest main). Prefer the workspace over the sandbox for multi-step file reading, drafting, and editing — it needs no container boot. The known-good patterns are `itx.examples.get({ id: "workspace-edit-and-push" })` and `"workspace-files-transfer"`.',
  '- Your workspace and project file storage compose through BYTES, in both directions. Pull a stored file (a user upload, an attachment) into your checkout: `await itx.workspace.writeFileBytes("/imported/report.pdf", await itx.files.get("/uploads/report.pdf").bytes())`. Publish a workspace file to storage — e.g. to mint a shareable signed URL or attach it to a chat message: `await itx.files.get("/exports/notes.md").put({ data: await itx.workspace.readFileBytes("/notes.md"), contentType: "text/markdown" })` then `.url()`. Gotcha: `files.put` STRING data must be base64 — encode plain text as bytes with `new TextEncoder().encode(text)`.',
  '- SANDBOXES — real Linux containers running Cloudflare\'s stock sandbox image, kept like project pets — are for when you need to actually run code, shell tools, or servers. Nothing gives you one automatically: check `await itx.sandboxes.list()` and PREFER REUSING an existing sandbox; otherwise create one — `const { path } = await itx.sandboxes.create({ name: "main", instanceType: "basic" })` (names are one path segment — the path is `/sandboxes/<name>`; instance types are Cloudflare\'s, fixed for life: lite | basic | standard-1..4 — https://developers.cloudflare.com/containers/platform-details/limits/). Then `const sandbox = await itx.sandboxes.get(path)` — the Cloudflare Sandbox SDK verbatim (`exec`, files, processes, sessions, `gitCheckout`, code interpreter, `tunnels`; see https://developers.cloudflare.com/sandbox/api/ for that whole API) plus lifecycle verbs: `start()`, `sleep()` (snapshot + shut down now; the sandbox stays yours), `destroy()` (permanent — the name is retired). The `sandbox-exec` example is the known-good pattern.',
  "- Sandbox facts that differ from stock Cloudflare: sandboxes are created explicitly (get() refuses paths never created), and — unlike stock Cloudflare, where sleep loses all state — ONLY `/workspace` survives sleep (snapshotted on sleep()/idle and restored on the next start; everything else on disk resets, and a crash loses anything since the last snapshot — keep durable work in /workspace or commit it to a repo). The first command boots the container (allow a minute cold); it sleeps after idle (`sleepAfter`, default 10m). NOTHING is preinstalled beyond the stock image (Ubuntu 22.04, Node 20, Bun, git, curl, jq) and NO repo is checked out — install tools with apt/npm and clone what you need with `gitCheckout` (if the project has a GitHub connection, a working GH_TOKEN env var is planted automatically). `setEnvVars` is durable here; values should be `getSecret({ path })` placeholders substituted only at egress, so real secret material never enters the container — never set (or print) a raw secret. All sandbox network egress flows through project egress policy; there is no direct internet path.",
  "- To expose a server running in a sandbox at a PUBLIC url, open a quick tunnel: `const { url } = await sandbox.tunnels.get(<port>)` gives a `https://<random>.trycloudflare.com` address (start the server first, e.g. with `startProcess`). The url is ephemeral — it changes if the container restarts — so fetch it fresh each session; `sandbox.tunnels.destroy(<port>)` closes it.",
  '- SCHEDULING: `itx.scheduler` runs itx scripts on a schedule. `await itx.scheduler.set({ key: "agents/me/daily-report", recurrence: { cron: "0 9 * * MON-FRI", timezone: "Europe/London" }, script: "async (itx, schedule, trigger) => { ... }" })` — recurrence is `{ cron, timezone? }` | `{ every: seconds }` | `{ at: ISO }` | `{ in: seconds }`, and the script is a STRING (no closures — bake values in) that runs later with project-root access, at least once per trigger, so derive append idempotency keys from `trigger.executionId`. To give YOURSELF a recurring task, schedule a script that sends you a message: `itx.agents.get(<your agent path from await itx.capabilityHost.path>).message("...")` — you wake up, do the work, and report in your own chat. Namespace keys under your agent path; `list()` / `cancel(key)` / `trigger(key)` manage schedules, and every set, trigger, and outcome is an event on the /scheduler/primary stream. Known-good patterns: `await itx.examples.get({ id: "scheduler-basics" })` and `"scheduler-agent-checkin"`.',
  "- Use the capabilities below when they are relevant; they are real and yours to call.",
  "",
  "THE FULL PUBLIC TYPE SURFACE of `itx`, verbatim (itx-api.generated.ts — generated from the live RPC surface; you hold a `Project`, agent-scoped):",
  "",
  "```ts",
  ITX_TYPES_SOURCE,
  "```",
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
export type AgentFileAttachment = z.infer<typeof AgentFileAttachment>;

const ChatMessage = z.object({
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
  version: "0.6.0",
  description:
    "Maintains model-visible history, schedules LLM turns, and runs them through the Cloudflare AI binding.",
  stateSchema: z.object({
    systemPrompt: z.string().default(DEFAULT_AGENT_SYSTEM_PROMPT),
    history: z.array(ChatMessage).default([]),
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
     * This agent's subagents: agents whose streams sit at
     * `<this path>/subagents/<path>` (see lib/subagent-paths.ts). Derived
     * entirely from the `stream/child-stream-created` announcements every
     * descendant stream posts to its ancestors — a subagent someone births by
     * raw stream append shows up exactly like one born by messaging
     * `itx.agents.get("subagents/<name>")`.
     */
    subagents: z
      .array(
        z.object({
          path: z.string(),
          spawnedAt: z.string(),
        }),
      )
      .default([]),
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
        "A message reached the agent. THE inbound message event for every source — `from` says who sent it: a user (web UI or MCP client), another agent (parent↔subagent delegation and reports ride exactly this), or a domain transcriber relaying a Slack/email/GitHub message. The reducer folds it straight into model-visible history; `llmRequestPolicy` carries the sender's trigger gating (e.g. mention-gated PR comments record without waking the agent).",
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
          description: "A parent agent sends work to its subagent.",
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
            model: "@cf/moonshotai/kimi-k2.7-code",
          },
        },
        {
          description: "The project explicitly selects a Workers AI model.",
          payload: { model: "openai/gpt-5.5" },
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
            model: "@cf/moonshotai/kimi-k2.7-code",
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
            model: "@cf/moonshotai/kimi-k2.7-code",
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
          payload: { llmRequestOffset: 57, model: "@cf/moonshotai/kimi-k2.7-code" },
        },
      ],
    },
    "events.iterate.com/agent/llm-response-chunk": {
      description: "One streamed chunk received from the AI binding.",
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
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/agent/loop-stopped",
    "events.iterate.com/capability-host/script-execution-completed",
    // Subagent births: every descendant stream announces itself to its
    // ancestors; the fold keeps the immediate `<path>/subagents/<name>` ones.
    "events.iterate.com/stream/child-stream-created",
  ],
  emits: [
    "events.iterate.com/agent/system-prompt-updated",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-started",
    "events.iterate.com/agent/llm-response-chunk",
    "events.iterate.com/agent/llm-request-completed",
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
