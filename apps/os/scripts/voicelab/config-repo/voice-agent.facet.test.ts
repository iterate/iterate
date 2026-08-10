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
const END_REQUESTED = "events.iterate.com/voice-agent/conversation-end-requested";
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
    /** The provider finishes speaking — the edge that closes the mouth. */
    finishAudio: () => emit({ type: "response.output_audio.done" }),
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

/*
 * THE MINUTE IS A SLEEP ON THE HARNESS'S VIRTUAL CLOCK, which is what makes a
 * sixty-second deadline observable in a millisecond. `advanceTime` releases
 * due sleeps, so the same `deps.sleep` the pacer's drain loop uses is also
 * what the idle countdown waits on — there is deliberately no second timing
 * seam to keep in step with it.
 */
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

/**
 * A harness that hands every dial its OWN provider, as the network does.
 *
 * `harnessWith` returns the same fake socket on every dial, which is honest
 * while a call is dialled once and held. It stops being honest the moment a
 * test wants to watch a SECOND call: the re-dial would talk into the socket
 * the first call closed, so a test could watch a second call be OPENED but
 * never watch one ANSWER. That gap is exactly where the first attempt at
 * ending calls went wrong — three green unit tests, and rounds two onwards
 * silent on preview.
 */
function harnessWithFreshProviders() {
  const providers: ReturnType<typeof fakeGrok>[] = [];
  const harness = makeProcessorHarness<VoiceAgentFacetContract, VoiceAgentFacetProcessor>({
    path: "/agents/voice/harness",
    createProcessor: (deps) =>
      new VoiceAgentFacetProcessor({
        ...deps,
        now: deps.now,
        dialGrok: async () => {
          const provider = fakeGrok();
          providers.push(provider);
          return provider.socket;
        },
      }),
  });
  return { harness, providers };
}

/**
 * Drive one whole press-to-answer turn.
 *
 * The greeting is only for a provider that has not had one: a conversation is
 * ONE call across many presses, so from the second turn on this is talking to
 * the session the first turn opened.
 */
async function takeTurn(
  harness: ReturnType<typeof harnessWithFreshProviders>["harness"],
  providers: ReturnType<typeof harnessWithFreshProviders>["providers"],
  audioBytes = 1280,
) {
  const before = providers.length;
  await harness.append({ type: PTT_START, payload: {} });
  await harness.settle();
  const provider = providers.at(-1)!;
  if (providers.length > before) {
    provider.greet();
    provider.ready();
    await harness.settle();
  }
  await harness.append({ type: PTT_END, payload: {} });
  provider.speak(audioBytes);
  provider.finishAudio();
  await harness.settle();
  return provider;
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

describe("the speaker lane's buffer verbs", () => {
  /*
   * A BOARD SHOULD NOT PARSE A PROVIDER SCHEMA TO MANAGE ITS OWN RING.
   *
   * Dropping a superseded answer and knowing an answer has ended are two bits
   * of information, and boards bought both by subscribing to `grok-event` —
   * every message xAI sends, which is the firehose that killed the host CLI's
   * receive buffer. They ride the frames now: `drop` cannot be reordered
   * against the audio it invalidates, because it IS that audio.
   */
  it("marks the first frame of an answer as a drop point", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();

    provider.speak(1920); // three whole frames
    await harness.settle();

    const frames = harness.events(SPK_FRAME);
    expect(frames[0]!.payload.drop).toBe(true);
    expect(frames.slice(1).every((f) => f.payload.drop === undefined)).toBe(true);
  });

  it("ends the answer with a frame that says so, and keeps the tail", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();

    /* 700 bytes is one whole frame and 60 left over — the ordinary case, since
     * a provider's final delta almost never lands on a 640-byte boundary. */
    provider.speak(700);
    await harness.settle();
    expect(harness.events(SPK_FRAME)).toHaveLength(1);

    provider.finishAudio();
    await harness.settle();

    const frames = harness.events(SPK_FRAME);
    expect(frames).toHaveLength(2);
    /* The remainder is PLAYED, not dropped. It used to be carried into a next
     * delta that never came, losing up to 20 ms off every answer's tail. */
    expect(frames[1]!.payload.pcm).not.toBe("");
    expect(frames[1]!.payload.last).toBe(true);
    expect(frames.slice(0, -1).every((f) => f.payload.last === false)).toBe(true);
  });

  it("still ends the answer when the audio divided evenly", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();
    provider.speak(1280); // exactly two frames, no remainder
    await harness.settle();

    provider.finishAudio();
    await harness.settle();

    /* Zero-length audio is a legitimate frame: a client that has played
     * everything still has to be told the answer is over. */
    const last = harness.events(SPK_FRAME).at(-1)!;
    expect(last.payload.last).toBe(true);
    expect(last.payload.pcm).toBe("");
  });
});

