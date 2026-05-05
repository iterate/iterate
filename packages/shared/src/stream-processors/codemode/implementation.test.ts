import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ConsumedEvent,
  defineProcessorContract,
  getInitialProcessorState,
  implementProcessor,
  type ProcessorStreamApi,
  runProcessorReduce,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import { CodemodeProcessorContract, type CodemodeState } from "./contract.ts";
import { createCodemodeProcessor } from "./implementation.ts";

describe("createCodemodeProcessor", () => {
  it("executes requested scripts through the injected executor and appends the completed event", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createCodemodeProcessor({
      now: fixedClock([new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.025Z")]),
      scriptExecutor: async ({ code, logger, scriptExecutionId }) => {
        await logger.log("log", `running ${scriptExecutionId}: ${code.length} chars`);
        return { result: { ok: true } };
      },
    });

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/codemode/script-execution-requested",
        payload: { code: "async (ctx) => ({ ok: true })", scriptExecutionId: "scr-1" },
        offset: 7,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: testStreamApi({ appended, storedEvents: [] }),
      signal: new AbortController().signal,
    });

    expect(appended).toEqual([
      {
        type: "events.iterate.com/codemode/log-emitted",
        idempotencyKey:
          "stream-processor:codemode:derived:log-emitted:1:/projects/prj_test/codemode-sessions/cblk_test:7",
        payload: {
          level: "log",
          message: "running scr-1: 29 chars",
          scriptExecutionId: "scr-1",
        },
      },
      {
        type: "events.iterate.com/codemode/script-execution-completed",
        idempotencyKey:
          "stream-processor:codemode:derived:script-execution-completed:/projects/prj_test/codemode-sessions/cblk_test:7",
        payload: {
          durationMs: 25,
          outcome: { status: "succeeded", output: { ok: true } },
          scriptExecutionId: "scr-1",
        },
      },
    ]);
  });

  it("lets script execution await a function call completed later in the stream", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createCodemodeProcessor({
      newId: fixedIds(["fn-1"]),
      scriptExecutor: async ({ session }) => {
        const output = await session.callFunction({
          input: { value: "hello" },
          path: ["providerB", "text", "exclaim"],
        });
        return { result: output };
      },
    });

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/codemode/script-execution-requested",
        payload: {
          code: "async (ctx) => ctx.providerB.text.exclaim()",
          scriptExecutionId: "scr-1",
        },
        offset: 7,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: testStreamApi({
        appended,
        storedEvents: [
          committedEvent({
            type: "events.iterate.com/codemode/function-call-completed",
            payload: {
              functionCallId: "fn-1",
              outcome: { status: "succeeded", output: { value: "HELLO!" } },
              path: ["providerB", "text", "exclaim"],
              scriptExecutionId: "scr-1",
            },
            offset: 9,
          }),
        ],
      }),
      signal: new AbortController().signal,
    });

    expect(appended).toEqual([
      {
        type: "events.iterate.com/codemode/function-call-requested",
        idempotencyKey:
          "stream-processor:codemode:derived:function-call-requested:1:/projects/prj_test/codemode-sessions/cblk_test:7",
        payload: {
          functionCallId: "fn-1",
          input: { value: "hello" },
          path: ["providerB", "text", "exclaim"],
          scriptExecutionId: "scr-1",
        },
      },
      {
        type: "events.iterate.com/codemode/script-execution-completed",
        idempotencyKey:
          "stream-processor:codemode:derived:script-execution-completed:/projects/prj_test/codemode-sessions/cblk_test:7",
        payload: {
          durationMs: expect.any(Number),
          outcome: { status: "succeeded", output: { value: "HELLO!" } },
          scriptExecutionId: "scr-1",
        },
      },
    ]);
  });

  it("waits on the committed function call id when request append is deduplicated", async () => {
    const appended: StreamEventInput[] = [];
    const requestedEvent = committedEvent({
      type: "events.iterate.com/codemode/function-call-requested",
      payload: {
        functionCallId: "fn-original",
        input: { value: "hello" },
        path: ["providerB", "text", "exclaim"],
        scriptExecutionId: "scr-1",
      },
      offset: 8,
    });
    const processor = createCodemodeProcessor({
      newId: fixedIds(["fn-replay"]),
      scriptExecutor: async ({ session }) => {
        const output = await session.callFunction({
          input: { value: "hello" },
          path: ["providerB", "text", "exclaim"],
        });
        return { result: output };
      },
    });

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/codemode/script-execution-requested",
        payload: {
          code: "async (ctx) => ctx.providerB.text.exclaim()",
          scriptExecutionId: "scr-1",
        },
        offset: 7,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: {
        append: async ({ event }) => {
          if (event.type === "events.iterate.com/codemode/function-call-requested") {
            return requestedEvent;
          }
          appended.push(event);
          return committedEvent({ ...event, offset: 10 + appended.length });
        },
        read: async () => [
          committedEvent({
            type: "events.iterate.com/codemode/function-call-completed",
            payload: {
              functionCallId: "fn-original",
              outcome: { status: "succeeded", output: { value: "HELLO!" } },
              path: ["providerB", "text", "exclaim"],
              scriptExecutionId: "scr-1",
            },
            offset: 9,
          }),
        ],
        subscribe: async function* () {},
      },
      signal: new AbortController().signal,
    });

    expect(appended).toEqual([
      {
        type: "events.iterate.com/codemode/script-execution-completed",
        idempotencyKey:
          "stream-processor:codemode:derived:script-execution-completed:/projects/prj_test/codemode-sessions/cblk_test:7",
        payload: {
          durationMs: expect.any(Number),
          outcome: { status: "succeeded", output: { value: "HELLO!" } },
          scriptExecutionId: "scr-1",
        },
      },
    ]);
  });

  it("lets stream processor providers complete function calls and call each other via events", async () => {
    const providerProcessorContract = defineProcessorContract({
      slug: "test-function-provider",
      version: "0.0.0-test",
      description: "Test provider processor that handles codemode function call events.",
      stateSchema: z.object({}),
      initialState: {},
      processorDeps: [CodemodeProcessorContract],
      events: {},
      consumes: [
        "events.iterate.com/codemode/function-call-requested",
        "events.iterate.com/codemode/function-call-completed",
      ],
      emits: [
        "events.iterate.com/codemode/function-call-requested",
        "events.iterate.com/codemode/function-call-completed",
      ],
    });
    type FunctionCallRequestedPayload = Extract<
      ConsumedEvent<typeof providerProcessorContract>,
      { type: "events.iterate.com/codemode/function-call-requested" }
    >["payload"];
    const parentRequestsByChildCallId = new Map<string, FunctionCallRequestedPayload>();

    const appended: StreamEvent[] = [];
    const waiters: Array<(event: StreamEvent) => void> = [];
    const processor = createCodemodeProcessor({
      newId: fixedIds(["fn-a"]),
      scriptExecutor: async ({ session }) => {
        const output = await session.callFunction({
          input: { value: "hello" },
          path: ["providerA", "compose", "exclaimViaB"],
        });
        return { result: output };
      },
    });
    let nextOffset = 20;

    const providerA = implementProcessor(providerProcessorContract, {
      afterAppend: async ({ event, streamApi }) => {
        if (
          event.type === "events.iterate.com/codemode/function-call-requested" &&
          event.payload.path.join(".") === "providerA.compose.exclaimViaB"
        ) {
          const childFunctionCallId = "fn-b";
          parentRequestsByChildCallId.set(childFunctionCallId, event.payload);
          await streamApi.append({
            event: {
              type: "events.iterate.com/codemode/function-call-requested",
              payload: {
                functionCallId: childFunctionCallId,
                input: event.payload.input,
                path: ["providerB", "text", "exclaim"],
                scriptExecutionId: event.payload.scriptExecutionId,
              },
            },
          });
          return;
        }

        if (
          event.type === "events.iterate.com/codemode/function-call-completed" &&
          event.payload.functionCallId === "fn-b"
        ) {
          const parentRequest = parentRequestsByChildCallId.get(event.payload.functionCallId);
          if (parentRequest == null) return;
          parentRequestsByChildCallId.delete(event.payload.functionCallId);

          if (event.payload.outcome.status === "failed") {
            await streamApi.append({
              event: {
                type: "events.iterate.com/codemode/function-call-completed",
                payload: {
                  functionCallId: parentRequest.functionCallId,
                  outcome: event.payload.outcome,
                  path: parentRequest.path,
                  scriptExecutionId: parentRequest.scriptExecutionId,
                },
              },
            });
            return;
          }

          const childOutput =
            event.payload.outcome.output != null && typeof event.payload.outcome.output === "object"
              ? (event.payload.outcome.output as Record<string, unknown>)
              : {};
          const childValue = childOutput.value;
          if (typeof childValue !== "string") {
            throw new Error("providerB completed without a string value");
          }

          await streamApi.append({
            event: {
              type: "events.iterate.com/codemode/function-call-completed",
              payload: {
                functionCallId: parentRequest.functionCallId,
                outcome: {
                  status: "succeeded",
                  output: {
                    provider: "provider-a",
                    value: childValue,
                  },
                },
                path: parentRequest.path,
                scriptExecutionId: parentRequest.scriptExecutionId,
              },
            },
          });
        }
      },
    });
    const providerB = implementProcessor(providerProcessorContract, {
      afterAppend: async ({ event, streamApi }) => {
        if (
          event.type !== "events.iterate.com/codemode/function-call-requested" ||
          event.payload.path.join(".") !== "providerB.text.exclaim"
        ) {
          return;
        }

        await streamApi.append({
          event: {
            type: "events.iterate.com/codemode/function-call-completed",
            payload: {
              functionCallId: event.payload.functionCallId,
              outcome: {
                status: "succeeded",
                output: { provider: "provider-b", value: "HELLO!" },
              },
              path: event.payload.path,
              scriptExecutionId: event.payload.scriptExecutionId,
            },
          },
        });
      },
    });
    const providerRecords = [
      { processor: providerA, state: getInitialProcessorState(providerProcessorContract) },
      { processor: providerB, state: getInitialProcessorState(providerProcessorContract) },
    ];

    const appendToStream = async ({ event }: { event: StreamEventInput }) => {
      const committed = committedEvent({ ...event, offset: nextOffset++ });
      appended.push(committed);
      for (const resolve of waiters.splice(0)) resolve(committed);

      for (const providerRecord of providerRecords) {
        const reduction = runProcessorReduce({
          event: committed,
          processor: providerRecord.processor,
          state: providerRecord.state,
        });
        if (reduction == null) continue;
        providerRecord.state = reduction.state;
        await providerRecord.processor.implementation.afterAppend?.({
          event: reduction.event,
          previousState: reduction.previousState,
          state: reduction.state,
          streamApi: providerStreamApi,
          signal: new AbortController().signal,
        });
      }

      return committed;
    };
    const readFromStream = async (options?: { afterOffset?: number | "start" | "end" }) => {
      const afterOffset = options?.afterOffset;
      return appended.filter(
        (event) => typeof afterOffset === "number" && event.offset > afterOffset,
      );
    };
    const subscribeToStream = async function* () {
      while (true) {
        yield await new Promise<StreamEvent>((resolve) => {
          waiters.push(resolve);
        });
      }
    };
    const streamApi: ProcessorStreamApi<typeof CodemodeProcessorContract> = {
      append: appendToStream,
      read: readFromStream,
      subscribe: subscribeToStream,
    };
    const providerStreamApi: ProcessorStreamApi<typeof providerProcessorContract> = {
      append: appendToStream,
      read: readFromStream,
      subscribe: subscribeToStream,
    };

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/codemode/script-execution-requested",
        payload: {
          code: "async (ctx) => ctx.providerA.compose.exclaimViaB()",
          scriptExecutionId: "scr-1",
        },
        offset: 7,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi,
      signal: new AbortController().signal,
    });

    expect(
      appended.map((event) => ({
        payload: event.payload,
        type: event.type,
      })),
    ).toEqual([
      {
        type: "events.iterate.com/codemode/function-call-requested",
        payload: {
          functionCallId: "fn-a",
          input: { value: "hello" },
          path: ["providerA", "compose", "exclaimViaB"],
          scriptExecutionId: "scr-1",
        },
      },
      {
        type: "events.iterate.com/codemode/function-call-requested",
        payload: {
          functionCallId: "fn-b",
          input: { value: "hello" },
          path: ["providerB", "text", "exclaim"],
          scriptExecutionId: "scr-1",
        },
      },
      {
        type: "events.iterate.com/codemode/function-call-completed",
        payload: {
          functionCallId: "fn-b",
          outcome: {
            status: "succeeded",
            output: { provider: "provider-b", value: "HELLO!" },
          },
          path: ["providerB", "text", "exclaim"],
          scriptExecutionId: "scr-1",
        },
      },
      {
        type: "events.iterate.com/codemode/function-call-completed",
        payload: {
          functionCallId: "fn-a",
          outcome: {
            status: "succeeded",
            output: { provider: "provider-a", value: "HELLO!" },
          },
          path: ["providerA", "compose", "exclaimViaB"],
          scriptExecutionId: "scr-1",
        },
      },
      {
        type: "events.iterate.com/codemode/script-execution-completed",
        payload: {
          durationMs: expect.any(Number),
          outcome: {
            status: "succeeded",
            output: { provider: "provider-a", value: "HELLO!" },
          },
          scriptExecutionId: "scr-1",
        },
      },
    ]);
  });
});

function registeredState(): CodemodeState {
  return {
    ...getInitialProcessorState(CodemodeProcessorContract),
    hasRegisteredCurrentVersion: true,
  };
}

function testStreamApi(args: {
  appended: StreamEventInput[];
  storedEvents: StreamEvent[];
}): ProcessorStreamApi<typeof CodemodeProcessorContract> {
  return {
    append: async ({ event }) => {
      args.appended.push(event);
      return committedEvent({ ...event, offset: args.appended.length });
    },
    read: async () => args.storedEvents,
    subscribe: async function* () {},
  };
}

function consumedCodemodeEvent<T extends ConsumedEvent<typeof CodemodeProcessorContract>>(args: {
  type: T["type"];
  payload: T["payload"];
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  offset?: number;
}): T {
  return committedEvent(args) as T;
}

function committedEvent(args: {
  type: string;
  payload: unknown;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  offset?: number;
}): StreamEvent {
  return {
    streamPath: "/projects/prj_test/codemode-sessions/cblk_test",
    type: args.type,
    payload: args.payload,
    metadata: args.metadata,
    idempotencyKey: args.idempotencyKey,
    offset: args.offset ?? 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function fixedClock(values: Date[]) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function fixedIds(values: string[]) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
