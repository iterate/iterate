import { describe, expect, test } from "vitest";
import {
  assessIndependentSpokenCountEvidence,
  assessOverlappingSpokenCountEvidence,
  assessInterruptedSpokenCountPrefix,
  assessSpokenCountRange,
  assessSpokenCountToOneHundred,
} from "./spoken-count-assessment.ts";

const words = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "twenty-one",
  "twenty-two",
  "twenty-three",
  "twenty-four",
  "twenty-five",
  "twenty-six",
  "twenty-seven",
  "twenty-eight",
  "twenty-nine",
  "thirty",
  "thirty-one",
  "thirty-two",
  "thirty-three",
  "thirty-four",
  "thirty-five",
  "thirty-six",
  "thirty-seven",
  "thirty-eight",
  "thirty-nine",
  "forty",
  "forty-one",
  "forty-two",
  "forty-three",
  "forty-four",
  "forty-five",
  "forty-six",
  "forty-seven",
  "forty-eight",
  "forty-nine",
  "fifty",
  "fifty-one",
  "fifty-two",
  "fifty-three",
  "fifty-four",
  "fifty-five",
  "fifty-six",
  "fifty-seven",
  "fifty-eight",
  "fifty-nine",
  "sixty",
  "sixty-one",
  "sixty-two",
  "sixty-three",
  "sixty-four",
  "sixty-five",
  "sixty-six",
  "sixty-seven",
  "sixty-eight",
  "sixty-nine",
  "seventy",
  "seventy-one",
  "seventy-two",
  "seventy-three",
  "seventy-four",
  "seventy-five",
  "seventy-six",
  "seventy-seven",
  "seventy-eight",
  "seventy-nine",
  "eighty",
  "eighty-one",
  "eighty-two",
  "eighty-three",
  "eighty-four",
  "eighty-five",
  "eighty-six",
  "eighty-seven",
  "eighty-eight",
  "eighty-nine",
  "ninety",
  "ninety-one",
  "ninety-two",
  "ninety-three",
  "ninety-four",
  "ninety-five",
  "ninety-six",
  "ninety-seven",
  "ninety-eight",
  "ninety-nine",
  "one hundred",
] as const;

describe("physical count-to-one-hundred oracle", () => {
  test("accepts every number in spoken-word form", () => {
    const result = assessSpokenCountToOneHundred(words.join(", "));

    expect(result.passed).toBe(true);
    expect(result.numbers).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
  });

  test("accepts digit-form STT without treating punctuation as evidence", () => {
    const result = assessSpokenCountToOneHundred(
      Array.from({ length: 100 }, (_, index) => String(index + 1)).join(", "),
    );

    expect(result.passed).toBe(true);
  });

  test("reports the exact first omission instead of accepting a coherent prefix", () => {
    const transcript = words.filter((_, index) => index !== 36).join(", ");
    const result = assessSpokenCountToOneHundred(transcript);

    expect(result).toMatchObject({
      firstMismatch: { actual: 38, expected: 37, position: 37 },
      passed: false,
    });
  });

  test("rejects an extra or repeated number", () => {
    const result = assessSpokenCountToOneHundred(`${words.join(", ")}, one hundred`);

    expect(result).toMatchObject({
      firstMismatch: { actual: 100, expected: null, position: 101 },
      passed: false,
    });
  });
});

