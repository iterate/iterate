import { type EventInput, type GenericEventInput } from "@iterate-com/events-contract";
import { match } from "schematch";
import { z } from "zod";
import { dispatchCallable } from "~/lib/callable.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";
import {
  AgentInputAddedEvent,
  AgentInputAddedEventInput,
  type AgentInputAddedPayload,
  AiChatRequest,
  CodemodeBlockAddedEvent,
  CodemodeResultAddedEvent,
  CodemodeResultAddedEventInput,
  DebugInfoRequestedEvent,
  DebugInfoReturnedEventInput,
  IterateAgentProcessorState,
  type LlmCancellationReason,
  LlmConfigUpdatedEvent,
  LlmRequestCancelledEvent,
  LlmRequestCancelledEventInput,
  LlmRequestCompletedEvent,
  LlmRequestQueuedEvent,
  LlmRequestQueuedEventInput,
  LlmRequestScheduledEvent,
  LlmRequestScheduledEventInput,
  LlmRequestStartedEvent,
  SystemPromptUpdatedEvent,
  ToolProviderConfigUpdatedEvent,
  type TriggerLlm,
} from "./agent-processor-types.ts";

/**
 * `TriggerLlm` after `auto` has been resolved against the message role.
 * `handleUserInput` works with this narrower type so the dispatch is
 * exhaustive without a defensive `auto` branch.
 */
type ConcreteTriggerLlm = Exclude<TriggerLlm, { behaviour: "auto" }>;

/**
 * Wire shape returned by a `ToolProviderConfig.getTypesCallable`. The string
 * is inserted verbatim into the codemode prompt as LLM-facing documentation
 * for the namespace (declarations, examples, prose — codemode does not
 * typecheck or parse it).
 */
const ProviderTypesResponse = z.object({
  types: z.string(),
});

// `@cloudflare/codemode` transitively pulls in `cloudflare:workers`, which
// Node's ESM loader cannot resolve. The codemode path is only ever exercised
// inside `CodemodeBlockAddedEvent` (runs in the DO in production / e2e), so
// we lazy-load it. This keeps the trigger logic in this module loadable from
// the node-pool unit tests in `agent-processor.test.ts`.
async function loadCodemodeRuntime() {
  const [{ DynamicWorkerExecutor, resolveProvider }, { dynamicTools }] = await Promise.all([
    import("@cloudflare/codemode"),
    import("@cloudflare/codemode/dynamic"),
  ]);
  return { DynamicWorkerExecutor, resolveProvider, dynamicTools };
}

// Re-export so existing consumers (e.g. iterate-agent.ts) can keep importing
// state types from here.
export {
  IterateAgentProcessorState,
  type LlmCancellationReason,
  type LlmModel,
} from "./agent-processor-types.ts";

