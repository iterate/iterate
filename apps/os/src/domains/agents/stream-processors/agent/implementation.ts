// Implements the "agent" processor as a class-based StreamProcessor.
//
// The Agent processor owns scheduling and model-visible history. It does not
// call an LLM provider directly; it appends `agent/llm-request-requested` and a
// subscribed LLM request processor owes the stream `agent/output-added` plus a
// terminal `agent/llm-request-completed`.
//
// Migrated from packages/shared/src/stream-processors/agent/implementation.ts.
// All appended events keep their legacy types, payload shapes, and
// idempotency-key derivations (`agent/<key>@<sourceOffset>`).

import {
  assertNever,
  buildProcessorIdempotencyKey,
  type StreamEvent,
} from "@iterate-com/streams/shared/stream-processors";
import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import {
  AgentProcessorContract,
  buildLlmChatRequest,
  reduceAgentEvent,
  reduceAgentEvents,
  type AgentConsumedEvent,
  type AgentState,
} from "./contract.ts";

export { AgentProcessorContract } from "./contract.ts";

export type AgentProcessorContract = typeof AgentProcessorContract;

export type AgentProcessorDeps = {
  /**
   * Reads the full committed history of the agent's stream. The debounce-timer
   * handoff rebuilds agent state from durable history at the last possible
   * moment so the provider request reflects the committed stream, not a
   * potentially stale warm reduction (see `#requestScheduledLlmWork`).
   */
  readStreamEvents(): Promise<StreamEvent[]>;
};

type LlmRequestPolicy = Extract<
  AgentConsumedEvent,
  { type: "events.iterate.com/agent/input-added" }
>["payload"]["llmRequestPolicy"];