describe("physical spoken-count range oracle", () => {
  test("combines substantial overlapping acoustic runs without filling an unobserved number", () => {
    /*
     * Whole-file xAI STT skipped two ten-number spans in a digitally lossless
     * 1..100 Stick recording, while overlapping 24-second windows recovered
     * them with long matching prefixes/suffixes. Repetitive speech is a known
     * transcription failure mode, but accepting the requested ledger as the
     * expected answer would be tautological. Each microphone number must still
     * occur in a consecutive run of at least five independently recognized
     * numbers, and the union must cover the whole provider-verified range.
     */
    const providerTranscript = Array.from({ length: 20 }, (_, index) => index + 1).join(", ");
    const result = assessOverlappingSpokenCountEvidence({
      microphoneTranscripts: [
        "1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15, 16, 17, 18, 19, 20",
        "5, 6, 7, 8, 9, 10, 11, 12, 13, 14",
      ],
      minimumConsecutiveNumbers: 5,
      providerTranscript,
      range: { end: 20, start: 1 },
    });

    expect(result).toMatchObject({
      microphone: { firstMismatch: null, numbers: Array.from({ length: 20 }, (_, i) => i + 1) },
      passed: true,
      provider: { passed: true },
    });

    const missing = assessOverlappingSpokenCountEvidence({
      microphoneTranscripts: ["1 2 3 4 5 6 7 8 9 10", "12 13 14 15 16 17 18 19 20"],
      minimumConsecutiveNumbers: 5,
      providerTranscript,
      range: { end: 20, start: 1 },
    });
    expect(missing).toMatchObject({
      microphone: { firstMismatch: { actual: 12, expected: 11, position: 11 }, passed: false },
      passed: false,
    });
  });

  test("cannot certify a missing acoustic number from a complete provider ledger", () => {
    /*
     * This is the exact anti-tautology boundary from the adversarial review.
     * The provider transcript says what Grok intended to synthesize; only the
     * separately transcribed Mac microphone says what crossed the physical
     * speaker path. Comparing a provider-derived expected ledger with itself
     * would pass this fixture even though 37 was never heard. Keep both raw
     * observations in one public assessment and require each independently.
     */
    const providerTranscript = Array.from({ length: 40 }, (_, index) => index + 1).join(", ");
    const microphoneTranscript = Array.from({ length: 40 }, (_, index) => index + 1)
      .filter((number) => number !== 37)
      .join(", ");

    expect(
      assessIndependentSpokenCountEvidence({
        microphoneTranscript,
        providerTranscript,
        range: { end: 40, start: 1 },
      }),
    ).toMatchObject({
      microphone: {
        firstMismatch: { actual: 38, expected: 37, position: 37 },
        passed: false,
      },
      passed: false,
      provider: { firstMismatch: null, passed: true },
      reasons: ["microphone: Spoken count position 37 was 38; expected 37."],
    });
  });

  test("accepts compound hundreds in the later mandatory acceptance ranges", () => {
    /*
     * A digit-only test would make the 100..400 landing gates look supported
     * while the independent acoustic recognizer normally emits words. These
     * boundary examples cover both optional English “and” and a compound tens
     * suffix, which are the two forms that previously fell apart above 100.
     */
    expect(
      assessSpokenCountRange(
        "one hundred twenty, one hundred and twenty-one, " +
          "one hundred twenty-two, one hundred twenty-three",
        { end: 123, start: 120 },
      ),
    ).toMatchObject({
      numbers: [120, 121, 122, 123],
      passed: true,
    });
    expect(
      assessSpokenCountRange(
        "three hundred ninety-eight, three hundred and ninety-nine, four hundred",
        { end: 400, start: 398 },
      ),
    ).toMatchObject({
      numbers: [398, 399, 400],
      passed: true,
    });
  });

  test("requires every number in an arbitrary inclusive range", () => {
    /*
     * The physical failure we are guarding against is a coherent prefix that
     * silently stops part-way through a long response. Range support must keep
     * the same exact omission oracle as 1..100, not merely recognize the two
     * new endpoints.
     */
    const transcript = Array.from({ length: 101 }, (_, index) => index + 100)
      .filter((number) => number !== 137)
      .join(", ");
    const result = assessSpokenCountRange(transcript, { end: 200, start: 100 });

    expect(result).toMatchObject({
      firstMismatch: { actual: 138, expected: 137, position: 38 },
      passed: false,
    });
  });
});

describe("physical interrupted spoken-count oracle", () => {
  test("accepts an exact substantial prefix that stops before the endpoint", () => {
    /*
     * The final endurance gate must prove both properties at once: the device
     * played a real section of 300..400, and barge-in stopped it before 400.
     * Merely accepting any prefix would let two audible numbers masquerade as
     * a meaningful long-response interruption.
     */
    const transcript = Array.from({ length: 31 }, (_, index) => index + 300).join(", ");

    const result = assessInterruptedSpokenCountPrefix(transcript, { end: 400, start: 300 }, 25);

    expect(result).toMatchObject({
      firstMismatch: null,
      lastNumber: 330,
      passed: true,
    });
  });

  test("rejects a skipped number inside an otherwise long prefix", () => {
    const transcript = Array.from({ length: 31 }, (_, index) => index + 300)
      .filter((number) => number !== 317)
      .join(", ");

    const result = assessInterruptedSpokenCountPrefix(transcript, { end: 400, start: 300 }, 25);

    expect(result).toMatchObject({
      firstMismatch: { actual: 318, expected: 317, position: 18 },
      passed: false,
    });
  });

  test("rejects both a trivial prefix and a response that reached 400", () => {
    expect(
      assessInterruptedSpokenCountPrefix("300, 301, 302", { end: 400, start: 300 }, 25),
    ).toMatchObject({ passed: false });
    expect(
      assessInterruptedSpokenCountPrefix(
        Array.from({ length: 101 }, (_, index) => index + 300).join(", "),
        { end: 400, start: 300 },
        25,
      ),
    ).toMatchObject({ passed: false });
  });
});
