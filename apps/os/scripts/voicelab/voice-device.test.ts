import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStreamNetwork,
} from "iterate/processors/testing";
import { SubscriptionConfiguredPayload } from "../../src/domains/streams/core-processor-contract.ts";

const setupVoiceAgent = vi.hoisted(() => vi.fn());

vi.mock("../../../../packages/voice-agent/src/voice-agent.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../packages/voice-agent/src/voice-agent.ts")>()),
  setupVoiceAgent,
}));

import {
  setupVoiceDevice,
  VoiceDeviceContract,
  VoiceDeviceProcessor,
} from "../../../../packages/voice-agent/src/device.ts";

const PARENT_PATH = "/clients/home-assistant-voice-preview-edition";
const ACTIVATION = "activation-a";

function micFrame(activation = ACTIVATION, pcm = "AQIDBA==") {
  return {
    type: "events.iterate.com/voice-agent/mic-frame" as const,
    payload: { activation, pcm },
  };
}

function terminal(activation = ACTIVATION) {
  return {
    type: "events.iterate.com/voice-agent/conversation-ended" as const,
    payload: { activation, reason: "button" },
  };
}

function makeHarness() {
  const clock = { now: Date.parse("2026-09-13T12:00:00.000Z") };
  const network = new MemoryStreamNetwork(() => clock.now);
  const stream = network.get(PARENT_PATH);
  const h = makeProcessorHarness<typeof VoiceDeviceContract, VoiceDeviceProcessor>({
    createProcessor: (deps) =>
      new VoiceDeviceProcessor({ ...deps, withProject: async (fn) => fn({} as never) }),
    substrate: { clock, stream, progress: makeMemoryProgressStore(VoiceDeviceContract) },
  });
  return { ...h, network };
}

async function configure(h: ReturnType<typeof makeHarness>) {
  await h.append(
    { type: "events.iterate.com/voice-agent/created", payload: {} },
    {
      type: "events.iterate.com/voice-agent/configured",
      payload: { instructions: "Be concise.", visemes: true },
    },
  );
}

