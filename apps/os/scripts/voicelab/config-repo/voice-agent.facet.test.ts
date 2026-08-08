// The voice facet against a SIMULATED provider: no microphone, no speaker, no
// network, no xAI. A fake socket and a virtual clock, so the press-to-answer
// sequence can be run hundreds of times and every run is the same run.
//
// This exists because the interesting cases are all races. "Does audio spoken
// during the handshake survive" and "does a second press wedge the stream" are
// questions about ordering, and ordering is exactly what a hand-run against a
// real provider cannot pin down: the handshake takes however long it takes and
// no two runs agree. Here the handshake takes as long as the test says.
import { describe, expect, it } from "vitest";
import { makeProcessorHarness } from "iterate/processors/testing";
import { VoiceAgentFacetContract, VoiceAgentFacetProcessor } from "./voice-agent.ts";

const PTT_START = "events.iterate.com/voice-agent/ptt-start";
const PTT_END = "events.iterate.com/voice-agent/ptt-end";
const MIC_FRAME = "events.iterate.com/voice-agent/mic-frame";
const CALL_STARTED = "events.iterate.com/voice-agent/call-started";
const ACCEPTED = "events.iterate.com/voice-agent/conversation-accepted";
const FLUSHED = "events.iterate.com/voice-agent/buffer-flushed";
const SPK_FRAME = "events.iterate.com/voice-agent/spk-frame";

/** 20 ms of 16 kHz PCM16, base64 — the shape a client actually sends. */
const micFrame = (seq: number) => ({
  type: MIC_FRAME as typeof MIC_FRAME,
  payload: { seq, pcm: btoa(String.fromCharCode(...new Uint8Array(640).fill(seq % 251))) },
});

/**
 * A provider socket that does exactly what the test says, when the test says.
 *
 * `session.created` is withheld until `greet()` so a test can hold the
 * handshake open across an arbitrary number of frames — which is the whole
 * window this design exists to cover.
 */
function fakeGrok() {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  /** Everything the facet sent upstream, in order. */
  const sent: Record<string, unknown>[] = [];
  let closed = false;
  const emit = (payload: Record<string, unknown>) => {
    for (const listener of listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(payload) });
    }
  };
  const socket = {
    addEventListener(kind: string, listener: (event: unknown) => void) {
      listeners.set(kind, [...(listeners.get(kind) ?? []), listener]);
    },
    send(raw: string) {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
    close() {
      closed = true;
    },
  };
  return {
    socket: socket as unknown as WebSocket,
    sent,
    get closed() {
      return closed;
    },
    /** The provider says hello; the facet answers with session.update. */
    greet: () => emit({ type: "session.created" }),
    /** The session is usable — the edge that flushes everything held. */
    ready: () => emit({ type: "session.updated" }),
    /** Begin an answer and send its first delta (bytes, not frames). */
    speak: (bytes: number) => {
      emit({ type: "response.created" });
      emit({
        type: "response.output_audio.delta",
        delta: btoa(String.fromCharCode(...new Uint8Array(bytes).fill(7))),
      });
    },
    /** Another delta of the SAME answer — this is where a remainder carries. */
    speakMore: (bytes: number) =>
      emit({
        type: "response.output_audio.delta",
        delta: btoa(String.fromCharCode(...new Uint8Array(bytes).fill(7))),
      }),
    /** How much captured audio actually reached the provider. */
    appended: () => sent.filter((message) => message.type === "input_audio_buffer.append").length,
    committed: () => sent.some((message) => message.type === "input_audio_buffer.commit"),
  };
}

function harnessWith(provider: ReturnType<typeof fakeGrok>, dialMs = 0) {
  return makeProcessorHarness<VoiceAgentFacetContract, VoiceAgentFacetProcessor>({
    path: "/agents/voice/harness",
    createProcessor: (deps) =>
      new VoiceAgentFacetProcessor({
        ...deps,
        now: deps.now,
        dialGrok: async () => {
          if (dialMs > 0) await deps.sleep(dialMs);
          return provider.socket;
        },
      }),
  });
}

describe("the press opens the call", () => {
  it("mints the call itself — the client never names one", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });

    const started = harness.events(CALL_STARTED);
    expect(started).toHaveLength(1);
    /* The id is the SERVER's, and the fold learns it from the event rather
     * than minting its own — which is what makes a replay reconstruct the
     * same call instead of a second one. */
    const conversationId = started[0]!.payload.conversationId;
    expect(conversationId).toMatch(/^[0-9a-f-]{8}$/);
    expect(harness.state().call?.conversationId).toBe(conversationId);
  });

  it("does not open a second call while one is up", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();
    await harness.append({ type: PTT_START, payload: {} });

    expect(harness.events(CALL_STARTED)).toHaveLength(1);
    /* The second press is a new utterance on the SAME call, so it clears
     * whatever the provider still holds rather than dialling again. */
    expect(provider.sent.some((m) => m.type === "input_audio_buffer.clear")).toBe(true);
  });
});

