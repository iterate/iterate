/*
 * THE SPEAKER LANE, AS ARITHMETIC.
 *
 * The provider produces an answer far faster than anybody can listen to it: a
 * count to one hundred is ninety seconds of speech delivered in a handful of
 * seconds. Something has to hold the difference. For a while that something
 * was the DEVICE — the board's ring was grown to thirty seconds and described,
 * in its own comment, as no longer a cushion but "the answer" itself. A
 * microcontroller became the buffer for a server that would not wait, and the
 * catch-up, high-water and lag-skip machinery built around it was all
 * compensation for the same missing wait.
 *
 * So the buffer lives HERE, where memory is free and a test can watch it, and
 * the device gets back a small jitter cushion and one rule: write it, or clear
 * it.
 *
 * WHAT THIS MODULE IS. A reducer and a release schedule, and nothing else. No
 * clock, no timer, no I/O, no codec, no knowledge of streams or events. Every
 * function takes `now` and returns plain data, which is what lets the whole
 * pacing policy be enumerated in microseconds instead of inferred from a
 * ninety-second recording. The facet owns the one loop that calls it.
 *
 * TIME IS THE UNIT. Every knob below is playback milliseconds, never bytes and
 * never frames, because every question worth asking here is a question about
 * time: how far ahead of the listener are we, how much may go now, when should
 * we come back. Bytes are a detail of the encoding and are converted at the
 * edges.
 */

/**
 * Mu-law at 16 kHz mono: one byte per sample, sixteen samples per millisecond.
 *
 * The exactness matters. Playback position is derived from bytes released, so
 * a rate that did not divide evenly would accumulate drift over a long answer
 * and the lead would wander away from the value the device was sized for.
 */
export const MULAW_BYTES_PER_MS = 16;

/**
 * How the lane is tuned. Three numbers, and the device's ring must be able to
 * hold {@link leadMs} with room to spare.
 */
export interface SpeakerLimits {
  /**
   * How far ahead of the listener the server may run.
   *
   * THIS IS THE NUMBER THAT SIZES THE DEVICE. Everything the server has
   * released but the listener has not yet heard is sitting in the board's
   * ring, so the ring must exceed this with margin for network jitter. Raising
   * it here without raising it there is how a board starts refusing audio at
   * the door.
   */
  leadMs: number;
  /**
   * The largest single event.
   *
   * Bigger is cheaper: one event carrying a second of speech costs the device
   * one parse and one dispatch, where fifty frames cost fifty of each, plus
   * fifty deliveries against a transport that sustains a few dozen messages a
   * second. The ceiling is the device's inbox slot, not taste.
   */
  maxChunkMs: number;
  /**
   * Below this, wait for more audio rather than spend an event on a sliver.
   *
   * Deliberately NOT applied to the opening chunk of an answer — see
   * {@link speakerRelease}. A minimum that delays the first word trades the
   * one latency the listener actually notices for a saving on events nobody
   * counts.
   */
  minChunkMs: number;
  /**
   * The wire frame every chunk is a whole number of.
   *
   * NOT decoration. The device expands mu-law into exactly 640-byte PCM
   * frames and both of its consumers reject any other length outright, so a
   * chunk that is 21 ms leaves a millisecond the board cannot place. It could
   * carry the remainder to the next chunk — that is a buffer, a phase, and a
   * reset path, on the microcontroller, which is the complexity this whole
   * redesign exists to move off it. Quantising here costs the sender one
   * modulo and the listener at most one frame of silence per answer.
   */
  frameMs: number;
}

/**
 * WHAT THE HARDWARE CAN ACTUALLY TAKE, which is what sets these.
 *
 * Every one of these is a contract with the firmware, not a preference, and
 * the firmware's limits are asymmetric in how they fail:
 *
 *   - `B64_CAPACITY` (1200 bytes) — an oversized `pcm` string is dropped
 *     SILENTLY, one counter, no log.
 *   - the inbox slot (16 KiB) — an oversized MESSAGE is TERMINAL: it latches
 *     the socket generation and forces a reconnect.
 *
 * And the device cannot defend itself. It asks for `maxDeliveryBytes: 13000`,
 * but `capSessionDelivery` always ships at least one event whole, so a single
 * fat event arrives at full size regardless. The ceiling therefore has to be
 * respected HERE or not at all.
 *
 * 300 ms is 4800 mu-law bytes, ~6.5 KB of base64, comfortably one-per-batch
 * inside a 16 KiB slot with the envelope on top. It is fifteen times fewer
 * events than the 20 ms frame it replaces, which is the whole point; going
 * further means raising three firmware buffers and a PSRAM budget first, and
 * those move together with these or not at all.
 *
 * The 3 s lead is what the device must be able to hold. Against a 10 s ring
 * that is seven seconds of margin for jitter, and it keeps the opening burst
 * to ten events rather than the 150 the old pacer sent.
 */
