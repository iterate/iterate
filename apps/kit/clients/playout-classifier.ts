// WHAT TO DO WITH A FRAME OF SPEECH THAT HAS JUST ARRIVED.
//
// A TypeScript mirror of the firmware's audio_playout module — the same wire
// contract, deliberately not shared code (decision D8). The decisions are all
// about IDENTITY: which call, which answer, which frame within that answer.
// Identity is exact, needs no clock, and makes every case decidable from
// three integers. The C source (components/core/src/audio_playout.c) carries
// the measured history behind each rule; the rules themselves are restated
// here so this file stands alone.

export interface PlayoutFrameIdentity {
  call: number;
  answer: number;
  frame: number;
}

export type PlayoutAction = "append" | "ignore" | "replace";

export interface PlayoutCounters {
  appended: number;
  /** One per answer, always: the first frame of every answer replaces. */
  replaced: number;
  /** The subset of `replaced` that cost the listener queued, unplayed audio. */
  supersededMidplay: number;
  ignoredOtherCall: number;
  ignoredStaleAnswer: number;
  ignoredDuplicate: number;
  /** Frames that never arrived, counted where the hole appears. */
  gaps: number;
}

export class PlayoutClassifier {
  private call: number;
  private answer = 0;
  private frame = 0;
  private answerStarted = false;
  /**
   * The answer the person talked over, kept as a NAME rather than expressed
   * by advancing `answer`: the local side must never author a number the
   * sender then has to catch up to, or every later frame is "stale" forever.
   */
  private abandoned = 0;
  private hasAbandoned = false;
  private abandonedFrame = 0;
  /** Whether the current answer still has audio the listener has not heard. */
  private answerAudible = false;
  readonly counters: PlayoutCounters = {
    appended: 0,
    replaced: 0,
    supersededMidplay: 0,
    ignoredOtherCall: 0,
    ignoredStaleAnswer: 0,
    ignoredDuplicate: 0,
    gaps: 0,
  };

  constructor(call = 1) {
    this.call = call;
  }

  /** Begin, or re-begin, on `call`; the caller must discard its queue. */
  reset(call: number) {
    this.call = call;
    this.answer = 0;
    this.frame = 0;
    this.answerStarted = false;
    this.hasAbandoned = false;
    this.abandoned = 0;
    this.abandonedFrame = 0;
    this.answerAudible = false;
  }

  /** The current answer has finished being heard (the buffer ran dry). */
  markDrained() {
    this.answerAudible = false;
  }

  /**
   * The person has started speaking: whatever is queued is no longer wanted.
   * A local act with no round trip; in-flight frames from the abandoned
   * answer are ignored on arrival.
   */
  interrupt() {
    if (this.answerStarted) {
      this.abandoned = this.answer;
      this.abandonedFrame = this.frame;
      this.hasAbandoned = true;
    }
    this.frame = 0;
    this.answerStarted = false;
  }

  /** Decide what to do with `frame`, AND record the decision. */
  classify(identity: PlayoutFrameIdentity): PlayoutAction {
    if (identity.call !== this.call) {
      this.counters.ignoredOtherCall++;
      return "ignore";
    }
    if (identity.answer < this.answer) {
      /*
       * A lower number means one of two opposite things, and only the frame
       * index tells them apart: late frames of a superseded answer continue
       * from where it got to, while a RESTARTED sender (recycled bridge, new
       * call on the same mount) begins its first answer at frame ZERO
       * exactly. Treating the restart as stale is a latch with no way out.
       */
      if (identity.frame !== 0) {
        this.counters.ignoredStaleAnswer++;
        return "ignore";
      }
      this.answer = identity.answer;
      this.answerStarted = false;
      this.hasAbandoned = false;
    }
    if (this.hasAbandoned && identity.answer === this.abandoned) {
      /*
       * Only the frames already on their way when the person interrupted:
       * the abandoned tail continues where it left off, while a different
       * answer wearing a reused number starts again near zero.
       */
      if (identity.frame >= this.abandonedFrame) {
        this.counters.ignoredStaleAnswer++;
        return "ignore";
      }
      this.hasAbandoned = false;
    }
    /* THE FIRST FRAME OF AN ANSWER ALWAYS REPLACES. */
    if (identity.answer > this.answer || !this.answerStarted) {
      this.counters.replaced++;
      if (this.answerAudible && identity.answer > this.answer) {
        this.counters.supersededMidplay++;
      }
      this.hasAbandoned = false;
      this.answer = identity.answer;
      this.frame = identity.frame;
      this.answerStarted = true;
      this.answerAudible = true;
      return "replace";
    }
    /* Same answer, at or behind where we already are: overlap duplicates. */
    if (identity.frame <= this.frame) {
      this.counters.ignoredDuplicate++;
      return "ignore";
    }
    if (identity.frame > this.frame + 1) {
      this.counters.gaps += identity.frame - this.frame - 1;
    }
    this.frame = identity.frame;
    this.answerAudible = true;
    this.counters.appended++;
    return "append";
  }
}