type ScheduledLlmRequest = {
  requestId: string;
  timer: ReturnType<typeof setTimeout>;
  /** Absent for checkpoints written before scheduledOffset existed; the
   * handoff then resolves the scheduled event from stream history. */
  scheduledEvent?: { offset: number };
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
      case "events.iterate.com/agent/output-added":
      case "events.iterate.com/agent/llm-request-scheduled":
      case "events.iterate.com/agent/status-updated":
      case "events.iterate.com/agent/llm-request-queued":
        return;
      case "events.iterate.com/stream/subscriber-connected": {
        // Scheduler reconciliation. Reduced state says a request should be
        // scheduled; if this instance has no debounce timer armed for it, the
        // timer died with a previous incarnation and nothing else will ever
        // fire it — convert the schedule into a request now. The handoff is
        // keyed off the original scheduled event, so if the dead timer's
        // append did land, this dedups instead of double-requesting.
        if (state.currentRequest?.phase !== "scheduled" || this.#scheduledLlmRequest !== null) {
          return;
        }
        const scheduled = state.currentRequest;
        args.blockProcessorWhile(() =>
          this.#requestLlmWorkForSchedule({
            requestId: scheduled.requestId,
            ...(scheduled.scheduledOffset === undefined
              ? {}
              : { scheduledEvent: { offset: scheduled.scheduledOffset } }),
          }),
        );
        return;
      }
      case "events.iterate.com/agent/capability-noted":
        // Blocking: these context rows must land before the checkpoint so a
        // failed append is retried instead of silently dropped from history.
        args.blockProcessorWhile(async () => {
          await this.#appendEventTypeExplanation({ eventType: event.type });
          await this.#appendRewrite({
            event,
            key: "render-agent-capability-noted",
            content: capabilityNotedEventBlock({
              instructions: event.payload.instructions,
              name: event.payload.name,
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
    this.#armLlmRequestDebounceTimer({
      requestId,
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
    scheduledOffset: number | undefined;
  }) {
    // The durable scheduledOffset is the fallback: after a restart the warm
    // timer is gone but the reduced state still knows which scheduled event
    // this debounce belongs to, so the timer re-arms instead of silently
    // dropping the schedule. (For checkpoints predating scheduledOffset the
    // handoff resolves the scheduled event from history when the timer fires.)
    const scheduledEvent =
      this.#scheduledLlmRequest?.scheduledEvent ??
      (args.scheduledOffset === undefined ? undefined : { offset: args.scheduledOffset });
    this.#cancelScheduledLlmRequest({ requestId: args.requestId });
    this.#armLlmRequestDebounceTimer({
      requestId: args.requestId,
      debounceMs: args.debounceMs,
      ...(scheduledEvent === undefined ? {} : { scheduledEvent }),
    });
  }

  #armLlmRequestDebounceTimer(args: {
    requestId: string;
    debounceMs: number;
    scheduledEvent?: { offset: number };
  }) {
    const timer = setTimeout(() => {
      // The timer fires outside any batch, so the base class's keep-alive-backed
      // background path is the equivalent of the old runner's `waitUntil`.
      this.runInBackground(() => this.#requestScheduledLlmWork({ requestId: args.requestId }));
    }, args.debounceMs);
    this.#scheduledLlmRequest = {
      requestId: args.requestId,
      timer,
      ...(args.scheduledEvent === undefined ? {} : { scheduledEvent: args.scheduledEvent }),
    };
  }

  async #requestScheduledLlmWork(args: { requestId: string }) {
    if (this.#scheduledLlmRequest?.requestId !== args.requestId) return;

    const scheduledEvent = this.#scheduledLlmRequest.scheduledEvent;
    this.#scheduledLlmRequest = null;
    await this.#requestLlmWorkForSchedule({
      requestId: args.requestId,
      ...(scheduledEvent === undefined ? {} : { scheduledEvent }),
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
    scheduledEvent?: { offset: number };
  }) {
    const events = await this.deps.readStreamEvents();
    const stateAtRequest = reduceAgentEvents({ events });

    if (
      stateAtRequest.currentRequest?.phase !== "scheduled" ||
      stateAtRequest.currentRequest.requestId !== args.requestId
    ) {
      return;
    }

    // Checkpoints written before scheduledOffset existed don't know which
    // event the debounce belongs to; recover it from the committed history
    // just read (the scheduled event must be there — reduced state only says
    // "scheduled" because it was committed).
    const scheduledEvent =
      args.scheduledEvent ??
      events.find(
        (event) =>
          event.type === "events.iterate.com/agent/llm-request-scheduled" &&
          (event.payload as { requestId?: string }).requestId === args.requestId,
      );
    if (scheduledEvent === undefined) {
      console.error("[agent] scheduled llm request has no llm-request-scheduled event", {
        requestId: args.requestId,
      });
      return;
    }

    try {
      await this.ctx.stream.append({
        event: {
          type: "events.iterate.com/agent/llm-request-requested",
          idempotencyKey: buildProcessorIdempotencyKey({
            processor: AgentProcessorContract,
            key: "llm-request-requested",
            sourceEvent: scheduledEvent,
          }),
          payload: {
            model: stateAtRequest.llmConfig.model,
            body: buildLlmChatRequest(stateAtRequest),
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
        scheduledEvent: { offset: scheduledEvent.offset },
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
  if (eventType === "events.iterate.com/agent/llm-request-cancelled") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "The current LLM request was interrupted by user input.",
    });
  }
  if (eventType === "events.iterate.com/agent/capability-noted") {
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

function yamlScalar(value: string | number): string {
  if (typeof value === "number") return String(value);
  if (/^[a-zA-Z0-9._/@:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function yamlBlockScalar(key: string, value: string): string[] {
  return [`  ${key}: |-`, ...value.split("\n").map((line) => `    ${line}`)];
}

function capabilityNotedEventBlock(args: {
  instructions: string;
  name: string;
  offset: number;
  type: string;
}): string {
  return `Capability available as \`itx.${args.name}\`. ${args.instructions} (to debug further, see ${args.type} event at offset ${args.offset})`;
}
