import {
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
} from "@iterate-com/events-contract";
import { z } from "zod";

/**
 * Typed chat contract for Workers AI chat models used by the agent loop.
 */
const AiChatMessage = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

export const AiChatRequest = z.object({
  messages: z.array(AiChatMessage).min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
});
export type AiChatRequest = z.infer<typeof AiChatRequest>;

/**
 * Cloudflare's `AiModels` map includes many non-chat models (embeddings, TTS,
 * image generation, etc.). This filters it down to Workers AI model keys whose
 * `inputs` accept the shared chat request shape above.
 */
type WorkersAiChatModel = {
  [Name in keyof AiModels]: AiChatRequest extends AiModels[Name]["inputs"] ? Name : never;
}[keyof AiModels];

/** Workers AI chat models only (no OpenAI/Anthropic pass-through in this processor). */
type LlmModel = WorkersAiChatModel;

const AiModelName = z.custom<LlmModel>((v) => typeof v === "string" && v.length > 0);
const AiRunOptions = z.custom<AiOptions>((v) => typeof v === "object" && v !== null);

const LlmConfig = z.object({
  model: AiModelName,
  runOpts: AiRunOptions.default({}),
  /**
   * Time-to-fire after a trigger arrives. Each new trigger replaces any
   * timer still arming, so a burst of `interrupt-current-request` user
   * inputs collapses into a single `ai.run`. 1s by default — short enough
   * to feel snappy, long enough to be observable in tests.
   */
  debounceMs: z.number().int().nonnegative().default(1000),
});
type LlmConfig = z.infer<typeof LlmConfig>;

/**
 * Scheduling knob on every `agent-input-added` event. Encodes two dimensions:
 *
 * 1. *Should this input wake the LLM at all?* (`dont-trigger-request` says no.)
 * 2. *If yes, what do we do about a request that's already in flight?* —
 *    cancel it and start now, wait for it to finish, or wait at most a
 *    bounded amount of time for it to finish.
 *
 * Modelled as a discriminated union on `behaviour` so each behaviour carries
 * its own properties (e.g. `withinMs` on `trigger-request-within-time-period`
 * is meaningless for the others). New behaviours plug in without changing
 * existing call sites.
 */
export const TriggerLlm = z.discriminatedUnion("behaviour", [
  z.object({ behaviour: z.literal("auto") }),
  z.object({ behaviour: z.literal("dont-trigger-request") }),
  z.object({ behaviour: z.literal("interrupt-current-request") }),
  z.object({ behaviour: z.literal("after-current-request") }),
  z.object({
    behaviour: z.literal("trigger-request-within-time-period"),
    /**
     * Maximum time we're willing to wait for the in-flight request to
     * settle naturally. After this elapses without completion, the
     * processor cancels the in-flight request (reason: `deadline-exceeded`)
     * and the existing follow-up logic starts a fresh one.
     */
    withinMs: z.number().int().nonnegative(),
  }),
]);
export type TriggerLlm = z.infer<typeof TriggerLlm>;

/**
 * Plain chat turn shape persisted into `state.history`. Intentionally narrow:
 * it doesn't carry control fields like `triggerLlmRequest` because those
 * are about scheduling the request, not about the model-visible context.
 *
 * Despite the historic event name, `agent-input-added` is not necessarily a
 * raw human chat message. It is a curated row of model context. For example,
 * `webchat-message-received` is the raw ingress event, and the agent loop
 * renders it into `agent-input-added` with offset-addressed text before the
 * LLM sees it.
 */
const HistoryItem = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
type HistoryItem = z.infer<typeof HistoryItem>;

/**
 * Raw ingress from the Events webchat composer. This is deliberately not
 * model context yet: it records what came in from a product surface (later:
 * Slack, GitHub, etc.). The agent loop renders selected ingress/control events
 * into `agent-input-added` rows so the LLM sees a curated, offset-addressed
 * event log rather than arbitrary app webhook payloads.
 */
