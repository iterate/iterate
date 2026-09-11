// The call core against fakes of its two injected dependencies — the stream
// handle and the audio session (the same interfaces the phone, the Node e2e,
// and a future library swap use; nothing here mocks internals).
import { expect, test } from "vitest";
import {
  captionForEvent,
  startVoiceCall,
  transcriptItems,
  type VoiceCallStatus,
} from "./voice-call.ts";

const SPK = "events.iterate.com/voice-agent/spk-frame";
const ENDED = "events.iterate.com/voice-agent/conversation-ended";

test("the mint is one silent mic frame at call start; holding gates the mic locally; no press or release rides the wire", async () => {
  const h = makeHarness();
  const call = await startVoiceCall(h.deps);
  /* The mint went out at start (the greeting needs the dial before any
   * hold): one ephemeral frame of digital silence — and captured frames
   * still go nowhere until a hold. */
  expect(h.appends).toHaveLength(1);
  expect(h.appends[0]).toMatchObject({
    type: "events.iterate.com/voice-agent/mic-frame",
    ephemeral: true,
    payload: { activation: expect.any(String) },
  });
  const mint = h.appends[0]!.payload as { pcm: string };
  expect(mint.pcm).toBe(`${"A".repeat(852)}AA==`);
  h.captureFrame("AAAA", 0.4);
  await settle();
  expect(h.appends).toHaveLength(1);
  expect(h.levels).toEqual([0]);

  call.setTalking(true);
  h.captureFrame("BBBB", 0.5);
  h.captureFrame("CCCC", 0.6);
  call.setTalking(false);
  await settle();

  /* Held frames go out as mic frames and NOTHING ELSE: no push, no release
   * — the facet never hears about the button. The press emptied the local
   * playback queue (the model's held beat) and the release zeroed the bar. */
  const types = h.appends.map((a) => a.type);
  expect(types).toEqual([
    "events.iterate.com/voice-agent/mic-frame",
    "events.iterate.com/voice-agent/mic-frame",
    "events.iterate.com/voice-agent/mic-frame",
  ]);
  expect(h.appends[1]).toMatchObject({
    ephemeral: true,
    payload: { pcm: "BBBB", activation: expect.any(String) },
  });
  expect(h.appends[2]!.payload).toMatchObject({ pcm: "CCCC", activation: expect.any(String) });
  expect(h.audioLog).toContain("clear");
  expect(h.levels).toEqual([0, 0.5, 0.6, 0]);
});

test("the connection starts at the stream head, so history cannot end a fresh call", async () => {
  const h = makeHarness({ streamMaxOffset: 4242 });
  await startVoiceCall(h.deps);
  expect(h.openedWith).toMatchObject({ replayAfterOffset: 4242 });
});

test("the spk-frame buffer policy: clear before frame, then play", async () => {
  const h = makeHarness();
  await startVoiceCall(h.deps);
  h.deliver({ type: SPK, payload: { pcm: "QUJD", deviceSpeakerFrameSeq: 1 } });
  h.deliver({
    type: SPK,
    payload: { pcm: "REVG", deviceSpeakerFrameSeq: 2, clearSpeakerBufferBeforeFrame: true },
  });
  expect(h.audioLog).toEqual(["start", "play:QUJD", "clear", "play:REVG"]);
});

test("activation-bound downlink for another call never reaches this speaker or UI", async () => {
  const h = makeHarness();
  await startVoiceCall(h.deps);
  h.deliver({
    type: SPK,
    payload: { activation: "another-activation", pcm: "QUJD", deviceSpeakerFrameSeq: 1 },
  });
  h.deliver({
    type: "events.iterate.com/voice-agent/conversation-accepted",
    payload: { activation: "another-activation", conversationId: "conv_other" },
  });
  expect(h.audioLog).toEqual(["start"]);
  expect(h.statuses.at(-1)).toMatchObject({ phase: "connecting", caption: "ringing…" });
});

