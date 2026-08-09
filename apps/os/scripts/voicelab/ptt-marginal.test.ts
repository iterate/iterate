// The one rule in `ptt-marginal` that can report a working server as a dead
// one: which speaker frame is the answer to THIS press.
//
// It earned a test the hard way. The facet's hang-up — let go of the provider
// when the answer is handed over, so an idle stream's Durable Object can
// sleep — shipped with three green unit tests and was reverted off preview the
// same hour, because rounds two to five "never answered". They had all
// answered. The probe was waiting for a speaker frame numbered above the
// highest `answer` it had ever seen, and `answer` counts responses within one
// `GrokCall`: hanging up after every press means every answer is numbered 1,
// so from round two the comparison could never be satisfied.
//
// The facet was never wrong, and no test of the facet could have caught it.
// This is the test that could.
import { describe, expect, it } from "vitest";

import { answerKey, type HeardFrame, firstFrameOfNewAnswer } from "./ptt-marginal.ts";

/** A frame off the wire, at a time, for a call, in an answer. */
const frame = (at: number, conversationId: string, answer: number): HeardFrame => ({
  at,
  facetT: at,
  conversationId,
  answer,
});

/** What the probe knew before the button went down. */
const seen = (...frames: HeardFrame[]) => new Set(frames.map(answerKey));

describe("which frame answers this press", () => {
  it("takes the first frame of an answer nobody had heard yet", () => {
    const heard = firstFrameOfNewAnswer([frame(200, "aaaaaaaa", 1)], seen(), 100);
    expect(heard?.at).toBe(200);
  });

  it("ignores frames that arrived before the button came up", () => {
    /* The release is the zero of this measurement. A frame from before it
     * belongs to the utterance, not to the reply. */
    const frames = [frame(50, "aaaaaaaa", 1), frame(200, "aaaaaaaa", 1)];
    expect(firstFrameOfNewAnswer(frames, seen(), 100)?.at).toBe(200);
  });

  it("does not time the tail of the answer the presser talked over", () => {
    /*
     * THE HAZARD THIS RULE EXISTS FOR. The facet paces a long answer out over
     * its whole playing time, so frames of the previous answer are still
     * arriving as the next press lands. Timing one of those reports a few
     * milliseconds for an answer that has not been generated.
     */
    const stale = frame(150, "aaaaaaaa", 1);
    const fresh = frame(900, "aaaaaaaa", 2);
    expect(firstFrameOfNewAnswer([stale, fresh], seen(stale), 100)?.at).toBe(900);
  });

  it("hears an answer numbered 1 again, because the call is a new one", () => {
    /*
     * THE REGRESSION, PINNED. Round one's answer is call `aaaaaaaa` answer 1;
     * the facet hangs up; round two's answer is call `bbbbbbbb` answer 1. A
     * rule that compares numbers alone sees 1 against a high-water mark of 1
     * and waits out its deadline. Scoped to the conversation, the pair is new
     * and the frame is the answer.
     */
    const roundOne = frame(150, "aaaaaaaa", 1);
    const roundTwo = frame(900, "bbbbbbbb", 1);
    expect(firstFrameOfNewAnswer([roundTwo], seen(roundOne), 800)?.at).toBe(900);
  });

  it("still refuses a repeat of a pair it has already timed", () => {
    /* A re-delivery of the same frames must not answer a later press. */
    const already = frame(900, "bbbbbbbb", 1);
    expect(firstFrameOfNewAnswer([frame(1_500, "bbbbbbbb", 1)], seen(already), 1_400)).toBe(
      undefined,
    );
  });

  it("answers nothing when nothing arrived, rather than guessing", () => {
    expect(firstFrameOfNewAnswer([], seen(), 100)).toBe(undefined);
  });
});
