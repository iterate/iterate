import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { EventInput, StreamPath } from "@iterate-com/shared/streams/types";

export const OS2_AGENT_LLM_PROVIDER_SELECTED_EVENT_TYPE =
  "events.iterate.com/os2-agent/llm-provider-selected";
export const OS2_AGENT_PATH_PREFIX_PRESET_CONFIGURED_EVENT_TYPE =
  "events.iterate.com/os2-agent/path-prefix-preset-configured";

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

export function defaultAgentSystemPrompt() {
  return [
    "You are an agent inside this Iterate OS2 project.",
    "Codemode is available and should be used for user-visible answers.",
    "Reply with exactly one fenced JavaScript code block and no surrounding prose.",
    "The block must evaluate to an async function, usually async (ctx) => { ... }.",
    "Use ctx.chat.sendMessage({ message: 'your message' }) to send visible chat replies.",
    "Return a non-undefined value only when the code result itself should be shown to the user.",
    "Use fetch for HTTP requests and ctx.streams for project-local streams.",
  ].join(" ");
}

export function defaultAgentSetupEvents(provider: AgentLlmProvider): AgentPresetEvent[] {
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
              model: "@cf/meta/llama-3.1-8b-instruct",
              runOpts: { gateway: { id: "default" } },
              debounceMs: 1000,
            },
          },
        ]),
    {
      type: "events.iterate.com/agent/system-prompt-updated",
      payload: {
        systemPrompt: defaultAgentSystemPrompt(),
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
  try {
    const parsed = JSON.parse(value);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Run options must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Run options must be valid JSON.");
  }
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
