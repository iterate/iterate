/*
 * THE WHOLE AUDIO LANE, END TO END, IN THIS PROCESS.
 *
 * `voice-agent.count-to-100.test.ts` proves the pacing arithmetic against a
 * provider written inline in the test — a plain object whose `send` is a no-op
 * and whose events arrive synchronously because the test calls a method. That
 * is exactly what makes its answers reproducible, and exactly what makes it
 * unable to catch a disagreement about the PROTOCOL: a provider that never
 * answers a `session.update`, or ends its answer with an event the facet does
 * not handle, looks identical to a perfect one when the test itself decides
 * which events exist.
 *
 * So this drives the SAME facet against `fake-grok.ts` — the provider double
 * that speaks the realtime protocol properly, over a real WebSocket pair, with
 * every misbehaviour selectable on the query string — and feeds what comes out
 * into a simulated board with the board's real bounds. Nothing is deployed,
 * nothing is tunneled, nothing is dialled over a network, and the run is the
 * same run every time.
 *
 * TWO CLOCKS, AND KEEPING THEM APART IS THE TRICK. The facet's pacing runs on
 * the harness's VIRTUAL clock (`advanceTime` releases the drain loop's sleeps),
 * while the fake's own timers are real. They never have to agree, because the
 * fake is configured to have essentially no timers of its own: it greets a
 * millisecond after the socket opens and answers a commit immediately, in one
 * burst. Everything the test waits for is therefore a FACT on the stream —
 * "the session was accepted", "the provider finished the answer" — reached by
 * settling until it is true and failing loudly if it never becomes true. No
 * test in this file waits for a duration.
 */
import { describe, expect, it } from "vitest";
import { makeProcessorHarness } from "iterate/processors/testing";
import { createFakeGrokHandler, type FakeGrokHandler } from "../fake-grok.ts";
import { DEFAULT_SPEAKER_LIMITS, MULAW_BYTES_PER_MS } from "./speaker.ts";
import {
  dialGrokSocket,
  GROK_HANDSHAKE_DEADLINE_MS,
  VoiceAgentFacetContract,
  VoiceAgentFacetProcessor,
} from "./voice-agent.ts";

const CREATED = "events.iterate.com/voice-agent/created";
const PTT_START = "events.iterate.com/voice-agent/ptt-start";
const PTT_END = "events.iterate.com/voice-agent/ptt-end";
const MIC_FRAME = "events.iterate.com/voice-agent/mic-frame";
const ACCEPTED = "events.iterate.com/voice-agent/conversation-accepted";
const FAILED = "events.iterate.com/voice-agent/conversation-failed";
const ENDED = "events.iterate.com/voice-agent/conversation-ended";
const SPK_FRAME = "events.iterate.com/voice-agent/spk-frame";
const GROK_EVENT = "events.iterate.com/voice-agent/grok-event";

/** 16 kHz mono PCM16: 32 bytes per millisecond, exactly. */
const PCM_BYTES_PER_MS = 32;
/** The wire frame both consumers on the device require, to the byte. */
const FRAME_BYTES = 640;
/** The board's ring at the size the profile gives it: ten seconds. */
const RING_BYTES = 10_000 * PCM_BYTES_PER_MS;

/**
 * The device, for a whole call rather than one answer.
 *
 * Same bounds and the same two honest counters as the board in
 * `voice-agent.count-to-100.test.ts` — a ring that REFUSES a write when full
 * and a drain that COUNTS finding it empty, because a file sink accepts
 * everything and makes a run that lost a second sound perfect. It is copied
 * rather than imported because that file is a test file: importing it would
 * run its suites here too.
 *
 * The one difference is the fence. `clear()` re-arms it, so a `last` released
 * for the previous answer cannot excuse a gap in the next one — without that,
 * every underrun from turn two onwards reads as "already finished" and the
 * multi-turn assertions below would all pass vacuously.
 */
class Board {
  buffered = 0;
  /** Bytes refused because the ring was full — audio the listener lost. */
  refusedBytes = 0;
  /** Drains that found the ring dry AFTER playback had begun — heard as gaps. */
  underruns = 0;
  /** Bytes actually handed to the converter. */
  playedBytes = 0;
  /** Peak occupancy, which is what the ring has to be sized for. */
  peakBuffered = 0;
  #playing = false;
  #done = false;

  write(pcm: Uint8Array): void {
    if (this.buffered + pcm.length > RING_BYTES) {
      this.refusedBytes += pcm.length;
      return;
    }
    this.buffered += pcm.length;
    this.peakBuffered = Math.max(this.peakBuffered, this.buffered);
    this.#playing = true;
  }

  /** `drop`: everything held belongs to an answer that is over. */
  clear(): void {
    this.buffered = 0;
    this.#done = false;
  }

  /** `last`: the fence may be released once what is held has played out. */
  finish(): void {
    this.#done = true;
  }

  get drained(): boolean {
    return this.#done && this.buffered === 0;
  }

