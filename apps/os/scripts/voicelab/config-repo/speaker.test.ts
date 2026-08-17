import { describe, expect, it } from "vitest";
import {
  heldBytes,
  MULAW_BYTES_PER_MS,
  speakerAheadMs,
  speakerComplete,
  speakerPush,
  speakerRelease,
  speakerReplace,
  speakerStart,
  speakerSummary,
  type SpeakerChunk,
  type SpeakerLimits,
  type SpeakerState,
} from "./speaker.ts";

/*
 * The pacing policy, enumerated.
 *
 * Every failure this module exists to prevent was found the expensive way — by
 * listening to a board mangle a count to one hundred and then guessing. The
 * point of a pure reducer is that the same failures are now arithmetic, so
 * this file asserts the invariants directly rather than sampling behaviour:
 * nothing is lost, nothing is reordered, and the device is never asked to hold
 * more than it was sized for.
 */

const LIMITS: SpeakerLimits = { leadMs: 8_000, maxChunkMs: 1_000, minChunkMs: 200, frameMs: 20 };

/** `ms` of recognisable audio: every byte carries its own offset, so a test can
 *  prove ordering and completeness by content rather than by length alone. */
function audio(ms: number, from = 0): Uint8Array {
  const bytes = new Uint8Array(ms * MULAW_BYTES_PER_MS);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = (from + index) % 251; /* prime, so the pattern never aligns */
  }
  return bytes;
}

/** Everything a run of chunks handed to the device, concatenated. */
function joined(chunks: SpeakerChunk[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.mulaw.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk.mulaw, at);
    at += chunk.mulaw.length;
  }
  return out;
}

/**
 * Drive the lane to exhaustion on a virtual clock, obeying its own wake advice.
 *
 * The clock only ever advances by what {@link speakerRelease} asked for, so a
 * schedule that would deadlock in production deadlocks here, and one that would
 * busy-loop shows up as a step count rather than as a hot CPU on a board.
 */
function drain(
  state: SpeakerState,
  limits: SpeakerLimits,
  startAt = 0,
): { chunks: SpeakerChunk[]; elapsedMs: number; steps: number; peakAheadMs: number } {
  const chunks: SpeakerChunk[] = [];
  let now = startAt;
  let steps = 0;
  let peakAheadMs = 0;
  for (;;) {
    const release = speakerRelease(state, now, limits);
    chunks.push(...release.chunks);
    peakAheadMs = Math.max(peakAheadMs, speakerAheadMs(state, now));
    steps++;
    if (release.nextWakeMs === null) break;
    if (steps > 10_000) throw new Error("speaker lane did not converge");
    now += Math.max(1, release.nextWakeMs);
  }
  return { chunks, elapsedMs: now - startAt, steps, peakAheadMs };
}