/**
 * Processor for `codemode-block-added`, `agent-input-added`, and
 * `llm-request-*` lifecycle events.
 *
 * # Reduce
 *
 * Pure projection of state from the event log:
 *
 * - `system-prompt-updated`: replaces `state.systemPrompt`. Never written to history.
 * - `agent-input-added`: appends a plain `{ role, content }` history item.
 *   The `triggerLlmRequest` field is a scheduling knob and is not persisted.
 * - `llm-request-scheduled`: sets `currentRequest` and resets
 *   `pendingTriggerCount` (the new request absorbs queued triggers).
 * - `llm-request-started`: sets `currentRequest`. Does NOT reset
 *   `pendingTriggerCount` so triggers arriving during the
 *   `scheduled → started` window are not lost.
 * - `llm-request-completed` / `llm-request-cancelled`: clears `currentRequest`
 *   when the id matches.
 * - `llm-request-queued`: increments `pendingTriggerCount`.
 *
 * # AfterAppend
 *
 * Side effects, expressed via the supplied `runtime` and `append` callbacks:
 *
 * - `codemode-block-added`: execute user script → emit `codemode-result-added`.
 * - `codemode-result-added`: append a synthetic user `agent-input-added` so
 *   the result is visible to the model on the next turn (the default `auto`
 *   behaviour resolves to `interrupt-current-request` for the user role).
 * - `agent-input-added` (role: user, behaviour != dont-trigger-request):
 *   drives the trigger FSM. While a request is `scheduled` (still inside
 *   the debounce window) every user trigger silently extends the debounce
 *   timer so the LLM fires `debounceMs` after the *last* input, not the
 *   first. Cancel + restart and the associated rewrite only happen against
 *   a `running` request. See `handleUserInput` below.
 * - `llm-request-completed` / `llm-request-cancelled`: if there are
 *   pending queued triggers, append a follow-up rewrite and fire a
 *   follow-up request via the same `emitScheduledAndKickoff` path as
 *   direct triggers.
 * - `llm-request-cancelled`: also appends a "your previous response was
 *   interrupted" rewrite so the conversation log carries an explicit note.
 *   Only ever fires for a running request, so the rewrite is always
 *   meaningful (the model actually started speaking).
 * - `debug-info-requested`: emits `debug-info-returned` carrying `state` plus
 *   the synchronous `runtime.inflight()` view. Useful for debugging via the
 *   stream alone, no extra HTTP endpoint needed.
 *
 * # Runtime
 *
 * The processor reasons about "is a request currently running right now?"
 * via the supplied `runtime`. We do *not* read `state.currentRequest` for
 * trigger decisions because events appended in `afterAppend` round-trip
 * through the events server before being reduced — the projection is
 * eventually consistent, while DO-tracked runtime state is synchronous.
 *
 * The caller (DO) owns transport (`append`), execution (`runtime`), and
 * lifecycle (`scheduleLlmRequest` arms a debounce timer; when it fires the
 * runtime appends `llm-request-started`, calls `ai.run` via `ctx.waitUntil`,
 * and on settle appends the resulting `agent-input-added` and
 * `llm-request-completed` events).
 *
 * TODO: the `codemode-block-added` / `codemode-result-added` payloads diverge from
 * `apps/events/src/lib/workshop-stream-reducer.ts`; needs a canonical contract in
 * `@iterate-com/events-contract` before this can interop with production streams.
 */

/**
 * Synchronous in-memory view of "what's actually executing right now in this
 * DO instance", plus the levers to schedule/cancel requests.
 *
 * Implemented by `iterate-agent.ts`. Kept narrow on purpose — anything richer
 * should be derived from `state` instead.
 */
export interface ProcessorRuntime {
  /**
   * Synchronous snapshot of the next-up / currently-running request, or null
   * when idle.
   *
   * - `status: "scheduled"` — debounce timer is arming; `ai.run` has not yet
   *   been invoked. Cancellable via `cancelLlmRequest` (clears the timer).
   * - `status: "running"` — `ai.run` is in flight. Cancellable via
   *   `cancelLlmRequest` (aborts the controller, best-effort).
   */
  inflight(): { requestId: string; status: "scheduled" | "running" } | null;
  /**
   * Arm a debounce timer for a new request. When it fires the DO appends
   * `llm-request-started`, invokes `ai.run`, and on settle appends
   * `agent-input-added` (assistant) + `llm-request-completed`. Caller appends
   * the corresponding `llm-request-scheduled` event so the schedule lands on
   * the event log.
   */
  scheduleLlmRequest(args: { debounceMs: number }): { requestId: string };
  /**
   * Push out the debounce timer of an already-scheduled request — true
   * debounce semantics: the LLM fires `debounceMs` after the *last* input,
   * not after the first one in a burst. Same `requestId`, no event on the
   * wire (the `agent-input-added` events already mark the activity, and
   * `llm-request-started`'s timestamp is the source of truth for when the
   * model actually ran). No-op if `requestId` no longer matches.
   */
  extendDebounce(args: { requestId: string; debounceMs: number }): void;
  /**
   * Cancel the in-flight request. Clears the debounce timer if still
   * scheduled; aborts the controller if already running (best-effort —
   * `env.AI.run` may not honour the signal). Caller appends
   * `llm-request-cancelled` so the cancellation lands on the event log.
   */
  cancelLlmRequest(args: { requestId: string }): void;
  /**
   * Used by `trigger-request-within-time-period`. Arms a deadline timer
   * that — if the request `requestId` is still running when it fires —
   * cancels the request and appends `llm-request-cancelled` (reason
   * `deadline-exceeded`) to the stream. The existing
   * `LlmRequestCancelledEvent` afterAppend handler then schedules the
   * follow-up via the queued-trigger path.
   *
   * The runtime (not the processor) emits the cancellation event because
   * by the time the timer fires the original `afterAppend` callstack is
   * long gone — there is no `append` callback to hand back.
   *
   * No-op if `requestId` is no longer the in-flight one when the timer
   * fires (e.g. the request settled naturally or was cancelled by another
   * path).
   */
  armCancelDeadline(args: { requestId: string; withinMs: number }): void;
}

