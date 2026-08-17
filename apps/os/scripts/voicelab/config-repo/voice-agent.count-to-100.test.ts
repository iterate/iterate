/*
 * COUNT TO ONE HUNDRED, WITH A BOARD ON THE OTHER END.
 *
 * The failure this file exists to prevent cannot be seen in a unit test of the
 * pacer and cannot be seen in a unit test of the firmware: it lives in the
 * relationship between them. The provider hands over ninety seconds of speech
 * in a few seconds; the device can hold ten and drains at exactly fifty frames
 * a second, forever, whether or not anyone has a frame for it. Every audible
 * defect this system has had — the tail chopped, the speech sped up, the reply
 * that plays and then goes deaf — is a disagreement between those two rates.
 *
 * So this drives the REAL facet against a simulated provider, and feeds what
 * it emits into a simulated board with the board's actual bounds. No network,
 * no hardware, no speaker, and the same run every time.
 *
 * What it asserts is what a listener would say: every word arrived, in order,
 * none was dropped for want of room, and the answer took as long to hand over
 * as it takes to say.
 */
import { describe, expect, it } from "vitest";
import { makeProcessorHarness } from "iterate/processors/testing";
import { VoiceAgentFacetContract, VoiceAgentFacetProcessor } from "./voice-agent.ts";
import { DEFAULT_SPEAKER_LIMITS } from "./speaker.ts";

const PTT_START = "events.iterate.com/voice-agent/ptt-start";
const PTT_END = "events.iterate.com/voice-agent/ptt-end";
const SPK_FRAME = "events.iterate.com/voice-agent/spk-frame";

/** 16 kHz mono PCM16: 32 bytes per millisecond, exactly. */
const PCM_BYTES_PER_MS = 32;
/** The wire frame both consumers on the device require, to the byte. */
const FRAME_BYTES = 640;

/**
 * The board's ring, at the size the profile gives it.
 *
 * Ten seconds. It used to be thirty, on the explicit theory that the ring "IS
 * the answer" because the sender would not pace — which is the inversion this
 * whole change undoes.
 */
const RING_BYTES = 10_000 * PCM_BYTES_PER_MS;

/** base64 without spreading a megabyte across an argument list. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 4096) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 4096));
  }
  return btoa(binary);
}

/** A provider that says a given number of milliseconds, as fast as the wire allows. */
function fakeGrok() {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const socket = {
    readyState: 1 as number,
    addEventListener(kind: string, listener: (event: unknown) => void) {
      listeners.set(kind, [...(listeners.get(kind) ?? []), listener]);
    },
    send() {},
    close() {
      socket.readyState = 3;
    },
  };
  const emit = (payload: Record<string, unknown>) => {
    for (const listener of listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(payload) });
    }
  };
  return {
    socket: socket as unknown as WebSocket,
    greet: () => emit({ type: "session.created" }),
    ready: () => emit({ type: "session.updated" }),
    /**
     * Say `ms` of speech, in the ragged deltas a real provider sends, all at
     * once. Each byte is its own position mod 251, so the receiving end can
     * prove ORDER and COMPLETENESS by content and not merely by length.
     */
    say(ms: number, deltaMs = 300) {
      emit({ type: "response.created" });
      const total = ms * PCM_BYTES_PER_MS;
      const step = deltaMs * PCM_BYTES_PER_MS;
      for (let at = 0; at < total; at += step) {
        const slice = new Uint8Array(Math.min(step, total - at));
        for (let index = 0; index < slice.length; index++) {
          /* PCM16 little-endian: vary the high byte only, so mu-law survives
           * the round trip well enough to compare sample count, and keep the
           * low byte zero so the pattern is readable in a hex dump. */
          slice[index] = index % 2 === 1 ? ((at + index) >> 1) % 127 : 0;
        }
        emit({ type: "response.output_audio.delta", delta: toBase64(slice) });
      }
      emit({ type: "response.output_audio.done" });
    },
  };
}

/**
 * A converter that takes one frame every 20 ms and does not care whether you
 * had one.
 *
 * The point of modelling it is that a file sink cannot: a file accepts every
 * frame instantly, can never be full and can never run dry, so a run that
 * dropped a second of speech produces a recording that is simply a second
 * shorter and sounds perfect. Refusing a write into a full ring and counting a
 * drain that found it empty are the only two honest records of what a listener
 * would have heard.
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

function harnessWith(provider: ReturnType<typeof fakeGrok>) {
  return makeProcessorHarness<VoiceAgentFacetContract, VoiceAgentFacetProcessor>({
    path: "/agents/voice/count",
    createProcessor: (deps) =>
      new VoiceAgentFacetProcessor({
        ...deps,
        now: deps.now,
        dialGrok: async () => provider.socket,
      }),
  });
}

/**
 * Run one answer end to end and report what the listener got.
 *
 * The clock moves in `stepMs` slices. Everything the facet appended during a
 * slice is written to the board at the end of it, then the board drains that
 * slice's worth of frames — which is the same order a real device sees, since
 * delivery and playback are independent.
 */
