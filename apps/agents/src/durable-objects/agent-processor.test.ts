import type { GenericEventInput } from "@iterate-com/events-contract";
import type { Callable } from "@iterate-com/shared/callable/types.ts";
import { describe, expect, test, vi } from "vitest";
import {
  AgentInputAddedEventInput,
  type AgentInputAddedPayload,
  LlmConfigUpdatedEventInput,
  LlmRequestCancelledEventInput,
  LlmRequestCompletedEventInput,
  LlmRequestFailedEventInput,
  LlmRequestQueuedEventInput,
  LlmRequestScheduledEventInput,
  LlmRequestStartedEventInput,
  SystemPromptUpdatedEventInput,
  WebchatMessageReceivedEventInput,
} from "./agent-loop-processor-types.ts";
import { createIterateAgentProcessor } from "./agent-processor.ts";
import type { ProcessorRuntime } from "./agent-processor-shared.ts";
import {
  DebugInfoRequestedEventInput,
  IterateAgentProcessorState,
} from "./agent-processor-types.ts";
import {
  CODEMODE_PRIMER_IDEMPOTENCY_KEY,
  extractCodemodeScriptFromAssistantResponse,
  parseWebchatSendMessageArgs,
} from "./codemode-processor.ts";
import {
  CodemodeResultAddedEventInput,
  ToolProviderConfigUpdatedEventInput,
} from "./codemode-processor-types.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

/**
 * Trigger-behavior unit tests. Exercise the processor in isolation:
 * - `reduce` is pure and tested directly against constructed events.
 * - `afterAppend` is driven through a stub `runtime` whose calls we record
 *   and a stub `append` that captures emitted event inputs.
 *
 * Codemode/MCP are not used by the trigger FSM, so deps are stubbed with the
 * simplest values that satisfy the shape; if any of them get touched the test
 * will throw (we want to know if scheduling logic accidentally pulls them in).
 */

function unreachable<T = never>(name: string): T {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`unexpected access to stub: ${name}`);
      },
    },
  ) as T;
}

function createProcessorForTests() {
  return createIterateAgentProcessor({
    loader: unreachable("loader"),
    outboundFetch: unreachable("outboundFetch"),
    env: unreachable("env"),
  });
}

function durableObjectRpcCallable(args: {
  bindingName: string;
  durableObjectName: string;
  rpcMethod: string;
}): Callable {
  return {
    type: "workers-rpc",
    via: {
      type: "env-binding",
      bindingType: "durable-object-namespace",
      bindingName: args.bindingName,
      durableObject: { name: args.durableObjectName },
    },
    rpcMethod: args.rpcMethod,
    argsMode: "object",
  };
}

function serviceFetchCallable(bindingName: string): Callable {
  return {
    type: "fetch",
    via: {
      type: "env-binding",
      bindingType: "service",
      bindingName,
    },
  };
}

/** Skip primer emission in `afterAppend` — for agent-loop-only assertions. */
function stateWithPrimerAlreadyApplied(
  processor: ReturnType<typeof createProcessorForTests>,
): IterateAgentProcessorState {
  return IterateAgentProcessorState.parse({
    ...processor.initialState,
    hasAppendedCodemodePrompt: true,
  });
}

/**
 * In-memory ledger of runtime calls + a single inflight slot. Mirrors the DO
 * surface area we expose to the processor (see `ProcessorRuntime`) without
 * actually firing any LLM call. The `initialInflightStatus` knob lets tests
 * pin the slot to either `scheduled` (debounce arming) or `running` (`ai.run`
 * in flight) to exercise different branches of `handleUserInput`.
 */
function createTestRuntime(opts?: {
  initialInflightId?: string | null;
  initialInflightStatus?: "scheduled" | "running";
}) {
  let inflight: { requestId: string; status: "scheduled" | "running" } | null =
    opts?.initialInflightId
      ? { requestId: opts.initialInflightId, status: opts.initialInflightStatus ?? "running" }
      : null;
  let nextSeq = 0;
  const calls: Array<
    | { kind: "schedule"; requestId: string; debounceMs: number }
    | { kind: "extend"; requestId: string; debounceMs: number }
    | { kind: "cancel"; requestId: string }
    | { kind: "armCancelDeadline"; requestId: string; withinMs: number }
  > = [];
  const runtime: ProcessorRuntime = {
    inflight: () => inflight,
    scheduleLlmRequest: ({ debounceMs }) => {
      nextSeq += 1;
      const requestId = `req_${nextSeq}`;
      inflight = { requestId, status: "scheduled" };
      calls.push({ kind: "schedule", requestId, debounceMs });
      return { requestId };
    },
    extendDebounce: ({ requestId, debounceMs }) => {
      calls.push({ kind: "extend", requestId, debounceMs });
    },
    cancelLlmRequest: ({ requestId }) => {
      calls.push({ kind: "cancel", requestId });
      if (inflight?.requestId === requestId) inflight = null;
    },
    armCancelDeadline: ({ requestId, withinMs }) => {
      // We only record the call. The real runtime fires the deadline on a
      // setTimeout and emits `llm-request-cancelled` itself; that path is
      // exercised by the `llm-request-cancelled` afterAppend tests below.
      calls.push({ kind: "armCancelDeadline", requestId, withinMs });
    },
  };
  return { runtime, calls, inflight: () => inflight };
}

