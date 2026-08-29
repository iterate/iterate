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

test("push-to-talk: the mint press dials at call start; holds gate the mic; release commits", async () => {
  const h = makeHarness();
  const call = await startVoiceCall(h.deps);
  /* The mint press went out at start (the greeting needs the dial before
   * any hold) — but captured frames still go nowhere until a hold. */
  expect(h.appends).toHaveLength(1);
  expect(h.appends[0]).toMatchObject({
    type: "events.iterate.com/voice-agent/ptt-start",
    payload: { t: 0 },
  });
  expect(h.appends[0]!.ephemeral).toBeUndefined();
  h.captureFrame("AAAA", 0.4);
  await settle();
  expect(h.appends).toHaveLength(1);
  expect(h.levels).toEqual([0]);

  call.setTalking(true);
  h.captureFrame("BBBB", 0.5);
  h.captureFrame("CCCC", 0.6);
  call.setTalking(false);
  await settle();

  expect(h.appends[1]).toMatchObject({
    type: "events.iterate.com/voice-agent/ptt-start",
    payload: {},
  });
  /* The press is DURABLE like the mint; the release is not. */
  expect(h.appends[1]!.ephemeral).toBeUndefined();
  const micFrames = h.appends.filter((a) => a.type.endsWith("mic-frame"));
  expect(micFrames).toHaveLength(2);
  expect(micFrames[0]).toMatchObject({
    ephemeral: true,
    payload: { pcm: "BBBB", deviceMicFrameSeq: 1 },
  });
  expect(micFrames[1]!.payload).toMatchObject({ deviceMicFrameSeq: 2 });
  expect(h.appends.at(-1)).toMatchObject({
    type: "events.iterate.com/voice-agent/ptt-end",
    ephemeral: true,
  });
  /* Held frames metered, release zeroes the bar. */
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

test("lifecycle and the colleague events share the caption; ended stops audio and closes", async () => {
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
    type: "events.iterate.com/voice-agent/colleague-status",
    payload: { phase: "running code" },
  });
  h.deliver({
    type: "events.iterate.com/voice-agent/colleague-note",
    payload: { text: "The codeword is walrus trumpet." },
  });
  call.setTalking(true);
  h.deliver({ type: ENDED, payload: { conversationId: "conv_1", reason: "idle" } });
  expect(h.statuses.map((s) => `${s.phase}:${s.caption}`)).toEqual([
    "connecting:ringing…",
    /* Live only at PICKUP (conversation-accepted) — the ring covers the
     * dial and handshake. */
    "live:hold the mic to talk",
    "live:backend: running code",
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

test("a colleague event during ringing captions but does not fake a pickup", async () => {
  const h = makeHarness();
  await startVoiceCall({ ...h.deps, ringTimeoutMs: 15 });
  h.deliver({
    type: "events.iterate.com/voice-agent/colleague-status",
    payload: { phase: "writing code" },
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

test("another call's stale obituary does not end this one", async () => {
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
  h.deliver({ type: ENDED, payload: { conversationId: "conv_other", reason: "idle" } });
  expect(h.statuses.at(-1)!.phase).toBe("live");
});

test("hang up ends locally FIRST, then appends the obituary — a wedged socket cannot eat the button", async () => {
  const h = makeHarness({ stallObituary: true });
  const call = await startVoiceCall(h.deps);
  h.deliver({
    type: "events.iterate.com/voice-agent/call-started",
    payload: { conversationId: "conv_9" },
  });
  /* Do not await: the stalled obituary must not delay the local end. */
  void call.hangUp();
  await settle();
  expect(h.statuses.at(-1)!.caption).toMatch(/^call ended · heard/);
  expect(h.statuses.at(-1)!.phase).toBe("ended");
  expect(h.audioLog.at(-1)).toBe("stop");
  expect(h.appends.at(-1)).toMatchObject({
    type: ENDED,
    payload: { conversationId: "conv_9", reason: "hang-up button" },
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
  await new Promise((resolve) => setTimeout(resolve, 20));
  const beats = () => h.appends.filter((a) => a.type.endsWith("/keepalive"));
  expect(beats().length).toBeGreaterThan(1);
  expect(beats()[0]).toMatchObject({ ephemeral: true });
  await call.hangUp();
  const after = beats().length;
  await new Promise((resolve) => setTimeout(resolve, 20));
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
  expect(
    captionForEvent("events.iterate.com/voice-agent/colleague-status", { waitingFor: null }),
  ).toBeNull();
  expect(
    captionForEvent("events.iterate.com/voice-agent/colleague-note", { text: "y".repeat(200) }),
  ).toMatch(/…$/);
});

test("transcriptItems: both sides, notes, deduped statuses, empties skipped", () => {
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
    /* The facet's quiet opening status, then the same folded line twice —
     * one status row, not three. */
    {
      type: "events.iterate.com/voice-agent/colleague-status",
      offset: 3,
      payload: { activity: "checking the forecast" },
    },
    {
      type: "events.iterate.com/voice-agent/colleague-status",
      offset: 4,
      payload: { activity: "checking the forecast" },
    },
    /* A waitingFor-only patch says nothing a glancing human needs. */
    {
      type: "events.iterate.com/voice-agent/colleague-status",
      offset: 5,
      payload: { waitingFor: null },
    },
    {
      type: "events.iterate.com/voice-agent/colleague-note",
      offset: 6,
      payload: { text: "Sunny, 24 degrees." },
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
    { type: "events.iterate.com/voice-agent/ptt-start", offset: 9, payload: {} },
  ]);
  expect(items).toEqual([
    { key: "e1", kind: "you", text: "what's the weather?" },
    { key: "e2", kind: "voice", text: "Let me check." },
    { key: "e3", kind: "status", text: "checking the forecast" },
    { key: "e6", kind: "backend", text: "Sunny, 24 degrees." },
    { key: "e7", kind: "voice", text: "It's sunny and —" },
  ]);
});

test("transcriptItems: a failed script's status carries its error", () => {
  expect(
    transcriptItems([
      {
        type: "events.iterate.com/voice-agent/colleague-status",
        offset: 1,
        payload: { phase: "a script failed", failure: "TypeError: no ledger" },
      },
    ]),
  ).toEqual([{ key: "e1", kind: "status", text: "a script failed — TypeError: no ledger" }]);
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
      processBatch!({ events: [event] });
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
      now: () => 1000,
    },
  };
  return harness;
}