async function playAnswer(answerMs: number, stepMs = 100) {
  const provider = fakeGrok();
  const harness = harnessWith(provider);
  await harness.append({ type: PTT_START, payload: {} });
  await harness.settle();
  provider.greet();
  provider.ready();
  await harness.settle();
  await harness.append({ type: PTT_END, payload: {} });
  await harness.settle();

  provider.say(answerMs);
  await harness.settle();

  const board = new Board();
  const received: number[] = [];
  let seen = 0;
  let drops = 0;
  let lasts = 0;
  let elapsedMs = 0;

  /* Generous: the answer's own length plus room to prove it does not overrun. */
  const budgetMs = answerMs * 2 + 20_000;
  for (; elapsedMs < budgetMs; elapsedMs += stepMs) {
    const fresh = harness.events(SPK_FRAME).slice(seen);
    seen += fresh.length;
    for (const event of fresh) {
      const pcm = String(event.payload.pcm);
      if (event.payload.drop === true) {
        drops++;
        board.clear();
      }
      const mulaw = Buffer.from(pcm, "base64");
      received.push(mulaw.length);
      /* Mu-law expands two-for-one into the PCM16 the converter plays. */
      if (mulaw.length > 0) board.write(new Uint8Array(mulaw.length * 2));
      if (event.payload.last === true) {
        lasts++;
        board.finish();
      }
    }
    for (let frame = 0; frame < stepMs / 20; frame++) board.tick();
    if (board.drained && lasts > 0) break;
    await harness.advanceTime(stepMs);
  }

  const mulawBytes = received.reduce((total, length) => total + length, 0);
  return {
    board,
    drops,
    lasts,
    elapsedMs,
    events: received.length,
    /** Playback milliseconds the device was handed, from the audio itself. */
    receivedMs: mulawBytes / 16,
  };
}

describe("counting to one hundred", () => {
  /*
   * Ninety seconds is the real prompt. A count to one hundred at a natural
   * pace is about that long, and it is the one that has broken every previous
   * version of this lane, on the CLI and on the HA Voice PE both.
   */
  it("hands over ninety seconds of speech without losing a word", async () => {
    const { board, receivedMs, drops, lasts } = await playAnswer(90_000);

    /* EVERY WORD. Padding rounds the tail up to a whole frame and nothing else
     * is added, so the device is handed the answer and at most 20 ms more. */
    expect(receivedMs).toBeGreaterThanOrEqual(90_000);
    expect(receivedMs).toBeLessThan(90_000 + DEFAULT_SPEAKER_LIMITS.frameMs * 2);

    /* NOT ONE BYTE REFUSED. This is the failure that produced "2080 frames —
     * forty-one seconds of speech — discarded at the door for want of room",
     * and it is invisible in a recording, because a frame refused on arrival
     * was never a frame that went missing. */
    expect(board.refusedBytes).toBe(0);

    /* AND NO GAPS. An underrun after playback has begun is silence a listener
     * heard in the middle of a sentence. */
    expect(board.underruns).toBe(0);

    expect(drops).toBe(1);
    expect(lasts).toBe(1);
  }, 60_000);

  it("is not guillotined by the idle deadline while it is still speaking", async () => {
    /*
     * THE SIXTY-SECOND CUT, and it is the reason a count to one hundred "went
     * terribly" rather than merely sounding rough.
     *
     * A conversation ends after a minute with nothing said either way, and
     * "said" was measured from provider traffic. But the provider hands over a
     * ninety-second answer in a few seconds and then goes quiet — so from its
     * last delta the countdown ran unopposed, and at sixty seconds it ended a
     * call that was still mid-sentence. MEASURED here before the fix: 63 s of
     * 90 s delivered, then `conversation-ended: no utterance from either side
     * for 60s`.
     *
     * The provider going quiet is not the room going quiet. Handing speech to
     * the listener is the call being used, and it now says so.
     */
    const answerMs = 90_000;
    const { receivedMs, lasts } = await playAnswer(answerMs);
    expect(receivedMs).toBeGreaterThanOrEqual(answerMs);
    expect(lasts).toBe(1); // the answer ENDED, rather than being cut off
  }, 60_000);

  it("never asks the board to hold more than the sender's lead", async () => {
    /*
     * THE CONTRACT WITH THE FIRMWARE. `leadMs` is what the ring must exceed;
     * raising it on the server without raising it on the board is how a device
     * starts refusing audio at the door.
     */
    const { board } = await playAnswer(90_000);
    const heldMs = board.peakBuffered / PCM_BYTES_PER_MS;
    expect(heldMs).toBeLessThanOrEqual(DEFAULT_SPEAKER_LIMITS.leadMs + 500);
    /* And comfortably inside the ring, which is the margin for jitter. */
    expect(board.peakBuffered).toBeLessThan(RING_BYTES / 2);
  }, 60_000);

  it("takes as long to hand over as it takes to say", async () => {
    /*
     * THE SPED-UP TAIL, AS ARITHMETIC. When the sender outran the listener the
     * device clawed back by skipping frames, and what a listener heard was the
     * end of the count accelerating. If handing over takes about as long as
     * playing, there is nothing to claw back.
     */
    const { elapsedMs } = await playAnswer(30_000);
    expect(elapsedMs).toBeGreaterThan(30_000 - DEFAULT_SPEAKER_LIMITS.leadMs - 1_000);
    expect(elapsedMs).toBeLessThan(30_000 + 5_000);
  }, 60_000);

  it("costs the board few enough events to keep up with", async () => {
    /*
     * The old lane cut this into 20 ms frames: 4500 events, fifty a second,
     * each one a JSON parse and a dispatch on a microcontroller whose
     * transport sustains a few dozen messages a second in total.
     */
    const { events } = await playAnswer(90_000);
    expect(events).toBeLessThan(400);
    expect(4_500 / events).toBeGreaterThan(11);
  }, 60_000);
});