let nextOffset = 0;
/** Shape an `EventInput` into the `Event` envelope `match()` expects. */
function asEvent<T extends { type: string; payload: object }>(input: T) {
  nextOffset += 1;
  return {
    ...input,
    streamPath: "/test",
    offset: nextOffset,
    createdAt: "2024-01-01T00:00:00.000Z",
  };
}

async function runAfterAppend(args: {
  processor: ReturnType<typeof createProcessorForTests>;
  event: ReturnType<typeof asEvent>;
  state: IterateAgentProcessorState;
  runtime: ProcessorRuntime;
  /**
   * Mimics the events `append` idempotency table across `afterAppend` invocations
   * (e.g. two inbound events before the primer has round-tripped into state).
   */
  idempotencySeenForAppend?: Set<string>;
}) {
  const appended: Array<GenericEventInput> = [];
  const idempotencySeen = args.idempotencySeenForAppend ?? new Set<string>();
  await args.processor.afterAppend({
    event: args.event,
    state: args.state,
    runtime: args.runtime,
    append: ({ event }) => {
      const key = (event as { idempotencyKey?: string }).idempotencyKey;
      if (key != null) {
        if (idempotencySeen.has(key)) return;
        idempotencySeen.add(key);
      }
      appended.push(event as GenericEventInput);
    },
  });
  return { appended };
}

