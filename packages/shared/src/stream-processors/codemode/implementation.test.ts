import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { dispatchCallable } from "../../callable/runtime.ts";
import type { Callable, CallableContext } from "../../callable/types.ts";
import {
  type ConsumedEvent,
  defineProcessorContract,
  type EmittedInput,
  getInitialProcessorState,
  implementProcessor,
  type ProcessorStreamApi,
  runProcessorReduce,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import { CodemodeProcessorContract, type CodemodeState } from "./contract.ts";
import { createCodemodeProcessor } from "./implementation.ts";

const sessionCapabilityCallable = {
  type: "workers-rpc",
  via: {
    type: "env-binding",
    bindingType: "service",
    bindingName: "CODEMODE_SESSION_CAPABILITY",
  },
  rpcMethod: "getCodemodeSessionCapability",
  argsMode: "object",
} satisfies Callable;

const aiCapabilityCallable = {
  type: "workers-rpc",
  via: {
    type: "env-binding",
    bindingType: "service",
    bindingName: "AI_CAPABILITY",
  },
  rpcMethod: "executeCodemodeFunctionCall",
  argsMode: "object",
} satisfies Callable;

describe("createCodemodeProcessor", () => {
  it("emits the codemode session-started singleton before doing script work", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createCodemodeProcessor({
      ...baseDeps(),
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
        type: "events.iterate.com/codemode/session-started",
        idempotencyKey: "events.iterate.com/codemode/session-started",
        payload: { sessionCapabilityCallable },
      },
      {
        type: "events.iterate.com/codemode/log-emitted",
        idempotencyKey: "codemode/log-emitted/1@7",
        payload: {
          level: "log",
          message: "running scr-1: 29 chars",
          scriptExecutionId: "scr-1",
        },
      },
      {
        type: "events.iterate.com/codemode/script-execution-completed",
        idempotencyKey: "codemode/script-execution-completed@7",
        payload: {
          durationMs: 25,
          outcome: { status: "returned", value: { ok: true } },
          scriptExecutionId: "scr-1",
        },
      },
    ]);
  });

  it("does not re-enter live catch-up before executing a requested script", async () => {
    const appended: StreamEventInput[] = [];
    const ensureLiveConsumer = vi.fn(async () => {});
    const scriptExecutor = vi.fn(async () => ({ result: { ok: true } }));
    const processor = createCodemodeProcessor({
      ...baseDeps(),
      ensureLiveConsumer,
      scriptExecutor,
    });

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/codemode/script-execution-requested",
        payload: { code: "async (ctx) => ({ ok: true })", scriptExecutionId: "scr-1" },
        offset: 7,
      }),
      previousState: registeredState({ sessionStarted: true }),
      state: registeredState({ sessionStarted: true }),
      streamApi: testStreamApi({ appended, storedEvents: [] }),
      signal: new AbortController().signal,
    });

    expect(ensureLiveConsumer).not.toHaveBeenCalled();
    expect(scriptExecutor).toHaveBeenCalledOnce();
    expect(appended).toContainEqual(
      expect.objectContaining({
        type: "events.iterate.com/codemode/script-execution-completed",
        payload: expect.objectContaining({
          outcome: { status: "returned", value: { ok: true } },
          scriptExecutionId: "scr-1",
        }),
      }),
    );
  });

  it("requests event-mediated function calls and waits for matching completion events", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createCodemodeProcessor({
      ...baseDeps(),
      newId: fixedIds(["fn-1"]),
      scriptExecutor: async ({ session }) => {
        const output = await session.callFunction({
          args: [{ value: "hello" }],
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
      state: registeredStateWithProviders([
        {
          instructions: "Provider B text functions.",
          invocation: { kind: "event" },
          path: ["providerB"],
        },
      ]),
      streamApi: testStreamApi({
        appended,
        storedEvents: [
          committedEvent({
            type: "events.iterate.com/codemode/function-call-completed",
            payload: {
              functionCallId: "fn-1",
              functionPath: ["text", "exclaim"],
              invocationKind: "event",
              outcome: { status: "returned", value: { value: "HELLO!" } },
              path: ["providerB", "text", "exclaim"],
              providerPath: ["providerB"],
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
        type: "events.iterate.com/codemode/session-started",
        idempotencyKey: "events.iterate.com/codemode/session-started",
        payload: { sessionCapabilityCallable },
      },
      {
        type: "events.iterate.com/codemode/function-call-requested",
        idempotencyKey: "codemode/function-call-requested/1@7",
        payload: {
          args: [{ value: "hello" }],
          functionCallId: "fn-1",
          functionPath: ["text", "exclaim"],
          invocationKind: "event",
          path: ["providerB", "text", "exclaim"],
          providerPath: ["providerB"],
          scriptExecutionId: "scr-1",
        },
      },
      {
        type: "events.iterate.com/codemode/script-execution-completed",
        idempotencyKey: "codemode/script-execution-completed@7",
        payload: {
          durationMs: expect.any(Number),
          outcome: { status: "returned", value: { value: "HELLO!" } },
          scriptExecutionId: "scr-1",
        },
      },
    ]);
  });

  it("dispatches rpc providers, appends returned completion, and keeps live result identity", async () => {
    const appended: StreamEventInput[] = [];
    const liveHandle = {
      async exec(input: { cmd: string }) {
        return { stdout: `ran ${input.cmd}` };
      },
    };
    const executeCodemodeFunctionCall = vi.fn(async () => liveHandle);
    const processor = createCodemodeProcessor({
      ...baseDeps({
        callableContext: {
          env: {
            AI_CAPABILITY: {
              executeCodemodeFunctionCall,
            },
          },
        },
      }),
      newId: fixedIds(["fn-rpc"]),
      scriptExecutor: async ({ session }) => {
        const handle = (await session.callFunction({
          args: [{ name: "build" }],
          path: ["sandbox", "get"],
        })) as typeof liveHandle;
        return { result: await handle.exec({ cmd: "pnpm test" }) };
      },
    });

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/codemode/script-execution-requested",
        payload: {
          code: "async (ctx) => ctx.sandbox.get({ name: 'build' }).exec({ cmd: 'pnpm test' })",
          scriptExecutionId: "scr-rpc",
        },
        offset: 11,
      }),
      previousState: registeredState(),
      state: registeredStateWithProviders([
        {
          instructions: "Sandbox handles.",
          invocation: { kind: "rpc", callable: aiCapabilityCallable },
          path: ["sandbox"],
        },
      ]),
      streamApi: testStreamApi({ appended, storedEvents: [] }),
      signal: new AbortController().signal,
    });

    expect(executeCodemodeFunctionCall).toHaveBeenCalledWith({
      args: [{ name: "build" }],
      codemodeSessionCapability: expect.objectContaining({ callFunction: expect.any(Function) }),
      functionCallId: "fn-rpc",
      functionPath: ["get"],
      invocationKind: "rpc",
      path: ["sandbox", "get"],
      providerPath: ["sandbox"],
      scriptExecutionId: "scr-rpc",
    });
    expect(appended.map(({ type, payload }) => ({ payload, type }))).toEqual([
      {
        type: "events.iterate.com/codemode/session-started",
        payload: { sessionCapabilityCallable },
      },
      {
        type: "events.iterate.com/codemode/function-call-requested",
        payload: {
          args: [{ name: "build" }],
          functionCallId: "fn-rpc",
          functionPath: ["get"],
          invocationKind: "rpc",
          path: ["sandbox", "get"],
          providerPath: ["sandbox"],
          scriptExecutionId: "scr-rpc",
        },
      },
      {
        type: "events.iterate.com/codemode/function-call-completed",
        payload: {
          durationMs: expect.any(Number),
          functionCallId: "fn-rpc",
          functionPath: ["get"],
          invocationKind: "rpc",
          outcome: {
            status: "returned",
            value: { exec: "[Function exec]" },
          },
          path: ["sandbox", "get"],
          providerPath: ["sandbox"],
          scriptExecutionId: "scr-rpc",
        },
      },
      {
        type: "events.iterate.com/codemode/script-execution-completed",
        payload: {
          durationMs: expect.any(Number),
          outcome: { status: "returned", value: { stdout: "ran pnpm test" } },
          scriptExecutionId: "scr-rpc",
        },
      },
    ]);
  });

  it("serves __codemode builtins without a registered provider", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createCodemodeProcessor({
      ...baseDeps(),
      newId: fixedIds(["fn-debug"]),
      scriptExecutor: async ({ session }) => {
        const output = await session.callFunction({
          args: [{ source: "test" }],
          path: ["__codemode", "debugInfo"],
        });
        return { result: output };
      },
    });

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/codemode/script-execution-requested",
        payload: {
          code: "async (ctx) => ctx.__codemode.debugInfo({ source: 'test' })",
          scriptExecutionId: "scr-debug",
        },
        offset: 17,
      }),
      previousState: registeredState(),
      state: registeredState(),
      streamApi: testStreamApi({ appended, storedEvents: [] }),
      signal: new AbortController().signal,
    });

    expect(appended.map(({ payload, type }) => ({ payload, type }))).toEqual([
      {
        type: "events.iterate.com/codemode/session-started",
        payload: { sessionCapabilityCallable },
      },
      {
        type: "events.iterate.com/codemode/function-call-requested",
        payload: {
          args: [{ source: "test" }],
          functionCallId: "fn-debug",
          functionPath: ["debugInfo"],
          invocationKind: "rpc",
          path: ["__codemode", "debugInfo"],
          providerPath: ["__codemode"],
          scriptExecutionId: "scr-debug",
        },
      },
      {
        type: "events.iterate.com/codemode/function-call-completed",
        payload: {
          durationMs: 0,
          functionCallId: "fn-debug",
          functionPath: ["debugInfo"],
          invocationKind: "rpc",
          outcome: {
            status: "returned",
            value: {
              args: [{ source: "test" }],
              functionCallId: "fn-debug",
              functionPath: ["debugInfo"],
              invocationKind: "rpc",
              path: ["__codemode", "debugInfo"],
              providerPath: ["__codemode"],
              scriptExecutionId: "scr-debug",
              streamPath: "/projects/prj_test/codemode-sessions/cblk_test",
            },
          },
          path: ["__codemode", "debugInfo"],
          providerPath: ["__codemode"],
          scriptExecutionId: "scr-debug",
        },
      },
      {
        type: "events.iterate.com/codemode/script-execution-completed",
        payload: {
          durationMs: expect.any(Number),
          outcome: {
            status: "returned",
            value: {
              args: [{ source: "test" }],
              functionCallId: "fn-debug",
              functionPath: ["debugInfo"],
              invocationKind: "rpc",
              path: ["__codemode", "debugInfo"],
              providerPath: ["__codemode"],
              scriptExecutionId: "scr-debug",
              streamPath: "/projects/prj_test/codemode-sessions/cblk_test",
            },
          },
          scriptExecutionId: "scr-debug",
        },
      },
    ]);
  });

  it("serializes callback args for rpc trace events while passing live callbacks to the provider", async () => {
    const appended: StreamEventInput[] = [];
    const executeCodemodeFunctionCall = vi.fn(
      async (input: { args: Array<{ callback: (value: unknown) => Promise<void> }> }) => {
        await input.args[0]!.callback({ ok: true });
        return { ok: true };
      },
    );
    const processor = createCodemodeProcessor({
      ...baseDeps({
        callableContext: {
          env: {
            AI_CAPABILITY: {
              executeCodemodeFunctionCall,
            },
          },
        },
      }),
      newId: fixedIds(["fn-callback"]),
      scriptExecutor: async ({ session }) => {
        const calls: unknown[] = [];
        await session.callFunction({
          args: [
            {
              callback: async (value: unknown) => {
                calls.push(value);
              },
            },
          ],
          path: ["workspace", "proofOfConcept"],
        });
        return { result: calls };
      },
    });

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/codemode/script-execution-requested",
        payload: {
          code: "async (ctx) => ctx.workspace.proofOfConcept({ callback })",
          scriptExecutionId: "scr-callback",
        },
        offset: 19,
      }),
      previousState: registeredState(),
      state: registeredStateWithProviders([
        {
          instructions: "Workspace proof of concept.",
          invocation: { kind: "rpc", callable: aiCapabilityCallable },
          path: ["workspace"],
        },
      ]),
      streamApi: testStreamApi({ appended, storedEvents: [] }),
      signal: new AbortController().signal,
    });

    expect(executeCodemodeFunctionCall.mock.calls[0]?.[0].args[0].callback).toEqual(
      expect.any(Function),
    );
    expect(
      appended.find((event) => event.type === "events.iterate.com/codemode/function-call-requested")
        ?.payload,
    ).toMatchObject({
      args: [{ callback: "[Function callback]" }],
      functionPath: ["proofOfConcept"],
      path: ["workspace", "proofOfConcept"],
      providerPath: ["workspace"],
    });
  });

  it("lets event-mediated providers use session-started to call another provider through a Codemode Context", async () => {
    const providerProcessorContract = defineProcessorContract({
      slug: "test-function-provider",
      version: "0.0.0-test",
      description: "Test provider processor that composes codemode providers.",
      stateSchema: z.object({ sessionCapabilityCallable: z.unknown().optional() }),
      initialState: {},
      processorDeps: [CodemodeProcessorContract],
      events: {},
      consumes: [
        "events.iterate.com/codemode/session-started",
        "events.iterate.com/codemode/function-call-requested",
        "events.iterate.com/codemode/function-call-completed",
      ],
      emits: ["events.iterate.com/codemode/function-call-completed"],
      reduce({ event, state }) {
        if (event.type !== "events.iterate.com/codemode/session-started") return state;
        return {
          ...state,
          sessionCapabilityCallable: event.payload.sessionCapabilityCallable,
        };
      },
    });
    const appended: StreamEvent[] = [];
    const waiters: Array<(event: StreamEvent) => void> = [];
    const processor = createCodemodeProcessor({
      ...baseDeps({
        callableContext: {
          env: {
            CODEMODE_SESSION_CAPABILITY: {
              getCodemodeSessionCapability: async () => sessionCapability,
            },
          },
        },
      }),
      newId: fixedIds(["fn-discord", "fn-slack"]),
      scriptExecutor: async ({ session }) => {
        const output = await session.callFunction({
          args: [{ slackChannel: "C123", version: "v1.2.3" }],
          path: ["discord", "announceRelease"],
        });
        return { result: output };
      },
    });
    const sessionCapability = {
      callFunction: async (input: {
        args: unknown[];
        path: string[];
        scriptExecutionId?: string;
      }) =>
        await processorSessionCall({
          input,
          streamApi,
        }),
    };
    const provider = implementProcessor(providerProcessorContract, {
      afterAppend: async ({ event, state, streamApi }) => {
        if (
          event.type !== "events.iterate.com/codemode/function-call-requested" ||
          event.payload.providerPath.join(".") !== "discord" ||
          event.payload.functionPath.join(".") !== "announceRelease"
        ) {
          return;
        }

        // Event-mediated providers are not directly called by codemode, so they
        // learn how to compose other tools by reducing the session-started
        // singleton and explicitly invoking its Session Capability Callable.
        // This is the smallest proof that a pull/browser/Discord-style provider
        // can still call Slack-style tools without becoming an RPC provider.
        const codemodeSessionCapability = await dispatchCallable({
          callable: state.sessionCapabilityCallable,
          ctx: {
            env: {
              CODEMODE_SESSION_CAPABILITY: {
                getCodemodeSessionCapability: async () => sessionCapability,
              },
            },
          },
          payload: {},
        });
        const [request] = event.payload.args as [{ slackChannel: string; version: string }];
        await (codemodeSessionCapability as typeof sessionCapability).callFunction({
          args: [
            {
              channel: request.slackChannel,
              text: `Released ${request.version}`,
            },
          ],
          path: ["slack", "chat", "postMessage"],
          scriptExecutionId: event.payload.scriptExecutionId,
        });
        await streamApi.append({
          event: completedEventInput({
            event,
            value: { mirroredToSlack: true },
          }),
        });
      },
    });
    const providerRecord = {
      processor: provider,
      state: getInitialProcessorState(providerProcessorContract),
    };

    const appendToStream = async ({ event }: { event: StreamEventInput }) => {
      const committed = committedEvent({ ...event, offset: 30 + appended.length });
      appended.push(committed);
      for (const resolve of waiters.splice(0)) resolve(committed);

      const reduction = runProcessorReduce({
        event: committed,
        processor: providerRecord.processor,
        state: providerRecord.state,
      });
      if (reduction != null) {
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
      appendBatch: async ({ events }) => {
        const appendedEvents: StreamEvent[] = [];
        for (const event of events) {
          appendedEvents.push(await appendToStream({ event }));
        }
        return appendedEvents;
      },
      read: readFromStream,
      subscribe: subscribeToStream,
    };
    const providerStreamApi: ProcessorStreamApi<typeof providerProcessorContract> = {
      append: appendToStream,
      appendBatch: async ({ events }) => {
        const appendedEvents: StreamEvent[] = [];
        for (const event of events) {
          appendedEvents.push(await appendToStream({ event }));
        }
        return appendedEvents;
      },
      read: readFromStream,
      subscribe: subscribeToStream,
    };
    const processorSessionCall = async (args: {
      input: { args: unknown[]; path: string[]; scriptExecutionId?: string };
      streamApi: ProcessorStreamApi<typeof CodemodeProcessorContract>;
    }) => {
      if (args.input.path.join(".") !== "slack.chat.postMessage") {
        throw new Error(`Unexpected nested path ${args.input.path.join(".")}`);
      }
      // This deliberately appends the same event pair an external pull-based
      // Slack processor would append. The session capability gives provider
      // code a normal call-shaped interface, but the trace remains plain
      // function-call-requested/function-call-completed events.
      const requested = await args.streamApi.append({
        event: {
          type: "events.iterate.com/codemode/function-call-requested",
          payload: {
            args: args.input.args,
            functionCallId: "fn-slack",
            functionPath: ["chat", "postMessage"],
            invocationKind: "event",
            path: args.input.path,
            providerPath: ["slack"],
            scriptExecutionId: args.input.scriptExecutionId,
          },
        },
      });
      await args.streamApi.append({
        event: {
          type: "events.iterate.com/codemode/function-call-completed",
          payload: {
            functionCallId: "fn-slack",
            functionPath: ["chat", "postMessage"],
            invocationKind: "event",
            outcome: { status: "returned", value: { ts: "123.456" } },
            path: args.input.path,
            providerPath: ["slack"],
            scriptExecutionId: args.input.scriptExecutionId,
          },
        },
      });
      return { requested };
    };

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/codemode/script-execution-requested",
        payload: {
          code: "async (ctx) => ctx.discord.announceRelease()",
          scriptExecutionId: "scr-compose",
        },
        offset: 29,
      }),
      previousState: registeredState(),
      state: registeredStateWithProviders([
        {
          instructions: "Discord functions.",
          invocation: { kind: "event" },
          path: ["discord"],
        },
        {
          instructions: "Slack functions.",
          invocation: { kind: "event" },
          path: ["slack"],
        },
      ]),
      streamApi,
      signal: new AbortController().signal,
    });

    expect(appended.map(({ payload, type }) => ({ payload, type }))).toEqual([
      {
        type: "events.iterate.com/codemode/session-started",
        payload: { sessionCapabilityCallable },
      },
      {
        type: "events.iterate.com/codemode/function-call-requested",
        payload: {
          args: [{ slackChannel: "C123", version: "v1.2.3" }],
          functionCallId: "fn-discord",
          functionPath: ["announceRelease"],
          invocationKind: "event",
          path: ["discord", "announceRelease"],
          providerPath: ["discord"],
          scriptExecutionId: "scr-compose",
        },
      },
      {
        type: "events.iterate.com/codemode/function-call-requested",
        payload: {
          args: [{ channel: "C123", text: "Released v1.2.3" }],
          functionCallId: "fn-slack",
          functionPath: ["chat", "postMessage"],
          invocationKind: "event",
          path: ["slack", "chat", "postMessage"],
          providerPath: ["slack"],
          scriptExecutionId: "scr-compose",
        },
      },
      {
        type: "events.iterate.com/codemode/function-call-completed",
        payload: {
          functionCallId: "fn-slack",
          functionPath: ["chat", "postMessage"],
          invocationKind: "event",
          outcome: { status: "returned", value: { ts: "123.456" } },
          path: ["slack", "chat", "postMessage"],
          providerPath: ["slack"],
          scriptExecutionId: "scr-compose",
        },
      },
      {
        type: "events.iterate.com/codemode/function-call-completed",
        payload: {
          functionCallId: "fn-discord",
          functionPath: ["announceRelease"],
          invocationKind: "event",
          outcome: { status: "returned", value: { mirroredToSlack: true } },
          path: ["discord", "announceRelease"],
          providerPath: ["discord"],
          scriptExecutionId: "scr-compose",
        },
      },
      {
        type: "events.iterate.com/codemode/script-execution-completed",
        payload: {
          durationMs: expect.any(Number),
          outcome: {
            status: "returned",
            value: { mirroredToSlack: true },
          },
          scriptExecutionId: "scr-compose",
        },
      },
    ]);
  });
});

