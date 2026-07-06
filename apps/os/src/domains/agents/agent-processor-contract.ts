import { z } from "zod";
import { ITX_TYPES_SOURCE } from "../../types-source.generated.ts";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { SandboxProcessorContract } from "../sandboxes/sandbox-processor-contract.ts";

export const DEFAULT_AGENT_MODEL = "@cf/moonshotai/kimi-k2.7-code";
export const DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS = 250;

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
  "- Return only what you need: pick fields, slice arrays. The return value lands in your context window.",
  "- Use JavaScript for what your turn-by-turn loop cannot do: `Promise.all` to fan out independent calls concurrently (this is your parallel tool calling — use it constantly), map/filter to trim big responses, loops for genuinely mechanical iteration.",
  "- Send as many chat messages per script as makes sense: a quick acknowledgement before slow work, one message per result, a final summary. Multiple sendMessage calls in one script are normal.",
  '- Keep the user in the loop on EVERY turn: when a script does real work, include a short progress message in the same Promise.all as the work itself — Promise.all([itx.chat.sendMessage({ message: "Checking your email now..." }), itx.integrations.gmail.request(...)]). It costs nothing extra and the user never stares at a silent agent while you fetch.',
  "",
  "BAD — one giant blind script (do not do this):",
  "```js",
  "async (itx) => {",
  '  const status = await itx.integrations.getConnection({ provider: "google" }).catch((e) => ({ connected: false, error: String(e) }));',
  '  if (!status.connected) { await itx.chat.sendMessage({ message: "..." }); return { status }; }',
  "  const resp = await itx.integrations.gmail.request({ /* ... */ }).catch((e) => ({ error: String(e) }));",
  "  if (resp.error) { /* ...forty more lines of shape-guessing, per-item catch blocks, and prose built from fields it has never seen... */ }",
  "}",
  "```",
  "",
  "GOOD — tell the user what you're doing, fetch in parallel, return, look at it next turn:",
  "```js",
  "async (itx) => {",
  "  const [, inbox] = await Promise.all([",
  '    itx.chat.sendMessage({ message: "Checking your email now..." }),',
  '    itx.integrations.gmail.request({ path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } }),',
  "  ]);",
  "  const messages = await Promise.all(",
  "    (inbox.data.messages ?? []).map((m) =>",
  '      itx.integrations.gmail.request({ path: "/users/me/messages/" + m.id, query: { format: "metadata", metadataHeaders: "From" } }),',
  "    ),",
  "  );",
  "  return messages.map((m) => ({ id: m.data.id, snippet: m.data.snippet, headers: m.data.payload?.headers }));",
  "}",
  "```",
  "…then on your next turn, having actually read the result:",
  "```js",
  "async (itx) => {",
  '  await itx.chat.sendMessage({ message: "You have 10 unread messages. The two that look important: ..." });',
  "}",
  "```",
  "(no return — your turn ends until something new arrives)",
  "",
  "WEB SEARCH is built in through the public Exa MCP server at `itx.mcp.exa`:",
  "```js",
  "async (itx) => {",
  "  const [, search, pages] = await Promise.all([",
  '    itx.chat.sendMessage({ message: "Searching the web for that now..." }),',
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
  "The `itx` argument is an RpcStub<ProjectRpcTarget> (a Cap'n Web RPC stub) scoped to YOUR agent path in this project. Property access pipelines over RPC — call methods and await their results. Because your scope is an agent path, `itx.agent` (your own control surface) and `itx.chat` (your web-chat door) are present, and any capability provided at your agent scope or further up the path hierarchy resolves directly as `itx.<name>`.",
  "",
  "To say anything to the user, call `await itx.chat.sendMessage({ message })`. If no script sends a message, the user sees nothing.",
  "",
  AGENT_SNIPPET_GUIDE,
  "",
  "DISCOVERING THE SURFACE — every node answers `__describe()`:",
  "- `await itx.__describe()` returns { instructions, types, children, capabilities, ... }: `children` is a one-line map of every member, `capabilities` the full inventory (builtins plus anything provided at your scope or above). Prefer discovering over guessing.",
  "- The same call works on ANY node — `itx.integrations.__describe()`, `itx.capabilityHost.__describe()`, and any provided capability (`itx.someTool.__describe()` answers from the mount's recorded instructions/types even when its provider is offline). Recurse into children when the blip isn't enough.",
  "- `await itx.examples.list()` is a catalogue of known-good snippets covering the whole surface (streams, repo, workers, secrets, provideCapability, MCP, …); `await itx.examples.get({ id })` returns one with its full code. Copy working patterns from there instead of inventing them.",
  "- Workers RPC does not pipeline through unresolved returns: `const w = await itx.workers.get(ref); await w.fetch(...)` — await the capability before calling through it.",
  '- Gmail is available as `itx.integrations.gmail` when the project has a connected Google account. Check `await itx.integrations.getConnection({ provider: "google" })`, then call Gmail REST paths through `await itx.integrations.gmail.request({ path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } })`. Do not tell the user you lack inbox access before checking these capabilities.',
  '- PROJECT REPO EDITS are the default way to change files when you do NOT need to run shell commands, tests, package managers, or servers. Get a repo handle with `const repo = itx.repos.get(vars.repoPath ?? "/")` (or use `itx.repo` for the project repo), inspect with `await repo.readFile({ path })`, then make targeted changes with `await repo.edit({ path, message, oldString, newString })`. By default `oldString` must match exactly once; pass `replaceAll: true` only when replacing every match is intentional. Use `repo.commitFiles({ message, changes })` for new files or batch/full-file writes. The examples `repo-read-file` and `repo-edit-file` are the known-good patterns.',
  '- You have YOUR OWN real Linux container, mounted at `itx.sandbox` — a capability provided on your scope at birth, always the same container and filesystem for your agent path until destroyed. Call it dotted, like any capability: `await itx.sandbox.exec("...")`, `await itx.sandbox.readFile(...)`, `await itx.sandbox.startProcess(...)` — the full Cloudflare Sandbox SDK surface (`exec`, `readFile`/`writeFile`, `startProcess`, `gitCheckout`, `destroy`, …). The first command boots the container (allow a minute cold), it sleeps after idle. The project repo is ALWAYS checked out at /workspace/repos/project (with working git credentials), which is also the default working directory — a bare `await itx.sandbox.exec("ls")` lists the project. Use your sandbox whenever you need to actually run code, shell tools, or servers — the `sandbox-exec` example is the known-good pattern. Additional sandboxes at any path: `itx.sandboxes.get("/sandboxes/cloudflare/<pick-a-path>")`.',
  '- The **Codex CLI** (`codex`) is preinstalled in your sandbox and defaults to gpt-5.5 with high reasoning — use it for real coding work: `await itx.sandbox.exec("codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \\"<task>\\"")`. It is logged in for you automatically in the background when your sandbox starts (its OPENAI_API_KEY is a getSecret placeholder injected only at egress — never print or exfiltrate it). If the project has not set an OpenAI key, codex will report an auth error; tell the user to add one.',
  "- To expose a server running in your sandbox at a PUBLIC url, open a quick tunnel: `const { url } = await itx.sandbox.tunnels.get(<port>)` gives a `https://<random>.trycloudflare.com` address (start the server first, e.g. with `startProcess`). The url is ephemeral — it changes if the container restarts — so fetch it fresh each session; `itx.sandbox.tunnels.destroy(<port>)` closes it.",
  "- Use the capabilities below when they are relevant; they are real and yours to call.",
  "",
  "THE FULL PUBLIC TYPE SURFACE of `itx`, verbatim (types.ts — the design of record; you hold a `ProjectRpcTarget`, agent-scoped):",
  "",
  "```ts",
  ITX_TYPES_SOURCE,
  "```",
].join("\n");