export const DEFAULT_SPEAKER_LIMITS: SpeakerLimits = {
  leadMs: 3_000,
  maxChunkMs: 300,
  minChunkMs: 100,
  frameMs: 20,
};

/**
 * Everything the lane knows, as plain data.
 *
 * A reduced value: no methods, no hidden fields, nothing that cannot be
 * inspected in a failing test or handed to `liveState` as a summary. The
 * pending audio is the only part that is large, and it is the only part that
 * never leaves this process.
 */
export interface SpeakerState {
  /**
   * Mu-law bytes produced but not yet released, oldest first.
   *
   * THE ONLY PLACE HELD AUDIO EXISTS. A `pendingBytes` counter used to sit
   * beside this and be kept in step by hand — a second copy of a fact the
   * array already states, which every mutator had to remember to update. Ask
   * {@link heldBytes}: it cannot disagree with the queue, because it IS the
   * queue.
   */
  pending: Uint8Array[];
  /** True once the provider has finished producing this answer. */
  complete: boolean;
  /** Playback milliseconds handed to the device so far, this answer. */
  releasedMs: number;
  /** Session clock at the first release, which is when playback began. */
  startedAtMs: number | null;
  /** Set while the next chunk must tell the device to clear its buffer. */
  dropNext: boolean;
  /** True once the closing chunk has gone out; the answer is finished. */
  closed: boolean;
  /** Bytes refused because the buffer was full. Should always be zero. */
  overflowBytes: number;
}

/** One event's worth of audio, and the two bits that travel with it. */
export interface SpeakerChunk {
  /** Mu-law bytes for the device to play. Empty only on a bare closing chunk. */
  mulaw: Uint8Array;
  /** Clear the device's buffer before writing this. */
  drop: boolean;
  /** This chunk completes the answer; the device may release its fence. */
  last: boolean;
}

/** What {@link speakerRelease} decided: what goes now, and when to come back. */
export interface SpeakerRelease {
  /** Chunks to append, in order. Usually zero or one. */
  chunks: SpeakerChunk[];
  /**
   * Milliseconds until there will be something worth releasing, or null when
   * there is nothing left to do and the loop should exit.
   *
   * Returned rather than assumed so the caller never polls: the loop sleeps
   * exactly as long as the arithmetic says, which is what keeps a ninety-second
   * answer to ninety wakes rather than a fixed tick's worth.
   */
  nextWakeMs: number | null;
}

/**
 * A ceiling on held audio, so a provider that never stops cannot exhaust the
 * isolate.
 *
 * Ten minutes of speech. Not a working limit — the longest answer anybody has
 * asked for is a minute and a half — but a bound that turns "the DO died" into
 * a counter somebody can read. Overflow drops the NEWEST bytes, because the
 * audio already queued is what the listener is in the middle of hearing.
 */
const MAX_PENDING_BYTES = 600_000 * MULAW_BYTES_PER_MS;

/** A fresh answer: nothing held, nothing released, and the device must clear. */
/** Bytes held, from the only thing that knows: the queue itself. */
export function heldBytes(state: SpeakerState): number {
  let total = 0;
  for (const chunk of state.pending) total += chunk.length;
  return total;
}

export function speakerStart(): SpeakerState {
  return {
    pending: [],
    complete: false,
    releasedMs: 0,
    startedAtMs: null,
    dropNext: true,
    closed: false,
    overflowBytes: 0,
  };
}

/**
 * The provider produced more audio for the answer in flight.
 *
 * Mu-law in, because the encode belongs to whoever also needs the PCM16 for
 * the face and should not happen twice.
 */
export function speakerPush(state: SpeakerState, mulaw: Uint8Array): void {
  if (mulaw.length === 0) return;
  if (heldBytes(state) + mulaw.length > MAX_PENDING_BYTES) {
    state.overflowBytes += mulaw.length;
    return;
  }
  state.pending.push(mulaw);
}

/** The provider has finished this answer. What is held is all there will be. */
export function speakerComplete(state: SpeakerState): void {
  state.complete = true;
}

