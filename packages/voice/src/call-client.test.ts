// call-client.test.ts — `startVoiceCall` over a fake project root: the path and the press, what
// the subscription hands its callbacks, the microphone's appends, the keepalive and the hang-up.
// The relay's side of the call is voice-agent.ts's (agent.test.ts, worker.test.ts).
import { expect, test, vi } from "vitest";
import { startVoiceCall, VOICE_CALL_KEEPALIVE_MS, type VoiceCallFact } from "./call-client.ts";

test("a call opens /agents/voice/<client>/<UTC stamp>-<activation>, presses there and subscribes to the answer's frames and the call's facts", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T10:11:12.345Z"));
  const root = project();
  const call = await startVoiceCall(root, callbacks());
  vi.useRealTimers();

  expect(call).toMatchObject({
    activation: expect.stringMatching(/^[0-9a-f]{32}$/),
    // allow-high-entropy-next-line: the UTC stamp of the fake clock above
    streamPath: `/agents/voice/cli/20260928101112-${call.activation}`,
  });
  expect(root).toMatchObject({
    cdPaths: [call.streamPath],
    presses: [{ streamPath: call.streamPath, activation: call.activation }],
    subscriptions: [
      {
        name: `cli-${call.activation}`,
        consumes: [
          "events.iterate.com/voice-agent/speaker-frame",
          "events.iterate.com/voice-agent/call-started",
          "events.iterate.com/voice-agent/conversation-accepted",
          "events.iterate.com/voice-agent/call-ended",
          "events.iterate.com/voice-agent/utterance-transcribed",
          "events.iterate.com/voice-agent/answer-transcribed",
          "events.iterate.com/agent/context-added",
          "events.iterate.com/voice-agent/provider-error-reported",
          "events.iterate.com/voice-agent/provider-disconnected",
        ],
        disposed: false,
      },
    ],
  });
  await call.hangUp("done");
});

test("the call's own speaker frames and its facts reach the callbacks and the stats; another call's frames and unknown rows do not", async () => {
  const root = project();
  const heard = callbacks();
  const call = await startVoiceCall(root, heard);
  const pcm = btoa(String.fromCharCode(...new Uint8Array(3_200))); // 100 ms of PCM16
  root.deliver([
    frame(call.activation, { pcm, clearSpeakerBufferBeforeFrame: true }),
    frame("another-call", { pcm }),
    frame(call.activation, { pcm: "", lastFrameOfAnswer: true }),
    {
      type: "events.iterate.com/voice-agent/conversation-accepted",
      payload: { handshakeTookMs: 812, upgradeTookMs: 240, activation: call.activation },
    },
    { type: "events.iterate.com/voice-agent/answer-transcribed", payload: { text: "Four." } },
    { type: "events.iterate.com/voice-agent/answer-transcribed", payload: {} },
    {
      type: "events.iterate.com/agent/context-added",
      payload: { role: "user", content: "What is two plus two?" },
    },
    { type: "events.iterate.com/agent/paused", payload: {} },
  ]);

  expect(heard).toMatchObject({
    frames: [
      { pcm, clearSpeakerBufferBeforeFrame: true },
      { pcm: "", lastFrameOfAnswer: true },
    ],
    facts: [
      {
        type: "events.iterate.com/voice-agent/conversation-accepted",
        payload: { handshakeTookMs: 812, upgradeTookMs: 240 },
      },
      { type: "events.iterate.com/voice-agent/answer-transcribed", payload: { text: "Four." } },
      {
        type: "events.iterate.com/agent/context-added",
        payload: { role: "user", content: "What is two plus two?" },
      },
    ],
  });
  expect(call.stats).toMatchObject({ spkChunksReceived: 1, spkMsReceived: 100, handshakeMs: 812 });
  await call.hangUp("done");
});

test("microphone frames are ephemeral appends, five in flight at most: the sixth is dropped and a failed append is counted", async () => {
  const root = project();
  const call = await startVoiceCall(root, callbacks());
  const held = Promise.withResolvers<void>();
  root.append.mockImplementation(async () => {
    await held.promise;
    return [];
  });
  const sent = Array.from({ length: 6 }, (_, index) => call.sendMicFrame(`frame-${index}`));
  held.reject(new Error("the link dropped"));
  await vi.waitFor(() => expect(call.stats).toMatchObject({ micFramesFailed: 5 }));

  expect(sent).toEqual([true, true, true, true, true, false]);
  expect(root.append.mock.calls[0]).toEqual([
    {
      type: "events.iterate.com/voice-agent/mic-frame",
      ephemeral: true,
      payload: { activation: call.activation, pcm: "frame-0" },
    },
  ]);
  expect(call.stats).toMatchObject({ micFramesSent: 5, micFramesDropped: 1, micFramesFailed: 5 });
  await call.hangUp("done");
});