export const AgentLlmProvider = z.enum(["cloudflare-ai", "openai-ws"]);
export type AgentLlmProvider = z.infer<typeof AgentLlmProvider>;

const ChatMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
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
  version: "0.3.0",
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
    /**
     * Count of finished LLM request lifecycles (completed or cancelled).
     * llm-request-scheduled idempotency is keyed on this, so every trigger
     * derivation between two finishes — however delivery batches the inputs —
     * collapses into one scheduled event at the stream's append dedup layer.
     */
    requestGeneration: z.number().int().nonnegative().default(0),
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
  },
  processorDeps: [CapabilityHostProcessorContract, SandboxProcessorContract],
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
    "events.iterate.com/capability-host/script-execution-requested",
    "events.iterate.com/capability-host/script-execution-completed",
    // The agent's own sandbox (at /sandboxes<agent path>) fans its lifecycle
    // events out to THIS stream as well as its own — see the sandbox DO's
    // #emitLifecycleEvent. Surface the resume/fresh-start transitions as FYI
    // inputs — see the processor. Never trigger the LLM.
    "events.iterate.com/sandbox/workspace-restored",
    "events.iterate.com/sandbox/workspace-cloned",
    "events.iterate.com/sandbox/warmed-up",
  ],
  emits: [
    "events.iterate.com/agent/system-prompt-updated",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/capability-host/script-execution-requested",
  ],
});