function baseDeps(options: { callableContext?: CallableContext } = {}) {
  return {
    buildSessionCapabilityCallable: () => sessionCapabilityCallable,
    callableContext: options.callableContext ?? {},
    scriptExecutor: async () => ({ result: undefined }),
  };
}

function completedEventInput(args: {
  event: Extract<
    ConsumedEvent<typeof CodemodeProcessorContract>,
    { type: "events.iterate.com/codemode/function-call-requested" }
  >;
  value: unknown;
}): Extract<
  EmittedInput<typeof CodemodeProcessorContract>,
  { type: "events.iterate.com/codemode/function-call-completed" }
> {
  return {
    type: "events.iterate.com/codemode/function-call-completed",
    payload: {
      functionCallId: args.event.payload.functionCallId,
      functionPath: args.event.payload.functionPath,
      invocationKind: args.event.payload.invocationKind,
      outcome: { status: "returned", value: args.value },
      path: args.event.payload.path,
      providerPath: args.event.payload.providerPath,
      scriptExecutionId: args.event.payload.scriptExecutionId,
    },
  };
}

function registeredState(state?: Partial<CodemodeState>): CodemodeState {
  return {
    ...getInitialProcessorState(CodemodeProcessorContract),
    hasRegisteredCurrentVersion: true,
    ...state,
  };
}

function registeredStateWithProviders(
  providers: Array<CodemodeState["toolProviders"][string]>,
): CodemodeState {
  const state = registeredState();
  return {
    ...state,
    toolProviders: Object.fromEntries(
      providers.map((provider) => [JSON.stringify(provider.path), provider]),
    ),
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
    appendBatch: async ({ events }) => {
      return await Promise.all(events.map((event) => testStreamApi(args).append({ event })));
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
