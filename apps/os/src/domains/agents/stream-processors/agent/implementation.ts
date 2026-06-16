// Implements the "agent" processor as a class-based StreamProcessor.
//
// The Agent processor owns scheduling and model-visible history. It does not
// call an LLM provider directly; it appends `agent/llm-request-requested` and a
// subscribed LLM request processor owes the stream `agent/output-added` plus a
// terminal `agent/llm-request-completed`.
//
// Appended event types, payload shapes, and idempotency-key derivations
// (`agent/<key>@<sourceOffset>`) are stable wire formats — changing them
// breaks dedup against events already committed to streams.

import {
  assertNever,
  buildProcessorIdempotencyKey,
  type StreamEvent,
} from "@iterate-com/shared/streams/stream-processors";
import {
  AgentProcessorContract,
  reduceAgentEvent,
  reduceAgentEvents,
  type AgentConsumedEvent,
  type AgentState,
} from "./contract.ts";
import { StreamProcessor } from "~/domains/streams/engine/stream-processor.ts";
import { ITX_EVENT_TYPES } from "~/itx/contract.ts";

export { AgentProcessorContract } from "./contract.ts";

export type AgentProcessorContract = typeof AgentProcessorContract;

export type AgentProcessorDeps = {
  ensureChildAgentRunner(childPath: string): Promise<unknown>;
  isAgentsRootStream(): boolean;
  /**
   * Reads the full committed history of the agent's stream. The debounce-timer
   * handoff rebuilds agent state from durable history at the last possible
   * moment so the provider request reflects the committed stream, not a
   * potentially stale warm reduction (see `#requestScheduledLlmWork`).
   */
  readStreamEvents(): Promise<StreamEvent[]>;
  /**
   * Ensures the agent's Itx context and its own stream subscription exist
   * before the agent enqueues script work for that context.
   */
  ensureItxContext(): Promise<unknown>;
};

type LlmRequestPolicy = Extract<
  AgentConsumedEvent,
  { type: "events.iterate.com/agent/input-added" }
>["payload"]["llmRequestPolicy"];

type ScheduledLlmRequest = {
  requestId: string;
  timer: ReturnType<typeof setTimeout>;
  scheduledEvent: { offset: number };
};

/**
 * Retry delay when the `llm-request-requested` handoff append fails. The
 * scheduled request is a durable promise (state stays `phase: "scheduled"`
 * until the handoff commits), so a transient append failure must re-arm the
 * timer instead of dropping the turn.
 */
const LLM_REQUEST_HANDOFF_RETRY_MS = 1000;

export class AgentProcessor extends StreamProcessor<AgentProcessorContract, AgentProcessorDeps> {
  readonly contract = AgentProcessorContract;

  /**
   * Warm-instance scheduling state. The durable request facts still live in the
   * stream, but timers cannot be serialized into reduced state. The hosting
   * Durable Object instance is the timer scope, exactly like the old runner DO.
   */
  #scheduledLlmRequest: ScheduledLlmRequest | null = null;
  #llmRequestSeq = 0;
  #triggerSchedulingInProgress = new Set<number>();