/**
 * Resolves `triggerLlmRequest`'s `auto` behaviour to a concrete one based
 * on the message role.
 *
 * - `assistant` → `dont-trigger-request`. Assistant turns are model output
 *   that the processor itself just appended, so they must never re-trigger.
 * - everything else (`user`, future `developer`) → `interrupt-current-request`.
 *   Matches the pre-feature behaviour of "every user message kicks off a
 *   fresh request".
 *
 * Non-`auto` behaviours are returned unchanged.
 */
function resolveTrigger(payload: AgentInputAddedPayload): ConcreteTriggerLlm {
  if (payload.triggerLlmRequest.behaviour !== "auto") return payload.triggerLlmRequest;
  return payload.role === "assistant"
    ? { behaviour: "dont-trigger-request" }
    : { behaviour: "interrupt-current-request" };
}

export function buildLlmChatRequest(state: IterateAgentProcessorState): AiChatRequest {
  return AiChatRequest.parse({
    messages: [
      { role: "system", content: state.systemPrompt },
      ...state.history.map((m) => ({ role: m.role, content: m.content })),
    ],
  });
}

/** OpenAI chat-completions shape (often returned when routing via AI Gateway). */
const OpenAiChatCompletionResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

/** Anthropic-style message payload (rare here, but cheap to accept). */
const AnthropicAssistantMessage = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).min(1),
});

/** Native Workers AI text response for `@cf/*` chat-style models. */
const WorkersAiChatResponse = z.object({
  response: z.string(),
});

export function extractLlmAssistantText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  return match(raw)
    .case(OpenAiChatCompletionResponse, (r) => r.choices[0].message.content)
    .case(AnthropicAssistantMessage, (r) =>
      r.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(""),
    )
    .case(WorkersAiChatResponse, (r) => r.response)
    .default(match.throw);
}

type Append = (input: { event: EventInput }) => void | Promise<void>;

/**
 * Schedule a fresh request via the runtime, then append `llm-request-scheduled`
 * so the wire log carries the same intent. Used by every "fire a request" path
 * in `afterAppend` — direct user trigger, queued follow-up, post-cancel
 * follow-up — so debounce + `requestId` minting stay in one place.
 */
async function emitScheduledAndKickoff(args: {
  runtime: ProcessorRuntime;
  append: Append;
  state: IterateAgentProcessorState;
}): Promise<void> {
  const debounceMs = args.state.llmConfig.debounceMs;
  const { requestId } = args.runtime.scheduleLlmRequest({ debounceMs });
  await args.append({
    event: LlmRequestScheduledEventInput.parse({
      type: "llm-request-scheduled",
      payload: { requestId, debounceMs, model: args.state.llmConfig.model },
    }),
  });
}

async function emitCancelled(args: {
  runtime: ProcessorRuntime;
  append: Append;
  requestId: string;
  reason: LlmCancellationReason;
}): Promise<void> {
  args.runtime.cancelLlmRequest({ requestId: args.requestId });
  await args.append({
    event: LlmRequestCancelledEventInput.parse({
      type: "llm-request-cancelled",
      payload: { requestId: args.requestId, reason: args.reason },
    }),
  });
}

