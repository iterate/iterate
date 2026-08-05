import { describe, expect, it } from "vitest";
import { PlayoutClassifier } from "./playout-classifier.ts";

// Scenarios restated from the firmware's audio_playout module, each of which
// was found by a measurement on hardware. The TS client must make the same
// decision in every one, or the two ends of the wire disagree about which
// frames are worth playing.
describe("playout identity classifier", () => {
  it("first frame of every answer replaces; later frames append", () => {
    const classifier = new PlayoutClassifier(1);
    expect(classifier.classify({ call: 1, answer: 1, frame: 0 })).toBe("replace");
    expect(classifier.classify({ call: 1, answer: 1, frame: 1 })).toBe("append");
    expect(classifier.classify({ call: 1, answer: 1, frame: 2 })).toBe("append");
    expect(classifier.counters.replaced).toBe(1);
    expect(classifier.counters.appended).toBe(2);
  });

  it("duplicates from an overlapping connection recycle are ignored", () => {
    const classifier = new PlayoutClassifier(1);
    classifier.classify({ call: 1, answer: 1, frame: 0 });
    classifier.classify({ call: 1, answer: 1, frame: 1 });
    expect(classifier.classify({ call: 1, answer: 1, frame: 1 })).toBe("ignore");
    expect(classifier.counters.ignoredDuplicate).toBe(1);
  });

  it("counts a hole where it appears", () => {
    const classifier = new PlayoutClassifier(1);
    classifier.classify({ call: 1, answer: 1, frame: 0 });
    expect(classifier.classify({ call: 1, answer: 1, frame: 4 })).toBe("append");
    expect(classifier.counters.gaps).toBe(3);
  });

  it("a newer answer supersedes; stale stragglers are refused", () => {
    const classifier = new PlayoutClassifier(1);
    classifier.classify({ call: 1, answer: 1, frame: 0 });
    classifier.classify({ call: 1, answer: 1, frame: 1 });
    expect(classifier.classify({ call: 1, answer: 2, frame: 0 })).toBe("replace");
    expect(classifier.counters.supersededMidplay).toBe(1);
    // Straggler from answer 1, deep in: genuine stale speech.
    expect(classifier.classify({ call: 1, answer: 1, frame: 2 })).toBe("ignore");
    expect(classifier.counters.ignoredStaleAnswer).toBe(1);
  });

  it("a restarted sender beginning at frame ZERO is adopted, not latched out", () => {
    // The measured latch: a recycled bridge numbers its first answer below
    // the local high-water mark; every frame was then 'stale' until reboot.
    const classifier = new PlayoutClassifier(1);
    classifier.classify({ call: 1, answer: 5, frame: 0 });
    classifier.classify({ call: 1, answer: 5, frame: 1 });
    expect(classifier.classify({ call: 1, answer: 1, frame: 0 })).toBe("replace");
    expect(classifier.classify({ call: 1, answer: 1, frame: 1 })).toBe("append");
    // But frame != 0 from a lower answer stays refused.
    const again = new PlayoutClassifier(1);
    again.classify({ call: 1, answer: 5, frame: 0 });
    expect(again.classify({ call: 1, answer: 1, frame: 2 })).toBe("ignore");
  });

  it("a local interrupt refuses only the abandoned tail, not a reused number", () => {
    const classifier = new PlayoutClassifier(1);
    classifier.classify({ call: 1, answer: 3, frame: 0 });
    classifier.classify({ call: 1, answer: 3, frame: 6 });
    classifier.interrupt();
    // In-flight tail of the abandoned answer: frames continue from where it
    // had got to, and must be refused.
    expect(classifier.classify({ call: 1, answer: 3, frame: 7 })).toBe("ignore");
    // A DIFFERENT answer wearing the same number starts again near zero —
    // the turn produced no new answer, so the sender's counter never moved.
    expect(classifier.classify({ call: 1, answer: 3, frame: 0 })).toBe("replace");
  });

  it("an interrupt never authors an answer number", () => {
    // Local interrupts fire on every talk press; the sender numbers only the
    // answers it speaks. The next real answer must still be accepted even if
    // its number equals the one that was playing when the person interrupted.
    const classifier = new PlayoutClassifier(1);
    classifier.classify({ call: 1, answer: 1, frame: 0 });
    classifier.interrupt();
    classifier.interrupt(); // second press, no answer in between
    expect(classifier.classify({ call: 1, answer: 2, frame: 0 })).toBe("replace");
    expect(classifier.classify({ call: 1, answer: 2, frame: 1 })).toBe("append");
  });

  it("frames for another call are somebody else's conversation", () => {
    const classifier = new PlayoutClassifier(1);
    expect(classifier.classify({ call: 2, answer: 1, frame: 0 })).toBe("ignore");
    expect(classifier.counters.ignoredOtherCall).toBe(1);
  });

  it("a completed answer followed by a new one is not a mid-play supersede", () => {
    const classifier = new PlayoutClassifier(1);
    classifier.classify({ call: 1, answer: 1, frame: 0 });
    classifier.markDrained();
    expect(classifier.classify({ call: 1, answer: 2, frame: 0 })).toBe("replace");
    expect(classifier.counters.supersededMidplay).toBe(0);
  });
});
