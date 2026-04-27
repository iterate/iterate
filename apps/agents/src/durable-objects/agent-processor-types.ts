import {
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
} from "@iterate-com/events-contract";
import { z } from "zod";
import { Callable } from "~/lib/callable.ts";

/**
 * Zod schemas + TS types for the IterateAgent stream processor.
 *
 * Split out of `agent-processor.ts` so the frontend (and anything else that
 * only needs the wire contract) can import them without dragging in the
 * Cloudflare-only runtime dependencies (`@cloudflare/codemode`, `Ai`, etc.).
 *
 * Runtime here is pure zod + tiny helpers, so this module is safe to bundle
 * for the browser. The `z.custom<AiOptions>`/`z.custom<LlmModel>` generics
 * pull their TS types from `@cloudflare/workers-types` (ambient), but the
 * runtime validators are `typeof` / `startsWith` checks only.
 */

/**
 * Typed chat contract for Workers AI chat models used by this processor.
 */
export const AiChatMessage = z.object({
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
export type WorkersAiChatModel = {
  [Name in keyof AiModels]: AiChatRequest extends AiModels[Name]["inputs"] ? Name : never;
}[keyof AiModels];

/** Workers AI chat models only (no OpenAI/Anthropic pass-through in this processor). */
export type LlmModel = WorkersAiChatModel;

export const AiModelName = z.custom<LlmModel>((v) => typeof v === "string" && v.length > 0);
export const AiRunOptions = z.custom<AiOptions>((v) => typeof v === "object" && v !== null);

export const LlmConfig = z.object({
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
export type LlmConfig = z.infer<typeof LlmConfig>;

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
 *
 * Behaviours:
 *
 * - `auto` (default): resolves at runtime based on the message role.
 *   Assistant turns → `dont-trigger-request` (the assistant just spoke,
 *   don't loop). Everything else (user, future "developer") →
 *   `interrupt-current-request`. Lets callers stay one-shot — they just
 *   record an input and the processor does the right thing.
 * - `dont-trigger-request`: append to history only, never schedule a
 *   request. Good for passive context injection or for follow-up rewrite
 *   messages emitted by the processor itself (so they don't recursively
 *   trigger).
 * - `interrupt-current-request`: if a request is currently in flight,
 *   cancel it and start a new one immediately. Otherwise start one
 *   immediately. Conceptually `{ cancel: true, maxWaitMs: 0 }`.
 * - `after-current-request`: if a request is currently in flight, wait for
 *   it to complete and then start a new one. Otherwise start one
 *   immediately. Conceptually `{ cancel: false, maxWaitMs: ∞ }`.
 * - `trigger-request-within-time-period`: queue behind the in-flight
 *   request, but only for `withinMs`; if it hasn't finished by then,
 *   cancel it and fire the new one. Conceptually
 *   `{ cancel: false-then-true, maxWaitMs: withinMs }`. Degenerate cases:
 *   `withinMs === 0` ≈ `interrupt-current-request`; very large `withinMs`
 *   ≈ `after-current-request`.
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
 * are about scheduling the request, not about the conversation itself.
 */
export const HistoryItem = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
export type HistoryItem = z.infer<typeof HistoryItem>;

/**
 * The reason a request was cancelled. Used in `llm-request-cancelled`
 * payloads so consumers can disambiguate stop paths.
 *
 * - `interrupted-by-user-input`: an `interrupt-current-request` trigger
 *   landed while the request was running.
 * - `deadline-exceeded`: a `trigger-request-within-time-period` trigger's
 *   `withinMs` elapsed before the in-flight request settled, so the
 *   processor forced an interrupt.
 */
export const LlmCancellationReason = z.enum(["interrupted-by-user-input", "deadline-exceeded"]);
export type LlmCancellationReason = z.infer<typeof LlmCancellationReason>;

/**
 * The active LLM request, as projected by the reducer from the
 * `llm-request-started` / `…-completed` / `…-cancelled` events on the wire.
 *
 * This is *eventually consistent* with the DO's in-memory `inflight` map: the
 * map is the source of truth for "right now" decisions inside `afterAppend`,
 * because new events appended in `afterAppend` round-trip through the events
 * server before being reduced into this state. See `ProcessorRuntime` in
 * `agent-processor.ts`.
 */
export const CurrentRequest = z.object({
  requestId: z.string(),
});
export type CurrentRequest = z.infer<typeof CurrentRequest>;

/**
 * Persistent description of a codemode tool provider, keyed by `slug` (the
 * sandbox namespace, e.g. `mcp` → `await mcp.someTool(...)`).
 *
 * `executeCallable` is invoked at codemode-block time with `{ name, args }`
 * to run a single tool call. `getTypesCallable` is invoked once per block to
 * obtain `{ types, toolNames }` — the LLM-facing TypeScript declarations and
 * the list of tool names to register on the namespace.
 *
 * Storing only `Callable`s here keeps state JSON-serialisable and lets
 * presets / external systems author tool providers without ever holding live
 * Worker bindings.
 */
export const ToolProviderConfig = z.object({
  executeCallable: Callable,
  getTypesCallable: Callable.optional(),
});
export type ToolProviderConfig = z.infer<typeof ToolProviderConfig>;

/**
 * Reduced projection persisted in the DO's synchronous KV (under key
 * `iterate-agent:stream-processor-state`). Small + lightweight — not execution payloads.
 */
export const IterateAgentProcessorState = z.object({
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
   * Count of `agent-input-added` events with `after-current-request` (or
   * `trigger-request-within-time-period`) that arrived while a request was
   * already in flight, and have not yet been "absorbed" by a subsequent
   * `llm-request-started`. Reset to 0 by every started event.
   */
  pendingTriggerCount: z.number().int().nonnegative().default(0),
  /**
   * Codemode tool providers, keyed by sandbox-namespace `slug`. Mutated by
   * `tool-provider-config-updated` events: a non-null `executeCallable`
   * upserts the slug, a null `executeCallable` deletes it.
   */
  toolProviders: z.record(z.string(), ToolProviderConfig).default({}),
});
export type IterateAgentProcessorState = z.infer<typeof IterateAgentProcessorState>;

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

export const { event: CodemodeBlockAddedEvent, input: CodemodeBlockAddedEventInput } =
  defineEventSchemas({
    type: "codemode-block-added",
    payload: z.object({ script: z.string() }),
  });

export const { event: CodemodeResultAddedEvent, input: CodemodeResultAddedEventInput } =
  defineEventSchemas({
    type: "codemode-result-added",
    payload: z.object({ result: z.unknown() }),
  });

export const { event: SystemPromptUpdatedEvent, input: SystemPromptUpdatedEventInput } =
  defineEventSchemas({
    type: "system-prompt-updated",
    payload: z.object({ systemPrompt: z.string() }),
  });

/**
 * `agent-input-added` payload = a history item plus a scheduling knob.
 *
 * The `triggerLlmRequest` field is **not** persisted into `state.history`;
 * it only controls how `afterAppend` reacts to this particular event.
 *
 * Defaults to `{ behaviour: "auto" }` if omitted, which resolves to
 * `interrupt-current-request` for non-assistant roles and to
 * `dont-trigger-request` for assistant roles. See `resolveTrigger` in
 * `agent-processor.ts`.
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
 *
 * Emitted by the processor (`afterAppend`) whenever a trigger lands and there
 * is no existing in-flight request to wait on. While the timer is arming, more
 * triggers replace this event with a fresh `scheduled` (same `requestId` is
 * fine — see `agent-processor.ts` `emitScheduledAndKickoff`). Useful as a
 * pre-fire signal for context providers that want to inject context before the
 * actual `ai.run` happens.
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
 * Emitted by the DO runtime the moment the debounce timer fires and
 * `ai.run` is actually invoked. Carries the `requestId` that subsequent
 * lifecycle events (`completed` / `cancelled`) use to refer to this run,
 * plus the *complete* invocation tuple (`model`, `body`, `runOpts`) so
 * stream consumers can replay or inspect exactly what was sent — without
 * having to reconstruct it from `state.history` + `state.llmConfig` and
 * potentially drift if the request-construction logic changes.
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
 * Emitted by the DO once the underlying `ai.run` promise settles
 * successfully. `rawResponse` is the *unmodified* return from `env.AI.run`
 * so debugging / replay tools see exactly what the model emitted (the
 * processor's `extractLlmAssistantText` then strips this down to a
 * human-readable assistant turn for `state.history`). Shape varies across
 * Workers AI models, hence `z.unknown`.
 *
 * `durationMs` is wall-clock from immediately before the `ai.run`
 * invocation to immediately after it resolved — purely the model call,
 * not the surrounding event-emit work. Useful for spotting slow models
 * from the stream viewer without instrumenting the runtime separately.
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
 * Emitted when the request is superseded (e.g. by an
 * `interrupt-current-request` follow-up input, or by a
 * `trigger-request-within-time-period` deadline elapsing). The result of
 * the in-flight `ai.run` is discarded once this event is observed.
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
 * Recorded when an `after-current-request` (or
 * `trigger-request-within-time-period`) input arrives while a request is
 * already in flight. The processor uses `pendingTriggerCount` to decide
 * whether to fire a follow-up request once the current one settles.
 */
export const { event: LlmRequestQueuedEvent, input: LlmRequestQueuedEventInput } =
  defineEventSchemas({
    type: "llm-request-queued",
    payload: z.object({}),
  });

/**
 * Debug round-trip: any client can append `debug-info-requested` to dump the
 * processor's current view of state + the DO's synchronous runtime view (just
 * `inflightRequestId` for now) into the stream as a `debug-info-returned`
 * event. Cheap; no reducer side effects (the events flow through history and
 * are then ignored). Useful from the stream viewer / e2e tests.
 */
/**
 * Mutate `state.toolProviders[slug]`. A non-null `executeCallable` upserts
 * the entry; a null `executeCallable` removes the slug entirely. `slug`
 * must be a valid JS identifier — it becomes the namespace in the sandbox.
 *
 * Sourced upstream from agents-app presets, never emitted by the DO itself.
 */
export const { event: ToolProviderConfigUpdatedEvent, input: ToolProviderConfigUpdatedEventInput } =
  defineEventSchemas({
    type: "tool-provider-config-updated",
    payload: z.object({
      slug: z
        .string()
        .min(1)
        .regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, {
          message: "slug must be a valid JS identifier (becomes a sandbox namespace)",
        }),
      executeCallable: Callable.nullable(),
      getTypesCallable: Callable.optional().nullable(),
    }),
  });

export const { event: DebugInfoRequestedEvent, input: DebugInfoRequestedEventInput } =
  defineEventSchemas({
    type: "debug-info-requested",
    payload: z.object({}),
  });

export const { event: DebugInfoReturnedEvent, input: DebugInfoReturnedEventInput } =
  defineEventSchemas({
    type: "debug-info-returned",
    payload: z.object({
      state: IterateAgentProcessorState,
      runtime: z.object({
        inflightRequestId: z.string().nullable(),
      }),
    }),
  });
