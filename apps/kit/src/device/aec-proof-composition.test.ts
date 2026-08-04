import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const packageDirectory = resolve(import.meta.dirname, "../..");

describe("physical AEC proof composition", () => {
  /*
   * The waveform oracle can look excellent while the realtime owner clips,
   * misses its frame deadline, drops capture, or resets playback. Schema 11
   * makes those faults observable, but observability is not a gate unless the
   * two executable physical harnesses actually run the StackChan assessment
   * and include its verdict in their final pass. This source-level tripwire
   * prevents a later harness cleanup from silently reverting to waveform-only
   * evidence while the numerical assessor remains green in isolation.
   */
  test.each(["prove-local-aec.ts", "prove-production-aec-waveform.ts"])(
    "%s requires waveform and StackChan health evidence",
    (scriptName) => {
      const source = readFileSync(resolve(packageDirectory, "scripts", scriptName), "utf8");

      expect(source).toContain("assessStackChanAecRun(");
      expect(source).toContain("stackChanAssessment?.passed");
      expect(source).toContain('"stackchan-aec-health.json"');
    },
  );

  /*
   * HAVPE exposes a different truthful view: simultaneous raw and XMOS-clean
   * channels rather than StackChan's near/reference/clean window. Reusing the
   * six acoustic captures is useful, but it is not sufficient. A clean-looking
   * provider recording can coexist with capture loss, playback underruns, or
   * an implausible raw-to-clean transfer. Keep the deployed dual-device runner
   * structurally dependent on the HAVPE-specific health oracle as well.
   */
  test("the production runner requires waveform and HAVPE raw/clean health evidence", () => {
    const source = readFileSync(
      resolve(packageDirectory, "scripts", "prove-production-aec-waveform.ts"),
      "utf8",
    );

    expect(source).toContain("assessVoicePeAecRun(");
    expect(source).toContain("ambientSequences:");
    expect(source).toContain("voicePeAssessment?.passed");
    expect(source).toContain('"voice-pe-aec-health.json"');
  });
});