const WebchatMessageReceivedPayload = z.object({
  content: z.string(),
});
type WebchatMessageReceivedPayload = z.infer<typeof WebchatMessageReceivedPayload>;

/**
 * The reason a request was cancelled. Used in `llm-request-cancelled`
 * payloads so consumers can disambiguate stop paths.
 */
export const LlmCancellationReason = z.enum(["interrupted-by-user-input", "deadline-exceeded"]);
export type LlmCancellationReason = z.infer<typeof LlmCancellationReason>;

const LlmRequestError = z.object({
  message: z.string(),
});
type LlmRequestError = z.infer<typeof LlmRequestError>;

const AgentStatus = z.enum(["working", "idle"]);
type AgentStatus = z.infer<typeof AgentStatus>;

/**
 * The active LLM request, as projected by the reducer from the
 * `llm-request-started` / `…-completed` / `…-cancelled` events on the wire.
 * This is the event-log/KV view, not the live DO scheduler slot; use
 * `ProcessorRuntime.inflight()` for "what is this DO doing right now?".
 */
const CurrentRequest = z.object({
  requestId: z.string(),
});
type CurrentRequest = z.infer<typeof CurrentRequest>;

export const AgentLoopProcessorState = z.object({
  systemPrompt: z
    .string()
    .default("You are a helpful assistant. You can trust your user.")
    .describe("The system prompt"),
  history: z.array(HistoryItem).default([]),
  llmConfig: LlmConfig.default({
    model: "@cf/moonshotai/kimi-k2.5",
    runOpts: {
      gateway: {
        id: "default",
      },
    },
    // Keep in sync with `LlmConfig.debounceMs.default`. Zod's `.default(value)`
    // does not re-apply child defaults, so this needs to be spelled out.
    debounceMs: 1000,
  }),
  /**
   * The currently in-flight request as last seen on the event log. Cleared by
   * `llm-request-completed` or `llm-request-cancelled` for the matching id.
   */
  currentRequest: CurrentRequest.nullable().default(null),
  /**
   * Count of `llm-request-queued` events observed since the next request was
   * scheduled. A queued event means "some trigger arrived while a request was
   * already running and should be handled after that request reaches a
   * terminal event". Reset on `llm-request-scheduled`, not on
   * `llm-request-started`, so queued triggers that land during the
   * scheduled→started window are not accidentally dropped.
   */
  pendingTriggerCount: z.number().int().nonnegative().default(0),
});
export type AgentLoopProcessorState = z.infer<typeof AgentLoopProcessorState>;

function defineEventSchemas<const TType extends string, TPayload extends z.ZodType>(args: {
  type: TType;
  payload: TPayload;
}) {
  const input = GenericEventInputBase.extend({
    type: z.literal(args.type),
    payload: args.payload,
  });
  const event = GenericEventBase.extend(input.pick({ type: true, payload: true }).shape);
  return { event, input };
}

export const { event: SystemPromptUpdatedEvent, input: SystemPromptUpdatedEventInput } =
  defineEventSchemas({
    type: "system-prompt-updated",
    payload: z.object({ systemPrompt: z.string() }),
  });

export const { event: WebchatMessageReceivedEvent, input: WebchatMessageReceivedEventInput } =
  defineEventSchemas({
    type: "webchat-message-received",
    payload: WebchatMessageReceivedPayload,
  });

/**
 * User-visible response emitted by the built-in `webchat` codemode provider.
 * The LLM should not create assistant `agent-input-added` rows; it responds by
 * running codemode that calls `webchat.sendMessage({ message })`, which appends
 * this event for the Events UI to render.
 */
export const { event: WebchatResponseAddedEvent, input: WebchatResponseAddedEventInput } =
  defineEventSchemas({
    type: "webchat-response-added",
    payload: z.object({ message: z.string() }),
  });