describe("one call across many presses", () => {
  /*
   * A CONVERSATION IS ONE CALL, and the button is not what starts or ends it.
   *
   * This used to hang up the provider socket the instant an answer had been
   * fully handed over — every single turn — so a push-to-talk caller re-dialled
   * on every press. The intent behind it was right (an idle stream must be
   * able to hibernate; nothing on a timer or a heartbeat while nobody is
   * interacting) and the means were wrong: a Durable Object awake DURING a
   * conversation is correct, because somebody is talking to it.
   */
  it("does not hang up when the answer has been handed over", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();
    provider.speak(1280);
    provider.finishAudio();
    await harness.settle();

    expect(provider.closed).toBe(false);
    expect(harness.events("events.iterate.com/voice-agent/conversation-ended")).toHaveLength(0);
    expect(harness.state().call).not.toBeNull();
  });

  it("keeps the SAME call over five presses, and numbers its answers 1..5", async () => {
    const { harness, providers } = harnessWithFreshProviders();
    const rounds = 5;
    const answered: { conversationId: string; answer: number; frame: number }[] = [];

    for (let round = 0; round < rounds; round++) {
      const seen = harness.events(SPK_FRAME).length;
      const provider = await takeTurn(harness, providers);
      /* The socket the first press opened is still the one answering. */
      expect(provider.closed).toBe(false);
      const fresh = harness.events(SPK_FRAME).slice(seen);
      expect(fresh.length).toBeGreaterThan(0);
      const first = fresh[0]!.payload;
      answered.push({
        conversationId: first.conversationId,
        answer: Number(first.answer),
        frame: Number(first.frame),
      });
    }

    /* ONE dial, ONE `call-started`, for five presses — the whole difference. */
    expect(providers).toHaveLength(1);
    expect(harness.events(CALL_STARTED)).toHaveLength(1);
    expect(new Set(answered.map((round) => round.conversationId)).size).toBe(1);
    /*
     * The answer counter runs on for the life of the call, and each answer
     * still starts at frame zero. Both halves are wire facts the firmware
     * depends on (a LOWER answer at frame zero means the sender restarted,
     * `audio_playout.c`), and any instrument comparing answer numbers must
     * scope the comparison to a conversation — reading it as a run-wide clock
     * is what made the previous design look like a dead server.
     */
    expect(answered.map((round) => round.answer)).toEqual([1, 2, 3, 4, 5]);
    expect(answered.map((round) => round.frame)).toEqual(Array(rounds).fill(0));
  });
});