describe("audio spoken into the handshake", () => {
  it("is held, then flushed in order the instant the session is usable", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });

    // The user is already talking; the provider has not said hello yet.
    for (let seq = 0; seq < 25; seq++) await harness.append(micFrame(seq));
    expect(provider.appended()).toBe(0);

    provider.greet();
    provider.ready();
    await harness.settle();

    /* Every frame, and not one dropped: the half-second somebody spoke into
     * the handshake is the half-second they cared about most. */
    expect(provider.appended()).toBe(25);
    const flushed = harness.events(FLUSHED);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.payload.frames).toBe(25);
  });

  it("commits a turn that ended before the session was ready", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    for (let seq = 0; seq < 8; seq++) await harness.append(micFrame(seq));
    // Short utterance: the button is already up before the provider answers.
    await harness.append({ type: PTT_END, payload: {} });
    expect(provider.committed()).toBe(false);

    provider.greet();
    provider.ready();
    await harness.settle();

    /* The commit rides out immediately behind the flushed audio, rather than
     * waiting for a frame that is never coming. */
    expect(provider.appended()).toBe(8);
    expect(provider.committed()).toBe(true);
  });

  it("sends straight through once the session is up, holding nothing", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();

    for (let seq = 0; seq < 10; seq++) await harness.append(micFrame(seq));
    expect(provider.appended()).toBe(10);
    expect(harness.events(FLUSHED)[0]!.payload.frames).toBe(0);
  });
});

describe("the answer", () => {
  it("arrives as whole 20 ms frames in one batch per delta", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();

    // 2048 PCM16 bytes is three whole 640-byte frames with 128 left over.
    provider.speak(2048);
    await harness.settle();

    const frames = harness.events(SPK_FRAME);
    expect(frames).toHaveLength(3);
    /* Contiguous numbering is what a jitter buffer needs; a gap here is
     * audible as chopped speech. */
    expect(frames.map((f) => f.payload.frame)).toEqual([0, 1, 2]);
    expect(frames.every((f) => f.payload.enc === "u")).toBe(true);
  });

  it("carries a partial frame into the next delta rather than emitting it short", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();

    provider.speak(700); // one whole frame, 60 bytes left over
    await harness.settle();
    expect(harness.events(SPK_FRAME)).toHaveLength(1);

    provider.speakMore(580); // 60 + 580 = 640: exactly one more, no short frame
    await harness.settle();
    expect(harness.events(SPK_FRAME)).toHaveLength(2);

    /*
     * A NEW ANSWER DROPS THE TAIL, deliberately. Sixty bytes of the previous
     * answer prepended to this one would be a click at the start of every
     * reply, and after a barge-in it would be audio from a reply the listener
     * already interrupted.
     */
    provider.speak(600); // under a frame, and the old 0 bytes do not help it
    await harness.settle();
    expect(harness.events(SPK_FRAME)).toHaveLength(2);
  });
});

describe("repeated end to end", () => {
  /*
   * THE REGRESSION THAT MATTERED MOST. A guard of "dial only when idle" made
   * one un-hung-up call refuse every later press in silence — nine requests on
   * one stream with not a single acceptance. One run cannot see that; the
   * second run is where it shows.
   */
  it("runs the whole press-speak-release cycle 50 times on one stream", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);

    for (let round = 0; round < 50; round++) {
      await harness.append({ type: PTT_START, payload: {} });
      if (round === 0) {
        provider.greet();
        provider.ready();
        await harness.settle();
      }
      for (let seq = 0; seq < 5; seq++) await harness.append(micFrame(seq));
      await harness.append({ type: PTT_END, payload: {} });
    }
    await harness.settle();

    /* One call, 250 frames, and every turn committed — no wedge, no re-dial,
     * no silently dropped audio. */
    expect(harness.events(CALL_STARTED)).toHaveLength(1);
    expect(harness.events(ACCEPTED)).toHaveLength(1);
    expect(provider.appended()).toBe(250);
  });

  it("re-dials after an eviction, from the fold alone", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();
    const before = harness.state().call?.conversationId;

    /* The socket dies with the incarnation; the obligation does not. */
    harness.crash();
    await harness.append(micFrame(0));

    expect(harness.state().call?.conversationId).toBe(before);
    expect(harness.events(CALL_STARTED)).toHaveLength(1);
  });
});
