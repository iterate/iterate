import { describe, expect, it } from "vitest";
import {
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "@iterate-com/shared/stream-processors";
import {
  CODEMODE_PRIMER_IDEMPOTENCY_KEY,
  CodemodeProcessorContract,
} from "@iterate-com/shared/stream-processors/codemode/contract";
import { createCodemodeProcessor } from "@iterate-com/shared/stream-processors/codemode/implementation";
import { buildProcessorRegisteredEvent } from "@iterate-com/shared/stream-processors/core/contract";
import { createMemoryPullProcessorStorage, runPullProcessor } from "./pull-runner.ts";

describe("runPullProcessor", () => {
  it("catches up, subscribes from the reduced offset, and consumes live events", async () => {
    const appended: StreamEventInput[] = [];
    const subscribeAfterOffsets: unknown[] = [];
    const history = [
      event(buildProcessorRegisteredEvent({ contract: CodemodeProcessorContract }), { offset: 1 }),
    ];
    const liveEvents = [
      event(
        {
          type: "events.iterate.com/agent/output-added",
          payload: {
            content: "```js\nasync () => {\n  return 1;\n}\n```",
          },
        },
        { offset: 2 },
      ),
    ];
    const storage = createMemoryPullProcessorStorage({
      contract: CodemodeProcessorContract,
    });
    const processor = createCodemodeProcessor({
      codeExecutor: async () => ({ result: { ok: true } }),
      env: {},
    });

    const storedState = await runPullProcessor({
      processor,
      storage,
      streamApi: testStreamApi({
        appended,
        history,
        liveEvents,
        subscribeAfterOffsets,
      }),
      signal: new AbortController().signal,
    });

    expect(subscribeAfterOffsets).toEqual([1]);
    expect(storedState).toMatchObject({
      hasCompletedFirstAttach: true,
      liveAfterOffset: 1,
      reducedThroughOffset: 2,
      afterAppendCompletedThroughOffset: 2,
      state: {
        hasRegisteredCurrentVersion: true,
        hasAppendedCodemodePrompt: false,
      },
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
          "stream-processor:codemode:derived:assistant-output-to-block:/agents/test:2",
        payload: {
          script: "async () => {\n  return 1;\n}",
        },
      },
    ]);
  });

  it("uses first-attach lookback for recent historical events", async () => {
    const appended: StreamEventInput[] = [];
    const storage = createMemoryPullProcessorStorage({
      contract: CodemodeProcessorContract,
    });
    const processor = createCodemodeProcessor({
      codeExecutor: async () => ({ result: { ok: true } }),
      env: {},
    });

    await runPullProcessor({
      processor,
      storage,
      streamApi: testStreamApi({
        appended,
        history: [
          event(buildProcessorRegisteredEvent({ contract: CodemodeProcessorContract }), {
            offset: 1,
          }),
          event(
            {
              type: "events.iterate.com/agent/input-added",
              payload: {
                content: "hello",
              },
            },
            {
              offset: 2,
              createdAt: new Date().toISOString(),
            },
          ),
        ],
        liveEvents: [],
        subscribeAfterOffsets: [],
      }),
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
    ]);
  });

  it("treats subscription abort as normal shutdown", async () => {
    const abortController = new AbortController();
    const storage = createMemoryPullProcessorStorage({
      contract: CodemodeProcessorContract,
    });
    const processor = createCodemodeProcessor({
      codeExecutor: async () => ({ result: { ok: true } }),
      env: {},
    });

    const storedState = await runPullProcessor({
      processor,
      storage,
      streamApi: {
        append: async ({ event: input }) => event(input, { offset: 100 }),
        read: async () => [
          event(buildProcessorRegisteredEvent({ contract: CodemodeProcessorContract }), {
            offset: 1,
          }),
        ],
        subscribe: async function* () {
          yield* [] as AsyncIterable<StreamEvent>;
          abortController.abort();
          throw abortError();
        },
      },
      signal: abortController.signal,
    });

    expect(storedState).toMatchObject({
      hasCompletedFirstAttach: true,
      liveAfterOffset: 1,
      reducedThroughOffset: 1,
      afterAppendCompletedThroughOffset: 1,
    });
  });
});

function testStreamApi(args: {
  appended: StreamEventInput[];
  history: StreamEvent[];
  liveEvents: StreamEvent[];
  subscribeAfterOffsets: unknown[];
}): ProcessorStreamApi<typeof CodemodeProcessorContract> {
  return {
    append: async ({ event: input }) => {
      args.appended.push(input);
      return event(input, { offset: 100 + args.appended.length });
    },
    read: async () => args.history,
    subscribe: async function* ({ afterOffset } = {}) {
      args.subscribeAfterOffsets.push(afterOffset);
      for (const liveEvent of args.liveEvents) {
        yield liveEvent;
      }
    },
  };
}

function event(
  input: StreamEventInput,
  options: { offset?: number; createdAt?: string } = {},
): StreamEvent {
  return {
    streamPath: "/agents/test",
    ...input,
    offset: options.offset ?? input.offset ?? 1,
    createdAt: options.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function abortError() {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