describe("letting the Durable Object sleep", () => {
  /*
   * A held provider socket keeps the stream's DO awake, and xAI only drops an
   * idle session after 900 seconds — so a call nobody ends pins a DO, and
   * burns a provider session, for fifteen minutes of silence. The call ends a
   * minute after the last utterance from EITHER side instead, which is the one
   * rule that lets a conversation run as long as it likes and still lets an
   * idle stream hibernate.
   */
  const ENDED = "events.iterate.com/voice-agent/conversation-ended";
  const IDLE_REASON = "no utterance from either side for 60s";

  it("asks for the end a minute after the last thing either side said", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();
    provider.speak(1280);
    provider.finishAudio();
    await harness.settle();

    /* A second short of the minute the call is still up... */
    await harness.advanceTime(59_000);
    expect(provider.closed).toBe(false);
    expect(harness.state().call).not.toBeNull();

    /* ...and a second later it is over, in two steps that are both readable
     * from the log: somebody decided, with a reason, and then the facet did
     * it. That order is the whole design — the decider need not be holding
     * the socket, and here it happens to be. */
    await harness.advanceTime(1_000);
    const requested = harness.events(END_REQUESTED);
    const ended = harness.events(ENDED);
    expect(requested).toHaveLength(1);
    expect(requested[0]!.payload).toMatchObject({ reason: IDLE_REASON });
    expect(ended).toHaveLength(1);
    expect(ended[0]!.payload).toMatchObject({ reason: IDLE_REASON });
    expect(requested[0]!.offset).toBeLessThan(ended[0]!.offset);
    expect(harness.state().call).toBeNull();
    expect(provider.closed).toBe(true);
  });

  it("does not age out somebody who paused to think and then spoke again", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();

    /* Fifty seconds of thinking, then the button again: the minute restarts,
     * so the call the second press folds into is the call the first opened. */
    await harness.advanceTime(50_000);
    await harness.append({ type: PTT_START, payload: {} });
    await harness.advanceTime(50_000);

    expect(harness.events(CALL_STARTED)).toHaveLength(1);
    expect(harness.state().call).not.toBeNull();
    expect(provider.closed).toBe(false);
  });

  it("does not age out a long answer, which is the provider talking", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();
    await harness.append({ type: PTT_END, payload: {} });

    /* Nothing from the client for two minutes; the model is mid-sentence the
     * whole time. Only the PROVIDER's half of "either side" saves this. */
    provider.speak(1280);
    for (let chunk = 0; chunk < 4; chunk++) {
      await harness.advanceTime(40_000);
      provider.speakMore(1280);
      await harness.settle();
    }

    expect(harness.events(ENDED)).toHaveLength(0);
    expect(provider.closed).toBe(false);
  });

  it("never ages out a board that streams continuously", async () => {
    /* An open-mic call has no press to re-dial on, so the sixty-second rule
     * has to be harmless to one: its audio is continuous, and every frame is
     * the client speaking. */
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: { client: "/clients/stackchan" } });
    provider.greet();
    provider.ready();
    await harness.settle();

    for (let second = 0; second < 180; second++) {
      await harness.append(micFrame(second));
      await harness.advanceTime(1_000);
    }

    expect(harness.events(ENDED)).toHaveLength(0);
    expect(provider.closed).toBe(false);
    expect(harness.events(CALL_STARTED)).toHaveLength(1);
  });

  it("leaves nothing running once the call is over", async () => {
    /*
     * The point of ending an idle call: the stream must be able to hibernate.
     * The pacer's drain loop breaks the instant its queue empties and the idle
     * countdown goes with the call it belonged to, so once the socket is let
     * go there is nothing left for the Durable Object to stay awake for.
     */
    const { harness, providers } = harnessWithFreshProviders();
    await takeTurn(harness, providers, 64_000); /* two seconds of audio, paced */
    await harness.advanceTime(60_000);

    expect(harness.state().call).toBeNull();
    expect(providers[0]!.closed).toBe(true);
    /* Nothing is left ticking, so more time passing appends nothing at all. */
    const quiet = harness.events().length;
    await harness.advanceTime(300_000);
    expect(harness.events().length).toBe(quiet);
    /*
     * AND THE KEEPALIVE HAS LET GO, which is what "the Durable Object may
     * hibernate" actually means. A call is registered as background work, so
     * an unreleased one would leave the runner's alarm re-arming every ten
     * seconds forever — invisible in the event count while the incarnation
     * lives, and a revival the moment it does not. An eviction now brings
     * nobody back.
     */
    harness.crash();
    await harness.advanceTime(300_000);
    expect(harness.events()).toHaveLength(quiet);
  });

  it("re-dials on the press after an idle hang-up, so it costs a caller nothing", async () => {
    const { harness, providers } = harnessWithFreshProviders();
    await takeTurn(harness, providers);
    await harness.advanceTime(60_000);
    expect(harness.state().call).toBeNull();

    await takeTurn(harness, providers);

    expect(providers).toHaveLength(2);
    const started = harness.events(CALL_STARTED);
    expect(started).toHaveLength(2);
    expect(started[1]!.payload.conversationId).not.toBe(started[0]!.payload.conversationId);
  });

  /*
   * THE WINDOW BETWEEN LETTING GO AND SAYING SO, which is what actually broke
   * on preview and what no test here could see.
   *
   * An obituary is an APPEND, so for a write and a delivery the processor has
   * released a call the fold still calls open. Every caught-up delivery in
   * that window used to re-dial it — opening a second provider session for a
   * conversation that was over, and leaving a freshly dialled corpse that the
   * next press found `alive` and folded into instead of opening its own call.
   * The obituary then landed and killed the call the presser was speaking
   * into: no `call-started`, no answer, no error.
   *
   * Refusing the append is how the window is held open long enough to see.
   */
  it("does not re-dial a call it has just buried, before the log agrees", async () => {
    const { harness, providers } = harnessWithFreshProviders();
    harness.stream.failAppendsOfType = ENDED;
    await takeTurn(harness, providers);

    /* The provider goes away and the obituary cannot be written. */
    providers[0]!.drop();
    await harness.settle();
    /* The fold never heard, so it still believes this call is up... */
    expect(harness.state().call).not.toBeNull();
    /* ...and the at-head pass still refuses to resurrect it. */
    expect(providers).toHaveLength(1);

    /* And the press that follows opens its OWN call rather than folding into
     * the corpse a re-dial would have left for it. */
    harness.stream.failAppendsOfType = undefined;
    await takeTurn(harness, providers);
    expect(providers).toHaveLength(2);
    const started = harness.events(CALL_STARTED);
    expect(started).toHaveLength(2);
    expect(started[1]!.payload.conversationId).not.toBe(started[0]!.payload.conversationId);
  });

  /*
   * THE CLOCK ENDS A CALL THE SAME WAY A PERSON DOES: by appending, which
   * means it can be REFUSED — and the countdown that would have retried it
   * has already been spent by the time it finds out.
   */
  it("starts another minute when the decision cannot be written", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();

    harness.stream.failAppendsOfType = END_REQUESTED;
    await harness.advanceTime(60_000);
    /* Nobody decided anything, so nothing ended — and the call is still HELD
     * rather than orphaned with no clock on it. */
    expect(harness.events(END_REQUESTED)).toHaveLength(0);
    expect(harness.events(ENDED)).toHaveLength(0);
    expect(harness.state().call).not.toBeNull();
    expect(provider.closed).toBe(false);

    harness.stream.failAppendsOfType = undefined;
    await harness.advanceTime(60_000);
    expect(harness.events(ENDED).at(-1)?.payload).toMatchObject({ reason: IDLE_REASON });
    expect(provider.closed).toBe(true);
  });

  /*
   * A DECISION THAT IS ALREADY DURABLE IS NOT UNDONE BY A FAILED FOLLOW-UP.
   *
   * Once the request is on the log the call is over, so the socket goes even
   * if the obituary cannot be written — keeping a provider session alive
   * because a second append failed is the opposite of what any of this is
   * for. What the failure costs is a fold that still names the call, and the
   * fold is exactly what makes the retry free: it says an end was requested,
   * so the next pass to reach head writes the obituary again.
   */
  it("lets the socket go even when the obituary cannot be written", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();

    harness.stream.failAppendsOfType = ENDED;
    await harness.advanceTime(60_000);
    expect(harness.events(END_REQUESTED)).toHaveLength(1);
    expect(harness.events(ENDED)).toHaveLength(0);
    expect(provider.closed).toBe(true);
    expect(harness.state().call).not.toBeNull();

    /* Anything at all reaching head is enough to finish it. */
    harness.stream.failAppendsOfType = undefined;
    await harness.append({
      type: "events.iterate.com/voice-agent/device-presence",
      payload: { connected: true },
    });
    expect(harness.events(ENDED)).toHaveLength(1);
    expect(harness.events(ENDED)[0]!.payload).toMatchObject({ reason: IDLE_REASON });
    expect(harness.state().call).toBeNull();
  });
});