  /** One converter period. */
  tick(): void {
    if (!this.#playing) return;
    if (this.buffered < FRAME_BYTES) {
      if (!this.drained) this.underruns++;
      return;
    }
    this.buffered -= FRAME_BYTES;
    this.playedBytes += FRAME_BYTES;
  }
}

/**
 * The behaviour every test here shares, as query parameters.
 *
 * `sessionCreatedDelayMs=1` is load-bearing and is a property of the real
 * platform, not of this fake: a pair socket queues what is sent before the
 * other end accepts, and flushes it on `accept()` in a microtask — which is
 * scheduled BEFORE the dial's own continuation, where the facet attaches its
 * listener. A provider that greets in the same tick as the upgrade therefore
 * loses its greeting (the fake says so in its own defaults, and has a
 * `greet-instantly` script for proving it). One real millisecond is a
 * macrotask, so the listener is always there first.
 */
const IMMEDIATE = "sessionCreatedDelayMs=1&answerDelayMs=0&base64Audio=1";

/**
 * Give a pair socket the one property a platform socket has and it does not.
 *
 * captun's in-memory `WebSocketPair` says in its own doc that it implements
 * "the surface Workers code uses — accept(), send(), close(), and
 * message/close events — not every WebSocket property". `readyState` is one it
 * leaves out, and the facet asks for it on every press, deliberately: a close
 * listener can be missed, and a corpse must not look alive. Left undefined it
 * compares unequal to `OPEN`, so the second press of a conversation declares
 * the socket gone and re-dials — a new provider session per press, which is
 * the exact defect the multi-turn test below is here to detect. Completing the
 * double is therefore the honest repair; teaching the product to do without
 * the check would delete a real guard to satisfy a fake.
 */
function withReadyState(socket: WebSocket): WebSocket {
  if (socket.readyState !== undefined) return socket;
  let state: number = WebSocket.OPEN;
  Object.defineProperty(socket, "readyState", { get: () => state });
  socket.addEventListener("close", () => {
    state = WebSocket.CLOSED;
  });
  const close = socket.close.bind(socket);
  socket.close = (code?: number, reason?: string) => {
    state = WebSocket.CLOSED;
    close(code, reason);
  };
  return socket;
}

/**
 * Facet, provider and the wire between them.
 *
 * The dial is the seam the whole rig hangs off: it calls the fake's handler
 * with the URL the BIRTH CERTIFICATE named and hands back `response.webSocket`
 * exactly as `dialGrokSocket` does — same `binaryType`, same `accept()`, same
 * shape of thing. So the query string that selects the misbehaviour travels
 * the same path in a test as it does through a tunnel to a preview.
 */
function makeRig(query: string, options?: { realDial?: boolean }) {
  const fake = createFakeGrokHandler();
  const providerBaseUrl = `http://fake-grok.test/v1/realtime?${query}`;
  /** Where every dial was pointed — length is "how many calls were opened". */
  const dials: (string | null)[] = [];
  /** The URL the REAL dial asked for, when this rig is using it. */
  const asked: string[] = [];

  /** What the injected dial does, and what `dialGrokSocket` does for real. */
  const open = async (baseUrl: string | null): Promise<WebSocket | null> => {
    const target = baseUrl ?? "http://fake-grok.test/v1/realtime";
    if (options?.realDial !== true) {
      const response = await fake.handler(
        new Request(target, { headers: { Upgrade: "websocket" } }),
      );
      /* `?? null` because a platform Response has `webSocket: null` when there
       * is no socket on it, and a Node one has no such property at all. */
      const socket = response.webSocket ?? null;
      if (socket === null) return null;
      socket.binaryType = "arraybuffer"; // before accept(), as the real dial does
      socket.accept();
      return socket;
    }
    /*
     * THE REAL DIAL, WITH THE FAKE BEHIND `fetch`.
     *
     * The only way to prove the query string survives the trip is to let the
     * function that makes the trip do it: `dialGrokSocket` re-parses the URL to
     * add `model`, and a re-parse is exactly where a query string gets
     * dropped. Swapped around the one call rather than for the whole test, so
     * nothing else in the process inherits it.
     */
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      asked.push(url);
      return fake.handler(new Request(url, init));
    }) as typeof fetch;
    try {
      return await dialGrokSocket(baseUrl);
    } finally {
      globalThis.fetch = original;
    }
  };

  const harness = makeProcessorHarness<VoiceAgentFacetContract, VoiceAgentFacetProcessor>({
    path: "/agents/voice/fake-grok",
    createProcessor: (deps) =>
      new VoiceAgentFacetProcessor({
        ...deps,
        now: deps.now,
        dialGrok: async (baseUrl) => {
          dials.push(baseUrl);
          const socket = await open(baseUrl);
          return socket === null ? null : withReadyState(socket);
        },
      }),
  });
  return { asked, dials, fake, harness, providerBaseUrl, seen: 0 };
}

type Rig = ReturnType<typeof makeRig>;

/**
 * Settle until something the PROVIDER did shows up, or say what never happened.
 *
 * The harness settles to a fixpoint over microtasks; the fake's greeting and
 * its answer arrive on real timers a millisecond away, which a fixpoint can
 * legitimately finish in front of. Yielding a real tick between settles is
 * what lets those land — and because the wait is on a FACT rather than a
 * duration, a run on a slow machine takes an extra lap instead of failing, and
 * a genuinely absent event fails with its own name in the message.
 */