test("lifecycle and the backend's replies share the caption; ended stops audio and closes", async () => {
  const h = makeHarness();
  const call = await startVoiceCall(h.deps);
  h.deliver({
    type: "events.iterate.com/voice-agent/call-started",
    payload: { conversationId: "conv_1" },
  });
  h.deliver({
    type: "events.iterate.com/voice-agent/conversation-accepted",
    payload: { conversationId: "conv_x", handshakeTookMs: 900, heldMicFrames: 0 },
  });
  h.deliver({
    type: "events.iterate.com/voice-agent/backend-reply",
    payload: { conversationId: "conv_1", text: "The codeword is walrus trumpet." },
  });
  call.setTalking(true);
  h.deliver({ type: ENDED, payload: { conversationId: "conv_1", reason: "idle" } });
  expect(h.statuses.map((s) => `${s.phase}:${s.caption}`)).toEqual([
    "connecting:ringing…",
    /* Live only at PICKUP (conversation-accepted) — the ring covers the
     * dial and handshake. */
    "live:hold the mic to talk",
    "live:backend: The codeword is walrus trumpet.",
    "live:listening…",
    "ended:call ended — idle · heard 0.0s (0 frames)",
  ]);
  expect(h.audioLog.at(-1)).toBe("stop");
  expect(h.closed).toBe(true);
  /* A frame captured after the end is not appended. */
  const before = h.appends.length;
  h.captureFrame("CCCC", 0.2);
  await settle();
  expect(h.appends.length).toBe(before);
});

