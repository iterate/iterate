import { z } from "zod";
import { defineProcessorContract } from "../streams/stream-processor.ts";
import { ItxProcessorContract } from "../itx/itx-processor-contract.ts";

export const DEFAULT_AGENT_MODEL = "@cf/moonshotai/kimi-k2.7-code";
export const DEFAULT_AGENT_LLM_REQUEST_DEBOUNCE_MS = 250;
export const DEFAULT_AGENT_SYSTEM_PROMPT = [
  "You are the minimal ITX web chat agent.",
  "Respond with exactly one fenced JavaScript code block and no surrounding prose.",
  "The code block must contain a single async arrow function: async (itx) => { ... }.",
  "For web chat, reply with await itx.chat.sendMessage({ message }). Do not return side-effect-only call results unless you need to inspect them on your next turn.",
  "Use project capabilities on itx when they are relevant.",
].join("\n");

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
  version: "0.2.0",
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
    llmProvider: z.literal("cloudflare-ai").default("cloudflare-ai"),
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
      description: "The web UI sent a user message to the agent.",
      payloadSchema: z.object({
        content: z.string(),
        origin: z.literal("web"),
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
        provider: z.literal("cloudflare-ai"),
      }),
    },
    "events.iterate.com/agent/llm-request-scheduled": {
      description: "An LLM request was scheduled after a trigger.",
      payloadSchema: z.object({
        debounceMs: z.number().int().nonnegative(),
        model: z.string().min(1),
        provider: z.literal("cloudflare-ai"),
        requestId: z.string(),
      }),
    },
    "events.iterate.com/agent/llm-request-requested": {
      description:
        "The agent has prepared an LLM request. The event offset is the llmRequestId; providers rebuild the prompt from history.",
      payloadSchema: z.object({
        model: z.string().min(1),
        provider: z.literal("cloudflare-ai"),
        requestId: z.string(),
      }),
    },
    "events.iterate.com/agent/llm-request-completed": {
      description: "A provider processor finished an LLM request.",
      payloadSchema: z.object({
        durationMs: z.number().int().nonnegative(),
        llmRequestId: z.number().int().positive(),
        provider: z.literal("cloudflare-ai"),
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