async function settleUntil(rig: Rig, done: () => boolean, what: string): Promise<void> {
  for (let lap = 0; lap < 500; lap++) {
    await rig.harness.settle();
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`the provider never got as far as ${what}`);
}

/** How many answers the provider has finished, from its own lane on the stream. */
function answersFinished(rig: Rig): number {
  return rig.harness
    .events(GROK_EVENT)
    .filter((row) => (row.payload.event as { type?: string } | undefined)?.type === "response.done")
    .length;
}

/** Playback milliseconds carried by a run of speaker frames, from the audio. */
function spokenMs(frames: readonly { payload: { pcm?: unknown } }[]): number {
  const bytes = frames.reduce(
    (total, frame) => total + Buffer.from(String(frame.payload.pcm ?? ""), "base64").length,
    0,
  );
  return bytes / MULAW_BYTES_PER_MS;
}

/** 20 ms of capture, the shape a client actually sends. */
const micFrame = (seq: number) => ({
  type: MIC_FRAME as typeof MIC_FRAME,
  payload: { seq, pcm: btoa(String.fromCharCode(...new Uint8Array(640).fill(seq % 251))) },
});

/** Open the call and get the provider's session up. */
async function openCall(rig: Rig): Promise<void> {
  await rig.harness.append({ type: CREATED, payload: { providerBaseUrl: rig.providerBaseUrl } });
  await rig.harness.append({ type: PTT_START, payload: {} });
  await settleUntil(rig, () => rig.harness.events(ACCEPTED).length > 0, "accepting the session");
}

/** Press, say something, let go — and wait for the provider to finish talking. */
async function takeTurn(rig: Rig, turn: number): Promise<void> {
  if (turn > 1) await rig.harness.append({ type: PTT_START, payload: {} });
  await rig.harness.append(...[0, 1, 2, 3, 4].map((seq) => micFrame(turn * 100 + seq)));
  await rig.harness.append({ type: PTT_END, payload: {} });
  await settleUntil(rig, () => answersFinished(rig) >= turn, `finishing answer ${turn}`);
}

/**
 * Make the append carrying the clear LOSE its race, once, on purpose.
 *
 * A race whose loser cannot be pinned is a flake rather than a test, so this
 * decides the outcome instead of hoping for it: the batch carrying `drop` is
 * held before it takes an offset, and released the moment any other speaker
 * frame commits ahead of it. Everything else commits at once, so the rest of
 * the run is the run it would otherwise have been.
 *
 * THE BUDGET IS THE POINT, not a safety net. Once the lane has ONE append
 * order, nothing can overtake this batch — that is the fix — so a hold that
 * waited for an overtake would wait for ever and hang the suite that proves
 * it. Bounded, the same test says "held, and still first" on a fixed lane and
 * "held, and overtaken" on a broken one.
 */