describe("agent-processor / reduce", () => {
  test("agent-input-added reduces to history without triggerLlmRequest", () => {
    const processor = createProcessorForTests();
    const event = asEvent(
      AgentInputAddedEventInput.parse({
        type: "agent-input-added",
        payload: {
          role: "user",
          content: "hi",
          triggerLlmRequest: { behaviour: "interrupt-current-request" },
        },
      }),
    );
    const next = processor.reduce({ state: processor.initialState, event });
    expect(next?.history).toEqual([{ role: "user", content: "hi" }]);
    // The trigger knob must not leak into the persisted history item.
    expect(next?.history[0]).not.toHaveProperty("triggerLlmRequest");
  });

  test("codemode prompt append records history and flips codemode prompt state by idempotency key", () => {
    const processor = createProcessorForTests();
    const first = asEvent(
      AgentInputAddedEventInput.parse({
        type: "agent-input-added",
        idempotencyKey: CODEMODE_PRIMER_IDEMPOTENCY_KEY,
        payload: {
          role: "user",
          content: "primer body",
          triggerLlmRequest: { behaviour: "dont-trigger-request" },
        },
      }),
    );
    const s = processor.reduce({ state: processor.initialState, event: first })!;
    expect(s.history).toHaveLength(1);
    expect(s.hasAppendedCodemodePrompt).toBe(true);
    expect(s.history[0]?.content).toBe("primer body");
  });

  test("llm-request-scheduled sets currentRequest and clears pendingTriggerCount", () => {
    const processor = createProcessorForTests();
    const queued = processor.reduce({
      state: processor.initialState,
      event: asEvent(LlmRequestQueuedEventInput.parse({ type: "llm-request-queued", payload: {} })),
    });
    expect(queued?.pendingTriggerCount).toBe(1);
    const scheduled = processor.reduce({
      state: queued ?? processor.initialState,
      event: asEvent(
        LlmRequestScheduledEventInput.parse({
          type: "llm-request-scheduled",
          payload: { requestId: "req_1", debounceMs: 1000, model: "@cf/moonshotai/kimi-k2.5" },
        }),
      ),
    });
    expect(scheduled?.currentRequest).toEqual({ requestId: "req_1" });
    expect(scheduled?.pendingTriggerCount).toBe(0);
  });

  test("llm-request-started after scheduled does NOT clear pendingTriggerCount", () => {
    // `pendingTriggerCount` lives across the `scheduled → started` window so
    // that triggers arriving while the debounce timer is arming + while
    // `ai.run` is starting are not silently dropped.
    const processor = createProcessorForTests();
    let s = processor.reduce({
      state: processor.initialState,
      event: asEvent(
        LlmRequestScheduledEventInput.parse({
          type: "llm-request-scheduled",
          payload: { requestId: "req_1", debounceMs: 1000, model: "@cf/moonshotai/kimi-k2.5" },
        }),
      ),
    })!;
    s = processor.reduce({
      state: s,
      event: asEvent(LlmRequestQueuedEventInput.parse({ type: "llm-request-queued", payload: {} })),
    })!;
    expect(s.pendingTriggerCount).toBe(1);
    s = processor.reduce({
      state: s,
      event: asEvent(
        LlmRequestStartedEventInput.parse({
          type: "llm-request-started",
          payload: {
            requestId: "req_1",
            model: "@cf/moonshotai/kimi-k2.5",
            body: { messages: [{ role: "user", content: "hi" }] },
            runOpts: {},
          },
        }),
      ),
    })!;
    expect(s.currentRequest).toEqual({ requestId: "req_1" });
    expect(s.pendingTriggerCount).toBe(1);
  });

  test("llm-request-completed clears matching currentRequest", () => {
    const processor = createProcessorForTests();
    let s = processor.reduce({
      state: processor.initialState,
      event: asEvent(
        LlmRequestScheduledEventInput.parse({
          type: "llm-request-scheduled",
          payload: { requestId: "req_1", debounceMs: 1000, model: "@cf/moonshotai/kimi-k2.5" },
        }),
      ),
    })!;
    s = processor.reduce({
      state: s,
      event: asEvent(
        LlmRequestCompletedEventInput.parse({
          type: "llm-request-completed",
          payload: { requestId: "req_1", rawResponse: { response: "ok" }, durationMs: 12 },
        }),
      ),
    })!;
    expect(s.currentRequest).toBeNull();
  });

  test("llm-request-failed clears matching currentRequest", () => {
    const processor = createProcessorForTests();
    let s = processor.reduce({
      state: processor.initialState,
      event: asEvent(
        LlmRequestScheduledEventInput.parse({
          type: "llm-request-scheduled",
          payload: { requestId: "req_1", debounceMs: 1000, model: "@cf/moonshotai/kimi-k2.5" },
        }),
      ),
    })!;
    s = processor.reduce({
      state: s,
      event: asEvent(
        LlmRequestFailedEventInput.parse({
          type: "llm-request-failed",
          payload: { requestId: "req_1", durationMs: 25, error: { message: "boom" } },
        }),
      ),
    })!;
    expect(s.currentRequest).toBeNull();
  });

  test("tool-provider-config-updated upserts and null-deletes by slug", () => {
    const processor = createProcessorForTests();
    const exec = durableObjectRpcCallable({
      bindingName: "MCP_CLIENT",
      durableObjectName: "cloudflare-docs",
      rpcMethod: "callTool",
    });
    const types = durableObjectRpcCallable({
      bindingName: "MCP_CLIENT",
      durableObjectName: "cloudflare-docs",
      rpcMethod: "getTypes",
    });
    const upserted = processor.reduce({
      state: processor.initialState,
      event: asEvent(
        ToolProviderConfigUpdatedEventInput.parse({
          type: "tool-provider-config-updated",
          payload: { slug: "mcp", executeCallable: exec, getTypesCallable: types },
        }),
      ),
    });
    expect(upserted?.toolProviders).toEqual({
      mcp: { executeCallable: exec, getTypesCallable: types },
    });

    const deleted = processor.reduce({
      state: upserted ?? processor.initialState,
      event: asEvent(
        ToolProviderConfigUpdatedEventInput.parse({
          type: "tool-provider-config-updated",
          payload: { slug: "mcp", executeCallable: null },
        }),
      ),
    });
    expect(deleted?.toolProviders).toEqual({});
  });

  test("llm-request-cancelled with a non-matching id does not clear currentRequest", () => {
    const processor = createProcessorForTests();
    const s = processor.reduce({
      state: processor.initialState,
      event: asEvent(
        LlmRequestScheduledEventInput.parse({
          type: "llm-request-scheduled",
          payload: { requestId: "req_1", debounceMs: 1000, model: "@cf/moonshotai/kimi-k2.5" },
        }),
      ),
    })!;
    const after = processor.reduce({
      state: s,
      event: asEvent(
        LlmRequestCancelledEventInput.parse({
          type: "llm-request-cancelled",
          payload: { requestId: "req_other", reason: "interrupted-by-user-input" },
        }),
      ),
    });
    // The cancel was for a different request id, so currentRequest must
    // remain pinned to req_1.
    expect(after?.currentRequest).toEqual({ requestId: "req_1" });
  });
});