test("a live call says keepalive every VOICE_CALL_KEEPALIVE_MS; hanging up waits for the frames in flight, appends call-ended and ends the subscription once it comes back", async () => {
  vi.useFakeTimers();
  const root = project();
  const heard = callbacks();
  const call = await startVoiceCall(root, heard);
  await vi.advanceTimersByTimeAsync(VOICE_CALL_KEEPALIVE_MS * 2);
  expect(root.appendedTypes()).toEqual([
    "events.iterate.com/voice-agent/keepalive",
    "events.iterate.com/voice-agent/keepalive",
  ]);

  const held = Promise.withResolvers<never[]>();
  root.append.mockImplementationOnce(() => held.promise);
  call.sendMicFrame("last-words");
  const hungUp = call.hangUp("hung up");
  await vi.advanceTimersByTimeAsync(0);
  // the terminal waits for the frame still in flight
  expect(root.appendedTypes().at(-1)).toBe("events.iterate.com/voice-agent/mic-frame");
  held.resolve([]);
  await hungUp;
  await vi.advanceTimersByTimeAsync(VOICE_CALL_KEEPALIVE_MS * 2);
  vi.useRealTimers();

  expect(root.append.mock.calls.slice(3)).toEqual([
    [
      {
        type: "events.iterate.com/voice-agent/call-ended",
        payload: { activation: call.activation, reason: "hung up" },
      },
    ],
  ]);
  expect(heard.facts).toMatchObject([
    { type: "events.iterate.com/voice-agent/call-ended", payload: { reason: "hung up" } },
  ]);
  expect(root.subscriptions).toMatchObject([{ disposed: true }]);
  expect(call.sendMicFrame("after the end")).toBe(false);
});

test("hanging up keeps the subscription for the answer's last frames until call-ended comes back, and ends it after a bounded wait when it does not", async () => {
  vi.useFakeTimers();
  const root = project();
  const heard = callbacks();
  const call = await startVoiceCall(root, heard);
  root.append.mockImplementationOnce(async () => []); // this call-ended never comes back
  const hungUp = call.hangUp("done");
  await vi.advanceTimersByTimeAsync(0);
  root.deliver([frame(call.activation, { pcm: "", lastFrameOfAnswer: true })]);
  expect(root.subscriptions).toMatchObject([{ disposed: false }]);
  await vi.advanceTimersByTimeAsync(5_000);
  await hungUp;
  vi.useRealTimers();

  expect(heard).toMatchObject({ frames: [{ pcm: "", lastFrameOfAnswer: true }] });
  expect(root.subscriptions).toMatchObject([{ disposed: true }]);
});

test("a press that answers another path is refused", async () => {
  const root = project();
  root.voice.setupVoiceAgent.mockResolvedValue({ streamPath: "/agents/voice/somewhere-else" });
  await expect(startVoiceCall(root, callbacks())).rejects.toThrow(
    /setupVoiceAgent answered \/agents\/voice\/somewhere-else/,
  );
});

/** A project root whose `itx.voice` answers the press, and the one context the call opens:
 *  records the paths, presses, subscriptions and appends; `deliver` plays rows to the
 *  subscription. */
function project() {
  const cdPaths: string[] = [];
  const presses: { streamPath?: string; activation: string }[] = [];
  const subscriptions: {
    name?: string;
    consumes?: string[];
    target: (events: unknown[]) => void;
    disposed: boolean;
  }[] = [];
  // The log hands a call's terminal back to the call's subscription, as the real one does.
  const append = vi.fn(async (...events: { type: string }[]): Promise<never[]> => {
    const ended = events.filter(
      (event) => event.type === "events.iterate.com/voice-agent/call-ended",
    );
    for (const subscription of subscriptions)
      if (ended.length > 0 && !subscription.disposed) subscription.target(ended);
    return [];
  });
  const setupVoiceAgent = vi.fn(async (options: { streamPath?: string; activation: string }) => {
    presses.push(options);
    return { streamPath: options.streamPath || "" };
  });
  const context = {
    append,
    subscribe: async (input: {
      name?: string;
      consumes?: string[];
      target: unknown;
    }): Promise<{ [Symbol.dispose](): void }> => {
      // the client hands a function target; the SDK's type also admits an expression
      const subscription = {
        name: input.name,
        consumes: input.consumes,
        target: input.target as (events: unknown[]) => void,
        disposed: false,
      };
      subscriptions.push(subscription);
      return { [Symbol.dispose]: () => void (subscription.disposed = true) };
    },
  };
  return {
    voice: { setupVoiceAgent },
    cd(path: string) {
      cdPaths.push(path);
      return context;
    },
    cdPaths,
    presses,
    subscriptions,
    append,
    appendedTypes: () => append.mock.calls.map(([event]) => event?.type),
    deliver: (events: unknown[]) => subscriptions[0]?.target(events),
  };
}

function callbacks() {
  const frames: unknown[] = [];
  const facts: VoiceCallFact[] = [];
  return {
    client: "cli",
    frames,
    facts,
    onSpeakerFrame: (speakerFrame: unknown) => void frames.push(speakerFrame),
    onFact: (fact: VoiceCallFact) => void facts.push(fact),
  };
}

function frame(activation: string, payload: Record<string, unknown>) {
  return {
    type: "events.iterate.com/voice-agent/speaker-frame",
    payload: { activation, conversationId: "conv", ...payload },
  };
}
