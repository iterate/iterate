import { describe, expect, it } from "vitest";
import {
  type ConsumedEvent,
  getInitialProcessorState,
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import type { ToolProviderDescriptor } from "../../codemode/types.ts";
import { CodemodeProcessorContract, type CodemodeState } from "./contract.ts";
import { createCodemodeProcessor } from "./implementation.ts";

describe("createCodemodeProcessor", () => {
  it("executes requested scripts through the injected executor and appends the durable result event", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createCodemodeProcessor({
      callableContext: {},
      now: fixedClock([new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.025Z")]),
      scriptExecutor: async ({ code, logger }) => {
        await logger.log("log", `running ${code.length} chars`);
        return { result: { ok: true } };
      },
    });

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/codemode/script-execution-requested",
        payload: { code: "async (ctx) => ({ ok: true })" },
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
          message: "running 29 chars",
          scriptExecutionRequestedOffset: 7,
        },
      },
      {
        type: "events.iterate.com/codemode/script-execution-finished",
        idempotencyKey:
          "stream-processor:codemode:derived:script-execution-finished:/projects/prj_test/codemode-sessions/cblk_test:7",
        payload: {
          result: { ok: true },
          durationMs: 25,
          scriptExecutionRequestedOffset: 7,
        },
      },
    ]);
  });

  it("dispatches tool function request events through registered providers", async () => {
    const appended: StreamEventInput[] = [];
    const fetchCalls: unknown[] = [];
    const descriptor = testToolProvider(["github"]);
    const processor = createCodemodeProcessor({
      callableContext: {
        fetch: async (input) => {
          const request = input instanceof Request ? input : new Request(input);
          fetchCalls.push(JSON.parse(await request.text()));
          return Response.json({ issue: 123 });
        },
      },
      scriptExecutor: async () => ({ result: { ok: true } }),
    });

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/codemode/tool-function-call-requested",
        payload: {
          path: ["github", "issues", "create"],
          payload: { title: "Bug" },
          providerPath: ["github"],
          toolFunctionPath: ["issues", "create"],
          scriptExecutionRequestedOffset: 10,
        },
        offset: 10,
      }),
      previousState: registeredState({ toolProviders: [descriptor] }),
      state: registeredState({ toolProviders: [descriptor] }),
      streamApi: testStreamApi({ appended, storedEvents: [] }),
      signal: new AbortController().signal,
    });

    expect(fetchCalls).toEqual([
      {
        path: ["issues", "create"],
        payload: { title: "Bug" },
        codemodeSessionCapability: expect.any(Object),
      },
    ]);
    expect(appended.map((event) => event.type)).toEqual([
      "events.iterate.com/codemode/tool-function-call-succeeded",
    ]);
    expect(appended[0]).toMatchObject({
      payload: {
        result: { issue: 123 },
        toolFunctionCallRequestedOffset: 10,
        scriptExecutionRequestedOffset: 10,
      },
    });
  });
});

function registeredState(args: { toolProviders?: ToolProviderDescriptor[] } = {}): CodemodeState {
  const state = {
    ...getInitialProcessorState(CodemodeProcessorContract),
    hasRegisteredCurrentVersion: true,
  };

  return {
    ...state,
    toolProviders: Object.fromEntries(
      (args.toolProviders ?? []).map((provider) => [JSON.stringify(provider.path), provider]),
    ),
  };
}

function testToolProvider(path: string[]): ToolProviderDescriptor {
  return {
    path,
    callable: {
      type: "fetch",
      via: {
        type: "url",
        url: "https://example.com/tools",
      },
    },
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
