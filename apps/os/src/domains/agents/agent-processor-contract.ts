import { z } from "zod";
import { ITX_TYPES_SOURCE } from "../../types-source.generated.ts";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { ItxProcessorContract } from "../itx/itx-processor-contract.ts";

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
  '- Keep the user in the loop on EVERY turn: when a script does real work, include a short progress message in the same Promise.all as the work itself — Promise.all([itx.chat.sendMessage({ message: "Checking your email now..." }), itx.integrations.google["<connection>"].gmail.request(...)]). It costs nothing extra and the user never stares at a silent agent while you fetch.',
  "",
  "BAD — one giant blind script (do not do this):",
  "```js",
  "async (itx) => {",
  "  const connections = await itx.integrations.list().catch((e) => ({ error: String(e) }));",
  '  if (!connections.length) { await itx.chat.sendMessage({ message: "..." }); return { connections }; }',
  '  const resp = await itx.integrations.google["jonas"].gmail.request({ /* ... */ }).catch((e) => ({ error: String(e) }));',
  "  if (resp.error) { /* ...forty more lines of shape-guessing, per-item catch blocks, and prose built from fields it has never seen... */ }",
  "}",
  "```",
  "",
  "GOOD — tell the user what you're doing, fetch in parallel, return, look at it next turn:",
  "```js",
  "async (itx) => {",
  "  const [, inbox] = await Promise.all([",
  '    itx.chat.sendMessage({ message: "Checking your email now..." }),',
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
  "The `itx` argument is an RpcStub<Itx> (a Cap'n Web RPC stub) scoped to YOUR agent path in this project. Property access pipelines over RPC — call methods and await their results. Because your scope is an agent path, `itx.agent` (your own control surface) and `itx.chat` (your web-chat door) are present, and any capability provided at your agent scope or further up the path hierarchy resolves directly as `itx.<name>`.",
  "",
  "To say anything to the user, call `await itx.chat.sendMessage({ message })`. If no script sends a message, the user sees nothing.",
  "",
  AGENT_SNIPPET_GUIDE,
  "",
  "DISCOVERING THE SURFACE:",
  "- `await itx.describe()` lists this project's current capabilities (builtins plus anything provided). Prefer discovering over guessing.",
  "- `await itx.examples.list()` is a catalogue of known-good snippets covering the whole surface (streams, repo, workers, secrets, provideCapability, MCP, …); `await itx.examples.get({ id })` returns one with its full code. Copy working patterns from there instead of inventing them.",
  "- Workers RPC does not pipeline through unresolved returns: `const w = await itx.workers.get(ref); await w.fetch(...)` — await the capability before calling through it.",
  '- Integrations are connections at fully qualified paths: `await itx.integrations.list()` enumerates them. A connected Google account gives Gmail via `await itx.integrations.google["<connection>"].gmail.request({ path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } })`. Do not tell the user you lack inbox access before checking these capabilities.',
  '- You have real Linux containers: `const sandbox = await itx.sandboxes.get("/sandboxes/cloudflare/<pick-a-path>")` returns the full Cloudflare Sandbox SDK surface (`exec`, `readFile`/`writeFile`, `startProcess`, `gitCheckout`, `exposePort`, `destroy`, …). The path is the identity — the same path is the same container and filesystem until destroyed. The first command boots the container (allow a minute cold); `await sandbox.ensureProjectRepo()` guarantees the project repo is cloned at /workspace/repo with working git credentials. Use a sandbox whenever you need to actually run code, shell tools, or servers — the `sandbox-exec` example is the known-good pattern.',
  "- Use the capabilities below when they are relevant; they are real and yours to call.",
  "",
  "THE FULL PUBLIC TYPE SURFACE of `itx`, verbatim (types.ts — the design of record; you hold an `Itx`, agent-scoped):",
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
  processorDeps: [ItxProcessorContract],
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
    "events.iterate.com/itx/script-execution-requested",
    "events.iterate.com/itx/script-execution-completed",
  ],
  emits: [
    "events.iterate.com/agent/system-prompt-updated",
    "events.iterate.com/agent/input-added",
    "events.iterate.com/agent/llm-request-scheduled",
    "events.iterate.com/agent/llm-request-requested",
    "events.iterate.com/agent/llm-request-cancelled",
    "events.iterate.com/itx/script-execution-requested",
  ],
});
