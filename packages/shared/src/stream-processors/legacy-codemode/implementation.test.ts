import { describe, expect, it } from "vitest";
import {
  type ConsumedEvent,
  getInitialProcessorState,
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import { AgentProcessorContract } from "../agent/contract.ts";
import { buildProcessorRegisteredEvent } from "../core/contract.ts";
import {
  CODEMODE_PRIMER_IDEMPOTENCY_KEY,
  CodemodeProcessorContract,
  reduceCodemodeEvents,
  type CodemodeState,
} from "./contract.ts";
import {
  createCodemodeProcessor,
  extractCodemodeScriptFromAssistantResponse,
} from "./implementation.ts";

describe("createCodemodeProcessor", () => {
  it("appends the exactly-once primer and extracts assistant codemode blocks", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createCodemodeProcessor({
      codeExecutor: async () => ({ result: { ok: true } }),
      env: {},
    });

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/agent/output-added",
        payload: {
          content: "```js\nasync () => {\n  return 1;\n}\n```",
        },
        offset: 5,
      }),
      previousState: registeredState({ hasAppendedCodemodePrompt: false }),
      state: registeredState({ hasAppendedCodemodePrompt: false }),
      streamApi: testStreamApi({ appended, storedEvents: [] }),
      signal: new AbortController().signal,
    });

    expect(appended).toEqual([
      {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: CODEMODE_PRIMER_IDEMPOTENCY_KEY,
        payload: {
          content: expect.stringContaining("codemode is how you use tools"),
          triggerLlmRequest: { behaviour: "dont-trigger-request" },
        },
      },
      {
        type: "events.iterate.com/codemode/block-added",
        idempotencyKey:
          "stream-processor:codemode:derived:assistant-output-to-block:/agents/test:5",
        payload: {
          script: "async () => {\n  return 1;\n}",
        },
      },
    ]);
  });

  it("uses embedded agent dependency state before appending idle status", async () => {
    const appended: StreamEventInput[] = [];
    const processor = createCodemodeProcessor({
      codeExecutor: async () => ({ result: { ok: true } }),
      env: {},
    });

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/codemode/result-added",
        payload: { result: { ok: true }, durationMs: 10 },
        offset: 9,
      }),
      previousState: registeredState({ hasAppendedCodemodePrompt: true }),
      state: reduceCodemodeEvents({
        state: registeredState({ hasAppendedCodemodePrompt: true }),
        events: [
          committedEvent(buildProcessorRegisteredEvent({ contract: AgentProcessorContract })),
        ],
      }),
      streamApi: testStreamApi({
        appended,
        storedEvents: [],
      }),
      signal: new AbortController().signal,
    });

    expect(appended.at(-1)).toEqual({
      type: "events.iterate.com/agent/status-updated",
      idempotencyKey:
        "stream-processor:codemode:derived:codemode-result-to-idle-status:/agents/test:9",
      payload: {
        status: "idle",
        reason: "codemode-result-added",
      },
    });
  });

  it("executes codemode blocks through the injected executor dependency", async () => {
    const appended: StreamEventInput[] = [];
    const executorCalls: { script: string; toolProviderCount: number }[] = [];
    const processor = createCodemodeProcessor({
      codeExecutor: async ({ script, toolProviders, webchat }) => {
        executorCalls.push({ script, toolProviderCount: toolProviders.length });
        await webchat.callTool({
          name: "sendMessage",
          rawArgs: { message: "hello from fake executor" },
        });
        return { result: { ok: true }, logs: ["ran in fake executor"] };
      },
      env: {},
    });

    await processor.implementation.afterAppend?.({
      event: consumedCodemodeEvent({
        type: "events.iterate.com/codemode/block-added",
        payload: {
          script: "async () => ({ ok: true })",
        },
        offset: 12,
      }),
      previousState: registeredState({ hasAppendedCodemodePrompt: true }),
      state: registeredState({ hasAppendedCodemodePrompt: true }),
      streamApi: testStreamApi({ appended, storedEvents: [] }),
      signal: new AbortController().signal,
    });

    expect(executorCalls).toEqual([
      {
        script: "async () => ({ ok: true })",
        toolProviderCount: 0,
      },
    ]);
    expect(appended).toEqual([
      {
        type: "events.iterate.com/agent-chat/agent-response-added",
        idempotencyKey: "stream-processor:codemode:derived:webchat-send-message:1:/agents/test:12",
        payload: { channel: "web", message: "hello from fake executor" },
      },
      {
        type: "events.iterate.com/codemode/result-added",
        idempotencyKey: "stream-processor:codemode:derived:block-to-result:/agents/test:12",
        payload: {
          result: { ok: true },
          durationMs: expect.any(Number),
          logs: ["ran in fake executor"],
        },
      },
    ]);
  });

  it("extracts codemode scripts from fenced assistant responses", () => {
    expect(
      extractCodemodeScriptFromAssistantResponse("```js\nasync () => {\n  return 1;\n}\n```"),
    ).toBe("async () => {\n  return 1;\n}");
  });
});

function registeredState(args: { hasAppendedCodemodePrompt: boolean }): CodemodeState {
  return {
    ...getInitialProcessorState(CodemodeProcessorContract),
    hasRegisteredCurrentVersion: true,
    hasAppendedCodemodePrompt: args.hasAppendedCodemodePrompt,
  };
}

function testStreamApi(args: {
  appended: StreamEventInput[];
  storedEvents: StreamEvent[];
}): ProcessorStreamApi<typeof CodemodeProcessorContract> {
  return {
    append: async ({ event }) => {
      args.appended.push(event);
      return committedEvent(event);
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
    streamPath: "/agents/test",
    type: args.type,
    payload: args.payload,
    metadata: args.metadata,
    idempotencyKey: args.idempotencyKey,
    offset: args.offset ?? 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