describe("VoiceDeviceProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates one child for a same-batch opening and forwards every held frame", async () => {
    setupVoiceAgent.mockResolvedValue({ streamPath: "ignored", warmMs: 0 });
    const h = makeHarness();
    await configure(h);

    await h.append(micFrame(), micFrame(ACTIVATION, "BQYHCA=="));
    await h.settle();

    expect(setupVoiceAgent).toHaveBeenCalledTimes(1);
    const options = setupVoiceAgent.mock.calls[0]![1] as {
      streamPath: string;
      transportStreamPath: string;
      activation: string;
    };
    expect(options).toMatchObject({ transportStreamPath: PARENT_PATH, activation: ACTIVATION });
    expect(
      h
        .events()
        .filter((event) => event.type === "events.iterate.com/voice-device/conversation-created"),
    ).toHaveLength(1);
    expect(
      h.network
        .eventsAt(options.streamPath)
        .map((event) => ({ type: event.type, payload: event.payload })),
    ).toEqual([
      { type: "events.iterate.com/voice-agent/mic-frame", payload: micFrame().payload },
      {
        type: "events.iterate.com/voice-agent/mic-frame",
        payload: micFrame(ACTIVATION, "BQYHCA==").payload,
      },
    ]);
  });

  it("keeps the inherited microphone event ephemeral at runtime", () => {
    expect(VoiceDeviceContract.events["events.iterate.com/voice-agent/mic-frame"].ephemeral).toBe(
      true,
    );
  });

  it("forwards opening PCM before its terminal and fences a late frame from that activation", async () => {
    setupVoiceAgent.mockResolvedValue({ streamPath: "ignored", warmMs: 0 });
    const h = makeHarness();
    await configure(h);

    await h.append(micFrame(), terminal());
    await h.settle();

    expect(setupVoiceAgent).toHaveBeenCalledTimes(1);
    const childStreamPath = (setupVoiceAgent.mock.calls[0]![1] as { streamPath: string })
      .streamPath;
    const childEventsBeforeLateFrame = [...h.network.eventsAt(childStreamPath)];
    expect(childEventsBeforeLateFrame).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/voice-agent/mic-frame",
        payload: micFrame().payload,
      }),
      expect.objectContaining({
        type: "events.iterate.com/voice-agent/conversation-ended",
        payload: expect.objectContaining({ activation: ACTIVATION }),
      }),
    ]);
    await h.append(micFrame(ACTIVATION, "BQYHCA=="));
    await h.settle();

    expect(h.network.eventsAt(childStreamPath)).toEqual(childEventsBeforeLateFrame);
    expect(setupVoiceAgent).toHaveBeenCalledTimes(1);
    expect(h.state()).toMatchObject({ call: null, recentEndedActivations: [ACTIVATION] });
  });

  it("does not create a child for an activation that ended before its first microphone frame", async () => {
    setupVoiceAgent.mockResolvedValue({ streamPath: "ignored", warmMs: 0 });
    const h = makeHarness();
    await configure(h);

    await h.append(terminal(), micFrame());
    await h.settle();

    expect(setupVoiceAgent).not.toHaveBeenCalled();
    expect(h.events("events.iterate.com/voice-device/conversation-created")).toEqual([]);
  });

  it("marks the fixed device call active only from the assigned child's call-started event", async () => {
    setupVoiceAgent.mockResolvedValue({ streamPath: "ignored", warmMs: 0 });
    const h = makeHarness();
    await configure(h);
    await h.append(micFrame());
    await h.settle();
    const childStreamPath = (setupVoiceAgent.mock.calls[0]![1] as { streamPath: string })
      .streamPath;

    await h.append({
      type: "events.iterate.com/voice-agent/call-started",
      source: {
        processor: {
          slug: "voice-agent",
          version: "1.0.0",
          stream: {
            path: childStreamPath,
            projectId: "proj_harness",
            streamId: "11111111-1111-4111-8111-111111111111",
          },
        },
      },
      payload: { activation: ACTIVATION, conversationId: "conv_a", streamPath: childStreamPath },
    });
    await h.settle();
    expect(h.state()).toMatchObject({ call: { activation: ACTIVATION, conversationId: "conv_a" } });

    await h.append(terminal());
    await h.settle();
    expect(h.state()).toMatchObject({ call: null });
  });

  it("ends the parent activation when the child cannot be set up", async () => {
    setupVoiceAgent.mockRejectedValue(new Error("OpenAI secret is unavailable"));
    const h = makeHarness();
    await configure(h);

    await h.append(micFrame());
    await h.settle();

    expect(h.events("events.iterate.com/voice-agent/conversation-ended")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          activation: ACTIVATION,
          reason: expect.stringContaining("OpenAI secret is unavailable"),
        }),
      }),
    ]);
  });

  it("forwards one terminal after a parent ends while buffered PCM is draining", async () => {
    let releaseSetup!: () => void;
    const setupReady = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    setupVoiceAgent.mockImplementation(async () => {
      await setupReady;
      return { streamPath: "ignored", warmMs: 0 };
    });
    const h = makeHarness();
    await configure(h);
    await h.append(micFrame(), micFrame(ACTIVATION, "BQYHCA=="));
    await h.settle();
    const childStreamPath = (setupVoiceAgent.mock.calls[0]![1] as { streamPath: string })
      .streamPath;
    const child = h.network.get(childStreamPath);
    const append = child.append.bind(child);
    let releaseChildAppend!: () => void;
    const childAppendReleased = new Promise<void>((resolve) => {
      releaseChildAppend = resolve;
    });
    let childAppendStarted!: () => void;
    const childAppendStartedPromise = new Promise<void>((resolve) => {
      childAppendStarted = resolve;
    });
    vi.spyOn(child, "append").mockImplementation(async (...events) => {
      childAppendStarted();
      await childAppendReleased;
      return append(...events);
    });

    releaseSetup();
    await childAppendStartedPromise;
    await h.append(terminal());
    await h.append(micFrame(ACTIVATION, "CQoLDA=="));
    releaseChildAppend();
    await h.settle();

    expect(child.events.map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      { type: "events.iterate.com/voice-agent/mic-frame", payload: micFrame().payload },
      {
        type: "events.iterate.com/voice-agent/mic-frame",
        payload: micFrame(ACTIVATION, "BQYHCA==").payload,
      },
      expect.objectContaining({
        type: "events.iterate.com/voice-agent/conversation-ended",
        payload: expect.objectContaining({ activation: ACTIVATION }),
      }),
    ]);
    expect(h.state()).toMatchObject({ call: null });
  });

  it("opens B after a mirrored child terminal has ended A", async () => {
    setupVoiceAgent.mockResolvedValue({ streamPath: "ignored", warmMs: 0 });
    const h = makeHarness();
    await configure(h);
    await h.append(micFrame());
    await h.settle();
    const childA = (setupVoiceAgent.mock.calls[0]![1] as { streamPath: string }).streamPath;
    const childSource = {
      processor: {
        slug: "voice-agent",
        version: "1.0.0",
        stream: {
          path: childA,
          projectId: "proj_harness",
          streamId: "11111111-1111-4111-8111-111111111111",
        },
      },
    };
    await h.append({
      type: "events.iterate.com/voice-agent/call-started",
      source: childSource,
      payload: { activation: ACTIVATION, conversationId: "conv_a", streamPath: childA },
    });
    await h.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      source: childSource,
      payload: { activation: ACTIVATION, reason: "the child finished" },
    });
    await h.append(micFrame("activation-b", "BQYHCA=="));
    await h.settle();

    expect(setupVoiceAgent).toHaveBeenCalledTimes(2);
    expect(h.state()).toMatchObject({ call: { activation: "activation-b" } });
    const childB = (setupVoiceAgent.mock.calls[1]![1] as { streamPath: string }).streamPath;
    expect(h.network.eventsAt(childB)).toEqual([
      expect.objectContaining({
        type: "events.iterate.com/voice-agent/mic-frame",
        payload: { activation: "activation-b", pcm: "BQYHCA==" },
      }),
    ]);
  });

  it("installs a core-valid parent subscription before its router configuration", async () => {
    const appends: unknown[][] = [];
    const waited: { offset: number; timeoutMs: number }[] = [];
    const stream = {
      append: async (...events: unknown[]) => {
        appends.push(events);
        return events.map((_, index) => ({ offset: index + 1 }));
      },
      subscriptions: {
        get: () => ({
          waitUntilProcessed: async (input: { offset: number; timeoutMs: number }) => {
            waited.push(input);
          },
          [Symbol.dispose]: () => {},
        }),
      },
      getProcessorRuntimeState: async () => null,
      [Symbol.dispose]: () => {},
    };
    await setupVoiceDevice(
      {
        secrets: {
          get: () => ({
            __describe: async () => ({ created: true, hasMaterial: true }),
            [Symbol.dispose]: () => {},
          }),
        },
        streams: { get: () => stream },
      } as never,
      { streamPath: PARENT_PATH, instructions: "Be concise.", visemes: true },
    );

    expect(appends).toEqual([
      [
        expect.objectContaining({
          type: "events.iterate.com/stream/subscription-configured",
        }),
        expect.objectContaining({ type: "events.iterate.com/voice-agent/created" }),
        expect.objectContaining({
          type: "events.iterate.com/voice-agent/configured",
          payload: { instructions: "Be concise.", visemes: true },
        }),
      ],
    ]);
    const subscription = appends[0]![0] as { payload: unknown };
    expect(SubscriptionConfiguredPayload.safeParse(subscription.payload).success).toBe(true);
    expect(waited).toEqual([{ offset: 3, timeoutMs: 90_000 }]);
  });

  it("replays legacy voice history without assigning a child until a fresh microphone frame", async () => {
    setupVoiceAgent.mockResolvedValue({ streamPath: "ignored", warmMs: 0 });
    const h = makeHarness();
    await h.stream.append(
      { type: "events.iterate.com/voice-agent/created", payload: {} },
      {
        type: "events.iterate.com/voice-agent/configured",
        payload: { instructions: "Old instructions.", visemes: true },
      },
      {
        type: "events.iterate.com/voice-agent/call-started",
        payload: { activation: ACTIVATION, conversationId: "legacy-call" },
      },
      {
        type: "events.iterate.com/voice-agent/utterance-transcript",
        payload: { conversationId: "legacy-call", text: "old user speech" },
      },
      {
        type: "events.iterate.com/voice-agent/answer-transcript",
        payload: { conversationId: "legacy-call", text: "old assistant speech" },
      },
      terminal(),
    );
    await h.settle();

    expect(h.state()).toMatchObject({
      call: null,
      recentEndedActivations: [ACTIVATION],
      instructions: "Old instructions.",
    });
    expect(setupVoiceAgent).not.toHaveBeenCalled();
    expect(h.network.streams.size).toBe(1);

    await h.append(micFrame("fresh-activation", "BQYHCA=="));
    await h.settle();
    expect(setupVoiceAgent).toHaveBeenCalledTimes(1);
    expect(setupVoiceAgent.mock.calls[0]![1]).toMatchObject({
      activation: "fresh-activation",
      instructions: "Old instructions.",
    });
  });
});