test("a backend reply during ringing captions but does not fake a pickup", async () => {
  const h = makeHarness();
  await startVoiceCall({ ...h.deps, ringTimeoutMs: 15 });
  h.deliver({
    type: "events.iterate.com/voice-agent/backend-reply",
    payload: { conversationId: "conv_1", text: "writing code" },
  });
  /* Still connecting: the hold-to-talk button must stay hidden and the
   * no-answer timer must stay armed — only conversation-accepted is a
   * pickup. */
  expect(h.statuses.at(-1)).toMatchObject({
    phase: "connecting",
    caption: "backend: writing code",
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(h.statuses.at(-1)!.phase).toBe("ended");
  expect(h.statuses.at(-1)!.caption).toMatch(/^no answer/);
});

test("another activation's stale obituary does not end this call", async () => {
  const h = makeHarness();
  await startVoiceCall(h.deps);
  h.deliver({
    type: "events.iterate.com/voice-agent/call-started",
    payload: { conversationId: "conv_mine" },
  });
  h.deliver({
    type: "events.iterate.com/voice-agent/conversation-accepted",
    payload: { conversationId: "conv_x", handshakeTookMs: 900, heldMicFrames: 0 },
  });
  h.deliver({
    type: ENDED,
    payload: { activation: "another-activation", reason: "idle" },
  });
  expect(h.statuses.at(-1)!.phase).toBe("live");
});

test("teardown clears queued playback and ignores a racing speaker frame", async () => {
  const h = makeHarness();
  const call = await startVoiceCall(h.deps);
  h.deliver({ type: SPK, payload: { pcm: "QUJD", deviceSpeakerFrameSeq: 1 } });
  await call.hangUp();
  const afterEnd = h.audioLog.length;
  h.deliver({ type: SPK, payload: { pcm: "REVG", deviceSpeakerFrameSeq: 2 } });
  expect(h.audioLog.slice(afterEnd)).toEqual([]);
  expect(h.audioLog).toContain("clear");
});

test("hang up ends locally FIRST, then appends the obituary — a wedged socket cannot eat the button", async () => {
  const h = makeHarness({ stallObituary: true });
  const call = await startVoiceCall(h.deps);
  /* Do not await: an activation can end before the provider accepts it, and
   * a stalled terminal append must not delay the local end. */
  void call.hangUp();
  await settle();
  expect(h.statuses.at(-1)!.caption).toMatch(/^call ended · heard/);
  expect(h.statuses.at(-1)!.phase).toBe("ended");
  expect(h.audioLog.at(-1)).toBe("stop");
  expect(h.appends.at(-1)).toMatchObject({
    type: ENDED,
    payload: { activation: expect.any(String), reason: "hang-up button" },
  });
});

test("a microphone that will not start ends the call cleanly instead of leaving a deaf mint", async () => {
  const h = makeHarness({ failAudioStart: true });
  await expect(startVoiceCall(h.deps)).rejects.toThrow("no mic");
  expect(h.statuses.at(-1)!.caption).toMatch(/^microphone failed/);
  expect(h.statuses.at(-1)!.phase).toBe("ended");
  /* Failed before any connection opened — nothing to close. */
});

test("the keepalive heartbeat runs for the call's life and dies with it", async () => {
  const h = makeHarness();
  const call = await startVoiceCall({ ...h.deps, keepaliveIntervalMs: 4 });
  const beats = () => h.appends.filter((a) => a.type.endsWith("/keepalive"));
  /* Poll-until with a watchdog, not a fixed sleep: a loaded CI runner can
   * starve a 4ms interval past any fixed wait (measured: one beat in 20ms
   * on Depot). Two beats prove periodicity. */
  const deadline = Date.now() + 2_000;
  while (beats().length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(beats().length).toBeGreaterThanOrEqual(2);
  expect(beats()[0]).toMatchObject({ ephemeral: true });
  await call.hangUp();
  /* A cleared interval cannot fire again, so a short fixed wait suffices
   * to catch a timer that survived finish(). */
  const after = beats().length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(beats().length).toBe(after);
});

test("a stalled socket drops mic frames instead of queueing the past", async () => {
  const h = makeHarness({ stallAppends: true });
  const call = await startVoiceCall(h.deps);
  call.setTalking(true);
  for (let i = 0; i < 20; i++) h.captureFrame("XXXX", 0.5);
  await settle();
  const micFrames = h.appends.filter((a) => a.type.endsWith("mic-frame"));
  expect(micFrames.length).toBeLessThanOrEqual(8);
  expect(micFrames.length).toBeGreaterThan(0);
});

test("the ring tone plays through the speaker path until PICKUP, then the queue is flushed", async () => {
  const h = makeHarness();
  await startVoiceCall({ ...h.deps, ringPcmBase64: "RING" });
  expect(h.audioLog[0]).toBe("start");
  expect(h.audioLog).toContain("play:RING");
  h.deliver({
    type: "events.iterate.com/voice-agent/conversation-accepted",
    payload: { conversationId: "conv_x", handshakeTookMs: 900, heldMicFrames: 0 },
  });
  /* Accepted = picked up: ringing stops and the queue is flushed so no
   * queued burst plays into the greeting. */
  expect(h.audioLog.at(-1)).toBe("clear");
});

test("ringing times out into an actionable caption when nobody picks up", async () => {
  const h = makeHarness();
  await startVoiceCall({ ...h.deps, ringTimeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(h.statuses.at(-1)!.phase).toBe("ended");
  expect(h.statuses.at(-1)!.caption).toMatch(/^no answer/);
});

test("pickup cancels the no-answer timeout", async () => {
  const h = makeHarness();
  await startVoiceCall({ ...h.deps, ringTimeoutMs: 15 });
  h.deliver({
    type: "events.iterate.com/voice-agent/conversation-accepted",
    payload: { conversationId: "conv_x", handshakeTookMs: 900, heldMicFrames: 0 },
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(h.statuses.at(-1)!.phase).toBe("live");
});

test("captionForEvent stays quiet for events a glancing human does not need", () => {
  expect(captionForEvent("events.iterate.com/voice-agent/spk-frame", { pcm: "x" })).toBeNull();
  expect(
    captionForEvent("events.iterate.com/voice-agent/call-started", { conversationId: "c" }),
  ).toBeNull();
  expect(captionForEvent("events.iterate.com/voice-agent/backend-reply", { text: "" })).toBeNull();
  expect(
    captionForEvent("events.iterate.com/voice-agent/backend-reply", { text: "y".repeat(200) }),
  ).toMatch(/…$/);
});

test("transcriptItems: both sides and the backend's replies, empties skipped", () => {
  const items = transcriptItems([
    {
      type: "events.iterate.com/voice-agent/utterance-transcript",
      offset: 1,
      payload: { text: "what's the weather?" },
    },
    {
      type: "events.iterate.com/voice-agent/answer-transcript",
      offset: 2,
      payload: { text: "Let me check." },
    },
    /* The backend's final words for the delegation. */
    {
      type: "events.iterate.com/voice-agent/backend-reply",
      offset: 6,
      payload: { conversationId: "conv_1", text: "Sunny, 24 degrees." },
    },
    /* An interrupted answer keeps its words, marked. */
    {
      type: "events.iterate.com/voice-agent/answer-transcript",
      offset: 7,
      payload: { text: "It's sunny and", cancelled: true },
    },
    /* Silence heard as a turn is not a row. */
    {
      type: "events.iterate.com/voice-agent/utterance-transcript",
      offset: 8,
      payload: { text: "" },
    },
    /* Machinery events are not conversation. */
    { type: "events.iterate.com/voice-agent/keepalive", offset: 9, payload: {} },
  ]);
  expect(items).toEqual([
    { key: "e1", kind: "you", text: "what's the weather?" },
    { key: "e2", kind: "voice", text: "Let me check." },
    { key: "e6", kind: "backend", text: "Sunny, 24 degrees." },
    { key: "e7", kind: "voice", text: "It's sunny and —" },
  ]);
});

/* ------------------------------------------------------------- harness --- */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeHarness(
  options: {
    streamMaxOffset?: number;
    stallAppends?: boolean;
    stallObituary?: boolean;
    failAudioStart?: boolean;
  } = {},
) {
  const appends: { type: string; ephemeral?: true; payload: any }[] = [];
  const statuses: VoiceCallStatus[] = [];
  const levels: number[] = [];
  const audioLog: string[] = [];
  let openedWith: any = null;
  let processBatch: ((batch: { events?: { type: string; payload?: unknown }[] }) => void) | null =
    null;
  let onFrame: ((frame: { pcmBase64: string; level: number }) => void) | null = null;
  let closed = false;

  const harness = {
    appends,
    statuses,
    levels,
    audioLog,
    closed: false,
    get openedWith() {
      return openedWith;
    },
    deliver(event: { type: string; payload?: unknown }) {
      const activation = (
        appends.find((append) => append.type.endsWith("/mic-frame"))?.payload as
          | { activation?: string }
          | undefined
      )?.activation;
      const activationBound =
        event.type === SPK ||
        event.type === "events.iterate.com/voice-agent/call-started" ||
        event.type === "events.iterate.com/voice-agent/conversation-accepted" ||
        event.type === ENDED;
      const payload =
        activationBound &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        !("activation" in event.payload)
          ? { ...event.payload, activation }
          : event.payload;
      processBatch!({ events: [{ ...event, payload }] });
      harness.closed = closed;
    },
    captureFrame(pcmBase64: string, level: number) {
      onFrame?.({ pcmBase64, level });
    },
    deps: {
      stream: {
        append: (...events: any[]) => {
          appends.push(...events);
          const type: string = events[0]?.type ?? "";
          const stalled =
            (options.stallAppends && type.endsWith("mic-frame")) ||
            (options.stallObituary && type.endsWith("conversation-ended"));
          return stalled ? new Promise(() => {}) : Promise.resolve([]);
        },
        openConnection: async (args: any) => {
          openedWith = args;
          processBatch = args.processEventBatch;
          return {
            close: () => {
              closed = true;
              harness.closed = true;
            },
          };
        },
        getEventPage: async () => ({ streamMaxOffset: options.streamMaxOffset ?? 7 }),
      },
      audio: {
        start: async (cb: (frame: { pcmBase64: string; level: number }) => void) => {
          if (options.failAudioStart) throw new Error("no mic");
          onFrame = cb;
          audioLog.push("start");
        },
        play: (pcm: string) => audioLog.push(`play:${pcm}`),
        clearPlayback: () => audioLog.push("clear"),
        setOutput: () => {},
        stop: async () => {
          audioLog.push("stop");
        },
      },
      ensureSetup: async () => {},
      onStatus: (status: VoiceCallStatus) => statuses.push(status),
      onLevel: (level: number) => levels.push(level),
    },
  };
  return harness;
}
