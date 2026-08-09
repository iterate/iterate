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
    /* A real socket reports this and the facet asks it, because a close
     * listener can be missed and a corpse must not look alive. */
    readyState: 1 as number,
    addEventListener(kind: string, listener: (event: unknown) => void) {
      listeners.set(kind, [...(listeners.get(kind) ?? []), listener]);
    },
    send(raw: string) {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
    close() {
      closed = true;
      socket.readyState = 3;
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
    /** The socket goes away with no close event — the corpse case. */
    die: () => {
      socket.readyState = 3;
    },
    /** The provider closes properly — the close listener DOES run. */
    drop: () => {
      socket.readyState = 3;
      for (const listener of listeners.get("close") ?? []) listener({});
    },
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

  it("holds a barge-in clear and a text turn too, not just audio", async () => {
    /*
     * THE BUG THIS EXISTS FOR. The queue used to hold decoded PCM, so only
     * audio was held: `input_audio_buffer.clear` and a text turn went straight
     * to the socket. Before it existed they were dropped on the floor; after
     * it existed but before `session.updated` they were pushed into a session
     * that was not configured yet. Both are invisible failures — the model
     * simply answers something slightly wrong.
     */
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    // Still mid-handshake: a second press (barge-in) and a text turn.
    await harness.append({ type: PTT_START, payload: {} });
    await harness.append({
      type: "events.iterate.com/voice-agent/say",
      payload: { text: "hello" },
    });
    expect(provider.sent).toHaveLength(0);

    provider.greet();
    provider.ready();
    await harness.settle();

    const types = provider.sent.map((message) => message.type);
    expect(types).toContain("input_audio_buffer.clear");
    expect(types).toContain("conversation.item.create");
    /* And in the order they happened: the clear before the text it precedes. */
    expect(types.indexOf("input_audio_buffer.clear")).toBeLessThan(
      types.indexOf("conversation.item.create"),
    );
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

describe("the release", () => {
  /*
   * A FRAME THAT ARRIVES AFTER THE RELEASE MUST NOT REACH THE PROVIDER.
   *
   * Its VAD reads late audio as the user starting to speak again, and a
   * barge-in a millisecond after `response.created` cancels the answer before
   * one delta exists. Measured against xAI: four turns in six died exactly
   * that way, `response.created` then `speech_started` then silence forever.
   * Clients race their own appends and lossy links reorder, so the rule lives
   * here and not in any one client.
   */
  it("ignores audio that arrives after the turn was committed", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();

    await harness.append(micFrame(0));
    await harness.append({ type: PTT_END, payload: {} });
    await harness.append(micFrame(1)); // the straggler
    await harness.settle();

    const appended = provider.sent.filter((m) => m.type === "input_audio_buffer.append");
    expect(appended).toHaveLength(1);
    /* And the next press opens the gate again, or the call goes deaf. */
    await harness.append({ type: PTT_START, payload: {} });
    await harness.append(micFrame(2));
    await harness.settle();
    expect(provider.sent.filter((m) => m.type === "input_audio_buffer.append")).toHaveLength(2);
  });

  /* An open-mic board never releases, so the gate must never close on it. */
  it("keeps taking audio on an open-mic call, which has no release", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: { client: "/clients/stackchan" } });
    provider.greet();
    provider.ready();
    await harness.settle();

    await harness.append({ type: PTT_END, payload: {} });
    await harness.append(micFrame(0));
    await harness.settle();

    expect(provider.sent.filter((m) => m.type === "input_audio_buffer.append")).toHaveLength(1);
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
      await harness.append({ type: PTT_START, payload: { t: round * 1000 } });
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
     * no silently dropped audio. Every press is ANSWERED, though: each one
     * re-appends the accept its presser's device latches call_active from —
     * the once-ever accept is what kept faces asleep on live calls. */
    expect(harness.events(CALL_STARTED)).toHaveLength(1);
    expect(harness.events(ACCEPTED)).toHaveLength(50);
    expect(provider.appended()).toBe(250);
  });

  it("re-dials when the held call's socket has quietly died", async () => {
    /*
     * A socket can die without its close listener ever running — the provider
     * goes away, the incarnation resumes, the event is simply missed. The
     * call object survives as a corpse and every later press folds into it.
     * Measured on a board: 479 microphone frames handed to a facet that
     * dropped every one, with no error anywhere.
     */
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();
    expect(harness.events(CALL_STARTED)).toHaveLength(1);

    /* The socket dies WITHOUT anyone telling the facet. */
    provider.die();
    await harness.append({ type: PTT_START, payload: {} });
    await harness.settle();

    /* The press opens a new call rather than clearing a dead one's buffer. */
    expect(harness.events(CALL_STARTED)).toHaveLength(2);
  });

  it("re-dials when a handshake never finishes, rather than waiting forever", async () => {
    /*
     * The quieter corpse. `alive` treated anything still dialling as alive, so
     * a dial that neither completed nor errored made the call immortal.
     * Measured on a preview stream: a provider socket closed after 32 minutes,
     * the next press dialled, and no acceptance and no failure ever followed —
     * four consecutive presses folded into a handshake that was never going to
     * end, with nothing on the stream to say so.
     */
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    await harness.settle();
    expect(harness.events(CALL_STARTED)).toHaveLength(1);

    /* The socket is attached and open, but the provider never greets. */
    await harness.advanceTime(10_000);
    await harness.append({ type: PTT_START, payload: {} });
    await harness.settle();

    expect(harness.events(CALL_STARTED)).toHaveLength(2);
    /* And it says why, so a silent stream is never the only evidence. */
    expect(
      harness.events("events.iterate.com/voice-agent/conversation-ended").at(-1)?.payload,
    ).toMatchObject({ reason: "provider handshake never completed" });
  });

  it("leaves a handshake still inside its deadline alone", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    await harness.settle();

    await harness.advanceTime(2_000);
    await harness.append({ type: PTT_START, payload: {} });
    await harness.settle();

    expect(harness.events(CALL_STARTED)).toHaveLength(1);
  });

  it("does not call a superseded dial a failure", async () => {
    /*
     * Being replaced is a tidy hand-over, not a fault. This wrote
     * `conversation-failed` with an EMPTY reason, because the superseded
     * branch fell through to the obituary with no failure set — and two of
     * those landed on the boards' stream the first time they successfully
     * called, which reads as a broken dial.
     */
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    /* End the call, then press again: the first dial is now superseded. */
    const first = harness.events(CALL_STARTED)[0]!.payload.conversationId;
    await harness.append({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { conversationId: first },
    });
    await harness.append({ type: PTT_START, payload: {} });
    await harness.settle();

    expect(harness.events("events.iterate.com/voice-agent/conversation-failed")).toHaveLength(0);
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

describe("the hang-up", () => {
  const ENDED = "events.iterate.com/voice-agent/conversation-ended";

  it("a self-named end retires the call, and the next press opens a new one", async () => {
    /*
     * The firmware ends calls under its own name ("scdev", "havpedev"), not
     * the worker-minted 8-hex id. When that obituary folded to nothing,
     * `state.call` was immortal: every incarnation's at-head pass re-dialled
     * the corpse and every later press folded into it in silence — both
     * open-mic boards were wedged exactly this way on hardware.
     */
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();

    await harness.append({
      type: ENDED,
      payload: { conversationId: "havpedev", reason: "button" },
    });
    expect(harness.state().call).toBeNull();

    await harness.append({ type: PTT_START, payload: {} });
    await harness.settle();
    expect(harness.events(CALL_STARTED)).toHaveLength(2);
  });

  it("a provider-side close reaches the fold, so the call does not resurrect", async () => {
    /*
     * Only the in-memory call was retired on socket close, so an abandoned
     * call stayed open in state.call forever and the at-head recovery
     * re-dialled it on every caught-up delivery — the same conversationId
     * collecting a 900-second inactivity timeout every ~15 minutes all night,
     * with every fresh press folding into the loop instead of dialling.
     */
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();
    expect(harness.state().call).not.toBeNull();

    provider.drop();
    await harness.settle();
    expect(harness.state().call).toBeNull();
  });

  it("a press folding into a live call re-accepts, so the presser's device can latch", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: { t: 1000 } });
    provider.greet();
    provider.ready();
    await harness.settle();
    expect(harness.events(ACCEPTED)).toHaveLength(1);

    /* Second press, same live call: no new dial, but the accept must be said
     * again — the first one went to a connection that may be long gone. */
    await harness.append({ type: PTT_START, payload: { t: 2000 } });
    await harness.settle();
    expect(harness.events(CALL_STARTED)).toHaveLength(1);
    expect(harness.events(ACCEPTED)).toHaveLength(2);
  });

  it("a stale obituary for a predecessor does not close the successor", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();
    const live = harness.state().call?.conversationId;

    /* A worker-shaped id that is not the live call: somebody ending the call
     * that was already replaced. The successor must survive it. */
    await harness.append({ type: ENDED, payload: { conversationId: "deadbee1", reason: "late" } });
    expect(harness.state().call?.conversationId).toBe(live);
  });
});