  protected override reduce(
    args: Parameters<StreamProcessor<AgentProcessorContract>["reduce"]>[0],
  ) {
    return reduceAgentEvent(args);
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<AgentProcessorContract>["processEvent"]>[0],
  ): void {
    const { event, previousState, state } = args;
    switch (event.type) {
      case "events.iterate.com/agent/system-prompt-updated":
      case "events.iterate.com/agent/llm-config-updated":
      case "events.iterate.com/agent/llm-request-scheduled":
      case "events.iterate.com/agent/status-updated":
      case "events.iterate.com/agent/llm-request-queued":
        return;
      case "events.iterate.com/stream/child-stream-created":
        args.blockProcessorWhile(() => this.deps.ensureChildAgentRunner(event.payload.childPath));
        return;
      case "events.iterate.com/agents/user-message-received":
        if (this.deps.isAgentsRootStream()) return;
        args.blockProcessorWhile(async () => {
          await this.#appendEventTypeExplanation({ eventType: event.type });
          await this.ctx.stream.append({
            event: {
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: AgentProcessorContract,
                key: "render-chat-message",
                sourceEvent: event,
              }),
              payload: {
                content: chatEventBlock({
                  offset: event.offset,
                  type: event.type,
                  bodyTag: "content",
                  body: event.payload.content,
                  fields: { origin: event.payload.origin },
                }),
              },
            },
          });
        });
        return;
      case "events.iterate.com/agents/web-message-sent":
      case "events.iterate.com/agents/tui-message-sent":
        if (this.deps.isAgentsRootStream()) return;
        args.blockProcessorWhile(async () => {
          await this.#appendEventTypeExplanation({ eventType: event.type });
          await this.ctx.stream.append({
            event: {
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: AgentProcessorContract,
                key: "render-chat-response",
                sourceEvent: event,
              }),
              payload: {
                content: chatEventBlock({
                  offset: event.offset,
                  type: event.type,
                  bodyTag: "message",
                  body: event.payload.message,
                }),
                llmRequestPolicy: { behaviour: "dont-trigger-request" },
              },
            },
          });
        });
        return;
      case "events.iterate.com/agent/output-added":
        if (this.deps.isAgentsRootStream()) return;
        args.blockProcessorWhile(() => this.#enqueueScriptFromAgentOutput(event));
        return;
      case "events.iterate.com/itx/script-execution-completed":
        if (this.deps.isAgentsRootStream()) return;
        args.blockProcessorWhile(() => this.#appendScriptCompletionInput(event));
        return;
      case "events.iterate.com/stream/subscriber-connected": {
        // Scheduler reconciliation. Reduced state says a request should be
        // scheduled; if this instance has no debounce timer armed for it, the
        // timer died with a previous incarnation and nothing else will ever
        // fire it — convert the schedule into a request now. The handoff is
        // keyed off the original scheduled event, so if the dead timer's
        // append did land, this dedups instead of double-requesting.
        if (state.currentRequest?.phase === "scheduled" && this.#scheduledLlmRequest === null) {
          const scheduled = state.currentRequest;
          args.blockProcessorWhile(() =>
            this.#requestLlmWorkForSchedule({
              requestId: scheduled.requestId,
              scheduledEvent: { offset: scheduled.scheduledOffset },
            }),
          );
          return;
        }
        if (
          state.currentRequest === null &&
          state.pendingTriggerOffset !== null &&
          this.#scheduledLlmRequest === null &&
          !this.#triggerSchedulingInProgress.has(state.pendingTriggerOffset)
        ) {
          const pendingTriggerOffset = state.pendingTriggerOffset;
          args.blockProcessorWhile(() =>
            this.#appendLlmRequestScheduled({
              sourceEvent: { offset: pendingTriggerOffset },
              state,
            }),
          );
          return;
        }
        return;
      }
      case "events.iterate.com/itx/capability-provided":
        // Blocking: these context rows must land before the checkpoint so a
        // failed append is retried instead of silently dropped from history.
        args.blockProcessorWhile(async () => {
          await this.#appendEventTypeExplanation({ eventType: event.type });
          await this.#appendRewrite({
            event,
            key: "render-itx-capability-provided",
            content: capabilityProvidedEventBlock({
              instructions:
                typeof event.payload.meta?.instructions === "string"
                  ? event.payload.meta.instructions
                  : "",
              name: (event.payload.path ?? []).join("."),
              offset: event.offset,
              type: event.type,
            }),
          });
        });
        return;
      case "events.iterate.com/agent/input-added":
        args.blockProcessorWhile(() =>
          this.#handleAgentInputAddedForLlmRequest({
            event,
            state,
            policy: event.payload.llmRequestPolicy,
          }),
        );
        return;
      case "events.iterate.com/agent/llm-request-requested":
        args.blockProcessorWhile(() =>
          this.#emitAgentStatus({
            sourceEvent: event,
            status: "working",
            reason: "llm-request-requested",
            llmRequestId: event.offset,
          }),
        );
        return;
      case "events.iterate.com/agent/llm-request-completed":
        if (
          event.payload.llmRequestId !== undefined &&
          (previousState.currentRequest?.phase !== "requested" ||
            previousState.currentRequest.llmRequestId !== event.payload.llmRequestId)
        ) {
          return;
        }
        args.blockProcessorWhile(() =>
          this.#handleTerminalLlmRequestEvent({
            sourceEvent: event,
            state,
            reason: "llm-request-completed",
            llmRequestId: event.payload.llmRequestId,
          }),
        );
        return;
      case "events.iterate.com/agent/llm-request-cancelled":
        if (
          event.payload.phase === "scheduled" &&
          (previousState.currentRequest?.phase !== "scheduled" ||
            previousState.currentRequest.requestId !== event.payload.requestId)
        ) {
          return;
        }
        if (
          event.payload.phase === "requested" &&
          (previousState.currentRequest?.phase !== "requested" ||
            previousState.currentRequest.llmRequestId !== event.payload.llmRequestId)
        ) {
          return;
        }
        if (event.payload.phase === "scheduled") {
          this.#cancelScheduledLlmRequest({ requestId: event.payload.requestId });
        }
        args.blockProcessorWhile(async () => {
          await this.#appendEventTypeExplanation({ eventType: event.type });
          await this.#appendRewrite({
            event,
            key: "render-llm-request-cancelled",
            content: `An event has occurred: \n\n${eventBlock({
              offset: event.offset,
              type: event.type,
              fields: {
                ...(event.payload.phase === "scheduled"
                  ? { requestId: event.payload.requestId }
                  : { llmRequestId: event.payload.llmRequestId }),
                reason: event.payload.reason,
              },
            })}`,
          });
          await this.#handleTerminalLlmRequestEvent({
            sourceEvent: event,
            state,
            reason: "llm-request-cancelled",
            ...(event.payload.phase === "scheduled"
              ? { requestId: event.payload.requestId }
              : { llmRequestId: event.payload.llmRequestId }),
          });
        });
        return;
      default:
        return assertNever(event);
    }
  }

  /**
   * Applies the Agent processor's LLM scheduling policy for a model-visible
   * input row. The durable handoff is `llm-request-requested`; provider
   * processors own the actual LLM side effect.
   */
  async #handleAgentInputAddedForLlmRequest(args: {
    event: { offset: number };
    state: AgentState;
    policy: LlmRequestPolicy;
  }) {
    const { event, state, policy } = args;
    if (policy.behaviour === "dont-trigger-request") return;

    this.#triggerSchedulingInProgress.add(event.offset);
    try {
      if (state.currentRequest == null) {
        await this.#appendLlmRequestScheduled({ sourceEvent: event, state });
        return;
      }

      if (state.currentRequest.phase === "scheduled") {
        if (policy.behaviour === "interrupt-current-request") {
          await this.#cancelCurrentScheduledRequest({
            requestId: state.currentRequest.requestId,
            sourceEvent: event,
          });
          await this.#appendLlmRequestScheduled({ sourceEvent: event, state });
          return;
        }

        this.#resetScheduledLlmRequestTimer({
          requestId: state.currentRequest.requestId,
          debounceMs: state.llmConfig.debounceMs,
          scheduledOffset: state.currentRequest.scheduledOffset,
        });
        return;
      }

      if (policy.behaviour === "interrupt-current-request") {
        await this.#cancelCurrentInFlightRequest({
          llmRequestId: state.currentRequest.llmRequestId,
          sourceEvent: event,
        });
        await this.#appendLlmRequestScheduled({ sourceEvent: event, state });
        return;
      }

      await this.#emitQueued({ sourceEvent: event });
    } finally {
      this.#triggerSchedulingInProgress.delete(event.offset);
    }
  }

  async #enqueueScriptFromAgentOutput(
    event: Extract<AgentConsumedEvent, { type: "events.iterate.com/agent/output-added" }>,
  ) {
    const script = extractCodemodeScript(event.payload.content);
    if (script == null) return;

    await this.deps.ensureItxContext();
    await this.ctx.stream.append({
      event: {
        type: ITX_EVENT_TYPES.scriptExecutionRequested,
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: AgentProcessorContract,
          key: "enqueue-output-script",
          sourceEvent: event,
        }),
        payload: {
          code: script,
          enqueued: true,
          executionId: `agent-output-script-${event.offset}`,
        },
      },
    });
  }

  async #appendScriptCompletionInput(
    event: Extract<
      AgentConsumedEvent,
      { type: "events.iterate.com/itx/script-execution-completed" }
    >,
  ) {
    const executionId = event.payload.executionId;
    if (typeof executionId !== "string" || executionId.trim() === "") return;

    const logs = Array.isArray(event.payload.logs) ? (event.payload.logs as string[]) : [];
    const outcome =
      event.payload.ok === true
        ? ({ status: "returned", value: event.payload.result } as const)
        : ({ error: event.payload.error ?? "Unknown script error", status: "threw" } as const);
    if (outcome.status === "returned" && outcome.value === undefined && logs.length === 0) return;

    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: `agent-itx-execution-result:${executionId}`,
        payload: {
          content: itxCompletionInputBlock({ event, logs, outcome }),
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
    });
  }

  /**
   * Reacts to completed/cancelled request events after the reducer has already
   * cleared or retained `currentRequest`. Queued triggers become a new
   * scheduled request; otherwise the processor publishes an idle status.
   */
  async #handleTerminalLlmRequestEvent(args: {
    sourceEvent: { offset: number };
    state: AgentState;
    reason: "llm-request-completed" | "llm-request-cancelled";
    requestId?: string;
    llmRequestId?: number;
  }) {
    if (args.state.pendingTriggerCount > 0 && this.#scheduledLlmRequest === null) {
      await this.#appendLlmRequestScheduled({
        sourceEvent: args.sourceEvent,
        state: args.state,
      });
      return;
    }

    if (args.state.pendingTriggerCount === 0 && this.#scheduledLlmRequest === null) {
      await this.#emitAgentStatus({
        sourceEvent: args.sourceEvent,
        status: "idle",
        reason: args.reason,
        requestId: args.requestId,
        llmRequestId: args.llmRequestId,
      });
    }
  }

  async #appendLlmRequestScheduled(args: { sourceEvent: { offset: number }; state: AgentState }) {
    const debounceMs = args.state.llmConfig.debounceMs;
    this.#llmRequestSeq += 1;
    const requestId = `req_${Date.now()}_${this.#llmRequestSeq}`;
    const scheduledEvent = (await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/agent/llm-request-scheduled",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: AgentProcessorContract,
          key: "llm-request-scheduled",
          sourceEvent: args.sourceEvent,
        }),
        payload: {
          requestId,
          debounceMs,
          model: args.state.llmConfig.model,
        },
      },
    })) as StreamEvent;
    // The append dedups on the idempotency key, so the committed payload may
    // carry a different requestId than this call generated (a raced duplicate
    // schedule, or a batch retry re-running this side effect). The timer must
    // track the durable requestId — the handoff re-reads committed history and
    // bails on a mismatch, which would wedge the schedule until the next
    // subscriber-connected recovery.
    const committedRequestId =
      (scheduledEvent.payload as { requestId?: string }).requestId ?? requestId;
    this.#armLlmRequestDebounceTimer({
      requestId: committedRequestId,
      debounceMs,
      scheduledEvent,
    });
  }

  #cancelScheduledLlmRequest(args: { requestId: string }) {
    if (this.#scheduledLlmRequest?.requestId !== args.requestId) return;
    clearTimeout(this.#scheduledLlmRequest.timer);
    this.#scheduledLlmRequest = null;
  }

  async #cancelCurrentScheduledRequest(args: {
    requestId: string;
    sourceEvent: { offset: number };
  }) {
    this.#cancelScheduledLlmRequest({ requestId: args.requestId });
    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/agent/llm-request-cancelled",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: AgentProcessorContract,
          key: "llm-request-cancelled/interrupted-by-user-input",
          sourceEvent: args.sourceEvent,
        }),
        payload: {
          phase: "scheduled",
          requestId: args.requestId,
          reason: "interrupted-by-user-input",
        },
      },
    });
  }

  async #cancelCurrentInFlightRequest(args: {
    llmRequestId: number;
    sourceEvent: { offset: number };
  }) {
    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/agent/llm-request-cancelled",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: AgentProcessorContract,
          key: "llm-request-cancelled/interrupted-by-user-input",
          sourceEvent: args.sourceEvent,
        }),
        payload: {
          phase: "requested",
          llmRequestId: args.llmRequestId,
          reason: "interrupted-by-user-input",
        },
      },
    });
  }

  #resetScheduledLlmRequestTimer(args: {
    requestId: string;
    debounceMs: number;
    scheduledOffset: number;
  }) {
    // The durable scheduledOffset lets a fresh instance re-arm without losing
    // the idempotency key for the original scheduled event.
    const scheduledEvent = this.#scheduledLlmRequest?.scheduledEvent ?? {
      offset: args.scheduledOffset,
    };
    this.#cancelScheduledLlmRequest({ requestId: args.requestId });
    this.#armLlmRequestDebounceTimer({
      requestId: args.requestId,
      debounceMs: args.debounceMs,
      scheduledEvent,
    });
  }

  #armLlmRequestDebounceTimer(args: {
    requestId: string;
    debounceMs: number;
    scheduledEvent: { offset: number };
  }) {
    const timer = setTimeout(() => {
      // The timer fires outside any batch, so the base class's keep-alive-backed
      // background path is the equivalent of the old runner's `waitUntil`.
      this.runInBackground(() => this.#requestScheduledLlmWork({ requestId: args.requestId }));
    }, args.debounceMs);
    this.#scheduledLlmRequest = {
      requestId: args.requestId,
      timer,
      scheduledEvent: args.scheduledEvent,
    };
  }

  async #requestScheduledLlmWork(args: { requestId: string }) {
    if (this.#scheduledLlmRequest?.requestId !== args.requestId) return;

    const scheduledEvent = this.#scheduledLlmRequest.scheduledEvent;
    this.#scheduledLlmRequest = null;
    await this.#requestLlmWorkForSchedule({
      requestId: args.requestId,
      scheduledEvent,
    });
  }

  /**
   * Converts a scheduled request into the durable `llm-request-requested`
   * handoff. Shared by the debounce-timer path and the subscriber-connected
   * reconciliation path; both derive the idempotency key from the original
   * scheduled event, so whichever fires first wins and the other dedups.
   *
   * Rebuilds the LLM handoff from durable stream history at the last possible
   * moment. The request debounce timer is independent from batch delivery, so
   * it can fire after the user-triggering input has been reduced but before
   * related non-triggering context rows (e.g. the codemode primer) have
   * reached this processor. Reading and reducing the committed stream here
   * makes the provider request reflect the stream, not a stale warm object —
   * and is also what protects the recovery path: if committed history says
   * this schedule was already cancelled or superseded, no request is made.
   */
  async #requestLlmWorkForSchedule(args: {
    requestId: string;
    scheduledEvent: { offset: number };
  }) {
    const events = await this.deps.readStreamEvents();
    const stateAtRequest = reduceAgentEvents({ events });

    if (
      stateAtRequest.currentRequest?.phase !== "scheduled" ||
      stateAtRequest.currentRequest.requestId !== args.requestId
    ) {
      return;
    }

    try {
      // Request-by-reference: no body. Providers rebuild the chat request from
      // committed history up to this event's offset.
      await this.ctx.stream.append({
        event: {
          type: "events.iterate.com/agent/llm-request-requested",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: AgentProcessorContract,
            key: "llm-request-requested",
            sourceEvent: args.scheduledEvent,
          }),
          payload: {
            model: stateAtRequest.llmConfig.model,
            runOpts: stateAtRequest.llmConfig.runOpts,
          },
        },
      });
    } catch (error) {
      // The durable state still says "scheduled" (the handoff never
      // committed), so dropping the turn here would wedge the stream until
      // the next incarnation's subscriber-connected recovery. Re-arm and
      // retry; the idempotency key makes a raced duplicate harmless.
      console.error("[agent] scheduled llm request handoff failed; retrying", error);
      this.#armLlmRequestDebounceTimer({
        requestId: args.requestId,
        debounceMs: LLM_REQUEST_HANDOFF_RETRY_MS,
        scheduledEvent: args.scheduledEvent,
      });
    }
  }

  async #emitQueued(args: { sourceEvent: { offset: number } }) {
    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/agent/llm-request-queued",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: AgentProcessorContract,
          key: "llm-request-queued",
          sourceEvent: args.sourceEvent,
        }),
        payload: {},
      },
    });
  }

  async #emitAgentStatus(args: {
    sourceEvent: { offset: number };
    status: "working" | "idle";
    reason: string;
    requestId?: string;
    llmRequestId?: number;
  }) {
    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/agent/status-updated",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: AgentProcessorContract,
          key: `status-updated/${args.status}/${args.reason}`,
          sourceEvent: args.sourceEvent,
        }),
        payload: {
          status: args.status,
          reason: args.reason,
          ...(args.requestId == null ? {} : { requestId: args.requestId }),
          ...(args.llmRequestId == null ? {} : { llmRequestId: args.llmRequestId }),
        },
      },
    });
  }

  async #appendRewrite(args: { event: { offset: number }; key: string; content: string }) {
    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: AgentProcessorContract,
          key: args.key,
          sourceEvent: args.event,
        }),
        payload: {
          content: args.content,
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
    });
  }

  async #appendEventTypeExplanation(args: { eventType: string }) {
    const explanation = eventTypeExplanation(args.eventType);
    if (explanation == null) return;

    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: AgentProcessorContract,
          key: `event-type-explainer/${args.eventType}`,
        }),
        payload: {
          content: explanation,
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
    });
  }
}

