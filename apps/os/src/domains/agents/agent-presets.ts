import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { DEFAULT_WORKERS_AI_AGENT_MODEL } from "~/domains/agents/stream-processors/agent/contract.ts";

export const OS_AGENT_LLM_PROVIDER_SELECTED_EVENT_TYPE =
  "events.iterate.com/os-agent/llm-provider-selected";
export const OS_AGENT_PATH_PREFIX_PRESET_CONFIGURED_EVENT_TYPE =
  "events.iterate.com/os-agent/path-prefix-preset-configured";
export const DEFAULT_CLOUDFLARE_AGENT_MODEL = DEFAULT_WORKERS_AI_AGENT_MODEL;
export const DEFAULT_OPENAI_AGENT_MODEL = "gpt-5.5";
export const DEFAULT_AGENT_LLM_PROVIDER = "openai-ws";
export const DEFAULT_AGENT_DEBOUNCE_MS = 200;

export const AgentLlmProvider = z.enum(["openai-ws", "cloudflare-ai"]);
export type AgentLlmProvider = z.infer<typeof AgentLlmProvider>;

export const AgentPresetEvent = z.object({
  type: z.string().trim().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type AgentPresetEvent = z.infer<typeof AgentPresetEvent>;
type AgentSetupEventInput = AgentPresetEvent & Pick<EventInput, "idempotencyKey">;

export const AgentPathPrefixPreset = z.object({
  basePath: z.string().trim().min(1),
  events: z.array(AgentPresetEvent),
});
export type AgentPathPrefixPreset = z.infer<typeof AgentPathPrefixPreset>;

export function providerSelectedEvent(provider: AgentLlmProvider): AgentPresetEvent {
  return {
    type: OS_AGENT_LLM_PROVIDER_SELECTED_EVENT_TYPE,
    payload: { provider },
  };
}

export function defaultAgentSystemPrompt(agentPath?: string) {
  const lines = [
    "You are the iterate AI agent. You will be sent _events_ and your only job is to respond by _writing code_. Everything in this system is built on streams — ordered event logs with an incrementing `offset`. You are running inside a stream yourself" +
      (agentPath != null ? ` at path \`${agentPath}\`` : "") +
      ". The messages you see (agent/input-added, itx/capability-provided, etc.) are all stream events. Your responses become agent/output-added events, which are then run as itx scripts (itx/script-execution-requested blocks).",
    "",
    "## Code execution",
    "Your entire response must be exactly one fenced JavaScript code block (```js) and no surrounding prose. Every fenced code block is executed. Never write a second code block.",
    "The block must contain a single async arrow function: `async (itx) => { ... }` — the one argument is your iterate context handle.",
    "If you want to think or plan, write JavaScript comments inside the function. Comments are encouraged, especially before complex actions.",
    "",
    "The function body implicitly returns undefined — do NOT write `return undefined` or `return;`, just let the function end. Only return a value when you want the result shown back to you and another LLM turn.",
    "If you're not sure about the shape of the result of a call, just return it from a code block and you'll be shown it on your next turn.",
    "",
    "Use normal JavaScript — comments, loops, variables, try/catch, destructuring, timers, and helper functions — as you would in any async function. Use `Promise.all([...])` for independent concurrent operations.",
    ...(agentPath != null && isSlackAgentPath(agentPath)
      ? [
          "For long-running work, send progress messages with `itx.slack.chat.postMessage({ channel, thread_ts, text })` when a Slack reply is warranted, then keep working in the same function.",
        ]
      : [
          "For long-running work, send progress messages with `itx.chat.sendMessage({ message })`, then keep working in the same function.",
        ]),
    "",
    "## Capabilities",
    "Available capabilities are announced as `itx/capability-provided` events. Call them as `itx.<name>.<method>(args)`.",
    ...(agentPath != null && isSlackAgentPath(agentPath)
      ? [
          "",
          "## Slack replies",
          "Reply to the user with `itx.slack.chat.postMessage({ channel, thread_ts, text })`, always on the same thread_ts you received.",
          "Slack thread events are often FYI context. Do not chime in just because a Slack event arrived.",
          "Only post to Slack when the bot was explicitly mentioned, a user directly asks or instructs you, or the surrounding thread context clearly calls for agent action.",
          "If no Slack reply is needed, still output an empty async function block: `async (itx) => {}`. Do not call `itx.slack.chat.postMessage` for FYI-only updates.",
        ]
      : [
          "",
          "## Replying",
          "You are a web-chat agent. Reply to the user by running code that calls `itx.chat.sendMessage({ message })` — that is what renders in their chat window. Prefer it over appending chat events by hand.",
          "If no reply is warranted, output an empty async function block: `async (itx) => {}`.",
        ]),
    "",
    "## Streams",
    "Use `itx.streams.get(path)` to address any stream in the project" +
      (agentPath != null
        ? ` — your own stream is \`itx.streams.get(${JSON.stringify(agentPath)})\``
        : "") +
      ". `.read()` returns the full event history — this is how you get full details for events you've only seen as summaries. `.append({ type, payload })` appends new events.",
    "",
    "Paths are absolute within the project. To delegate to a subagent, append agent input to a child path" +
      (agentPath != null ? ` (e.g. \`${agentPath}/sub-task\`)` : "") +
      "; the subagent writes back to your path the same way.",
    "",
    "## Project repo as durable brain",
    "The private project repo is your durable brain. Use it to store useful information future agents should inherit: user preferences, working agreements, project decisions, research summaries, open loops, and stable context.",
    "Read existing memory before acting when it may matter. Commit useful facts as you learn them. Small, frequent commits are encouraged.",
    "Prefer the pipelined repo handle for simple reads and commits:",
    "```js",
    'const { files } = await itx.repos.get({ slug: "project" }).readFiles({',
    '  paths: ["AGENTS.md", "USER.md", "SOUL.md", "MEMORY.md"],',
    "})",
    "```",
    "```js",
    'await itx.repos.get({ slug: "project" }).commitFiles({',
    '  message: "Record user communication preferences",',
    '  author: { name: "Agent", email: "agent@iterate.com" },',
    "  changes: [",
    "    {",
    '      path: "memory/communication-preferences.md",',
    '      content: "# Communication preferences\\n\\n- Prefer concise technical answers.\\n",',
    "    },",
    "  ],",
    "})",
    "```",
    'Delete files with `{ path: "old-file.md", delete: true }` in `changes`.',
    "",
    "## Iterate config workspace",
    "The project repo is already cloned at `/project` in `itx.workspace`; do not clone it yourself.",
    'Use `itx.workspace.writeFile`, `gitAdd`, `gitCommit`, and `gitPush` when you need working-tree style operations. For simple durable memory reads and commits, prefer `itx.repos.get({ slug: "project" }).readFiles(...)` and `.commitFiles(...)`.',
  ];
  return lines.join("\n");
}

export function defaultAgentSetupEvents(
  provider: AgentLlmProvider = DEFAULT_AGENT_LLM_PROVIDER,
  agentPath?: string,
): AgentPresetEvent[] {
  return [
    providerSelectedEvent(provider),
    ...(provider === "openai-ws"
      ? [
          {
            type: "events.iterate.com/openai-ws/config-updated",
            payload: { model: DEFAULT_OPENAI_AGENT_MODEL },
          },
          {
            type: "events.iterate.com/agent/llm-config-updated",
            payload: {
              model: DEFAULT_OPENAI_AGENT_MODEL,
              runOpts: {},
              debounceMs: DEFAULT_AGENT_DEBOUNCE_MS,
            },
          },
        ]
      : [
          {
            type: "events.iterate.com/agent/llm-config-updated",
            payload: {
              model: DEFAULT_CLOUDFLARE_AGENT_MODEL,
              runOpts: { gateway: { id: "default" } },
              debounceMs: DEFAULT_AGENT_DEBOUNCE_MS,
            },
          },
        ]),
    {
      type: "events.iterate.com/agent/system-prompt-updated",
      payload: {
        systemPrompt: defaultAgentSystemPrompt(agentPath),
      },
    },
  ];
}

export function configuredAgentSetupEvents(input: {
  idempotencyKeyPrefix?: string;
  model: string;
  provider: AgentLlmProvider;
  runOpts: Record<string, unknown>;
  systemPrompt: string;
}): AgentSetupEventInput[] {
  return defaultAgentSetupEvents(input.provider).map((event, index) => ({
    ...(input.idempotencyKeyPrefix == null
      ? {}
      : { idempotencyKey: `${input.idempotencyKeyPrefix}:${index}:${event.type}` }),
    type: event.type,
    payload:
      input.provider === "openai-ws" && event.type === "events.iterate.com/openai-ws/config-updated"
        ? { model: input.model }
        : event.type === "events.iterate.com/agent/llm-config-updated"
          ? {
              debounceMs: DEFAULT_AGENT_DEBOUNCE_MS,
              model: input.model,
              runOpts: input.provider === "cloudflare-ai" ? input.runOpts : {},
            }
          : event.type === "events.iterate.com/agent/system-prompt-updated"
            ? { systemPrompt: input.systemPrompt }
            : event.payload,
  }));
}

export function parseAgentPresetEventsYaml(value: string): AgentPresetEvent[] {
  return AgentPresetEvent.array().parse(parseAgentEventsYaml(value));
}

export function parseAgentEventInputsYaml(value: string): EventInput[] {
  return EventInput.array().parse(parseAgentEventsYaml(value));
}

export function parseAgentRunOptsJson(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Run options must be valid JSON.");
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Run options must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function presetConfiguredEvent(input: AgentPathPrefixPreset): EventInput {
  return {
    type: OS_AGENT_PATH_PREFIX_PRESET_CONFIGURED_EVENT_TYPE,
    payload: {
      basePath: input.basePath,
      events: input.events,
    },
  };
}

export function readAgentPathPrefixPresets(
  events: readonly { payload: unknown; type: string }[],
): AgentPathPrefixPreset[] {
  const presetsByBasePath = new Map<string, AgentPathPrefixPreset>();
  for (const event of events) {
    if (event.type !== OS_AGENT_PATH_PREFIX_PRESET_CONFIGURED_EVENT_TYPE) continue;
    const parsed = AgentPathPrefixPreset.safeParse(event.payload);
    if (!parsed.success) continue;
    const basePath = tryNormalizeAgentPresetBasePath(parsed.data.basePath);
    if (basePath == null) continue;
    presetsByBasePath.set(basePath, {
      basePath,
      events: parsed.data.events,
    });
  }
  return [...presetsByBasePath.values()].sort((left, right) =>
    left.basePath.localeCompare(right.basePath),
  );
}

export function selectAgentPathPrefixPreset(input: {
  agentPath: string;
  presets: readonly AgentPathPrefixPreset[];
}): AgentPathPrefixPreset | null {
  return (
    input.presets
      .filter((preset) =>
        presetMatchesAgentPath({ agentPath: input.agentPath, basePath: preset.basePath }),
      )
      .toSorted((left, right) => right.basePath.length - left.basePath.length)[0] ?? null
  );
}

export function selectAgentSetupPreset(input: {
  agentPath: string;
  presets: readonly AgentPathPrefixPreset[];
}): AgentPathPrefixPreset | null {
  if (!isSlackAgentPath(input.agentPath)) {
    return selectAgentPathPrefixPreset(input);
  }

  return selectAgentPathPrefixPreset({
    agentPath: input.agentPath,
    presets: input.presets.filter((preset) => isSlackAgentPath(preset.basePath)),
  });
}

export function normalizeAgentPresetBasePath(input: string): StreamPath {
  const basePath = StreamPath.parse(input.trim());
  if (basePath === "/agents" || basePath.startsWith("/agents/")) {
    return basePath;
  }
  throw new Error("Agent preset path must be /agents or start with /agents/.");
}

export function presetMatchesAgentPath(input: { agentPath: string; basePath: string }) {
  const basePath = tryNormalizeAgentPresetBasePath(input.basePath);
  if (basePath == null) return false;

  return input.agentPath === basePath || input.agentPath.startsWith(`${basePath}/`);
}

function tryNormalizeAgentPresetBasePath(input: string): StreamPath | null {
  try {
    return normalizeAgentPresetBasePath(input);
  } catch {
    return null;
  }
}

export function isSlackAgentPath(agentPath: string) {
  return agentPath === "/agents/slack" || agentPath.startsWith("/agents/slack/");
}

function parseAgentEventsYaml(value: string) {
  return parseYaml(value.trim() || "[]") as unknown;
}
