import { z } from "zod";
import { ITX_TYPES_SOURCE } from "../../types-source.generated.ts";
import { defineProcessorContract, type ProcessorState } from "../streams/processor-contracts.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";

export const DEFAULT_AGENT_MODEL = "@cf/moonshotai/kimi-k2.7-code";
export const DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS = 250;
export const DEFAULT_AGENT_MAX_AUTONOMOUS_TURNS = 20;

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
  '      itx.integrations.google["jonas"].gmail.request({ path: "/users/me/messages/" + m.id, query: { format: "metadata", metadataHeaders: "From" } }),',
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
  '- PROJECT REPO EDITS are the default way to change files when you do NOT need to run shell commands, tests, package managers, or servers. Get a repo handle with `const repo = itx.repos.get(vars.repoPath ?? "/")` (or use `itx.repo` for the project repo), inspect with `await repo.readFile({ path })`, then make targeted changes with `await repo.edit({ path, message, oldString, newString })`. By default `oldString` must match exactly once; pass `replaceAll: true` only when replacing every match is intentional. Use `repo.commitFiles({ message, changes })` for new files or batch/full-file writes. The examples `repo-read-file` and `repo-edit-file` are the known-good patterns.',
  '- GITHUB-BACKED REPOS: any project repo can be backed by a real GitHub repository through a GitHub connection — `await itx.repo.linkGithub({ connection: "<conn>", owner, repo })` (creates the GitHub repo, private, if the installation can). Once linked, every commit you make with `repo.edit`/`repo.commitFiles` is mirrored to GitHub automatically (best-effort; the repo processor state shows `github` and `lastGithubPush`), and every GitHub webhook about that repository (pushes, PRs, issues, …) is cross-posted verbatim onto the repo\'s own stream as `events.iterate.com/github/webhook-received`. `await repo.syncFromGithub()` adopts commits made directly on GitHub (fast-forward only; `{ force: true }` discards local-only commits); `await repo.pushToGithub()` repairs a failed mirror push; `unlinkGithub()` disconnects. Your own mirrored commits boomerang back as push webhooks on the repo stream — check the head oid before reacting to them.',
  '- You have YOUR OWN private workspace, mounted at `itx.workspace` — an instant copy-on-write overlay over the project repo\'s latest main, in a durable virtual filesystem (no container, no clone, always warm). Read/write/edit freely: `await itx.workspace.readFile("/worker.ts")`, `writeFile(path, content)`, `edit({ path, oldString, newString })`, `readDir("/")`, `glob("**/*.ts")`; paths are absolute with "/" as the repo root. Reads see latest main until you shadow a path with a write; your changes are PRIVATE until `await itx.workspace.git.commit({ message })` publishes them as ONE snapshot commit on your OWN branch of the project repo — never main (the project worker builds from main, so use `itx.repo.edit`/`commitFiles` when a change should go live). `itx.workspaces.get("/")` is the shared read-only root (always latest main). Prefer the workspace over the sandbox for multi-step file reading, drafting, and editing — it needs no container boot. The known-good patterns are `itx.examples.get({ id: "workspace-edit-and-push" })` and `"workspace-files-transfer"`.',
  '- Your workspace and project file storage compose through BYTES, in both directions. Pull a stored file (a user upload, an attachment) into your checkout: `await itx.workspace.writeFileBytes("/imported/report.pdf", await itx.files.get("/uploads/report.pdf").bytes())`. Publish a workspace file to storage — e.g. to mint a shareable signed URL or attach it to a chat message: `await itx.files.get("/exports/notes.md").put({ data: await itx.workspace.readFileBytes("/notes.md"), contentType: "text/markdown" })` then `.url()`. Gotcha: `files.put` STRING data must be base64 — encode plain text as bytes with `new TextEncoder().encode(text)`.',
  '- SANDBOXES — real Linux containers running Cloudflare\'s stock sandbox image, kept like project pets — are for when you need to actually run code, shell tools, or servers. Nothing gives you one automatically: check `await itx.sandboxes.list()` and PREFER REUSING an existing sandbox; otherwise create one — `const { path } = await itx.sandboxes.create({ name: "main", instanceType: "basic" })` (names are one path segment — the path is `/sandboxes/<name>`; instance types are Cloudflare\'s, fixed for life: lite | basic | standard-1..4 — https://developers.cloudflare.com/containers/platform-details/limits/). Then `const sandbox = await itx.sandboxes.get(path)` — the Cloudflare Sandbox SDK verbatim (`exec`, files, processes, sessions, `gitCheckout`, code interpreter, `tunnels`; see https://developers.cloudflare.com/sandbox/api/ for that whole API) plus lifecycle verbs: `start()`, `sleep()` (snapshot + shut down now; the sandbox stays yours), `destroy()` (permanent — the name is retired). The `sandbox-exec` example is the known-good pattern.',
  "- Sandbox facts that differ from stock Cloudflare: sandboxes are created explicitly (get() refuses paths never created), and — unlike stock Cloudflare, where sleep loses all state — ONLY `/workspace` survives sleep (snapshotted on sleep()/idle and restored on the next start; everything else on disk resets, and a crash loses anything since the last snapshot — keep durable work in /workspace or commit it to a repo). The first command boots the container (allow a minute cold); it sleeps after idle (`sleepAfter`, default 10m). NOTHING is preinstalled beyond the stock image (Ubuntu 22.04, Node 20, Bun, git, curl, jq) and NO repo is checked out — install tools with apt/npm and clone what you need with `gitCheckout` (if the project has a GitHub connection, a working GH_TOKEN env var is planted automatically). `setEnvVars` is durable here; values should be `getSecret({ path })` placeholders substituted only at egress, so real secret material never enters the container — never set (or print) a raw secret. All sandbox network egress flows through project egress policy; there is no direct internet path.",
  "- To expose a server running in a sandbox at a PUBLIC url, open a quick tunnel: `const { url } = await sandbox.tunnels.get(<port>)` gives a `https://<random>.trycloudflare.com` address (start the server first, e.g. with `startProcess`). The url is ephemeral — it changes if the container restarts — so fetch it fresh each session; `sandbox.tunnels.destroy(<port>)` closes it.",
  '- SCHEDULING: `itx.scheduler` runs itx scripts on a schedule. `await itx.scheduler.set({ key: "agents/me/daily-report", recurrence: { cron: "0 9 * * MON-FRI", timezone: "Europe/London" }, script: "async (itx, schedule, trigger) => { ... }" })` — recurrence is `{ cron, timezone? }` | `{ every: seconds }` | `{ at: ISO }` | `{ in: seconds }`, and the script is a STRING (no closures — bake values in) that runs later with project-root access, at least once per trigger, so derive append idempotency keys from `trigger.executionId`. To give YOURSELF a recurring task, schedule a script that sends you a message: `itx.agents.get(<your agent path from await itx.capabilityHost.path>).sendMessage("...")` — you wake up, do the work, and report in your own chat. Namespace keys under your agent path; `list()` / `cancel(key)` / `trigger(key)` manage schedules, and every set, trigger, and outcome is an event on the /scheduler/primary stream. Known-good patterns: `await itx.examples.get({ id: "scheduler-basics" })` and `"scheduler-agent-checkin"`.',
  "- Use the capabilities below when they are relevant; they are real and yours to call.",
  "",
  "THE FULL PUBLIC TYPE SURFACE of `itx`, verbatim (itx-api.generated.ts — generated from the live RPC surface; you hold a `Project`, agent-scoped):",
  "",
  "```ts",
  ITX_TYPES_SOURCE,
  "```",
].join("\n");

