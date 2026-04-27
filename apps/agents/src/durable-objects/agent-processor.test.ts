import type { GenericEventInput } from "@iterate-com/events-contract";
import { describe, expect, test } from "vitest";
import {
  AgentInputAddedEventInput,
  DebugInfoRequestedEventInput,
  IterateAgentProcessorState,
  LlmRequestCancelledEventInput,
  LlmRequestCompletedEventInput,
  LlmRequestQueuedEventInput,
  LlmRequestScheduledEventInput,
  LlmRequestStartedEventInput,
  ToolProviderConfigUpdatedEventInput,
} from "./agent-processor-types.ts";
import { createIterateAgentProcessor, type ProcessorRuntime } from "./agent-processor.ts";

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
}) {
  const appended: Array<GenericEventInput> = [];
  await args.processor.afterAppend({
    event: args.event,
    state: args.state,
    runtime: args.runtime,
    append: ({ event }) => {
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

  test("tool-provider-config-updated upserts and null-deletes by slug", () => {
    const processor = createProcessorForTests();
    const exec = {
      kind: "rpc" as const,
      target: {
        type: "durable-object" as const,
        binding: { $binding: "MCP_CLIENT" },
        address: { type: "name" as const, name: "cloudflare-docs" },
      },
      rpcMethod: "callTool",
      argsMode: "object" as const,
    };
    const types = {
      kind: "rpc" as const,
      target: {
        type: "durable-object" as const,
        binding: { $binding: "MCP_CLIENT" },
        address: { type: "name" as const, name: "cloudflare-docs" },
      },
      rpcMethod: "getTypes",
      argsMode: "object" as const,
    };
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
    let s = processor.reduce({
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
      state: processor.initialState,
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
      state: processor.initialState,
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
      state: processor.initialState,
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
      state: processor.initialState,
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
      state: processor.initialState,
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
      state: processor.initialState,
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
      state: processor.initialState,
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
      state: processor.initialState,
      runtime,
    });
    expect(calls).toEqual([]);
    expect(appended.map((e) => e.type)).toEqual(["llm-request-queued"]);
  });

  test("user after-current-request while a request is debouncing also extends the debounce timer", async () => {
    // While `scheduled`, all triggering behaviours collapse to the same
    // thing: the pending request hasn't started yet, so the distinction
    // between "interrupt" and "queue" is meaningless. They all push the
    // debounce timer out.
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
      state: processor.initialState,
      runtime,
    });
    expect(calls).toEqual([{ kind: "extend", requestId: "req_existing", debounceMs: 1000 }]);
    expect(appended).toEqual([]);
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
      state: processor.initialState,
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
      state: processor.initialState,
      runtime,
    });
    expect(calls).toEqual([{ kind: "schedule", requestId: "req_1", debounceMs: 1000 }]);
    expect(appended.map((e) => e.type)).toEqual(["llm-request-scheduled"]);
  });

  test("user trigger-request-within-time-period during debounce extends the debounce timer", async () => {
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
      state: processor.initialState,
      runtime,
    });
    expect(calls).toEqual([{ kind: "extend", requestId: "req_existing", debounceMs: 1000 }]);
    expect(appended).toEqual([]);
  });

  test("llm-request-completed with pendingTriggerCount > 0 emits follow-up rewrite then schedules", async () => {
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
      state: { ...processor.initialState, pendingTriggerCount: 2, currentRequest: null },
      runtime,
    });
    expect(calls).toEqual([{ kind: "schedule", requestId: "req_1", debounceMs: 1000 }]);
    expect(appended.map((e) => e.type)).toEqual(["agent-input-added", "llm-request-scheduled"]);
    expect(appended[0]).toMatchObject({
      type: "agent-input-added",
      payload: {
        role: "user",
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
        content: expect.stringContaining("2 user messages"),
      },
    });
  });

  test("llm-request-completed with no pending trigger does nothing", async () => {
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
      state: { ...processor.initialState, pendingTriggerCount: 0 },
      runtime,
    });
    expect(calls).toEqual([]);
    expect(appended).toEqual([]);
  });

  test("llm-request-cancelled with pendingTriggerCount > 0 emits cancel rewrite + follow-up rewrite + schedule", async () => {
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
      state: { ...processor.initialState, pendingTriggerCount: 1 },
      runtime,
    });
    expect(calls).toEqual([{ kind: "schedule", requestId: "req_1", debounceMs: 1000 }]);
    expect(appended.map((e) => e.type)).toEqual([
      "agent-input-added", // cancellation rewrite
      "agent-input-added", // follow-up rewrite
      "llm-request-scheduled",
    ]);
    expect(appended[0]).toMatchObject({
      type: "agent-input-added",
      payload: { role: "user", content: expect.stringContaining("interrupted") },
    });
    expect(appended[1]).toMatchObject({
      type: "agent-input-added",
      payload: { role: "user", content: expect.stringContaining("1 user message") },
    });
  });

  test("llm-request-cancelled without pending trigger still emits cancel rewrite", async () => {
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
      state: { ...processor.initialState, pendingTriggerCount: 0 },
      runtime,
    });
    expect(calls).toEqual([]);
    expect(appended.map((e) => e.type)).toEqual(["agent-input-added"]);
    expect(appended[0]).toMatchObject({
      type: "agent-input-added",
      payload: { role: "user", triggerLlmRequest: { behaviour: "dont-trigger-request" } },
    });
  });

  test("llm-request-cancelled with deadline-exceeded reason emits a deadline-specific rewrite + follow-up + schedule", async () => {
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
      state: { ...processor.initialState, pendingTriggerCount: 1 },
      runtime,
    });
    expect(calls).toEqual([{ kind: "schedule", requestId: "req_1", debounceMs: 1000 }]);
    expect(appended.map((e) => e.type)).toEqual([
      "agent-input-added", // deadline-exceeded rewrite
      "agent-input-added", // follow-up rewrite
      "llm-request-scheduled",
    ]);
    expect(appended[0]).toMatchObject({
      type: "agent-input-added",
      payload: { role: "user", content: expect.stringContaining("took too long") },
    });
  });

  test("debug-info-requested round-trips state + runtime view as a debug-info-returned event", async () => {
    const processor = createProcessorForTests();
    const { runtime } = createTestRuntime({
      initialInflightId: "req_existing",
      initialInflightStatus: "running",
    });
    const stateWithStuff: IterateAgentProcessorState = {
      ...processor.initialState,
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