function makeTheClearLoseItsRace(rig: Rig): void {
  const framesCommitted = () => rig.harness.events(SPK_FRAME).length;
  let armed = true;
  rig.harness.stream.holdAppend = (events) => {
    if (!armed) return undefined;
    if (!events.some((event) => event.payload?.["drop"] === true)) return undefined;
    armed = false;
    const committedBefore = framesCommitted();
    return (async () => {
      for (let tick = 0; tick < 200 && framesCommitted() === committedBefore; tick++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();
  };
}

/**
 * Take a turn with the CLOCK MOVING, so the previous answer's drain loop wakes
 * while this answer is arriving.
 *
 * {@link takeTurn} settles on real timers alone, which leaves the pacer asleep
 * on a virtual clock that never advances — the one appender the shape under
 * test needs awake.
 */
async function takeTurnWhilePacing(rig: Rig, turn: number): Promise<void> {
  await rig.harness.append({ type: PTT_START, payload: {} });
  await rig.harness.append(...[0, 1, 2, 3, 4].map((seq) => micFrame(turn * 100 + seq)));
  await rig.harness.append({ type: PTT_END, payload: {} });
  for (let lap = 0; lap < 500; lap++) {
    if (answersFinished(rig) >= turn) return;
    await rig.harness.advanceTime(100);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`the provider never got as far as finishing answer ${turn}`);
}

/** Move the clock until the answer's closing chunk has been appended. */
async function drainTheAnswer(rig: Rig): Promise<void> {
  for (let lap = 0; lap < 1_000; lap++) {
    if (rig.harness.events(SPK_FRAME).some((frame) => frame.payload.last === true)) return;
    await rig.harness.advanceTime(100);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("the answer's closing chunk never went out");
}

/**
 * Play the answer out on the virtual clock and report what the listener got.
 *
 * The clock moves in `stepMs` slices: everything the facet appended during a
 * slice is written to the board at the end of it, then the board drains that
 * slice's worth of frames — the order a real device sees, since delivery and
 * playback are independent of each other.
 */
async function playOut(rig: Rig, board: Board, budgetMs: number, stepMs = 100) {
  const before = { refused: board.refusedBytes, underruns: board.underruns };
  let drops = 0;
  let lasts = 0;
  let events = 0;
  let mulawBytes = 0;
  let elapsedMs = 0;
  for (; elapsedMs < budgetMs; elapsedMs += stepMs) {
    const fresh = rig.harness.events(SPK_FRAME).slice(rig.seen);
    rig.seen += fresh.length;
    for (const event of fresh) {
      events++;
      if (event.payload.drop === true) {
        drops++;
        board.clear();
      }
      const mulaw = Buffer.from(String(event.payload.pcm), "base64");
      mulawBytes += mulaw.length;
      /* Mu-law expands two-for-one into the PCM16 the converter plays. */
      if (mulaw.length > 0) board.write(new Uint8Array(mulaw.length * 2));
      if (event.payload.last === true) {
        lasts++;
        board.finish();
      }
    }
    for (let frame = 0; frame < stepMs / 20; frame++) board.tick();
    if (board.drained && lasts > 0) break;
    await rig.harness.advanceTime(stepMs);
  }
  return {
    drops,
    elapsedMs,
    events,
    lasts,
    /** Playback milliseconds the device was handed, from the audio itself. */
    receivedMs: mulawBytes / MULAW_BYTES_PER_MS,
    refusedBytes: board.refusedBytes - before.refused,
    underruns: board.underruns - before.underruns,
  };
}

/**
 * What the provider says it sent, in playback ms — the honest left-hand side.
 *
 * Summed over every session it opened, so a call that was secretly re-dialled
 * cannot make its second answer look like nothing was sent.
 */
function providerMs(rig: Rig): number {
  return (
    rig.fake.sessions.reduce((total, session) => total + session.speakerBytes, 0) / PCM_BYTES_PER_MS
  );
}

describe("ninety seconds from a provider that speaks the protocol", () => {
  it("delivers the whole answer, at the speed of speech, and says when it ends", async () => {
    /*
     * The count-to-100 shape, from the fake's own `flood` script: ninety
     * seconds of audio handed over in one burst, which is what a real provider
     * does and what every audible defect in this lane has come from.
     */
    const rig = makeRig(`script=flood&${IMMEDIATE}`);
    const board = new Board();
    await openCall(rig);
    await takeTurn(rig, 1);

    const answer = await playOut(rig, board, 200_000);

    /* NOTHING LOST. What the device was handed is what the provider sent, plus
     * at most the one frame of silence the tail is padded up to. */
    expect(providerMs(rig)).toBe(90_000);
    expect(answer.receivedMs).toBeGreaterThanOrEqual(providerMs(rig));
    expect(answer.receivedMs).toBeLessThan(providerMs(rig) + DEFAULT_SPEAKER_LIMITS.frameMs * 2);

    /* NOTHING REFUSED. Invisible in a recording — a frame refused on arrival
     * was never a frame that went missing — and the reason this board exists. */
    expect(answer.refusedBytes).toBe(0);

    /* NO GAPS. An underrun after playback began is silence heard mid-sentence. */
    expect(answer.underruns).toBe(0);

    /* NO SPEED-UP. Handing over takes about as long as saying it; when the
     * sender outran the listener the device clawed back by skipping frames. */
    expect(answer.elapsedMs).toBeGreaterThan(90_000 - DEFAULT_SPEAKER_LIMITS.leadMs - 1_000);
    expect(answer.elapsedMs).toBeLessThan(90_000 + 5_000);

    /* BOUNDED. The ring only has to hold the sender's lead. */
    expect(board.peakBuffered / PCM_BYTES_PER_MS).toBeLessThanOrEqual(
      DEFAULT_SPEAKER_LIMITS.leadMs + 500,
    );
    expect(board.peakBuffered).toBeLessThan(RING_BYTES / 2);

    /* ONE CLEAR AND ONE END, and the end is the bug this file was written for:
     * the provider's answer finishes with `response.done`, and until that was
     * handled the closing chunk never went out at all. */
    expect(answer.drops).toBe(1);
    expect(answer.lasts).toBe(1);
  }, 120_000);
});

describe("a conversation is one call across many presses", () => {
  it("holds every invariant on all four turns, on one dial", async () => {
    /*
     * FOUR TURNS ON ONE SOCKET. Eight seconds each rather than ninety, because
     * what a second turn can break is not the arithmetic — that is proven
     * above — but the STATE between turns: a speaker left closed, a fence
     * never re-armed, a drain loop that exited and cannot be restarted, an
     * answer whose `drop` never came so the previous tail plays under it.
     */
    const rig = makeRig(`answerSeconds=8&burst=1&${IMMEDIATE}`);
    const board = new Board();
    await openCall(rig);

    let sentSoFar = 0;
    for (const turn of [1, 2, 3, 4]) {
      await takeTurn(rig, turn);
      const answer = await playOut(rig, board, 60_000);
      const thisAnswerMs = providerMs(rig) - sentSoFar;
      sentSoFar = providerMs(rig);

      expect(thisAnswerMs, `turn ${turn} provider audio`).toBe(8_000);
      expect(answer.receivedMs, `turn ${turn} delivered`).toBeGreaterThanOrEqual(thisAnswerMs);
      expect(answer.receivedMs, `turn ${turn} delivered`).toBeLessThan(
        thisAnswerMs + DEFAULT_SPEAKER_LIMITS.frameMs * 2,
      );
      expect(answer.refusedBytes, `turn ${turn} refused`).toBe(0);
      expect(answer.underruns, `turn ${turn} underruns`).toBe(0);
      expect(answer.drops, `turn ${turn} drops`).toBe(1);
      expect(answer.lasts, `turn ${turn} lasts`).toBe(1);
      expect(answer.elapsedMs, `turn ${turn} elapsed`).toBeGreaterThan(
        8_000 - DEFAULT_SPEAKER_LIMITS.leadMs - 1_000,
      );
      expect(answer.elapsedMs, `turn ${turn} elapsed`).toBeLessThan(8_000 + 5_000);
    }

    /* ONE CALL. A second dial here would mean a fresh provider session per
     * press — a new conversation every time somebody speaks, with none of the
     * history that makes the next answer follow from the last. */
    expect(rig.dials).toEqual([rig.providerBaseUrl]);
    expect(rig.fake.sessions).toHaveLength(1);
    expect(rig.fake.sessions[0]!.commits).toBe(4);
    expect(rig.fake.sessions[0]!.closedAt).toBeNull();
    /* And the capture reached the provider on every one of those turns. */
    expect(rig.fake.sessions[0]!.micBytesByTurn).toEqual([3_200, 3_200, 3_200, 3_200]);
    expect(board.peakBuffered / PCM_BYTES_PER_MS).toBeLessThanOrEqual(
      DEFAULT_SPEAKER_LIMITS.leadMs + 500,
    );
  }, 120_000);
});

describe("the clear that opens an answer", () => {
  /*
   * BUG 12, AND THE HARNESS CAPABILITY IT NEEDED.
   *
   * `#drainSpeaker` appends the speaker lane from two places. The provider's
   * delta handler appends UN-AWAITED, straight off the socket-message turn;
   * the pacer's drain loop AWAITS its own. A conversation is one call across
   * many answers, so when a new answer begins the PREVIOUS answer's loop is
   * usually still alive — it exits only on `nextWakeMs === null` — and the two
   * appenders are then in flight against the same lane at the same time with
   * nothing ordering them.
   *
   * The chunk that loses is the one that matters: `speakerReplace` arms `drop`
   * on the first chunk of the new answer, so a lost race lands the CLEAR
   * behind audio it then tells the device to throw away. Measured on the mock
   * against real boards: 0.7 s gone on turn 2 and 2.0 s on turn 4, to
   * `spkDiscarded`, with every clock counter (`spkCatchup`, `spkLagMaxMs`,
   * `spkStarvedMs`) reading zero. Never once on turn 1 — the only answer with
   * no pacer loop already running.
   *
   * WHY THIS COULD NOT BE WRITTEN BEFORE. The in-memory stream committed an
   * append inside `append`'s own synchronous body, so the order two call sites
   * committed in was the order they called in and the inversion was
   * unreachable. `holdAppend` is that limitation removed: it holds a batch
   * before it takes an offset, so a test can say WHICH of two in-flight
   * appends wins instead of waiting to see.
   */
  it("is appended ahead of every chunk of the answer it clears for", async () => {
    /* Six seconds handed over in one burst, so the pacer owes the listener
     * several seconds of audio for several seconds of clock — which is the
     * window in which the next answer starts. */
    const rig = makeRig(`answerSeconds=6&burst=1&${IMMEDIATE}`);
    await openCall(rig);
    await takeTurn(rig, 1);
    await rig.harness.advanceTime(1_000);

    /* THE PREMISE, ASSERTED RATHER THAN ASSUMED: answer 1 is still going out.
     * With it fully delivered the pacer would have exited and this test would
     * pass on a call that never had two appenders in it at all. */
    const beforeTheSecondAnswer = spokenMs(rig.harness.events(SPK_FRAME));
    expect(beforeTheSecondAnswer).toBeGreaterThan(0);
    expect(beforeTheSecondAnswer).toBeLessThan(6_000);

    makeTheClearLoseItsRace(rig);
    await takeTurnWhilePacing(rig, 2);
    await drainTheAnswer(rig);

    /*
     * THE INVARIANT, IN THE UNITS OF THE BUG. Answer 2 is exactly six seconds
     * and exactly one of its chunks carries `drop`, so every millisecond of it
     * has to be at or after that chunk. Anything missing from the run that
     * starts there was committed AHEAD of the clear — audio the device is
     * handed and then told to discard.
     */
    const frames = rig.harness.events(SPK_FRAME);
    let clearAt = -1;
    for (const [index, frame] of frames.entries()) {
      if (frame.payload.drop === true) clearAt = index;
    }
    expect(clearAt).toBeGreaterThan(0);
    const heardOfTheSecondAnswer = spokenMs(frames.slice(clearAt));
    expect(6_000 - heardOfTheSecondAnswer, "ms of the new answer appended before its clear").toBe(
      0,
    );

    /* And the whole answer really did go out, so the line above cannot pass by
     * the answer being short rather than by the clear being first. */
    expect(heardOfTheSecondAnswer).toBe(6_000);
    expect(frames.filter((frame) => frame.payload.drop === true)).toHaveLength(2);
    expect(frames.filter((frame) => frame.payload.last === true)).toHaveLength(1);
  }, 120_000);
});

describe("the end of an answer", () => {
  /*
   * THE BUG, ON ITS OWN, IN A SECOND OF AUDIO.
   *
   * The facet closed an answer only on `response.output_audio.done` — a name
   * that appears nowhere else in this repository. The provider's actual end of
   * turn is `response.done`: it is what the retired bridge keyed the floor off,
   * what `direct.ts` counts turns with against the real xAI endpoint, and what
   * `fake-grok.ts` sends. Handled by neither name, `speakerComplete` never ran,
   * so no chunk was ever marked `last`, so the device's fence was never
   * released — a reply that plays and then a board that has gone deaf.
   *
   * Both existing facet suites missed it for the same reason: their inline
   * providers were written alongside the implementation and send the event it
   * happens to handle. This one sends what a provider sends.
   */
  it("is `response.done`, whatever else the provider does or does not send", async () => {
    const rig = makeRig(`answerSeconds=1&burst=1&${IMMEDIATE}`);
    const board = new Board();
    await openCall(rig);
    await takeTurn(rig, 1);

    const seen = rig.harness
      .events(GROK_EVENT)
      .map((row) => (row.payload.event as { type?: string } | undefined)?.type);
    expect(seen).toContain("response.done");
    expect(seen).not.toContain("response.output_audio.done");

    const answer = await playOut(rig, board, 20_000);
    expect(answer.lasts).toBe(1);
    expect(answer.receivedMs).toBeGreaterThanOrEqual(1_000);
  }, 60_000);
});

describe("the handler is the provider, with no tunnel under it", () => {
  it("selects its misbehaviour from the query string it was dialled with", async () => {
    /*
     * `?script=no-answer` is `ignoreCommits`: the provider takes the turn and
     * never answers it. Proving the selection works in-process is what makes
     * every other misbehaviour in `fake-grok.ts` reachable from a unit test —
     * they all arrive the same way.
     */
    const rig = makeRig(`script=no-answer&${IMMEDIATE}`);
    await openCall(rig);
    await rig.harness.append({ type: PTT_END, payload: {} });
    await settleUntil(
      rig,
      () => rig.fake.sessions[0]!.commits > 0,
      "acknowledging the commit it will not answer",
    );

    expect(rig.fake.sessions[0]!.script).toBe("no-answer");
    expect(rig.fake.sessions[0]!.answers).toBe(0);
    expect(rig.harness.events(SPK_FRAME)).toHaveLength(0);
  }, 60_000);

  it("hands out a client socket whose peer is a session in the log", async () => {
    const fake: FakeGrokHandler = createFakeGrokHandler();
    const plain = await fake.handler(new Request("http://fake-grok.test/v1/realtime"));
    expect(plain.webSocket ?? null).toBeNull();
    expect(fake.sessions).toHaveLength(0);

    const upgraded = await fake.handler(
      new Request("http://fake-grok.test/v1/realtime?script=tool", {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(upgraded.webSocket).not.toBeNull();
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0]!.script).toBe("tool");
    expect(fake.log.join("\n")).toContain("session 1 open (script=tool)");

    fake.close();
    expect(fake.sessions[0]!.closedBy).toBe("fake grok shut down");
  });
});

describe("the query string is the whole control surface", () => {
  /*
   * WHY THIS MATTERS BEYOND THIS FILE. A deployed facet is dialled by a worker
   * on someone else's machine; the only thing a driver can hand it is the URL
   * on the `voice-agent/created` event. So every knob has to survive
   * `dialGrokSocket`, which re-parses that URL to add `model` — and a re-parse
   * that built a fresh URL from origin and path would silently drop the lot,
   * leaving a scenario that ran perfectly as its own default.
   */
  it("survives the real dial, which adds a model and changes nothing else", async () => {
    const rig = makeRig(`answerSeconds=3&burst=1&${IMMEDIATE}`, { realDial: true });
    const board = new Board();
    await openCall(rig);
    await takeTurn(rig, 1);

    expect(rig.asked).toHaveLength(1);
    const asked = new URL(rig.asked[0]!);
    expect(asked.searchParams.get("answerSeconds")).toBe("3");
    expect(asked.searchParams.get("burst")).toBe("1");
    expect(asked.searchParams.get("base64Audio")).toBe("1");
    expect(asked.searchParams.get("model")).toBe("grok-voice-think-fast-2.0");

    /* And they were OBEYED, which the URL alone does not prove: the fake
     * resolved them into its behaviour and said exactly three seconds. */
    expect(rig.fake.sessions[0]!.behaviour.answerSeconds).toBe(3);
    expect(providerMs(rig)).toBe(3_000);
    const answer = await playOut(rig, board, 30_000);
    expect(answer.receivedMs).toBeGreaterThanOrEqual(3_000);
    expect(answer.underruns).toBe(0);
    expect(answer.lasts).toBe(1);
  }, 60_000);
});

describe("a door that is slow to open", () => {
  /*
   * TWO CLOCKS AGAIN, AND HERE THEY ARE BOTH THE POINT. The upgrade is held in
   * REAL time (a few hundred ms — long enough that it is still pending while
   * the test runs, short enough not to be a wait), and the bridge's ten-second
   * handshake deadline is crossed on the VIRTUAL clock. A real deployment sets
   * `upgradeDelayMs` either side of that deadline in wall-clock seconds
   * instead; the presets do exactly that and are checked below.
   */
  it("holds the upgrade for as long as the query string says", async () => {
    const fake = createFakeGrokHandler();
    const startedAt = Date.now();
    const response = await fake.handler(
      new Request("http://fake-grok.test/v1/realtime?upgradeDelayMs=120", {
        headers: { Upgrade: "websocket" },
      }),
    );
    /* Never early. The upper bound is deliberately absent: a machine under
     * load may take longer, and asserting it would buy nothing but flakes. */
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(115);
    expect(response.webSocket).not.toBeNull();
    /* The dial was recorded when it ARRIVED, not when it was answered — which
     * is what tells "still connecting" apart from "never asked". */
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0]!.behaviour.upgradeDelayMs).toBe(120);
    expect(fake.log.join("\n")).toContain("holding the upgrade for 120ms");
  });

  it("keeps one call while a dial inside the deadline is still connecting", async () => {
    const rig = makeRig(`upgradeDelayMs=250&${IMMEDIATE}`);
    await rig.harness.append({
      type: CREATED,
      payload: { providerBaseUrl: rig.providerBaseUrl },
    });
    await rig.harness.append({ type: PTT_START, payload: {} });
    expect(rig.dials).toHaveLength(1);
    expect(rig.fake.sessions[0]!.received).toHaveLength(0); // nobody has said anything yet

    /* Five seconds later — inside the deadline — the presser tries again. That
     * press belongs to the call already dialling; opening a second one would
     * leave the first socket to arrive with nobody expecting it. */
    await rig.harness.advanceTime(5_000);
    await rig.harness.append({ type: PTT_START, payload: {} });
    expect(rig.dials).toHaveLength(1);
    expect(rig.harness.events(ENDED)).toHaveLength(0);

    await settleUntil(
      rig,
      () => rig.fake.sessions[0]!.received.includes("session.update"),
      "getting its greeting answered",
    );
    expect(rig.fake.sessions).toHaveLength(1);
  }, 60_000);

  it("gives up on one that has passed the deadline, and dials again", async () => {
    const rig = makeRig(`upgradeDelayMs=400&${IMMEDIATE}`);
    await rig.harness.append({
      type: CREATED,
      payload: { providerBaseUrl: rig.providerBaseUrl },
    });
    await rig.harness.append({ type: PTT_START, payload: {} });
    expect(rig.dials).toHaveLength(1);

    /*
     * Eleven seconds of nothing. A press now must NOT fold into a handshake
     * that is never going to finish: measured on a real stream, four
     * consecutive presses folded into one such dial, with no acceptance and no
     * failure ever written — a call that was immortal and silent at once.
     */
    await rig.harness.advanceTime(11_000);
    await rig.harness.append({ type: PTT_START, payload: {} });

    expect(rig.dials).toHaveLength(2);
    expect(rig.fake.sessions).toHaveLength(2);
    const reasons = rig.harness.events(ENDED).map((row) => String(row.payload.reason));
    expect(reasons).toContain("provider handshake never completed");
  }, 60_000);

  it("says so on the stream when the provider shuts the door", async () => {
    /*
     * THROUGH THE REAL DIAL, because that is where this went wrong. A refused
     * upgrade has no socket on its response, and `dialGrokSocket` tested for
     * that with `=== null` — true of a platform Response, and not of every
     * one: where the property is simply ABSENT the check passes the undefined
     * through and the next line throws. The call still failed, but it failed
     * with `TypeError: Cannot set properties of undefined (setting
     * 'binaryType')` written on the stream where the reason should be, and no
     * refusal could be exercised in-process at all.
     */
    const rig = makeRig(`refuseUpgrade=1&upgradeStatus=429&${IMMEDIATE}`, { realDial: true });
    await rig.harness.append({
      type: CREATED,
      payload: { providerBaseUrl: rig.providerBaseUrl },
    });
    await rig.harness.append({ type: PTT_START, payload: {} });
    await settleUntil(rig, () => rig.harness.events(FAILED).length > 0, "refusing the upgrade");

    /* A refusal is a FACT on the stream, not a silence: a device that hears
     * nothing cannot tell "still connecting" from "never going to happen". */
    const failed = rig.harness.events(FAILED);
    expect(String(failed[0]!.payload.reason)).toContain("provider refused the websocket upgrade");
    expect(rig.fake.sessions[0]!.closedBy).toBe("refused the upgrade (429)");
    expect(rig.harness.events(SPK_FRAME)).toHaveLength(0);
  }, 60_000);

  it("refuses with the status the query string asked for", async () => {
    const fake = createFakeGrokHandler();
    const upgrade = (query: string) =>
      fake.handler(
        new Request(`http://fake-grok.test/v1/realtime?${query}`, {
          headers: { Upgrade: "websocket" },
        }),
      );
    expect((await upgrade("refuseUpgrade=1&upgradeStatus=429")).status).toBe(429);
    expect((await upgrade("refuseUpgrade=1&upgradeStatus=503")).status).toBe(503);
    expect((await upgrade("script=refused")).status).toBe(502);
    /* THE TRAP THE DOC WARNS ABOUT: a status with nothing refusing is inert. */
    const fine = await upgrade("upgradeStatus=429");
    expect(fine.webSocket).not.toBeNull();
  });
});

describe("a provider that is slow to speak", () => {
  it("takes the turn at once and the first word later", async () => {
    /*
     * `firstDeltaDelayMs` against `answerDelayMs`, which is the distinction
     * worth having: this one leaves `response.created` where it was, so the
     * turn is visibly taken on time and only the audio is late. Six hundred
     * milliseconds, real, because the fake's timers are real ones.
     */
    const rig = makeRig(`answerSeconds=0.5&burst=1&firstDeltaDelayMs=600&${IMMEDIATE}`);
    await openCall(rig);
    const pressedAt = Date.now();
    await rig.harness.append({ type: PTT_END, payload: {} });
    await settleUntil(rig, () => rig.fake.sessions[0]!.responseCreates > 0, "taking the turn");

    /* Taken, and not a byte of it said yet. */
    expect(rig.fake.sessions[0]!.speakerBytes).toBe(0);
    expect(rig.harness.events(SPK_FRAME)).toHaveLength(0);

    await settleUntil(rig, () => rig.harness.events(SPK_FRAME).length > 0, "saying anything");
    /* Never early: the first frame cannot leave before the provider produces
     * it, and the provider was told to wait six hundred milliseconds. */
    expect(Date.now() - pressedAt).toBeGreaterThanOrEqual(590);
    expect(rig.fake.sessions[0]!.behaviour.firstDeltaDelayMs).toBe(600);
  }, 60_000);

  it("spaces its deltas by the gap it was given", async () => {
    /*
     * Three 100 ms chunks, 300 ms apart: 900 ms of provider for 300 ms of
     * speech. The derived default would have paced the same answer in 270 ms
     * (90% of each chunk's own playback time), so the lower bound below is a
     * measurement of the knob and not of the default.
     */
    const rig = makeRig(
      `answerSeconds=0.3&burst=0&audioChunkBytes=3200&deltaGapMs=300&${IMMEDIATE}`,
    );
    await openCall(rig);
    const pressedAt = Date.now();
    await rig.harness.append({ type: PTT_END, payload: {} });
    await settleUntil(rig, () => answersFinished(rig) >= 1, "finishing an answer it drags out");

    expect(Date.now() - pressedAt).toBeGreaterThanOrEqual(800);
    expect(rig.fake.sessions[0]!.behaviour.deltaGapMs).toBe(300);
    expect(providerMs(rig)).toBe(300);
  }, 60_000);
});

describe("the connection presets", () => {
  it("straddle the deadline the bridge actually enforces", async () => {
    /*
     * Read off the SESSION rather than waited for: `dead-connect` holds its
     * upgrade for twelve seconds, and a test that sat through that to find out
     * which preset it got would simply never be written. The deadline is
     * imported from the facet for the same reason — a copy of the number here
     * would go stale the day it moves, and the presets would quietly stop
     * straddling anything.
     */
    const fake = createFakeGrokHandler();
    const upgrade = (script: string) =>
      fake.handler(
        new Request(`http://fake-grok.test/v1/realtime?script=${script}`, {
          headers: { Upgrade: "websocket" },
        }),
      );
    const slow = upgrade("slow-connect");
    const dead = upgrade("dead-connect");

    expect(fake.sessions.map((session) => session.behaviour.upgradeDelayMs)).toEqual([
      8_000, 12_000,
    ]);
    expect(fake.sessions[0]!.behaviour.upgradeDelayMs).toBeLessThan(GROK_HANDSHAKE_DEADLINE_MS);
    expect(fake.sessions[1]!.behaviour.upgradeDelayMs).toBeGreaterThan(GROK_HANDSHAKE_DEADLINE_MS);

    /* And nothing is left holding the process open: closing releases a door
     * nobody is standing at with the refusal a caller can act on. */
    fake.close();
    expect((await slow).status).toBe(503);
    expect((await dead).status).toBe(503);
    expect(fake.sessions.map((session) => session.closedBy)).toEqual([
      "shut down mid-upgrade",
      "shut down mid-upgrade",
    ]);
  });

  it("mean what their names say", async () => {
    const fake = createFakeGrokHandler();
    const behaviourOf = async (script: string) => {
      await fake.handler(
        new Request(`http://fake-grok.test/v1/realtime?script=${script}&upgradeDelayMs=0`, {
          headers: { Upgrade: "websocket" },
        }),
      );
      return fake.sessions.at(-1)!.behaviour;
    };
    expect((await behaviourOf("slow-first-token")).firstDeltaDelayMs).toBe(3_000);
    expect((await behaviourOf("slow-first-token")).answerDelayMs).toBe(150); // untouched
    const slowSpeech = await behaviourOf("slow-speech");
    expect(slowSpeech.deltaGapMs).toBe(600);
    expect(slowSpeech.burst).toBe(false);
    /* Slower than the speech it carries — which is the whole scenario, and the
     * reason its doc says an underrun there is a pass. */
    expect(slowSpeech.deltaGapMs).toBeGreaterThan(slowSpeech.audioChunkBytes / PCM_BYTES_PER_MS);
    expect((await behaviourOf("refused")).refuseUpgrade).toBe(true);
    fake.close();
  });
});