export const AgentLlmProvider = z.enum(["cloudflare-ai", "openai-ws"]);
export type AgentLlmProvider = z.infer<typeof AgentLlmProvider>;

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

export const AgentProcessorContract = defineProcessorContract({
  slug: "agent",
  version: "0.3.1",
  description:
    "Maintains model-visible web-chat history and requests LLM work from a provider processor.",
  stateSchema: z.object({
    systemPrompt: z.string().default(DEFAULT_AGENT_SYSTEM_PROMPT),
    history: z.array(ChatMessage).default([]),
    llmConfig: z
      .object({
        model: z.string().min(1),
      })
      .default({ model: DEFAULT_AGENT_MODEL }),
    llmProvider: AgentLlmProvider.default("cloudflare-ai"),
    llmProviderConfigured: z.boolean().default(false),
    currentRequest: z
      .discriminatedUnion("phase", [
        z.object({
          phase: z.literal("scheduled"),
          requestId: z.string(),
          scheduledOffset: z.number().int().positive(),
        }),
        z.object({
          phase: z.literal("requested"),
          llmRequestId: z.number().int().positive(),
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
    inProgressScriptExecutions: z
      .array(
        z.object({
          code: z.string(),
          executionId: z.string(),
          requestedOffset: z.number().int().positive(),
          startedAt: z.string(),
        }),
      )
      .default([]),
    scriptExecutionsCompleted: z.array(z.string()).default([]),
  }),
  events: {
    "events.iterate.com/agent/config-updated": {
      description: "Project-authored agent setup/configuration.",
      payloadSchema: z.object({
        systemPrompt: z.string().optional(),
      }),
    },
    "events.iterate.com/agent/system-prompt-updated": {
      description: "Updates the system prompt used for future LLM requests.",
      payloadSchema: z.object({
        systemPrompt: z.string(),
      }),
    },
    "events.iterate.com/agent/input-added": {
      description: "A normalized model-visible input was added.",
      payloadSchema: z.object({
        content: z.string(),
        /** Files attached to this input — see {@link AgentFileAttachment}. */
        files: z.array(AgentFileAttachment).optional(),
        llmRequestPolicy: LlmRequestPolicy,
      }),
    },
    "events.iterate.com/agents/user-message-received": {
      description:
        "A user message reached the agent — from the web UI, or from an MCP client acting on the project owner's behalf.",
      payloadSchema: z.object({
        content: z.string(),
        origin: z.enum(["web", "mcp"]),
      }),
    },
    "events.iterate.com/agents/web-message-sent": {
      description: "A visible agent message was sent to the web UI.",
      payloadSchema: z.object({
        message: z.string(),
        /** Files attached to the message — see {@link AgentFileAttachment}. */
        files: z.array(AgentFileAttachment).optional(),
      }),
    },
    "events.iterate.com/agent/output-added": {
      description: "The LLM provider produced assistant output.",
      payloadSchema: z.object({
        content: z.string(),
        llmRequestId: z.number().int().positive().optional(),
      }),
    },
    "events.iterate.com/agent/llm-provider-selected": {
      description: "Selects the model for future LLM requests.",
      payloadSchema: z.object({
        ifUnset: z.boolean().optional(),
        model: z.string().min(1),
        provider: AgentLlmProvider,
      }),
    },
    "events.iterate.com/agent/llm-request-scheduled": {
      description: "An LLM request was scheduled after a trigger.",
      payloadSchema: z.object({
        debounceMs: z.number().int().nonnegative(),
        model: z.string().min(1),
        provider: AgentLlmProvider,
        requestId: z.string(),
      }),
    },
    "events.iterate.com/agent/llm-request-requested": {
      description:
        "The agent has prepared an LLM request. The event offset is the llmRequestId; providers rebuild the prompt from history.",
      payloadSchema: z.object({
        model: z.string().min(1),
        provider: AgentLlmProvider,
        requestId: z.string(),
      }),
    },
    "events.iterate.com/agent/llm-request-completed": {
      description: "A provider processor finished an LLM request.",
      payloadSchema: z.object({
        durationMs: z.number().int().nonnegative(),
        llmRequestId: z.number().int().positive(),
        provider: AgentLlmProvider,
        result: z.discriminatedUnion("status", [
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
        ]),
      }),
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
          reason: z.literal("interrupted-by-user-input"),
          llmRequestId: z.number().int().positive(),
        }),
      ]),
    },
    "events.iterate.com/agent/loop-stopped": {
      description:
        "The agent circuit breaker stopped an autonomous tool-result loop without pausing the stream.",
      payloadSchema: z.object({
        maxAutonomousTurns: z.number().int().positive(),
        reason: z.string().trim().min(1),
        triggerOffset: z.number().int().positive(),
      }),
    },
  },
  processorDeps: [CapabilityHostProcessorContract],
  consumes: [
    "events.iterate.com/agent/config-updated",
    "events.iterate.com/agent/system-prompt-updated",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agents/user-message-received",
    "events.iterate.com/agents/web-message-sent",
    "events.iterate.com/agent/output-added",
    "events.iterate.com/agent/llm-provider-selected",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-completed",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/agent/loop-stopped",
    "events.iterate.com/capability-host/script-execution-requested",
    "events.iterate.com/capability-host/script-execution-completed",
  ],
  emits: [
    "events.iterate.com/agent/system-prompt-updated",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
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
 * `stateSchema` — the one definition of the shape (the old hand-written copy
 * in the former types.ts silently omitted `llmProviderConfigured` and
 * `requestGeneration`).
 */
export type AgentProcessorState = ProcessorState<AgentProcessorContract>;