describe("agent-processor / afterAppend trigger matrix", () => {
  test("webchat-message-received renders into triggerable model context", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        WebchatMessageReceivedEventInput.parse({
          type: "webchat-message-received",
          payload: { content: "please help" },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([]);
    expect(appended).toHaveLength(2);
    expect(appended[0]).toMatchObject({
      type: "agent-input-added",
      idempotencyKey: "iterate-agent:event-type-explainer:webchat-message-received",
      payload: {
        role: "user",
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
        content: expect.stringContaining("First `webchat-message-received` event."),
      },
    });
    expect(appended[1]).toMatchObject({
      type: "agent-input-added",
      payload: {
        role: "user",
        triggerLlmRequest: { behaviour: "auto" },
        content: expect.stringContaining("type: webchat-message-received"),
      },
    });
  });

  test("dont-trigger-request never starts a request", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: {
            role: "user",
            content: "context only",
            triggerLlmRequest: { behaviour: "dont-trigger-request" },
          },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([]);
    expect(appended).toEqual([]);
  });

  test("auto resolves to dont-trigger-request for assistant role", async () => {
    // Default behaviour for omitted `triggerLlmRequest` is `auto`. Assistant
    // turns are processor-emitted and must never re-trigger.
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: { role: "assistant", content: "hello world" },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([]);
    expect(appended).toEqual([]);
  });

  test("auto resolves to interrupt-current-request for user role with no inflight", async () => {
    // `auto` is the default — omitting `triggerLlmRequest` for a user
    // message should kick off a fresh request just like the explicit form.
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: { role: "user", content: "hi" },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([{ kind: "schedule", requestId: "req_1", debounceMs: 1000 }]);
    expect(appended.map((e) => e.type)).toEqual(["llm-request-scheduled"]);
  });

  test("user interrupt-current-request with no inflight schedules a fresh request", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: {
            role: "user",
            content: "hi",
            triggerLlmRequest: { behaviour: "interrupt-current-request" },
          },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([{ kind: "schedule", requestId: "req_1", debounceMs: 1000 }]);
    expect(appended.map((e) => e.type)).toEqual(["llm-request-scheduled"]);
    expect(appended[0]).toMatchObject({
      type: "llm-request-scheduled",
      payload: { requestId: "req_1", debounceMs: 1000 },
    });
  });

  test("user interrupt-current-request with running request cancels then schedules a new one", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime({
      initialInflightId: "req_existing",
      initialInflightStatus: "running",
    });
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: {
            role: "user",
            content: "redo",
            triggerLlmRequest: { behaviour: "interrupt-current-request" },
          },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([
      { kind: "cancel", requestId: "req_existing" },
      { kind: "schedule", requestId: "req_1", debounceMs: 1000 },
    ]);
    expect(appended.map((e) => e.type)).toEqual(["llm-request-cancelled", "llm-request-scheduled"]);
    expect(appended[0]).toMatchObject({
      type: "llm-request-cancelled",
      payload: { requestId: "req_existing", reason: "interrupted-by-user-input" },
    });
  });

  test("user interrupt-current-request during debounce extends the debounce timer (no events emitted)", async () => {
    // True debounce semantics: each new input pushes the timer out so the
    // LLM fires `debounceMs` after the *last* message in a burst, not the
    // first. No cancel/restart churn, no rewrites, no extra wire-log
    // events — typing fast must just delay the request.
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime({
      initialInflightId: "req_existing",
      initialInflightStatus: "scheduled",
    });
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: {
            role: "user",
            content: "and another",
            triggerLlmRequest: { behaviour: "interrupt-current-request" },
          },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([{ kind: "extend", requestId: "req_existing", debounceMs: 1000 }]);
    expect(appended).toEqual([]);
  });

  test("user after-current-request with no inflight schedules immediately", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: {
            role: "user",
            content: "hi",
            triggerLlmRequest: { behaviour: "after-current-request" },
          },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([{ kind: "schedule", requestId: "req_1", debounceMs: 1000 }]);
    expect(appended.map((e) => e.type)).toEqual(["llm-request-scheduled"]);
  });

  test("user after-current-request while a request is running queues instead of scheduling", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime({
      initialInflightId: "req_existing",
      initialInflightStatus: "running",
    });
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: {
            role: "user",
            content: "queued",
            triggerLlmRequest: { behaviour: "after-current-request" },
          },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([]);
    expect(appended.map((e) => e.type)).toEqual(["llm-request-queued"]);
  });

  test("llm-request-queued renders a model-visible trace row", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(LlmRequestQueuedEventInput.parse({ type: "llm-request-queued", payload: {} })),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([]);
    expect(appended).toHaveLength(2);
    expect(appended[0]).toMatchObject({
      type: "agent-input-added",
      idempotencyKey: "iterate-agent:event-type-explainer:llm-request-queued",
    });
    expect(appended[1]).toMatchObject({
      type: "agent-input-added",
      payload: {
        role: "user",
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
        content: expect.stringContaining("type: llm-request-queued"),
      },
    });
  });

  test("llm-request-started marks the agent as working", async () => {
    const processor = createProcessorForTests();
    const { runtime } = createTestRuntime({ initialInflightId: "req_existing" });
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        LlmRequestStartedEventInput.parse({
          type: "llm-request-started",
          payload: {
            requestId: "req_existing",
            model: "@cf/moonshotai/kimi-k2.5",
            body: { messages: [{ role: "user", content: "hello" }] },
            runOpts: {},
          },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });

    expect(appended.at(-1)).toMatchObject({
      type: "agent-status-updated",
      payload: {
        status: "working",
        reason: "llm-request-started",
        requestId: "req_existing",
      },
    });
  });

  test("user after-current-request while a request is debouncing queues a follow-up request", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime({
      initialInflightId: "req_existing",
      initialInflightStatus: "scheduled",
    });
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: {
            role: "user",
            content: "later",
            triggerLlmRequest: { behaviour: "after-current-request" },
          },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([]);
    expect(appended.map((e) => e.type)).toEqual(["llm-request-queued"]);
  });

  test("user trigger-request-within-time-period with running request queues + arms cancel deadline", async () => {
    // The behaviour-specific `withinMs` is plumbed through to
    // `armCancelDeadline`. The runtime is responsible for firing the
    // deadline timer; this test only verifies the wire-up.
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime({
      initialInflightId: "req_existing",
      initialInflightStatus: "running",
    });
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: {
            role: "user",
            content: "patient",
            triggerLlmRequest: {
              behaviour: "trigger-request-within-time-period",
              withinMs: 5000,
            },
          },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([
      { kind: "armCancelDeadline", requestId: "req_existing", withinMs: 5000 },
    ]);
    expect(appended.map((e) => e.type)).toEqual(["llm-request-queued"]);
  });

  test("user trigger-request-within-time-period with no inflight schedules immediately", async () => {
    // No inflight to wait on, so `withinMs` is irrelevant — same as any
    // other triggering behaviour with no inflight.
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: {
            role: "user",
            content: "patient",
            triggerLlmRequest: {
              behaviour: "trigger-request-within-time-period",
              withinMs: 5000,
            },
          },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([{ kind: "schedule", requestId: "req_1", debounceMs: 1000 }]);
    expect(appended.map((e) => e.type)).toEqual(["llm-request-scheduled"]);
  });

  test("user trigger-request-within-time-period during debounce queues and arms cancel deadline", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime({
      initialInflightId: "req_existing",
      initialInflightStatus: "scheduled",
    });
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        AgentInputAddedEventInput.parse({
          type: "agent-input-added",
          payload: {
            role: "user",
            content: "patient",
            triggerLlmRequest: {
              behaviour: "trigger-request-within-time-period",
              withinMs: 5000,
            },
          },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });
    expect(calls).toEqual([
      { kind: "armCancelDeadline", requestId: "req_existing", withinMs: 5000 },
    ]);
    expect(appended.map((e) => e.type)).toEqual(["llm-request-queued"]);
  });

  test("llm-request-completed with pendingTriggerCount > 0 renders completion event then schedules", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    // State reflects that req_existing just completed (currentRequest cleared
    // by the reducer for this event) and there are two queued triggers.
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        LlmRequestCompletedEventInput.parse({
          type: "llm-request-completed",
          payload: {
            requestId: "req_existing",
            rawResponse: { response: "done" },
            durationMs: 42,
          },
        }),
      ),
      state: {
        ...stateWithPrimerAlreadyApplied(processor),
        pendingTriggerCount: 2,
        currentRequest: null,
      },
      runtime,
    });
    expect(calls).toEqual([{ kind: "schedule", requestId: "req_1", debounceMs: 1000 }]);
    expect(appended.map((e) => e.type)).toEqual([
      "agent-input-added",
      "agent-input-added",
      "llm-request-scheduled",
    ]);
    expect(appended[1]).toMatchObject({
      type: "agent-input-added",
      payload: {
        role: "user",
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
        content: expect.stringContaining("type: llm-request-completed"),
      },
    });
  });

  test("llm-request-completed with no pending trigger still renders the event for model context", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        LlmRequestCompletedEventInput.parse({
          type: "llm-request-completed",
          payload: {
            requestId: "req_existing",
            rawResponse: { response: "done" },
            durationMs: 42,
          },
        }),
      ),
      state: { ...stateWithPrimerAlreadyApplied(processor), pendingTriggerCount: 0 },
      runtime,
    });
    expect(calls).toEqual([]);
    expect(appended.map((e) => e.type)).toEqual([
      "agent-input-added",
      "agent-input-added",
      "agent-status-updated",
    ]);
    expect(appended[1]).toMatchObject({
      type: "agent-input-added",
      payload: {
        role: "user",
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
        content: expect.stringContaining("durationMs: 42"),
      },
    });
  });

  test("llm-request-cancelled with pendingTriggerCount > 0 renders cancel event + schedules follow-up", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        LlmRequestCancelledEventInput.parse({
          type: "llm-request-cancelled",
          payload: { requestId: "req_existing", reason: "interrupted-by-user-input" },
        }),
      ),
      state: { ...stateWithPrimerAlreadyApplied(processor), pendingTriggerCount: 1 },
      runtime,
    });
    expect(calls).toEqual([{ kind: "schedule", requestId: "req_1", debounceMs: 1000 }]);
    expect(appended.map((e) => e.type)).toEqual([
      "agent-input-added", // event type explainer
      "agent-input-added", // rendered cancellation event
      "llm-request-scheduled",
    ]);
    expect(appended[1]).toMatchObject({
      type: "agent-input-added",
      payload: { role: "user", content: expect.stringContaining("type: llm-request-cancelled") },
    });
  });

  test("llm-request-cancelled without pending trigger still renders the event for model context", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        LlmRequestCancelledEventInput.parse({
          type: "llm-request-cancelled",
          payload: { requestId: "req_existing", reason: "interrupted-by-user-input" },
        }),
      ),
      state: { ...stateWithPrimerAlreadyApplied(processor), pendingTriggerCount: 0 },
      runtime,
    });
    expect(calls).toEqual([]);
    expect(appended.map((e) => e.type)).toEqual([
      "agent-input-added",
      "agent-input-added",
      "agent-status-updated",
    ]);
    expect(appended[1]).toMatchObject({
      type: "agent-input-added",
      payload: { role: "user", triggerLlmRequest: { behaviour: "dont-trigger-request" } },
    });
    expect(appended[2]).toMatchObject({
      type: "agent-status-updated",
      payload: {
        status: "idle",
        reason: "llm-request-cancelled",
        requestId: "req_existing",
      },
    });
  });

  test("llm-request-cancelled with deadline-exceeded reason renders event + schedules queued follow-up", async () => {
    // When `trigger-request-within-time-period`'s deadline elapses, the
    // runtime emits `llm-request-cancelled` with `deadline-exceeded`. The
    // processor should annotate with a deadline-specific phrase and use
    // the queued trigger from `pendingTriggerCount` to schedule a fresh
    // request — the entire point of the time-period behaviour.
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        LlmRequestCancelledEventInput.parse({
          type: "llm-request-cancelled",
          payload: { requestId: "req_existing", reason: "deadline-exceeded" },
        }),
      ),
      state: { ...stateWithPrimerAlreadyApplied(processor), pendingTriggerCount: 1 },
      runtime,
    });
    expect(calls).toEqual([{ kind: "schedule", requestId: "req_1", debounceMs: 1000 }]);
    expect(appended.map((e) => e.type)).toEqual([
      "agent-input-added", // event type explainer
      "agent-input-added", // rendered deadline-exceeded cancellation event
      "llm-request-scheduled",
    ]);
    expect(appended[1]).toMatchObject({
      type: "agent-input-added",
      payload: { role: "user", content: expect.stringContaining("reason: deadline-exceeded") },
    });
  });

  test("llm-request-failed renders failure event and schedules queued follow-up", async () => {
    const processor = createProcessorForTests();
    const { runtime, calls } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        LlmRequestFailedEventInput.parse({
          type: "llm-request-failed",
          payload: {
            requestId: "req_existing",
            durationMs: 12,
            error: { message: "provider exploded" },
          },
        }),
      ),
      state: { ...stateWithPrimerAlreadyApplied(processor), pendingTriggerCount: 1 },
      runtime,
    });
    expect(calls).toEqual([{ kind: "schedule", requestId: "req_1", debounceMs: 1000 }]);
    expect(appended.map((e) => e.type)).toEqual([
      "agent-input-added",
      "agent-input-added",
      "llm-request-scheduled",
    ]);
    expect(appended[1]).toMatchObject({
      type: "agent-input-added",
      payload: {
        role: "user",
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
        content: expect.stringContaining('error: "provider exploded"'),
      },
    });
  });

  test("debug-info-requested round-trips state + runtime view as a debug-info-returned event", async () => {
    const processor = createProcessorForTests();
    const { runtime } = createTestRuntime({
      initialInflightId: "req_existing",
      initialInflightStatus: "running",
    });
    const stateWithStuff: IterateAgentProcessorState = {
      ...stateWithPrimerAlreadyApplied(processor),
      systemPrompt: "be helpful",
      history: [{ role: "user", content: "hi" }],
      pendingTriggerCount: 1,
      currentRequest: { requestId: "req_existing" },
    };
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        DebugInfoRequestedEventInput.parse({ type: "debug-info-requested", payload: {} }),
      ),
      state: stateWithStuff,
      runtime,
    });
    expect(appended.map((e) => e.type)).toEqual(["debug-info-returned"]);
    expect(appended[0]).toMatchObject({
      type: "debug-info-returned",
      payload: {
        state: { systemPrompt: "be helpful", pendingTriggerCount: 1 },
        runtime: { inflightRequestId: "req_existing" },
      },
    });
  });
});

