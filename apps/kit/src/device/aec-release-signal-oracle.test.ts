import { describe, expect, it } from "vitest";
import { assessAecReleaseSignalWindow } from "./aec-release-signal-oracle.ts";

const sampleRateHz = 16_000;
const signal = (amplitude: number, phase = 0) =>
  Int16Array.from({ length: sampleRateHz }, (_, index) =>
    Math.round(Math.sin((2 * Math.PI * 431 * index) / sampleRateHz + phase) * amplitude),
  );
const silence = () => new Int16Array(sampleRateHz);

describe("AEC release signal window oracle", () => {
  it("accepts strong far-path observation with bounded clean residual", () => {
    /*
     * A low clean level is not evidence unless the same physical window shows
     * the raw microphone received the speaker. This is the central anti-vacuity
     * gate: a disconnected speaker cannot qualify as a perfect canceller.
     */
    expect(
      assessAecReleaseSignalWindow({
        ambientRms: 8,
        clean: silence(),
        raw: signal(5_000),
        sampleRateHz,
        scenario: "far",
      }),
    ).toMatchObject({ passed: true, reasons: [] });
  });

  it("rejects far leakage and full-scale clipping without loosening either gate", () => {
    const leaked = assessAecReleaseSignalWindow({
      ambientRms: 8,
      clean: signal(700),
      raw: signal(5_000),
      sampleRateHz,
      scenario: "far",
    });
    expect(leaked.passed).toBe(false);
    expect(leaked.reasons.join(" ")).toMatch(/residual|ERLE/u);

    const clippedRaw = signal(5_000);
    clippedRaw[100] = 32_767;
    expect(
      assessAecReleaseSignalWindow({
        ambientRms: 8,
        clean: silence(),
        raw: clippedRaw,
        sampleRateHz,
        scenario: "far",
      }).reasons.join(" "),
    ).toMatch(/clipped/u);
  });

  it("measures near preservation and double-talk against a physical near-only control", () => {
    /*
     * The Mac source is not the microphone waveform after room transfer. The
     * comparable reference is the same exact source captured in a near-only
     * phase. Double-talk may apply bounded gain/nonlinearity, but it may not
     * erase that capture or leave a correlated far-end residue.
     */
    const near = signal(2_000);
    const preserved = Int16Array.from(near, (sample) => Math.round(sample * 0.9));
    expect(
      assessAecReleaseSignalWindow({
        ambientRms: 8,
        clean: preserved,
        nearControl: near,
        raw: signal(5_000, 0.4),
        sampleRateHz,
        scenario: "double-talk",
      }),
    ).toMatchObject({ passed: true });

    expect(
      assessAecReleaseSignalWindow({
        ambientRms: 8,
        clean: Int16Array.from(near, (sample) => Math.round(sample * 0.1)),
        nearControl: near,
        raw: signal(5_000, 0.4),
        sampleRateHz,
        scenario: "double-talk",
      }).reasons.join(" "),
    ).toMatch(/gain|preservation/u);
  });
});
