// The call core against fakes at its two real seams — the stream handle and
// the audio session (the same seams the phone, the Node e2e, and a future
// library swap use; nothing here mocks internals).
import { expect, test } from "vitest";
import { captionForEvent, startVoiceCall, type VoiceCallStatus } from "./voice-call.ts";

const SPK = "events.iterate.com/voice-agent/spk-frame";
const ENDED = "events.iterate.com/voice-agent/conversation-ended";

test("a call mints with one durable press, then pumps ephemeral mic frames with a device sequence", async () => {
  const h = makeHarness();
  await startVoiceCall(h.deps);
  expect(h.appends[0]).toMatchObject({
    type: "events.iterate.com/voice-agent/ptt-start",
    payload: { t: 1000 },
  });
  expect(h.appends[0]!.ephemeral).toBeUndefined();

  h.captureFrame("AAAA", 0.4);
  h.captureFrame("BBBB", 0.6);
  await settle();
  const micFrames = h.appends.filter((a) => a.type.endsWith("mic-frame"));
  expect(micFrames).toHaveLength(2);
  expect(micFrames[0]).toMatchObject({
    ephemeral: true,
    payload: { pcm: "AAAA", deviceMicFrameSeq: 1 },
  });
  expect(micFrames[1]!.payload).toMatchObject({ deviceMicFrameSeq: 2 });
  expect(h.levels).toEqual([0.4, 0.6]);
});

test("the connection starts at the stream head, so history cannot end a fresh call", async () => {
  const h = makeHarness({ streamMaxOffset: 4242 });
  await startVoiceCall(h.deps);
  expect(h.openedWith).toMatchObject({ replayAfterOffset: 4242 });
});

test("the speaker lane's buffer policy: clear before frame, then play", async () => {
  const h = makeHarness();
  await startVoiceCall(h.deps);
  h.deliver({ type: SPK, payload: { pcm: "QUJD", deviceSpeakerFrameSeq: 1 } });
  h.deliver({
    type: SPK,
    payload: { pcm: "REVG", deviceSpeakerFrameSeq: 2, clearSpeakerBufferBeforeFrame: true },
  });
  expect(h.audioLog).toEqual(["start", "play:QUJD", "clear", "play:REVG"]);
});

test("lifecycle and the colleague lanes share the caption; ended stops audio and closes", async () => {
  const h = makeHarness();
  await startVoiceCall(h.deps);
  h.deliver({
    type: "events.iterate.com/voice-agent/call-started",
    payload: { conversationId: "conv_1" },
  });
  h.deliver({
    type: "events.iterate.com/voice-agent/colleague-status",
    payload: { phase: "running code" },
  });
  h.deliver({
    type: "events.iterate.com/voice-agent/colleague-note",
    payload: { text: "The codeword is walrus trumpet." },
  });
  h.deliver({ type: ENDED, payload: { conversationId: "conv_1", reason: "idle" } });
  expect(h.statuses.map((s) => `${s.phase}:${s.caption}`)).toEqual([
    "connecting:setting up…",
    "connecting:connecting…",
    "live:listening",
    "live:backend: running code",
    "live:backend: The codeword is walrus trumpet.",
    "ended:call ended — idle",
  ]);
  expect(h.audioLog.at(-1)).toBe("stop");
  expect(h.closed).toBe(true);
  /* A frame captured after the end is not appended. */
  const before = h.appends.length;
  h.captureFrame("CCCC", 0.2);
  await settle();
  expect(h.appends.length).toBe(before);
});

test("another call's stale obituary does not end this one", async () => {
  const h = makeHarness();
  await startVoiceCall(h.deps);
  h.deliver({
    type: "events.iterate.com/voice-agent/call-started",
    payload: { conversationId: "conv_mine" },
  });
  h.deliver({ type: ENDED, payload: { conversationId: "conv_other", reason: "idle" } });
  expect(h.statuses.at(-1)!.phase).toBe("live");
});

test("hang up appends the device obituary for the minted conversation", async () => {
  const h = makeHarness();
  const call = await startVoiceCall(h.deps);
  h.deliver({
    type: "events.iterate.com/voice-agent/call-started",
    payload: { conversationId: "conv_9" },
  });
  await call.hangUp();
  expect(h.appends.at(-1)).toMatchObject({
    type: ENDED,
    payload: { conversationId: "conv_9", reason: "hang-up button" },
  });
  expect(h.audioLog.at(-1)).toBe("stop");
});

test("a stalled socket drops mic frames instead of queueing the past", async () => {
  const h = makeHarness({ stallAppends: true });
  await startVoiceCall(h.deps);
  for (let i = 0; i < 20; i++) h.captureFrame("XXXX", 0.5);
  await settle();
  const micFrames = h.appends.filter((a) => a.type.endsWith("mic-frame"));
  /* ptt-start consumed one stalled slot too; the cap is 8 in-flight. */
  expect(micFrames.length).toBeLessThanOrEqual(8);
  expect(micFrames.length).toBeGreaterThan(0);
});

test("captionForEvent stays quiet for events a glancing human does not need", () => {
  expect(captionForEvent("events.iterate.com/voice-agent/spk-frame", { pcm: "x" })).toBeNull();
  expect(
    captionForEvent("events.iterate.com/voice-agent/colleague-status", { waitingFor: null }),
  ).toBeNull();
  expect(
    captionForEvent("events.iterate.com/voice-agent/colleague-note", { text: "y".repeat(200) }),
  ).toMatch(/…$/);
});

/* ------------------------------------------------------------- harness --- */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeHarness(options: { streamMaxOffset?: number; stallAppends?: boolean } = {}) {
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
          /* Stall only the mic lane: the durable press must mint (a stalled
           * mint is the transport's own failure surface, not this test's). */
          const stalled = options.stallAppends && events[0]?.type?.endsWith("mic-frame");
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
          onFrame = cb;
          audioLog.push("start");
        },
        play: (pcm: string) => audioLog.push(`play:${pcm}`),
        clearPlayback: () => audioLog.push("clear"),
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