/**
 * Append a human-readable `agent-input-added` (role: user,
 * `dont-trigger-request`) that "rewrites" a machine event into the
 * conversation. The string is for the model's eyes only — phrasing may
 * change; consumers should not pattern match on the literal text. Always
 * `dont-trigger-request` so the rewrite cannot recursively spawn requests.
 */
async function appendRewrite(args: { append: Append; content: string }): Promise<void> {
  await args.append({
    event: AgentInputAddedEventInput.parse({
      type: "agent-input-added",
      payload: {
        role: "user",
        content: args.content,
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    }),
  });
}

function rewriteContentForCancellation(reason: LlmCancellationReason): string {
  if (reason === "interrupted-by-user-input") {
    return "[your previous response was interrupted by new user input before you could finish]";
  }
  if (reason === "deadline-exceeded") {
    return "[your previous response took too long; a new one is being started in its place]";
  }
  return `[your previous response was cancelled (${reason})]`;
}

function rewriteContentForFollowup(pendingTriggerCount: number): string {
  return pendingTriggerCount === 1
    ? "[continuing — 1 user message arrived while you were responding]"
    : `[continuing — ${pendingTriggerCount} user messages arrived while you were responding]`;
}

/** Append `llm-request-queued` so the reducer bumps `pendingTriggerCount`. */
async function emitQueued(args: { append: Append }): Promise<void> {
  await args.append({
    event: LlmRequestQueuedEventInput.parse({
      type: "llm-request-queued",
      payload: {},
    }),
  });
}

async function handleUserInput(args: {
  runtime: ProcessorRuntime;
  append: Append;
  state: IterateAgentProcessorState;
  trigger: ConcreteTriggerLlm;
}): Promise<void> {
  const { runtime, append, state, trigger } = args;
  if (trigger.behaviour === "dont-trigger-request") return;
  const inflight = runtime.inflight();

  // No request armed yet → kick one off. Debounce window starts here.
  if (inflight === null) {
    await emitScheduledAndKickoff({ runtime, append, state });
    return;
  }

  // A request is armed but `ai.run` hasn't started yet — we're inside the
  // debounce window. Push the timer out so the LLM fires `debounceMs` after
  // *this* turn rather than after the first message in a burst. The pending
  // request will absorb every input that landed in the window via
  // `state.history`. The interrupt-vs-wait distinction is meaningless while
  // the LLM hasn't started speaking yet, so all triggering behaviours
  // collapse to the same thing here: no cancel/restart, no rewrite, no
  // extra wire-log event — folding bursty input into one request is the
  // entire point.
  if (inflight.status === "scheduled") {
    runtime.extendDebounce({
      requestId: inflight.requestId,
      debounceMs: state.llmConfig.debounceMs,
    });
    return;
  }

  // From here on `inflight.status === "running"` — `ai.run` is mid-flight.
  if (trigger.behaviour === "after-current-request") {
    await emitQueued({ append });
    return;
  }

  if (trigger.behaviour === "trigger-request-within-time-period") {
    // Queue (so when the running request settles naturally, the existing
    // completion/cancellation handlers schedule a follow-up) AND arm a
    // deadline. If the request finishes within `withinMs` the deadline is
    // a no-op; if it doesn't, the runtime fires `llm-request-cancelled`
    // (reason `deadline-exceeded`) and the cancellation handler picks up
    // the queued trigger from there.
    await emitQueued({ append });
    runtime.armCancelDeadline({
      requestId: inflight.requestId,
      withinMs: trigger.withinMs,
    });
    return;
  }

  // `interrupt-current-request` against a running request: tear it down
  // (the cancellation rewrite appended in `afterAppend` is meaningful here
  // because the model genuinely started speaking) and schedule a fresh one.
  await emitCancelled({
    runtime,
    append,
    requestId: inflight.requestId,
    reason: "interrupted-by-user-input",
  });
  await emitScheduledAndKickoff({ runtime, append, state });
}

export function createIterateAgentProcessor(deps: {
  loader: WorkerLoader;
  outboundFetch: Fetcher;
  /**
   * Worker env, threaded through so `dispatchCallable` can resolve symbolic
   * binding names (`{ $binding: "MCP_CLIENT" }`) against live `Fetcher`s and
   * `DurableObjectNamespace`s when materialising tool providers.
   */
  env: CloudflareEnv;
}) {
  return {
    slug: "iterate-agent",
    initialState: IterateAgentProcessorState.parse({}),
    reduce: ({ event, state }: { event: GenericEventInput; state: IterateAgentProcessorState }) =>
      match(event)
        .case(SystemPromptUpdatedEvent, (event) => ({
          ...state,
          systemPrompt: event.payload.systemPrompt,
        }))
        .case(AgentInputAddedEvent, (event) => ({
          ...state,
          history: [...state.history, { role: event.payload.role, content: event.payload.content }],
        }))
        .case(LlmConfigUpdatedEvent, (event) => ({
          ...state,
          llmConfig: event.payload,
        }))
        .case(LlmRequestScheduledEvent, (event) => ({
          // `scheduled` is the canonical "a new request is now in-flight from
          // the processor's POV" event — it absorbs any queued triggers. The
          // subsequent `started` event is just a transition marker and does
          // not reset `pendingTriggerCount`, otherwise queues that arrive
          // between `scheduled` and `started` would be lost.
          ...state,
          currentRequest: { requestId: event.payload.requestId },
          pendingTriggerCount: 0,
        }))
        .case(LlmRequestStartedEvent, (event) => ({
          ...state,
          currentRequest: { requestId: event.payload.requestId },
        }))
        .case(LlmRequestCompletedEvent, (event) =>
          state.currentRequest?.requestId === event.payload.requestId
            ? { ...state, currentRequest: null }
            : state,
        )
        .case(LlmRequestCancelledEvent, (event) =>
          state.currentRequest?.requestId === event.payload.requestId
            ? { ...state, currentRequest: null }
            : state,
        )
        .case(LlmRequestQueuedEvent, () => ({
          ...state,
          pendingTriggerCount: state.pendingTriggerCount + 1,
        }))
        .case(ToolProviderConfigUpdatedEvent, (event) => {
          const { slug, executeCallable, getTypesCallable } = event.payload;
          // Null `executeCallable` deletes the slug entirely. We treat this
          // as the only deletion signal so adding `getTypesCallable` later
          // without a fresh `executeCallable` doesn't accidentally wipe the
          // entry.
          if (executeCallable === null) {
            const { [slug]: _removed, ...rest } = state.toolProviders;
            return { ...state, toolProviders: rest };
          }
          return {
            ...state,
            toolProviders: {
              ...state.toolProviders,
              [slug]: {
                executeCallable,
                ...(getTypesCallable === undefined || getTypesCallable === null
                  ? {}
                  : { getTypesCallable }),
              },
            },
          };
        })
        .default(() => undefined),

    afterAppend: async ({
      event,
      state,
      append,
      runtime,
    }: {
      append: Append;
      event: unknown;
      state: IterateAgentProcessorState;
      runtime: ProcessorRuntime;
    }) =>
      match(event)
        .case(CodemodeBlockAddedEvent, async (event) => {
          const { DynamicWorkerExecutor, resolveProvider, dynamicTools } =
            await loadCodemodeRuntime();
          const executor = new DynamicWorkerExecutor({
            loader: deps.loader,
            globalOutbound: deps.outboundFetch,
          });

          // Materialise the serialised tool-provider stack as codemode
          // `dynamicTools` providers: each slug becomes a runtime-resolved
          // namespace where `slug.<anything>(args)` forwards to the
          // configured `executeCallable`. `getTypesCallable` (when present)
          // produces the LLM-facing prompt material — codemode inserts it
          // verbatim, so the callable can return declarations, prose, or
          // anything else useful to the model.
          const dynamicResolved = await Promise.all(
            Object.entries(state.toolProviders).map(async ([slug, config]) => {
              const types = config.getTypesCallable
                ? ProviderTypesResponse.parse(
                    await dispatchCallable<unknown>({
                      callable: config.getTypesCallable,
                      // Pass the slug so callables that emit codemode-style
                      // declarations (e.g. via `generateTypesFromJsonSchema`)
                      // can pin the namespace to match the runtime one-to-one.
                      payload: { namespace: slug },
                      ctx: { env: deps.env as unknown as Record<string, unknown> },
                    }),
                  ).types
                : undefined;
              return resolveProvider(
                dynamicTools({
                  name: slug,
                  types,
                  callTool: (name, args) =>
                    dispatchCallable({
                      callable: config.executeCallable,
                      payload: { name, args },
                      ctx: { env: deps.env as unknown as Record<string, unknown> },
                    }),
                }),
              );
            }),
          );

          const result = await executor.execute(event.payload.script, [
            // `builtin.answer()` is the e2e canary asserted by
            // `apps/agents/e2e/vitest/iterate-agent.e2e.test.ts` and `…-mixed-codemode.e2e.test.ts`.
            { name: "builtin", fns: { answer: async () => 42 } },
            ...dynamicResolved,
          ]);

          await append({
            event: CodemodeResultAddedEventInput.parse({
              type: "codemode-result-added",
              payload: result,
            }),
          });
        })
        .case(CodemodeResultAddedEvent, async (event) => {
          await append({
            event: AgentInputAddedEventInput.parse({
              type: "agent-input-added",
              payload: {
                role: "user",
                content: `[Codemode result]:\n${JSON.stringify(event.payload.result, null, 2)}`,
              },
            }),
          });
        })
        .case(AgentInputAddedEvent, async (event) => {
          if (event.offset == null) return;
          const trigger = resolveTrigger(event.payload);
          await handleUserInput({ runtime, append, state, trigger });
        })
        .case(LlmRequestCompletedEvent, async () => {
          // After a clean completion, fire one follow-up if queued triggers
          // piled up (from `after-current-request` or
          // `trigger-request-within-time-period` while running). The
          // runtime check guards against the (rare) case where another
          // path already kicked off a new request between reduce and
          // afterAppend.
          if (state.pendingTriggerCount > 0 && runtime.inflight() === null) {
            await appendRewrite({
              append,
              content: rewriteContentForFollowup(state.pendingTriggerCount),
            });
            await emitScheduledAndKickoff({ runtime, append, state });
          }
        })
        .case(LlmRequestCancelledEvent, async (event) => {
          // Annotate the log with a human-readable cancellation note.
          // Always fires (regardless of cancellation reason) so any future
          // source gets the same treatment.
          await appendRewrite({
            append,
            content: rewriteContentForCancellation(event.payload.reason),
          });
          // If the cancellation was caused by `interrupt-current-request`,
          // the new request has already been scheduled synchronously by
          // `handleUserInput` — `runtime.inflight()` is non-null, so this
          // branch is skipped. Kicks in for `deadline-exceeded` cancels
          // (where the queued follow-up has not yet been scheduled) and
          // for any other cancellation path that leaves the queue
          // unserved.
          if (state.pendingTriggerCount > 0 && runtime.inflight() === null) {
            await appendRewrite({
              append,
              content: rewriteContentForFollowup(state.pendingTriggerCount),
            });
            await emitScheduledAndKickoff({ runtime, append, state });
          }
        })
        .case(DebugInfoRequestedEvent, async () => {
          await append({
            event: DebugInfoReturnedEventInput.parse({
              type: "debug-info-returned",
              payload: {
                state,
                runtime: { inflightRequestId: runtime.inflight()?.requestId ?? null },
              },
            }),
          });
        })
        .defaultAsync(() => undefined),
  };
}
