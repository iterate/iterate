import { afterEach, describe, expect, it, vi } from "vitest";
import { ZERO_AGENT_RUNTIME, type AgentRuntime } from "@iterate-com/shared/agent-events";
import { StreamProcessorRunner } from "iterate/processors";
import { MemoryStreamNetwork } from "iterate/processors/testing";
import { SlackAgentProcessor } from "./slack-agent-processor-implementation.ts";

const NOW = Date.parse("2026-07-18T08:00:00.000Z");

function activeRuntime(): AgentRuntime {
  return { ...ZERO_AGENT_RUNTIME, runningScripts: 1 };
}

async function setup({
  channel = "D123",
  channelType = "im",
  mentionBot = false,
}: { channel?: string; channelType?: string; mentionBot?: boolean } = {}) {
  const network = new MemoryStreamNetwork(() => NOW);
  const stream = network.get("/agents/slack/test/c123/ts-111-222");
  const calls: Array<{ body: Record<string, unknown>; method: string }> = [];
  await stream.append(
    {
      type: "events.iterate.com/slack-agent/created",
      payload: {
        config: {
          channel,
          connection: "test",
          threadTs: "111.222",
        },
      },
    },
    {
      type: "events.iterate.com/slack/webhook-received",
      payload: {
        slackTeamId: "T1",
        body: {
          type: "event_callback",
          ...(mentionBot
            ? { authorizations: [{ is_bot: true, user_id: "UBOT", bot_id: "BBOT" }] }
            : {}),
          event: {
            type: "message",
            channel,
            channel_type: channelType,
            user: "U1",
            text: mentionBot ? "<@UBOT> hello" : "hello",
            ts: "111.222",
          },
        },
      },
    },
  );
  const processor = new SlackAgentProcessor({
    stream,
    path: stream.path,
    projectId: "prj_1",
    now: () => Date.now(),
    callSlackApi: async ({ body, method }) => {
      calls.push({ body, method });
    },
  });
  const runner = new StreamProcessorRunner({ processor, stream });
  await runner.catchUp();
  calls.length = 0;
  return { calls, processor, runner, state: runner.currentState, stream };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Slack direct runtime presentation", () => {
  it("paints active runtime immediately and clears only after the one-second idle edge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { calls, processor, state } = await setup();

    processor.presentRuntimeTransition(state, {
      runtime: activeRuntime(),
      since: new Date(NOW).toISOString(),
      sinceOffset: 10,
    });
    await processor.waitForRuntimePresentation();
    expect(calls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "D123",
          thread_ts: "111.222",
          status: "Running code…",
          loading_messages: ["Running code…"],
        },
      },
    ]);

    processor.presentRuntimeTransition(state, {
      runtime: ZERO_AGENT_RUNTIME,
      since: new Date(NOW).toISOString(),
      sinceOffset: 11,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await processor.waitForRuntimePresentation();
    expect(calls.at(-1)).toEqual({
      method: "assistant.threads.setStatus",
      body: {
        channel_id: "D123",
        thread_ts: "111.222",
        status: "",
      },
    });
  });

  it("cancels a pending idle clear when active work hands off within the debounce", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { calls, processor, state } = await setup();

    processor.presentRuntimeTransition(state, {
      runtime: activeRuntime(),
      since: new Date(NOW).toISOString(),
      sinceOffset: 20,
    });
    await processor.waitForRuntimePresentation();
    calls.length = 0;

    processor.presentRuntimeTransition(state, {
      runtime: ZERO_AGENT_RUNTIME,
      since: new Date(NOW).toISOString(),
      sinceOffset: 21,
    });
    await vi.advanceTimersByTimeAsync(500);
    processor.presentRuntimeTransition(state, {
      runtime: {
        ...ZERO_AGENT_RUNTIME,
        llmRequests: {
          ...ZERO_AGENT_RUNTIME.llmRequests,
          requested: 1,
        },
      },
      since: new Date(NOW + 500).toISOString(),
      sinceOffset: 22,
    });
    await processor.waitForRuntimePresentation();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(calls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "D123",
          thread_ts: "111.222",
          status: "Waiting for the model…",
          loading_messages: ["Waiting for the model…"],
        },
      },
    ]);
  });

  it("does not let metadata delivery bypass the idle debounce", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { calls, processor, runner, state, stream } = await setup();

    processor.presentRuntimeTransition(state, {
      runtime: activeRuntime(),
      since: new Date(NOW).toISOString(),
      sinceOffset: 25,
    });
    await processor.waitForRuntimePresentation();
    calls.length = 0;

    processor.presentRuntimeTransition(state, {
      runtime: ZERO_AGENT_RUNTIME,
      since: new Date(NOW).toISOString(),
      sinceOffset: 26,
    });
    await stream.append({
      type: "events.iterate.com/agent/metadata-changed",
      payload: { pinned: true },
    });
    await runner.catchUp();

    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await processor.waitForRuntimePresentation();
    expect(calls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "D123",
          thread_ts: "111.222",
          status: "",
        },
      },
    ]);
  });

  it("disposal cancels a pending idle presentation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { calls, processor, state } = await setup();

    processor.presentRuntimeTransition(state, {
      runtime: activeRuntime(),
      since: new Date(NOW).toISOString(),
      sinceOffset: 30,
    });
    await processor.waitForRuntimePresentation();
    calls.length = 0;

    processor.presentRuntimeTransition(state, {
      runtime: ZERO_AGENT_RUNTIME,
      since: new Date(NOW).toISOString(),
      sinceOffset: 31,
    });
    processor.disposeRuntimePresentation();
    await vi.advanceTimersByTimeAsync(2_000);
    await processor.waitForRuntimePresentation();

    expect(calls).toEqual([]);
  });

  it("uses current agent activity for assistant-thread status text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { calls, processor, state } = await setup();

    processor.presentRuntimeTransition(
      { ...state, metadata: { ...state.metadata, activity: "Checking CI" } },
      {
        runtime: activeRuntime(),
        since: new Date(NOW).toISOString(),
        sinceOffset: 40,
      },
    );
    await processor.waitForRuntimePresentation();

    expect(calls).toEqual([
      {
        method: "assistant.threads.setStatus",
        body: {
          channel_id: "D123",
          thread_ts: "111.222",
          status: "Checking CI…",
          loading_messages: ["Checking CI…"],
        },
      },
    ]);
  });

  it("never paints assistant status in an ordinary channel and still clears eyes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { calls, processor, state } = await setup({
      channel: "C123",
      channelType: "channel",
      mentionBot: true,
    });

    processor.presentRuntimeTransition(state, {
      runtime: activeRuntime(),
      since: new Date(NOW).toISOString(),
      sinceOffset: 50,
    });
    await processor.waitForRuntimePresentation();
    expect(calls).toEqual([]);

    processor.presentRuntimeTransition(state, {
      runtime: ZERO_AGENT_RUNTIME,
      since: new Date(NOW).toISOString(),
      sinceOffset: 51,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await processor.waitForRuntimePresentation();

    expect(calls).toEqual([
      {
        method: "reactions.remove",
        body: { channel: "C123", name: "eyes", timestamp: "111.222" },
      },
    ]);
  });
});
