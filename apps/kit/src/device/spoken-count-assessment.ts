const SMALL_NUMBERS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

export interface SpokenCountAssessment {
  firstMismatch: {
    actual: number | null;
    expected: number | null;
    position: number;
  } | null;
  numbers: number[];
  passed: boolean;
  reasons: string[];
}

export interface SpokenCountRange {
  end: number;
  start: number;
}

export interface InterruptedSpokenCountAssessment extends SpokenCountAssessment {
  lastNumber: number | null;
  minimumNumbers: number;
}

export interface IndependentSpokenCountEvidenceAssessment {
  microphone: SpokenCountAssessment;
  passed: boolean;
  provider: SpokenCountAssessment;
  reasons: string[];
}

export interface OverlappingSpokenCountEvidenceAssessment {
  microphone: SpokenCountAssessment;
  passed: boolean;
  provider: SpokenCountAssessment;
  reasons: string[];
}

/**
 * Combines independently transcribed, overlapping acoustic windows without
 * turning the provider's requested count into physical-playback evidence.
 *
 * Long, repetitive counts are a hostile input for whole-file speech-to-text:
 * the recognizer can omit a coherent span even when the retained microphone
 * PCM contains it. Overlapping windows give the recognizer a fresh decoding
 * boundary, but accepting arbitrary isolated numbers from those windows would
 * be equally unsafe—a hallucinated `37` could conceal a real playback gap.
 * We therefore admit a number only when it belongs to a substantial strictly
 * consecutive run in one microphone transcript. The union of those admitted
 * runs must still cover the complete range; provider text is assessed
 * separately and cannot fill an acoustic hole.
 */
export function assessOverlappingSpokenCountEvidence(input: {
  microphoneTranscripts: readonly string[];
  minimumConsecutiveNumbers: number;
  providerTranscript: string;
  range: SpokenCountRange;
}): OverlappingSpokenCountEvidenceAssessment {
  assertValidSpokenCountRange(input.range);
  if (
    !Number.isSafeInteger(input.minimumConsecutiveNumbers) ||
    input.minimumConsecutiveNumbers < 2
  ) {
    throw new Error(
      "Overlapping count evidence requires consecutive runs of at least two numbers.",
    );
  }

  const provider = assessSpokenCountRange(input.providerTranscript, input.range);
  const acousticallyObserved = new Set<number>();
  for (const transcript of input.microphoneTranscripts) {
    const numbers = extractSpokenNumbers(transcript);
    let runStart = 0;
    for (let index = 1; index <= numbers.length; index += 1) {
      const continues = index < numbers.length && numbers[index] === numbers[index - 1]! + 1;
      if (continues) continue;

      const run = numbers.slice(runStart, index);
      if (run.length >= input.minimumConsecutiveNumbers) {
        for (const number of run) {
          if (number >= input.range.start && number <= input.range.end) {
            acousticallyObserved.add(number);
          }
        }
      }
      runStart = index;
    }
  }

  /*
   * Sorting the independently observed set into the requested range's order
   * makes the ordinary exact-sequence oracle report the first acoustic hole.
   * It does not manufacture evidence: only numbers retained from qualifying
   * microphone runs enter this ledger.
   */
  const microphone = assessSpokenNumbers(
    [...acousticallyObserved].sort((left, right) => left - right),
    input.range,
  );
  const reasons = [
    ...provider.reasons.map((reason) => `provider: ${reason}`),
    ...microphone.reasons.map((reason) => `microphone: ${reason}`),
  ];
  return {
    microphone,
    passed: reasons.length === 0,
    provider,
    reasons,
  };
}

/**
 * Assesses the two independent observations required by a physical count run.
 *
 * Grok's output transcript proves what the provider intended to synthesize;
 * it cannot prove that the device played it. Conversely, the Mac microphone
 * transcript proves the acoustic path but must not silently redefine what the
 * provider produced. Keeping both raw transcripts at this seam prevents a
 * harness from replacing either observation with the requested/expected
 * ledger and then comparing that expected ledger to itself.
 */
export function assessIndependentSpokenCountEvidence(input: {
  microphoneTranscript: string;
  providerTranscript: string;
  range: SpokenCountRange;
}): IndependentSpokenCountEvidenceAssessment {
  const provider = assessSpokenCountRange(input.providerTranscript, input.range);
  const microphone = assessSpokenCountRange(input.microphoneTranscript, input.range);
  const reasons = [
    ...provider.reasons.map((reason) => `provider: ${reason}`),
    ...microphone.reasons.map((reason) => `microphone: ${reason}`),
  ];
  return {
    microphone,
    passed: reasons.length === 0,
    provider,
    reasons,
  };
}

/**
 * Turns an independent microphone transcript into an exact count ledger.
 *
 * Provider and acoustic STT are free to render the same sound as `37`,
 * `thirty-seven`, or `thirty seven`. Comparing raw words would make typography
 * the oracle while accepting only a coherent prefix would recreate the
 * physical failure that stopped at 37. This parser ignores non-numeric prose,
 * but retains every number it hears and requires the resulting ledger to be
 * exactly 1..100: omissions, repetitions, reordering, and numeric preambles
 * therefore remain failures.
 */
export function assessSpokenCountToOneHundred(transcript: string): SpokenCountAssessment {
  return assessSpokenCountRange(transcript, { end: 100, start: 1 });
}

/**
 * Requires an exact, inclusive spoken integer sequence from `start` to `end`.
 *
 * The physical acceptance campaign deliberately advances through 1..100,
 * 100..200, and 200..300. Keeping the range in one oracle prevents each new
 * endurance gate from inventing subtly weaker “heard the endpoint” logic.
 * Position remains relative to the requested range so a failure artifact says
 * both which spoken value vanished and where the acoustic stream diverged.
 */