describe("the speaker lane holds the buffer so the device does not", () => {
  it("says nothing when there is nothing to say", () => {
    const state = speakerStart();
    expect(speakerRelease(state, 0, LIMITS)).toEqual({ chunks: [], nextWakeMs: null });
  });

  it("releases the first word immediately, however short it is", () => {
    /* 40 ms is a fifth of minChunkMs. Waiting for a quota here would add delay
     * to the one number a listener notices, so the opening chunk is exempt. */
    const state = speakerStart();
    speakerPush(state, audio(40));
    const { chunks } = speakerRelease(state, 0, LIMITS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.mulaw.length).toBe(40 * MULAW_BYTES_PER_MS);
    expect(chunks[0]!.drop).toBe(true);
  });

  it("holds a sliver back once the answer is already under way", () => {
    const state = speakerStart();
    speakerPush(state, audio(1_000));
    speakerRelease(state, 0, LIMITS); /* opening chunk takes its 1000 ms */
    speakerPush(state, audio(40));
    /* Budget is wide open, but 40 ms is below the minimum and the answer is
     * not finished, so it waits for company rather than costing an event. */
    expect(speakerRelease(state, 10, LIMITS).chunks).toHaveLength(0);
  });

  it("sends a sliver anyway when it is the end of the answer", () => {
    const state = speakerStart();
    speakerPush(state, audio(1_000));
    speakerRelease(state, 0, LIMITS);
    speakerPush(state, audio(40));
    speakerComplete(state);
    const { chunks } = speakerRelease(state, 10, LIMITS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.mulaw.length).toBe(40 * MULAW_BYTES_PER_MS);
    expect(chunks[0]!.last).toBe(true);
  });

  it("never runs further ahead of the listener than the lead", () => {
    const state = speakerStart();
    speakerPush(state, audio(90_000)); /* a whole count to one hundred, at once */
    speakerComplete(state);
    const { peakAheadMs } = drain(state, LIMITS);
    expect(peakAheadMs).toBeLessThanOrEqual(LIMITS.leadMs);
  });

  it("takes as long to hand over an answer as the answer takes to play", () => {
    /* THE INVARIANT THE DEVICE WAS STANDING IN FOR. Ninety seconds of speech
     * arriving in one burst leaves over ninety seconds, less the lead we are
     * allowed to be ahead by at the end. */
    const state = speakerStart();
    speakerPush(state, audio(90_000));
    speakerComplete(state);
    const { elapsedMs } = drain(state, LIMITS);
    expect(elapsedMs).toBeGreaterThan(90_000 - LIMITS.leadMs - 1_000);
    expect(elapsedMs).toBeLessThan(90_000);
  });

  it("delivers every byte exactly once, in order", () => {
    const state = speakerStart();
    const source = audio(30_000);
    /* Pushed in ragged pieces, the way a provider actually sends deltas. */
    for (let at = 0; at < source.length; at += 7_919) {
      speakerPush(state, source.subarray(at, Math.min(at + 7_919, source.length)));
    }
    speakerComplete(state);
    const { chunks } = drain(state, LIMITS);
    expect(joined(chunks)).toEqual(source);
  });

  it("spends few enough events that a microcontroller can keep up", () => {
    /* The old lane cut everything into 20 ms frames: 4500 events for this
     * answer, fifty a second, against a transport that sustains a few dozen
     * messages a second in total. */
    const state = speakerStart();
    speakerPush(state, audio(90_000));
    speakerComplete(state);
    const { chunks } = drain(state, LIMITS);
    expect(chunks.length).toBeLessThan(120);
    expect(4_500 / chunks.length).toBeGreaterThan(35); /* vs one frame per event */
  });

  it("never exceeds the chunk ceiling the device inbox is sized for", () => {
    const state = speakerStart();
    speakerPush(state, audio(90_000));
    speakerComplete(state);
    const { chunks } = drain(state, LIMITS);
    for (const chunk of chunks) {
      expect(chunk.mulaw.length).toBeLessThanOrEqual(LIMITS.maxChunkMs * MULAW_BYTES_PER_MS);
    }
  });

  it("asks the device to clear exactly once, on the first chunk", () => {
    const state = speakerStart();
    speakerPush(state, audio(90_000));
    speakerComplete(state);
    const { chunks } = drain(state, LIMITS);
    expect(chunks.filter((chunk) => chunk.drop)).toHaveLength(1);
    expect(chunks[0]!.drop).toBe(true);
  });

  it("announces the end exactly once, on the final chunk", () => {
    const state = speakerStart();
    speakerPush(state, audio(5_000));
    speakerComplete(state);
    const { chunks } = drain(state, LIMITS);
    expect(chunks.filter((chunk) => chunk.last)).toHaveLength(1);
    expect(chunks[chunks.length - 1]!.last).toBe(true);
  });

  it("closes on a bare chunk when the audio has already all gone", () => {
    /* The provider's completion routinely arrives after the last delta has
     * been released. The device still has to be told, or it never drains and
     * never releases its half-duplex fence — heard as an answer that plays and
     * then a conversation that has gone deaf. */
    const state = speakerStart();
    speakerPush(state, audio(100));
    const first = speakerRelease(state, 0, LIMITS);
    expect(first.chunks).toHaveLength(1);
    expect(first.chunks[0]!.last).toBe(false);

    speakerComplete(state);
    const second = speakerRelease(state, 10, LIMITS);
    expect(second.chunks).toHaveLength(1);
    expect(second.chunks[0]!.mulaw).toHaveLength(0);
    expect(second.chunks[0]!.last).toBe(true);
    expect(second.nextWakeMs).toBeNull();
  });

  it("closes an answer whose tail is a fraction of a millisecond", () => {
    /*
     * THE ANSWER THAT COULD NEVER END. Chunks are cut on whole milliseconds,
     * so a 14-byte remainder rounded to nothing: the loop released zero bytes,
     * the held byte count never reached zero, and the completion branch never
     * fired. The device is then waiting on a `last` that has already been
     * decided and will never be sent, which is a board that answers once and
     * then goes deaf. Provider deltas do not land on millisecond boundaries,
     * so this is the ordinary case, not an edge.
     */
    const state = speakerStart();
    speakerPush(state, new Uint8Array(350)); /* 21.875 ms */
    const first = speakerRelease(state, 0, LIMITS);
    expect(first.chunks).toHaveLength(1);
    expect(heldBytes(state)).toBeGreaterThan(0); /* 14 bytes stranded */

    speakerComplete(state);
    const second = speakerRelease(state, 1, LIMITS);
    expect(second.chunks).toHaveLength(1);
    expect(second.chunks[0]!.last).toBe(true);
    expect(heldBytes(state)).toBe(0);
    /*
     * Not one byte of the answer was dropped on the way — 350 bytes of audio,
     * rounded up to whole 20 ms frames the device can actually place. The
     * padding is silence; the alternative was a truncated last word.
     */
    const total = [...first.chunks, ...second.chunks].reduce((n, c) => n + c.mulaw.length, 0);
    expect(total).toBe(640); // ceil(350 / 320) frames
    expect(total - 350).toBeLessThan(LIMITS.frameMs * MULAW_BYTES_PER_MS);
  });

  it("does not tell the device to clear when an answer produced no audio", () => {
    /*
     * A response that is created and then says nothing — a tool-only turn, an
     * aborted turn — used to close on a bare chunk that still carried `drop`.
     * The device would have thrown away the tail of the PREVIOUS answer, which
     * it may well still have been playing, on the strength of an answer that
     * never existed. The clear stays armed for whoever really does speak next.
     */
    const state = speakerStart();
    speakerPush(state, audio(1_000));
    speakerRelease(state, 0, LIMITS); /* answer one, drop spent */
    speakerComplete(state);
    speakerRelease(state, 0, LIMITS);

    speakerReplace(state); /* answer two begins... */
    speakerComplete(state); /* ...and says nothing at all */
    const { chunks } = speakerRelease(state, 10, LIMITS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.last).toBe(true);
    expect(chunks[0]!.mulaw).toHaveLength(0);
    expect(chunks[0]!.drop).toBe(false);

    /* And the next answer that DOES speak still gets its clear. */
    speakerReplace(state);
    speakerPush(state, audio(500));
    expect(speakerRelease(state, 20, LIMITS).chunks[0]!.drop).toBe(true);
  });

  it("says nothing more once the answer is closed", () => {
    const state = speakerStart();
    speakerPush(state, audio(100));
    speakerComplete(state);
    drain(state, LIMITS);
    speakerPush(state, audio(100)); /* a straggler after the end */
    expect(speakerRelease(state, 5_000, LIMITS)).toEqual({ chunks: [], nextWakeMs: null });
  });

  it("throws away a superseded answer instead of queueing it in front", () => {
    const state = speakerStart();
    speakerPush(state, audio(90_000));
    speakerRelease(state, 0, LIMITS);
    expect(heldBytes(state)).toBeGreaterThan(0);

    speakerReplace(state);
    expect(heldBytes(state)).toBe(0);
    expect(speakerAheadMs(state, 0)).toBe(0);

    speakerPush(state, audio(500, 9));
    const { chunks } = speakerRelease(state, 0, LIMITS);
    /* The replacement clears the device, and its own audio is what plays. */
    expect(chunks[0]!.drop).toBe(true);
    expect(chunks[0]!.mulaw).toEqual(audio(500, 9));
  });

  it("re-opens after a replace, so a barge-in is not a latch", () => {
    /* Every silencing bug this lane has had was a latch: some high-water mark
     * the sender could never reach again. A replaced answer must be able to
     * complete and close normally. */
    const state = speakerStart();
    speakerPush(state, audio(3_000));
    speakerRelease(state, 0, LIMITS);
    speakerReplace(state);
    speakerPush(state, audio(3_000));
    speakerComplete(state);
    const { chunks } = drain(state, LIMITS, 5_000);
    expect(joined(chunks)).toHaveLength(3_000 * MULAW_BYTES_PER_MS);
    expect(chunks[chunks.length - 1]!.last).toBe(true);
  });

  it("always says when to come back while audio is still held", () => {
    const state = speakerStart();
    speakerPush(state, audio(90_000));
    let now = 0;
    for (let step = 0; step < 50; step++) {
      const release = speakerRelease(state, now, LIMITS);
      expect(release.nextWakeMs).not.toBeNull();
      now += Math.max(1, release.nextWakeMs!);
    }
    expect(heldBytes(state)).toBeGreaterThan(0);
  });

  it("waits rather than spinning when it is too far ahead", () => {
    const state = speakerStart();
    speakerPush(state, audio(90_000));
    speakerRelease(state, 0, LIMITS);
    const release = speakerRelease(state, 0, LIMITS);
    expect(release.chunks).toHaveLength(0);
    /* The wake is the real remaining lead, not a tick: it must be long enough
     * that the loop is not a busy wait. */
    expect(release.nextWakeMs).toBeGreaterThan(LIMITS.minChunkMs / 2);
  });

  it("keeps the device inside its buffer even when the clock jumps", () => {
    /* A Durable Object that was evicted and revived can see a long jump. The
     * listener has heard everything by then, so the lane simply resumes. */
    const state = speakerStart();
    speakerPush(state, audio(20_000));
    speakerComplete(state);
    speakerRelease(state, 0, LIMITS);
    const release = speakerRelease(state, 600_000, LIMITS);
    expect(speakerAheadMs(state, 600_000)).toBeLessThanOrEqual(LIMITS.leadMs);
    expect(release.chunks.length).toBeGreaterThan(0);
  });

  it("counts audio it had to refuse rather than exhausting the isolate", () => {
    const state = speakerStart();
    for (let index = 0; index < 12; index++) speakerPush(state, audio(60_000));
    expect(state.overflowBytes).toBeGreaterThan(0);
    expect(speakerSummary(state, 0).overflowBytes).toBe(state.overflowBytes);
  });

  it("reports itself in milliseconds, without the audio", () => {
    /* Five seconds fits inside the eight-second lead, so it all goes at once
     * and the device holds it: released 5000, nothing pending, and by one
     * second in the listener still has four seconds of it left to hear. */
    const state = speakerStart();
    speakerPush(state, audio(5_000));
    speakerRelease(state, 0, LIMITS);
    const summary = speakerSummary(state, 1_000);
    expect(summary.pendingMs).toBe(0);
    expect(summary.releasedMs).toBe(5_000);
    expect(summary.aheadMs).toBe(4_000);
    expect(JSON.stringify(summary)).not.toContain("mulaw");
  });

  it("honours a lead the device profile actually has room for", () => {
    /* The knob is the contract with the board's ring. A tighter lead must
     * still deliver everything, just with more events. */
    const tight: SpeakerLimits = { leadMs: 1_000, maxChunkMs: 200, minChunkMs: 100, frameMs: 20 };
    const state = speakerStart();
    const source = audio(20_000);
    speakerPush(state, source);
    speakerComplete(state);
    const { chunks, peakAheadMs } = drain(state, tight);
    expect(joined(chunks)).toEqual(source);
    expect(peakAheadMs).toBeLessThanOrEqual(tight.leadMs);
  });
});