function eventTypeExplanation(eventType: string): string | null {
  if (eventType === "events.iterate.com/agents/user-message-received") {
    return "First `events.iterate.com/agents/user-message-received` event. This represents a message received from a user; the payload origin says whether it came from web or TUI.";
  }
  if (eventType === "events.iterate.com/agents/web-message-sent") {
    return "First `events.iterate.com/agents/web-message-sent` event. This represents a message sent through the web chat response tool.";
  }
  if (eventType === "events.iterate.com/agents/tui-message-sent") {
    return "First `events.iterate.com/agents/tui-message-sent` event. This represents a message sent through the TUI chat response tool.";
  }
  if (eventType === "events.iterate.com/agent/llm-request-cancelled") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "The current LLM request was interrupted by user input.",
    });
  }
  if (eventType === "events.iterate.com/itx/capability-provided") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning:
        "A capability is now available to your scripts. Call it as `itx.<name>.<method>(args)` in a code block. If you're not sure about the shape of a result, just return it and you'll be shown it on your next turn. The event below shows the capability's name and usage instructions.",
    });
  }
  return null;
}

function eventTypeExplanationBlock(args: { type: string; meaning: string }): string {
  return `First \`${args.type}\` event. ${args.meaning}`;
}

function eventBlock(args: {
  offset: number;
  type: string;
  fields?: Record<string, string | number>;
  bodyTag?: string;
  body?: string;
}): string {
  const yamlLines = [
    "event:",
    `  offset: ${args.offset}`,
    `  type: ${yamlScalar(args.type)}`,
    ...Object.entries(args.fields ?? {}).map(([key, value]) => `  ${key}: ${yamlScalar(value)}`),
    ...(args.body == null ? [] : yamlBlockScalar(args.bodyTag ?? "body", args.body)),
  ];
  return ["```yaml", ...yamlLines, "```"].join("\n");
}