export function assessSpokenCountRange(
  transcript: string,
  range: SpokenCountRange,
): SpokenCountAssessment {
  assertValidSpokenCountRange(range);
  return assessSpokenNumbers(extractSpokenNumbers(transcript), range);
}

function assessSpokenNumbers(numbers: number[], range: SpokenCountRange): SpokenCountAssessment {
  const expected = Array.from(
    { length: range.end - range.start + 1 },
    (_, index) => range.start + index,
  );
  const mismatchIndex = Array.from(
    { length: Math.max(numbers.length, expected.length) },
    (_, index) => index,
  ).find((index) => numbers[index] !== expected[index]);
  if (mismatchIndex === undefined) {
    return { firstMismatch: null, numbers, passed: true, reasons: [] };
  }
  const firstMismatch = {
    actual: numbers[mismatchIndex] ?? null,
    expected: expected[mismatchIndex] ?? null,
    position: mismatchIndex + 1,
  };
  return {
    firstMismatch,
    numbers,
    passed: false,
    reasons: [
      `Spoken count position ${firstMismatch.position} was ` +
        `${String(firstMismatch.actual)}; expected ${String(firstMismatch.expected)}.`,
    ],
  };
}

/**
 * Proves that an audible count formed one exact, substantial prefix and then
 * stopped before its requested endpoint.
 *
 * A normal range oracle quite correctly calls an interrupted response a
 * failure. The final 300..400 barge-in gate needs the opposite terminal rule,
 * but it must not weaken sequence integrity: every retained number still has
 * one exact expected value, the prefix must be long enough to exercise the
 * sustained downlink, and reaching the endpoint means interruption was late.
 */
export function assessInterruptedSpokenCountPrefix(
  transcript: string,
  range: SpokenCountRange,
  minimumNumbers: number,
): InterruptedSpokenCountAssessment {
  assertValidSpokenCountRange(range);
  const rangeLength = range.end - range.start + 1;
  if (
    !Number.isSafeInteger(minimumNumbers) ||
    minimumNumbers < 1 ||
    minimumNumbers >= rangeLength
  ) {
    throw new Error("Interrupted count minimum must leave at least one number unplayed.");
  }
  const numbers = extractSpokenNumbers(transcript);
  const mismatchIndex = numbers.findIndex((number, index) => number !== range.start + index);
  const firstMismatch =
    mismatchIndex < 0
      ? null
      : {
          actual: numbers[mismatchIndex] ?? null,
          expected: range.start + mismatchIndex,
          position: mismatchIndex + 1,
        };
  const reasons: string[] = [];
  if (firstMismatch) {
    reasons.push(
      `Interrupted count position ${firstMismatch.position} was ` +
        `${String(firstMismatch.actual)}; expected ${String(firstMismatch.expected)}.`,
    );
  }
  if (numbers.length < minimumNumbers) {
    reasons.push(
      `Interrupted count retained ${numbers.length} numbers; at least ${minimumNumbers} are required.`,
    );
  }
  if (numbers.length >= rangeLength) {
    reasons.push(
      `Interrupted count reached ${range.end}; the response was not stopped before its endpoint.`,
    );
  }
  return {
    firstMismatch,
    lastNumber: numbers.at(-1) ?? null,
    minimumNumbers,
    numbers,
    passed: reasons.length === 0,
    reasons,
  };
}

function assertValidSpokenCountRange(range: SpokenCountRange) {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 1 ||
    range.end < range.start
  ) {
    throw new Error("Spoken count range must contain ascending positive safe integers.");
  }
}

function extractSpokenNumbers(transcript: string): number[] {
  const tokens = transcript
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const numbers: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (/^\d+$/u.test(token)) {
      numbers.push(Number(token));
      continue;
    }
    const hundreds = SMALL_NUMBERS[token];
    if (hundreds !== undefined && hundreds < 10 && tokens[index + 1] === "hundred") {
      let value = hundreds * 100;
      index += 1;
      /*
       * Independent STT legitimately alternates between “one hundred one” and
       * “one hundred and one”. Consume the optional conjunction only inside a
       * hundred phrase; ignoring every “and” globally could join two separate
       * numbers and manufacture evidence that was never spoken.
       */
      if (tokens[index + 1] === "and") index += 1;
      const suffixTens = TENS[tokens[index + 1] ?? ""];
      if (suffixTens !== undefined) {
        value += suffixTens;
        index += 1;
        const suffixUnit = SMALL_NUMBERS[tokens[index + 1] ?? ""];
        if (suffixUnit !== undefined && suffixUnit < 10 && tokens[index + 2] !== "hundred") {
          value += suffixUnit;
          index += 1;
        }
      } else {
        const suffixSmall = SMALL_NUMBERS[tokens[index + 1] ?? ""];
        if (suffixSmall !== undefined && tokens[index + 2] !== "hundred") {
          value += suffixSmall;
          index += 1;
        }
      }
      numbers.push(value);
      continue;
    }
    const tens = TENS[token];
    if (tens !== undefined) {
      const unit = SMALL_NUMBERS[tokens[index + 1] ?? ""];
      if (unit !== undefined && unit < 10) {
        numbers.push(tens + unit);
        index += 1;
      } else {
        numbers.push(tens);
      }
      continue;
    }
    const small = SMALL_NUMBERS[token];
    if (small !== undefined) numbers.push(small);
  }
  return numbers;
}
