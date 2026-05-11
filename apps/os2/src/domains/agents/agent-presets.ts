import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { DEFAULT_WORKERS_AI_AGENT_MODEL } from "@iterate-com/shared/stream-processors/agent/contract";

export const OS2_AGENT_LLM_PROVIDER_SELECTED_EVENT_TYPE =
  "events.iterate.com/os2-agent/llm-provider-selected";
export const OS2_AGENT_PATH_PREFIX_PRESET_CONFIGURED_EVENT_TYPE =
  "events.iterate.com/os2-agent/path-prefix-preset-configured";
export const DEFAULT_CLOUDFLARE_AGENT_MODEL = DEFAULT_WORKERS_AI_AGENT_MODEL;

export const AgentLlmProvider = z.enum(["openai-ws", "cloudflare-ai"]);
export type AgentLlmProvider = z.infer<typeof AgentLlmProvider>;

export const AgentPresetEvent = z.object({
  type: z.string().trim().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type AgentPresetEvent = z.infer<typeof AgentPresetEvent>;

export const AgentPathPrefixPreset = z.object({
  basePath: z.string().trim().min(1),
  events: z.array(AgentPresetEvent),
});
export type AgentPathPrefixPreset = z.infer<typeof AgentPathPrefixPreset>;

export function providerSelectedEvent(provider: AgentLlmProvider): AgentPresetEvent {
  return {
    type: OS2_AGENT_LLM_PROVIDER_SELECTED_EVENT_TYPE,
    payload: { provider },
  };
}

export function defaultAgentSystemPrompt(agentPath?: string) {
  const lines = [
    "You are an agent inside an Iterate OS2 project. Everything in this system is built on streams — ordered event logs. You are running inside a stream yourself" +
      (agentPath != null ? ` at path \`${agentPath}\`` : "") +
      ". The messages you see (agent/input-added, tool-provider-registered, etc.) are all stream events. Your responses become stream events too.",
    "",
    "## Codemode",
    "Codemode is mandatory for user-visible answers. Reply with exactly one fenced JavaScript code block (```js) and no surrounding prose. The block must be a single async arrow function: `async (ctx) => { ... }`.",
    "",
    "Use `ctx.chat.sendMessage({ message })` to send visible chat replies. The function body implicitly returns undefined — do NOT write `return undefined` or `return;`, just let the function end. Only return a value when you want the result shown back to you and another LLM turn.",
    "",
    "Use `Promise.all([...])` for independent concurrent operations. Use `fetch` for HTTP requests. Use normal JavaScript — loops, variables, try/catch, destructuring — as you would in any async function.",
    "",
    "## Tool providers",
    "Available tools are announced as `codemode/tool-provider-registered` events. Call them as `ctx.<path>.<method>(args)` — e.g. `ctx.slack.chat.postMessage({ channel, text })` or `ctx.streams.read()`.",
    "",
    "## Streams",
    "Use `ctx.streams.read()` to read the current stream's full event history — this is how you get full details for events you've only seen as summaries. Use `ctx.streams.append({ event: { type, payload } })` to append new events.",
    "",
    "Streams support relative paths from your agent's stream. For example, `ctx.streams.append({ event: { type: 'events.iterate.com/agent/input-added', payload: { content: 'hello' } }, streamPath: './sub-task' })` appends to a child stream. A subagent at that child path can respond back with `ctx.streams.append({ ..., streamPath: '..' })` to write to the parent.",
  ];
  return lines.join("\n");
}

export function defaultAgentSetupEvents(
  provider: AgentLlmProvider,
  agentPath?: string,
): AgentPresetEvent[] {
  return [
    providerSelectedEvent(provider),
    ...(provider === "openai-ws"
      ? [
          {
            type: "events.iterate.com/openai-ws/config-updated",
            payload: { model: "gpt-5.5" },
          },
        ]
      : [
          {
            type: "events.iterate.com/agent/llm-config-updated",
            payload: {
              model: DEFAULT_CLOUDFLARE_AGENT_MODEL,
              runOpts: { gateway: { id: "default" } },
              debounceMs: 1000,
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
}): EventInput[] {
  return defaultAgentSetupEvents(input.provider).map((event, index) => ({
    ...(input.idempotencyKeyPrefix == null
      ? {}
      : { idempotencyKey: `${input.idempotencyKeyPrefix}:${index}:${event.type}` }),
    type: event.type,
    payload:
      input.provider === "openai-ws" && event.type === "events.iterate.com/openai-ws/config-updated"
        ? { model: input.model }
        : input.provider === "cloudflare-ai" &&
            event.type === "events.iterate.com/agent/llm-config-updated"
          ? {
              debounceMs: 1000,
              model: input.model,
              runOpts: input.runOpts,
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
    type: OS2_AGENT_PATH_PREFIX_PRESET_CONFIGURED_EVENT_TYPE,
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
    if (event.type !== OS2_AGENT_PATH_PREFIX_PRESET_CONFIGURED_EVENT_TYPE) continue;
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

function parseAgentEventsYaml(value: string) {
  return parseYaml(value.trim() || "[]") as unknown;
}