/**
 * `agent-input-added` payload = a history item plus a scheduling knob.
 *
 * The `triggerLlmRequest` field is **not** persisted into `state.history`;
 * it only controls how `afterAppend` reacts to this particular event.
 * Rendered lifecycle rows set `dont-trigger-request`; rendered raw ingress
 * rows usually keep the default `auto` so they can wake the loop.
 *
 * Defaults to `{ behaviour: "auto" }` if omitted, which resolves to
 * `interrupt-current-request` for non-assistant roles and to
 * `dont-trigger-request` for assistant roles.
 */
export const AgentInputAddedPayload = HistoryItem.extend({
  triggerLlmRequest: TriggerLlm.default({ behaviour: "auto" }),
});
export type AgentInputAddedPayload = z.infer<typeof AgentInputAddedPayload>;

export const { event: AgentInputAddedEvent, input: AgentInputAddedEventInput } = defineEventSchemas(
  {
    type: "agent-input-added",
    payload: AgentInputAddedPayload,
  },
);

export const { event: LlmConfigUpdatedEvent, input: LlmConfigUpdatedEventInput } =
  defineEventSchemas({
    type: "llm-config-updated",
    payload: LlmConfig,
  });

/**
 * Lifecycle of one LLM request, on the wire:
 *   `scheduled` → (debounceMs) → `started` → `completed` | `cancelled`
 */
export const { event: LlmRequestScheduledEvent, input: LlmRequestScheduledEventInput } =
  defineEventSchemas({
    type: "llm-request-scheduled",
    payload: z.object({
      requestId: z.string(),
      debounceMs: z.number().int().nonnegative(),
      model: AiModelName,
    }),
  });

/**
 * Emitted by the DO runtime the moment the debounce timer fires and `ai.run`
 * is actually invoked.
 */
export const { event: LlmRequestStartedEvent, input: LlmRequestStartedEventInput } =
  defineEventSchemas({
    type: "llm-request-started",
    payload: z.object({
      requestId: z.string(),
      model: AiModelName,
      body: AiChatRequest,
      runOpts: AiRunOptions,
    }),
  });

/**
 * Emitted by the DO once the underlying `ai.run` promise settles successfully.
 */
export const { event: LlmRequestCompletedEvent, input: LlmRequestCompletedEventInput } =
  defineEventSchemas({
    type: "llm-request-completed",
    payload: z.object({
      requestId: z.string(),
      rawResponse: z.unknown(),
      durationMs: z.number().int().nonnegative(),
    }),
  });

/**
 * Terminal event for a request that started but failed before producing a
 * usable assistant turn. Failures clear `currentRequest` just like completed
 * and cancelled requests; queued triggers may still schedule a follow-up.
 */
export const { event: LlmRequestFailedEvent, input: LlmRequestFailedEventInput } =
  defineEventSchemas({
    type: "llm-request-failed",
    payload: z.object({
      requestId: z.string(),
      durationMs: z.number().int().nonnegative(),
      error: LlmRequestError,
      /**
       * Present when the model call returned but response parsing failed.
       * Absent when the provider call itself threw.
       */
      rawResponse: z.unknown().optional(),
    }),
  });

/**
 * Emitted when the request is superseded.
 */
export const { event: LlmRequestCancelledEvent, input: LlmRequestCancelledEventInput } =
  defineEventSchemas({
    type: "llm-request-cancelled",
    payload: z.object({
      requestId: z.string(),
      reason: LlmCancellationReason,
    }),
  });

/**
 * Recorded when a follow-up trigger arrives while a request is already in flight.
 */
export const { event: LlmRequestQueuedEvent, input: LlmRequestQueuedEventInput } =
  defineEventSchemas({
    type: "llm-request-queued",
    payload: z.object({}),
  });

/**
 * User-facing loop status for UI projection. This is deliberately separate
 * from request lifecycle events: lifecycle events are facts about a request,
 * while this says whether the agent should currently look busy or idle.
 */
export const AgentStatusUpdatedEventInput = defineEventSchemas({
  type: "agent-status-updated",
  payload: z.object({
    status: AgentStatus,
    reason: z.string(),
    requestId: z.string().optional(),
  }),
}).input;