/*
 * THE EVICTION, which is where every version of this has gone wrong.
 *
 * A call is registered as background work so the Durable Object stays up
 * through the silence it is measuring. That registration also arms the
 * runner's keepalive, which REVIVES the processor after an eviction — and a
 * revived incarnation holds no socket while the fold still says a call is
 * open. MEASURED: the at-head pass re-dialled on every revival, roughly every
 * ten seconds, restarting the in-memory minute each time. An abandoned call
 * kept alive forever by the machinery meant to rescue it, one provider session
 * per lap.
 *
 * `crash()` is that eviction exactly: runtime state and pending closures die,
 * the stream, the progress record and the clock survive, and the armed alarm
 * brings a fresh incarnation back. So the fix has to be visible here or it is
 * not a fix.
 */
describe("an eviction mid-call", () => {
  const ENDED = "events.iterate.com/voice-agent/conversation-ended";
  const REVIVED = "events.iterate.com/stream/processor-revived";

  /*
   * THE CADENCE, WHICH IS A CORRECTNESS PROPERTY AND NOT A COST ONE.
   *
   * MEASURED on the platform: a worker-loader facet whose PARENT sees no
   * inbound activity for 73 seconds (±2) is corrupted — not reaped. Its timers
   * keep firing and its outbound socket keeps sending (one ran 15+ hours),
   * its storage writes start throwing, and `facets.get()` on the new parent
   * hands out a SECOND, fresh facet while the first runs on. Two live
   * incarnations, one of them a zombie holding the provider socket, which is a
   * worse failure than the idle call this whole file is about. A periodic
   * alarm on the parent is the measured fix (30s 9/9 intact, 45s 6/6, 60s 4/4,
   * 120s 0/3).
   *
   * A held call is `runInBackground` work, and the runner's keepalive re-arms
   * a durable alarm ten seconds ahead of in-flight work on EVERY fire, not
   * once — so the parent is poked six or seven times inside the minute a
   * silent call has left to live, and never approaches the threshold. This
   * test is that claim, checked rather than asserted in a comment: each crash
   * proves the alarm standing at the moment of the crash was less than eleven
   * seconds out, and doing it three times proves the re-arm rather than a
   * single park.
   */
  it("keeps the parent poked on a ten-second cadence while a call is open", async () => {
    const { harness, providers } = harnessWithFreshProviders();
    await takeTurn(harness, providers);

    for (let lap = 1; lap <= 3; lap++) {
      /* Twenty-five seconds of held call, which is two keepalive fires. A
       * keepalive owed NOTHING confirms quiet on the first of them and
       * DISARMS — leaving no alarm at all to poke the parent with — so this
       * wait is what makes the crash below measure the obligation rather than
       * some leftover alarm from the turn. */
      await harness.advanceTime(25_000);
      const revivedBefore = harness.events(REVIVED).length;
      harness.crash();
      await harness.advanceTime(11_000);

      /* The alarm standing when the incarnation died was less than eleven
       * seconds out — three laps running, so a re-arm and not a single park. */
      expect(harness.events(REVIVED).length).toBeGreaterThan(revivedBefore);
      expect(harness.state().call).not.toBeNull();

      /* The rescue is a working call again, and somebody speaks on it, so the
       * next lap measures the cadence rather than the deadline. */
      const rescued = providers.at(-1)!;
      rescued.greet();
      rescued.ready();
      await harness.settle();
      await harness.append({ type: PTT_START, payload: {} });
    }
    expect(harness.events(ENDED)).toHaveLength(0);
  });

  it("buries a call that is already past due rather than re-dialling it", async () => {
    const { harness, providers } = harnessWithFreshProviders();
    await takeTurn(harness, providers);

    /* A second short of the minute — then the incarnation holding the
     * countdown dies, taking the countdown with it. Nothing in memory can end
     * this call now; only the deadline in the fold can. */
    await harness.advanceTime(59_000);
    harness.crash();
    await harness.advanceTime(20_000);

    expect(providers).toHaveLength(1);
    expect(harness.events(END_REQUESTED)).toHaveLength(1);
    expect(harness.events(END_REQUESTED)[0]!.payload).toMatchObject({
      reason: "no utterance from either side for 60s",
    });
    expect(harness.events(ENDED)).toHaveLength(1);
    expect(harness.state().call).toBeNull();
  });

  it("gives a call its full minute even when its press is already gone", async () => {
    /*
     * THE FLOOR UNDER THE DEADLINE. A press is EPHEMERAL: it exists in the
     * incarnation that handled it and nowhere else, so an eviction seconds
     * after the dial leaves `call-started` as the only durable trace that
     * anybody spoke at all. If the fold did not take its stamp as the start of
     * the minute, a revival would read "never heard from" as "heard from at
     * the epoch" and bury a call one second old.
     */
    const { harness, providers } = harnessWithFreshProviders();
    await harness.append({ type: PTT_START, payload: {} });
    await harness.settle();
    expect(harness.events(CALL_STARTED)).toHaveLength(1);

    harness.crash();
    await harness.advanceTime(15_000);

    expect(harness.events(END_REQUESTED)).toHaveLength(0);
    expect(harness.state().call).not.toBeNull();
    expect(providers).toHaveLength(2);
  });

  it("re-dials a conversation that is still going, so a pause is not a hang-up", async () => {
    const { harness, providers } = harnessWithFreshProviders();
    await takeTurn(harness, providers);

    /* Twenty seconds into a pause, which is a person thinking. */
    await harness.advanceTime(20_000);
    harness.crash();
    await harness.advanceTime(15_000);

    expect(providers).toHaveLength(2);
    expect(harness.events(END_REQUESTED)).toHaveLength(0);
    expect(harness.state().call).not.toBeNull();
    /* And it is the SAME conversation, rescued — not a new one. */
    expect(harness.events(CALL_STARTED)).toHaveLength(1);
  });

  it("cannot be kept alive forever by the machinery meant to rescue it", async () => {
    const { harness, providers } = harnessWithFreshProviders();
    await takeTurn(harness, providers);

    /* Five minutes of eviction after eviction with nobody speaking. The old
     * shape dialled a fresh provider session on every lap; the deadline in the
     * fold does not move without an utterance, so the laps run out. */
    for (let round = 0; round < 20; round++) {
      harness.crash();
      await harness.advanceTime(15_000);
    }

    expect(harness.events(ENDED)).toHaveLength(1);
    expect(harness.state().call).toBeNull();
    /* Every rescue happened inside the first minute — four laps, not twenty. */
    expect(providers.length).toBeLessThanOrEqual(5);

    const dialled = providers.length;
    harness.crash();
    await harness.advanceTime(120_000);
    expect(providers).toHaveLength(dialled);
    expect(harness.events(ENDED)).toHaveLength(1);
  });

  it("never ages out a board that streams continuously, across an eviction", async () => {
    /* An open-mic board has no press to re-dial on, so an eviction must not be
     * allowed to read its silence-free stream as silence. Every frame it sends
     * moves the deadline in the fold, which is the only thing a revived
     * incarnation can read. */
    const { harness, providers } = harnessWithFreshProviders();
    await harness.append({ type: PTT_START, payload: { client: "/clients/stackchan" } });
    await harness.settle();
    providers[0]!.greet();
    providers[0]!.ready();
    await harness.settle();

    for (let second = 0; second < 120; second++) {
      if (second === 40 || second === 80) harness.crash();
      await harness.append(micFrame(second));
      await harness.advanceTime(1_000);
    }

    expect(harness.events(END_REQUESTED)).toHaveLength(0);
    expect(harness.events(ENDED)).toHaveLength(0);
    expect(harness.state().call).not.toBeNull();
    expect(harness.events(CALL_STARTED)).toHaveLength(1);
  });
});