/**
 * A new answer supersedes whatever is in flight.
 *
 * Everything still held is discarded — nobody will ever hear it, and releasing
 * it would put it in front of the answer the listener is waiting for. The
 * device is told to clear by the `drop` on the next chunk, which is the same
 * decision travelling with the audio it invalidates rather than beside it.
 */
export function speakerReplace(state: SpeakerState): void {
  /*
   * A REPLACED ANSWER IS A NEW ANSWER, so this is `speakerStart` and must not
   * be a second hand-written copy of it. It was, field for field, and the two
   * could drift in silence: anything added to the initial state and forgotten
   * here would survive a barge-in into the answer that displaced it.
   *
   * `overflowBytes` is the one exception and is carried across, because it
   * counts bytes no answer ever held — a lifetime fault counter, not part of
   * the answer being replaced.
   */
  const { overflowBytes } = state;
  Object.assign(state, speakerStart(), { overflowBytes });
}

/** Playback milliseconds the listener has actually heard, never more than sent. */
function playedMs(state: SpeakerState, now: number): number {
  if (state.startedAtMs === null) return 0;
  const elapsed = now - state.startedAtMs;
  if (elapsed <= 0) return 0;
  return Math.min(state.releasedMs, elapsed);
}

/** How much released audio the device is still holding, in playback ms. */
export function speakerAheadMs(state: SpeakerState, now: number): number {
  return state.releasedMs - playedMs(state, now);
}

/** Take exactly `bytes` off the front of the queue, spanning pushes as needed. */
function takeFront(state: SpeakerState, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let filled = 0;
  while (filled < bytes) {
    const head = state.pending[0]!;
    const want = bytes - filled;
    if (head.length <= want) {
      out.set(head, filled);
      filled += head.length;
      state.pending.shift();
      continue;
    }
    out.set(head.subarray(0, want), filled);
    state.pending[0] = head.subarray(want);
    filled += want;
  }
  /* No counter to decrement: shifting and slicing the queue above IS the
   * bookkeeping, which is the point of not keeping a second copy of it. */
  return out;
}

/**
 * Decide what may go to the device right now.
 *
 * THE WHOLE POLICY, and it is three lines of arithmetic: work out how far
 * ahead of the listener we already are, spend the difference up to the lead,
 * and cut what that buys into chunks no larger than the device's inbox.
 *
 * The opening chunk of an answer ignores {@link SpeakerLimits.minChunkMs} and
 * goes at whatever size is available. That is deliberate and it is the only
 * special case in this file: the first chunk is the one the listener is
 * waiting on, and holding it back to fill a quota adds delay to the single
 * number anybody has ever complained about. Every chunk after it is bulk.
 */