describe("agent-processor / codemode primer + provider explainer", () => {
  test.each([
    ["raw async arrow", "async () => {\n  return 1;\n}", "async () => {\n  return 1;\n}"],
    ["js fence", "```js\nasync () => {\n  return 2;\n}\n```", "async () => {\n  return 2;\n}"],
    [
      "javascript fence",
      "```javascript\nasync () => {\n  return 3;\n}\n```",
      "async () => {\n  return 3;\n}",
    ],
    [
      "codemode fence",
      "```codemode\nasync () => {\n  return 4;\n}\n```",
      "async () => {\n  return 4;\n}",
    ],
    ["ts fence", "```ts\nasync () => {\n  return 5;\n}\n```", "async () => {\n  return 5;\n}"],
    [
      "typescript fence",
      "```typescript\nasync () => {\n  return 6;\n}\n```",
      "async () => {\n  return 6;\n}",
    ],
  ])("extracts codemode script from assistant response: %s", (_label, content, expected) => {
    expect(extractCodemodeScriptFromAssistantResponse(content)).toBe(expected);
  });

  test("webchat provider accepts codemode's positional tool argument array", () => {
    expect(parseWebchatSendMessageArgs([{ message: "hello" }])).toEqual({ message: "hello" });
    expect(parseWebchatSendMessageArgs({ message: "hello" })).toEqual({ message: "hello" });
  });

  test("assistant codemode response appends codemode-block-added", async () => {
    const processor = createProcessorForTests();
    const { runtime } = createTestRuntime();
    const assistantEvent = asEvent(
      AgentInputAddedEventInput.parse({
        type: "agent-input-added",
        payload: {
          role: "assistant",
          content: "```js\nasync () => {\n  return await builtin.answer();\n}\n```",
          triggerLlmRequest: { behaviour: "dont-trigger-request" },
        },
      }),
    );
    const reduced =
      processor.reduce({
        state: stateWithPrimerAlreadyApplied(processor),
        event: assistantEvent,
      }) ?? stateWithPrimerAlreadyApplied(processor);

    const { appended } = await runAfterAppend({
      processor,
      event: assistantEvent,
      state: reduced,
      runtime,
    });

    expect(appended).toContainEqual({
      type: "codemode-block-added",
      payload: { script: "async () => {\n  return await builtin.answer();\n}" },
    });
  });

  test("codemode-result-added marks the agent idle when no follow-up is queued", async () => {
    const processor = createProcessorForTests();
    const { runtime } = createTestRuntime();
    const { appended } = await runAfterAppend({
      processor,
      event: asEvent(
        CodemodeResultAddedEventInput.parse({
          type: "codemode-result-added",
          payload: { result: { ok: true }, durationMs: 12, logs: [] },
        }),
      ),
      state: stateWithPrimerAlreadyApplied(processor),
      runtime,
    });

    expect(appended[0]).toMatchObject({
      type: "agent-status-updated",
      payload: { status: "idle", reason: "codemode-result-added" },
    });
  });

  test("two preset-like inbound events before primer echoes: same idempotency key → one primer append", async () => {
    const processor = createProcessorForTests();
    const { runtime } = createTestRuntime();
    const idempotencySeen = new Set<string>();
    const systemPromptEvent = asEvent(
      SystemPromptUpdatedEventInput.parse({
        type: "system-prompt-updated",
        payload: { systemPrompt: "be helpful" },
      }),
    );
    let state =
      processor.reduce({ state: processor.initialState, event: systemPromptEvent }) ??
      processor.initialState;
    const { appended: firstAppend } = await runAfterAppend({
      processor,
      event: systemPromptEvent,
      state,
      runtime,
      idempotencySeenForAppend: idempotencySeen,
    });
    const llmEvent = asEvent(
      LlmConfigUpdatedEventInput.parse({
        type: "llm-config-updated",
        payload: { model: "@cf/moonshotai/kimi-k2.5", runOpts: {} },
      }),
    );
    state = processor.reduce({ state, event: llmEvent }) ?? state;
    const { appended: secondAppend } = await runAfterAppend({
      processor,
      event: llmEvent,
      state,
      runtime,
      idempotencySeenForAppend: idempotencySeen,
    });

    const primerRows = [...firstAppend, ...secondAppend].filter(
      (e) =>
        e.type === "agent-input-added" &&
        (e as { idempotencyKey?: string }).idempotencyKey === CODEMODE_PRIMER_IDEMPOTENCY_KEY,
    );
    expect(primerRows).toHaveLength(1);
  });

  test("first afterAppend emits codemode primer; second turn does not re-emit", async () => {
    const processor = createProcessorForTests();
    const { runtime } = createTestRuntime();
    const event = asEvent(
      SystemPromptUpdatedEventInput.parse({
        type: "system-prompt-updated",
        payload: { systemPrompt: "be helpful" },
      }),
    );
    const reduced = processor.reduce({ state: processor.initialState, event })!;
    const { appended } = await runAfterAppend({ processor, event, state: reduced, runtime });
    expect(appended[0]).toMatchObject({
      type: "agent-input-added",
      idempotencyKey: CODEMODE_PRIMER_IDEMPOTENCY_KEY,
      payload: {
        role: "user",
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    });
    expect((appended[0] as { payload: { content: string } }).payload.content).toContain("codemode");

    const primerEvent = asEvent(
      AgentInputAddedEventInput.parse({
        type: "agent-input-added",
        idempotencyKey: CODEMODE_PRIMER_IDEMPOTENCY_KEY,
        payload: (appended[0] as { payload: AgentInputAddedPayload }).payload,
      }),
    );
    const stateAfterPrimer = processor.reduce({ state: reduced, event: primerEvent })!;
    expect(stateAfterPrimer.hasAppendedCodemodePrompt).toBe(true);

    const userEvent = asEvent(
      AgentInputAddedEventInput.parse({
        type: "agent-input-added",
        payload: { role: "user", content: "hi" },
      }),
    );
    const reducedUser = processor.reduce({ state: stateAfterPrimer, event: userEvent })!;
    const { appended: second } = await runAfterAppend({
      processor,
      event: userEvent,
      state: reducedUser,
      runtime,
    });
    const primerAgain = second.some(
      (e) =>
        e.type === "agent-input-added" &&
        (e as { idempotencyKey?: string }).idempotencyKey === CODEMODE_PRIMER_IDEMPOTENCY_KEY,
    );
    expect(primerAgain).toBe(false);
  });

  test("tool-provider-config-updated upsert without getTypesCallable says the API surface is missing", async () => {
    const processor = createProcessorForTests();
    const { runtime } = createTestRuntime();
    const exec = durableObjectRpcCallable({
      bindingName: "MCP_CLIENT",
      durableObjectName: "cloudflare-docs",
      rpcMethod: "callTool",
    });
    const upsert = asEvent(
      ToolProviderConfigUpdatedEventInput.parse({
        type: "tool-provider-config-updated",
        payload: { slug: "mcp", executeCallable: exec },
      }),
    );
    const reduced = processor.reduce({
      state: stateWithPrimerAlreadyApplied(processor),
      event: upsert,
    })!;
    const { appended } = await runAfterAppend({
      processor,
      event: upsert,
      state: reduced,
      runtime,
    });
    const explainer = appended.find((e) => e.type === "agent-input-added");
    expect(explainer).toBeDefined();
    const content = (explainer as { payload: { content: string } }).payload.content;
    expect(content).toContain("Tool provider `mcp`");
    expect(content).toContain("`mcp.<tool>(...)`");
    expect(content).toContain("No generated API surface was attached");
  });

  test("tool-provider-config-updated upsert with getTypesCallable includes resolved types in explainer", async () => {
    const mockTypesService = {
      fetch: vi.fn(async () => {
        return new Response(JSON.stringify({ types: "declare const demoNs: { ping(): string }" }), {
          headers: { "content-type": "application/json" },
        });
      }),
    } as unknown as Fetcher;
    const mockExecService = {
      fetch: vi.fn(async () => {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }),
    } as unknown as Fetcher;
    const processor = createIterateAgentProcessor({
      loader: unreachable("loader"),
      outboundFetch: unreachable("outboundFetch"),
      env: {
        MOCK_TYPES: mockTypesService,
        MOCK_EXEC: mockExecService,
      } as CloudflareEnv,
    });
    const { runtime } = createTestRuntime();
    const getTypesCallable = serviceFetchCallable("MOCK_TYPES");
    const executeCallable = serviceFetchCallable("MOCK_EXEC");
    const upsert = asEvent(
      ToolProviderConfigUpdatedEventInput.parse({
        type: "tool-provider-config-updated",
        payload: { slug: "demoNs", executeCallable, getTypesCallable },
      }),
    );
    const reduced = processor.reduce({
      state: stateWithPrimerAlreadyApplied(processor),
      event: upsert,
    })!;
    const { appended } = await runAfterAppend({
      processor,
      event: upsert,
      state: reduced,
      runtime,
    });
    const explainer = appended.find((e) => e.type === "agent-input-added");
    expect(explainer).toBeDefined();
    const content = (explainer as { payload: { content: string } }).payload.content;
    expect(content).toContain("Complete generated API surface for `demoNs`");
    expect(content).toContain("```ts\ndeclare const demoNs: { ping(): string }\n```");
    expect(mockTypesService.fetch).toHaveBeenCalled();
  });

  test("tool-provider-config-updated upsert when getTypesCallable fails explains the type-loading failure", async () => {
    const throwingTypes = {
      fetch: vi.fn(() => Promise.reject(new Error("boom"))),
    } as unknown as Fetcher;
    const mockExecService = {
      fetch: vi.fn(async () => {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }),
    } as unknown as Fetcher;
    const processor = createIterateAgentProcessor({
      loader: unreachable("loader"),
      outboundFetch: unreachable("outboundFetch"),
      env: {
        MOCK_TYPES: throwingTypes,
        MOCK_EXEC: mockExecService,
      } as CloudflareEnv,
    });
    const { runtime } = createTestRuntime();
    const getTypesCallable = serviceFetchCallable("MOCK_TYPES");
    const executeCallable = serviceFetchCallable("MOCK_EXEC");
    const upsert = asEvent(
      ToolProviderConfigUpdatedEventInput.parse({
        type: "tool-provider-config-updated",
        payload: { slug: "mcp", executeCallable, getTypesCallable },
      }),
    );
    const reduced = processor.reduce({
      state: stateWithPrimerAlreadyApplied(processor),
      event: upsert,
    })!;
    const { appended } = await runAfterAppend({
      processor,
      event: upsert,
      state: reduced,
      runtime,
    });
    const explainer = appended.find((e) => e.type === "agent-input-added");
    expect(explainer).toBeDefined();
    const content = (explainer as { payload: { content: string } }).payload.content;
    expect(content).toContain("Tool provider `mcp`");
    expect(content).toContain("Failed to load the generated API surface for `mcp`: boom");
    expect(content).not.toContain("declare const");
  });

  test("tool-provider-config-updated delete does not emit provider explainer", async () => {
    const processor = createProcessorForTests();
    const { runtime } = createTestRuntime();
    const exec = durableObjectRpcCallable({
      bindingName: "MCP_CLIENT",
      durableObjectName: "cloudflare-docs",
      rpcMethod: "callTool",
    });
    let s = processor.reduce({
      state: stateWithPrimerAlreadyApplied(processor),
      event: asEvent(
        ToolProviderConfigUpdatedEventInput.parse({
          type: "tool-provider-config-updated",
          payload: { slug: "mcp", executeCallable: exec },
        }),
      ),
    })!;
    const deleteEvent = asEvent(
      ToolProviderConfigUpdatedEventInput.parse({
        type: "tool-provider-config-updated",
        payload: { slug: "mcp", executeCallable: null },
      }),
    );
    s = processor.reduce({ state: s, event: deleteEvent })!;
    const { appended } = await runAfterAppend({
      processor,
      event: deleteEvent,
      state: s,
      runtime,
    });
    expect(appended.filter((e) => e.type === "agent-input-added")).toEqual([]);
  });
});