describe("the face", () => {
  /*
   * THE MOUTH IS THE SERVER'S, and it had stopped moving.
   *
   * Boards have subscribed to a face lane since the sprite work landed, and
   * the classifier has had its own tests all along — but every caller lived in
   * the retiring bridge, so across the whole facet era the facet drove nothing
   * and lip-sync was silently off. Nothing failed: a client can watch for a
   * thing nobody publishes, and the only symptom is a still face.
   *
   * It is STATE, not events. Shapes arrive tens of times a second and only the
   * latest one is worth anything, so they fold into the runtime bag that
   * `liveState` publishes rather than competing with the speaker frames they
   * describe for room in a delivery batch.
   */
  /** The pose `liveState` publishes; null until the mouth has moved. */
  type FacePose = { viseme: number; answer: number; playoutSamples: number; at: number } | null;
  const face = async (harness: { processor: () => VoiceAgentFacetProcessor }) =>
    ((await harness.processor().getRuntimeState()) as { runtime: { face: FacePose } }).runtime.face;

  it("drives the mouth from the answer's audio", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();
    expect(await face(harness)).toBeNull();

    provider.speak(6400); // 200 ms of audio: enough for the tracker to move
    await harness.settle();

    const pose = await face(harness);
    expect(pose).not.toBeNull();
    expect(pose!.viseme).toBeGreaterThanOrEqual(0);
    expect(pose!.viseme).toBeLessThanOrEqual(14);
    /* Positioned against the answer the frames carry, or the mouth drifts. */
    expect(pose!.answer).toBe(harness.events(SPK_FRAME)[0]!.payload.answer);
  });

  it("closes the mouth when the answer ends", async () => {
    const provider = fakeGrok();
    const harness = harnessWith(provider);
    await harness.append({ type: PTT_START, payload: {} });
    provider.greet();
    provider.ready();
    await harness.settle();
    provider.speak(6400);
    await harness.settle();

    provider.finishAudio();
    await harness.settle();

    /* SIL is 14. A face left mid-syllable reads as a crashed board, not a
     * pause — and unlike an event, the last state is what a client sees. */
    expect((await face(harness))!.viseme).toBe(14);
  });

  it("publishes no face before anything has been said", async () => {
    const harness = harnessWith(fakeGrok());
    expect(await face(harness)).toBeNull();
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

describe("what the facet reports about itself", () => {
  /*
   * THE INSTRUMENT THAT LIED. A live facet published
   *
   *   consumeOwnAppendMs { last: 84, p50: 8661, p95: 12054, samples: 32 }
   *   appendRoundTripMs  { last: 24, p50: 24,   p95: 35,    samples: 32 }
   *
   * — a processor apparently taking nine seconds to see an event it appended
   * itself, while the append's own round trip was 24 ms. Not one of those
   * samples was a loop. They were speaker frames: a type this facet emits
   * fifty times a second and consumes never, retired by the acknowledgement
   * cursor sweeping past them when the person next spoke. The published
   * number was the gap between two sentences, and the fold it supposedly
   * indicted was never stale at all.
   *
   * `call-started` is the ONE thing this facet both emits and consumes, so
   * one turn owes exactly one sample.
   */
  it("times the append that comes back to it, and not the speaker firehose", async () => {
    const { harness, providers } = harnessWithFreshProviders();
    await takeTurn(harness, providers, 12_800);

    // Twenty frames of answer, every one of them appended by this facet.
    expect(harness.events(SPK_FRAME).length).toBeGreaterThan(10);
    expect(harness.events(CALL_STARTED)).toHaveLength(1);

    const report = harness.processor().eventConsumptionMetrics.report();
    // Every append is timed for its round trip…
    expect(report.appendRoundTripMs?.samples ?? 0).toBeGreaterThan(1);
    // …and exactly one of them was a consume-your-own-append loop.
    expect(report.consumeOwnAppendMs).toMatchObject({ samples: 1 });
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
