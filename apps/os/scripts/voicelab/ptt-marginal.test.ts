// The one rule in `ptt-marginal` that can report a working server as a dead
// one: which speaker frame is the answer to THIS press.
//
// It earned a test the hard way. A facet that hung up as soon as an answer had
// been handed over — so an idle stream's Durable Object could sleep — shipped
// with three green unit tests and was reverted off preview the same hour,
// because rounds two to five "never answered". They had all answered. The
// probe was waiting for a speaker frame numbered above the highest `answer` it
// had ever seen, and `answer` counts responses within one `GrokCall`: a call
// per press means every answer is numbered 1, so from round two the comparison
// could never be satisfied.
//
// A conversation is one call again, so the numbers usually run on — but a call
// still ends (a minute of silence, a device hanging up, an eviction) and the
// next one starts over at 1. Scoping the comparison to the conversation is
// what makes the rule true either way.
//
// The facet was never wrong, and no test of the facet could have caught it.
// This is the test that could.
import { describe, expect, it } from "vitest";

import { answerKey, type HeardFrame, firstFrameOfNewAnswer } from "./ptt-marginal.ts";

/** A frame off the wire, at a time, for a call, cut from a provider delta. */
const frame = (
  atDeviceMs: number,
  conversationId: string,
  fromGrokAudioDeltaSeq: number,
  hasAudio = true,
): HeardFrame => ({
  atDeviceMs,
  sentAtFacetMs: atDeviceMs,
  conversationId,
  fromGrokAudioDeltaSeq,
  hasAudio,
});

/** What the probe knew before the button went down. */
const seen = (...frames: HeardFrame[]) => new Set(frames.map(answerKey));

describe("which frame answers this press", () => {
  it("takes the first frame of an answer nobody had heard yet", () => {
    const heard = firstFrameOfNewAnswer([frame(200, "aaaaaaaa", 1)], seen(), 100);
    expect(heard?.atDeviceMs).toBe(200);
  });

  it("ignores frames that arrived before the button came up", () => {
    /* The release is the zero of this measurement. A frame from before it
     * belongs to the utterance, not to the reply. */
    const frames = [frame(50, "aaaaaaaa", 1), frame(200, "aaaaaaaa", 1)];
    expect(firstFrameOfNewAnswer(frames, seen(), 100)?.atDeviceMs).toBe(200);
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
    expect(firstFrameOfNewAnswer([stale, fresh], seen(stale), 100)?.atDeviceMs).toBe(900);
  });

  it("hears an answer numbered 1 again, because the call is a new one", () => {
    /*
     * THE REGRESSION, PINNED. Round one's answer is call `aaaaaaaa` answer 1;
     * that call ends and the next press dials `bbbbbbbb`, whose answer is 1
     * again. A rule that compares numbers alone sees 1 against a high-water
     * mark of 1 and waits out its deadline. Scoped to the conversation, the
     * pair is new and the frame is the answer.
     */
    const roundOne = frame(150, "aaaaaaaa", 1);
    const roundTwo = frame(900, "bbbbbbbb", 1);
    expect(firstFrameOfNewAnswer([roundTwo], seen(roundOne), 800)?.atDeviceMs).toBe(900);
  });

  it("still refuses a repeat of a pair it has already timed", () => {
    /* A re-delivery of the same frames must not answer a later press. */
    const already = frame(900, "bbbbbbbb", 1);
    expect(firstFrameOfNewAnswer([frame(1_500, "bbbbbbbb", 1)], seen(already), 1_400)).toBe(
      undefined,
    );
  });

  it("does not time the clear this very press caused", () => {
    /*
     * THE v2 TRAP. A press interrupts whatever is playing, and the facet says
     * so by putting out a frame with no samples in it — carrying a delta
     * number one past anything heard, arriving milliseconds after the release.
     * It is new, it is late enough, and it is not an answer: timing it reports
     * a couple of milliseconds for a reply the model has not started.
     */
    const clear = frame(120, "aaaaaaaa", 7, false);
    const answer = frame(1_400, "aaaaaaaa", 8);
    expect(firstFrameOfNewAnswer([clear, answer], seen(), 100)?.atDeviceMs).toBe(1_400);
  });

  it("answers nothing when nothing arrived, rather than guessing", () => {
    expect(firstFrameOfNewAnswer([], seen(), 100)).toBe(undefined);
  });
});