export function speakerRelease(
  state: SpeakerState,
  now: number,
  limits: SpeakerLimits,
): SpeakerRelease {
  if (state.closed) return { chunks: [], nextWakeMs: null };

  const chunks: SpeakerChunk[] = [];
  let budgetMs = limits.leadMs - speakerAheadMs(state, now);

  while (heldBytes(state) > 0 && budgetMs > 0) {
    const opening = state.releasedMs === 0 && chunks.length === 0;
    const heldMs = heldBytes(state) / MULAW_BYTES_PER_MS;
    const takeMs = Math.min(budgetMs, limits.maxChunkMs, heldMs);
    /* A sliver is worth an event only when it is the last of a finished answer
     * or the first word of a new one; otherwise it is cheaper to wait. */
    const tail = state.complete && takeMs >= heldMs;
    if (takeMs < limits.minChunkMs && !tail && !opening) break;

    /*
     * THE TAIL TAKES EVERYTHING, and the reason is a bug this line already had.
     *
     * Chunks are cut on whole milliseconds, which is tidy until the last of an
     * answer is a handful of bytes: `floor(0.875) * 16` is zero, the loop
     * breaks having released nothing, `pendingBytes` never reaches zero, and
     * so the "answer is complete" branch below never fires. No closing chunk,
     * no `last`, and a device that waits forever for an end that was already
     * decided — heard as a reply that plays and then a board that has gone
     * deaf. Caught by an existing test, on a 700-byte delta.
     */
    const frameBytes = limits.frameMs * MULAW_BYTES_PER_MS;
    const bytes = tail ? heldBytes(state) : Math.floor(takeMs / limits.frameMs) * frameBytes;
    if (bytes === 0) break;
    let mulaw = takeFront(state, Math.min(bytes, heldBytes(state)));
    /*
     * THE TAIL IS PADDED UP TO A WHOLE FRAME, with mu-law silence (0xFF).
     *
     * An answer's last few bytes are almost never a whole frame, and the
     * device cannot place a partial one. Padding is what makes the final
     * syllable audible instead of discarded — the alternative, carrying it
     * nowhere, is the truncated last word this lane used to produce.
     */
    if (mulaw.length % frameBytes !== 0) {
      const padded = new Uint8Array(Math.ceil(mulaw.length / frameBytes) * frameBytes);
      padded.fill(0xff);
      padded.set(mulaw);
      mulaw = padded;
    }
    const releasedMs = mulaw.length / MULAW_BYTES_PER_MS;

    if (state.startedAtMs === null) state.startedAtMs = now;
    state.releasedMs += releasedMs;
    budgetMs -= releasedMs;
    chunks.push({ mulaw, drop: state.dropNext, last: false });
    state.dropNext = false;
  }

  /*
   * The answer is over. Say so on the audio if there is any — an extra event
   * carrying nothing is an extra parse and an extra delivery — and on a bare
   * chunk if the last of the audio already went out in an earlier pass.
   */
  if (state.complete && heldBytes(state) === 0) {
    const trailing = chunks[chunks.length - 1];
    if (trailing !== undefined) {
      trailing.last = true;
    } else {
      /*
       * NO AUDIO MEANS NO `drop`, and the clear stays armed for whoever does
       * speak next.
       *
       * A chunk with no audio has nothing to invalidate the previous answer
       * FOR. Sending `drop` on one would cut the tail of the answer before it
       * off a device that was still playing it — reachable whenever a response
       * is created and then produces no speech at all, which a tool-only or
       * aborted turn does. All this chunk is for is saying the answer ended.
       */
      chunks.push({ mulaw: new Uint8Array(0), drop: false, last: true });
    }
    state.closed = true;
    return { chunks, nextWakeMs: null };
  }

  if (heldBytes(state) === 0) return { chunks, nextWakeMs: null };

  /*
   * Come back when there is room for a WHOLE chunk, not for the smallest one
   * we would tolerate. Waking at the minimum is what turns a ninety-second
   * answer into four hundred dribbles of two hundred milliseconds: correct,
   * paced, and four times the events the device has to parse. Waiting for the
   * lead to drain by a full chunk costs nothing — the listener is still eight
   * seconds behind either way — and hands the board one event a second.
   */
  const heldMs = heldBytes(state) / MULAW_BYTES_PER_MS;
  const wantMs = Math.max(
    limits.frameMs,
    Math.min(limits.maxChunkMs, Math.max(limits.minChunkMs, heldMs)),
  );
  const wakeMs = speakerAheadMs(state, now) - (limits.leadMs - wantMs);
  /*
   * NEVER WAKE MORE OFTEN THAN THE SMALLEST CHUNK WE WOULD SEND.
   *
   * Without this floor the loop spins. A lane that is behind on audio rather
   * than on budget — the provider is still thinking, and less than
   * `minChunkMs` is held — computes a wake in the past, releases nothing when
   * it gets there, and computes it again. The provider's next delta is what
   * actually unblocks it; this is only the safety net, so it may be slow.
   */
  return {
    chunks,
    nextWakeMs: Math.max(Math.min(limits.minChunkMs, limits.maxChunkMs), Math.ceil(wakeMs)),
  };
}

/**
 * What the lane looks like from outside, for `liveState` and for tests.
 *
 * Milliseconds and counters only. The audio itself is never published: it is
 * megabytes, it is already on its way to the only consumer that wants it, and
 * a reduced state that carries it would be copied on every read.
 */
export function speakerSummary(state: SpeakerState, now: number) {
  return {
    /** Playback ms produced but not yet sent. */
    pendingMs: Math.round(heldBytes(state) / MULAW_BYTES_PER_MS),
    /** Playback ms sent so far this answer. */
    releasedMs: Math.round(state.releasedMs),
    /** Playback ms sent but not yet heard — what the device is holding. */
    aheadMs: Math.round(speakerAheadMs(state, now)),
    /** True once the provider has finished producing. */
    complete: state.complete,
    /** True once the closing chunk has gone. */
    closed: state.closed,
    /** Non-zero means audio was dropped for want of room. */
    overflowBytes: state.overflowBytes,
  };
}