function chatEventBlock(args: {
  offset: number;
  type: string;
  fields?: Record<string, string | number>;
  bodyTag: string;
  body: string;
}): string {
  return eventBlock({
    offset: args.offset,
    type: args.type,
    fields: args.fields,
    bodyTag: args.bodyTag,
    body: args.body,
  });
}

function yamlScalar(value: string | number): string {
  if (typeof value === "number") return String(value);
  if (/^[a-zA-Z0-9._/@:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/** Render a multi-line YAML field as a block scalar with the indentation expected by the prompt. */
function yamlBlockScalar(key: string, value: string): string[] {
  return [`  ${key}: |-`, ...value.split("\n").map((line) => `    ${line}`)];
}

/** Human-readable body for the system event that teaches an agent about a newly provided cap. */
function capabilityProvidedEventBlock(args: {
  instructions: string;
  name: string;
  offset: number;
  type: string;
}): string {
  return `Capability available as \`itx.${args.name}\`. ${args.instructions} (to debug further, see ${args.type} event at offset ${args.offset})`;
}

const CODEMODE_FENCE_RE =
  /^```(?:js|javascript|codemode|ts|typescript)\s*\n([\s\S]*?)(?:\n```\s*)?$/;

export function extractCodemodeScript(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith("async (itx) => {") && trimmed.endsWith("}")) {
    return trimmed;
  }
  if (trimmed.startsWith("async () => {") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = CODEMODE_FENCE_RE.exec(trimmed);
  return fenced?.[1]?.trim() || null;
}

function itxCompletionInputBlock(input: {
  event: Extract<AgentConsumedEvent, { type: "events.iterate.com/itx/script-execution-completed" }>;
  logs: string[];
  outcome: { status: "returned"; value: unknown } | { status: "threw"; error: unknown };
}) {
  const executionId = input.event.payload.executionId;
  return [
    "```yaml",
    "event:",
    `  offset: ${input.event.offset}`,
    "  type: events.iterate.com/itx/script-execution-completed",
    `  executionId: ${yamlScalar(executionId)}`,
    "  outcome:",
    `    status: ${input.outcome.status}`,
    ...yamlNestedBlockScalar(
      input.outcome.status === "returned" ? "    value" : "    error",
      formatCodemodeOutput(
        input.outcome.status === "returned" ? input.outcome.value : input.outcome.error,
      ),
    ),
    ...(input.logs.length > 0 ? yamlNestedBlockScalar("  console", input.logs.join("\n")) : []),
    "```",
  ].join("\n");
}

function formatCodemodeOutput(output: unknown) {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2) ?? String(output);
  } catch {
    return String(output);
  }
}

function yamlNestedBlockScalar(key: string, value: string): string[] {
  return [`${key}: |-`, ...value.split("\n").map((line) => `      ${line}`)];
}
