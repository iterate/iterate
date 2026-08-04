import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import {
  assessProductionAecDiagnosticCapture,
  extractProductionAecAnalysisWindow,
  parseProductionAecDiagnosticCapture,
  planProductionAecAnalysisWindow,
} from "./production-aec-diagnostic-capture.ts";

function captureFixture(
  options: {
    firstAcceptedAtMs?: number;
    firstAcceptedUplinkFrame?: number;
    durationMs?: number;
    frames?: number;
    lastAcceptedAtMs?: number;
    lastAcceptedUplinkFrame?: number;
    maximumInterFrameGapMs?: number;
    pcm?: Uint8Array;
    truncatedFrames?: number;
  } = {},
) {
  const durationMs = options.durationMs ?? 1_000;
  const frames = options.frames ?? 50;
  const firstAcceptedAtMs = options.firstAcceptedAtMs ?? 10_001;
  const lastAcceptedAtMs =
    frames === 0 ? null : (options.lastAcceptedAtMs ?? firstAcceptedAtMs + (frames - 1) * 20);
  const firstAcceptedUplinkFrame = options.firstAcceptedUplinkFrame ?? 101;
  return {
    finishedAtMonotonicMs: 10_000 + durationMs,
    finishedAtMs: 10_000 + durationMs,
    firstAcceptedAtMonotonicMs: frames === 0 ? null : firstAcceptedAtMs,
    firstAcceptedAtMs: frames === 0 ? null : firstAcceptedAtMs,
    firstAcceptedUplinkFrame: frames === 0 ? null : firstAcceptedUplinkFrame,
    frameBytes: 640,
    frames,
    lastAcceptedAtMonotonicMs: lastAcceptedAtMs,
    lastAcceptedAtMs,
    lastAcceptedUplinkFrame:
      frames === 0
        ? null
        : (options.lastAcceptedUplinkFrame ?? firstAcceptedUplinkFrame + frames - 1),
    maximumFrames: 300,
    maximumInterFrameGapMs: options.maximumInterFrameGapMs ?? (frames > 1 ? 20 : 0),
    pcm: options.pcm ?? new Uint8Array(frames * 640),
    schemaVersion: 3,
    startedAtMonotonicMs: 10_000,
    startedAtMs: 10_000,
    truncatedFrames: options.truncatedFrames ?? 0,
  };
}

describe("production AEC diagnostic capture", () => {
  test("uses schema-3 monotonic boundaries when wall time moves backward", () => {
    /*
     * Network attribution still needs epoch timestamps, but they can step
     * backward under clock correction. A production oracle must accept that
     * evidence only when the independent monotonic boundaries remain ordered,
     * and derive both capture duration and PCM arrival span from that clock.
     */
    const parsed = parseProductionAecDiagnosticCapture({
      ...captureFixture(),
      finishedAtMonotonicMs: 2_000,
      finishedAtMs: 9_990,
      firstAcceptedAtMonotonicMs: 1_001,
      firstAcceptedAtMs: 10_001,
      lastAcceptedAtMonotonicMs: 1_981,
      lastAcceptedAtMs: 9_991,
      schemaVersion: 3,
      startedAtMonotonicMs: 1_000,
    });

    expect(parsed).toMatchObject({
      acceptedFrameSpanMs: 980,
      durationMs: 1_000,
      finishedAtMs: 9_990,
      firstAcceptedAtMs: 10_001,
      lastAcceptedAtMs: 9_991,
      schemaVersion: 3,
    });
  });

  test("parses the exact Cap'n Web Buffer payload and decodes signed PCM16LE", () => {
    /*
     * Cap'n Web presents the worker's Uint8Array as a Node Buffer in the
     * production harness. Treating that unknown value as a plain object lost
     * the only sample-level evidence for AEC. This boundary test uses the real
     * runtime representation and known PCM literals so neither the serializer
     * nor host endianness can manufacture a plausible waveform.
     */
    const pcm = Buffer.alloc(50 * 640);
    pcm[0] = 0x01;
    pcm[1] = 0x80;
    pcm[2] = 0xff;
    pcm[3] = 0x7f;

    const parsed = parseProductionAecDiagnosticCapture(captureFixture({ pcm }));

    expect(parsed.pcm).toBeInstanceOf(Uint8Array);
    expect(parsed.samples).toHaveLength(16_000);
    expect([...parsed.samples.subarray(0, 3)]).toEqual([-32_767, 32_767, 0]);
    expect(parsed.durationMs).toBe(1_000);
    expect(parsed.acceptedFrameSpanMs).toBe(980);
  });

  test("fails closed when frame accounting and retained bytes disagree", () => {
    /*
     * A shifted or partial frame invalidates every subsequent acoustic lag.
     * Do not trim to the shorter side: an exact-looking comparison over the
     * surviving prefix would hide the capture defect we are trying to prove
     * absent.
     */
    const malformed = captureFixture({ pcm: new Uint8Array(50 * 640 - 2) });

    expect(() => parseProductionAecDiagnosticCapture(malformed)).toThrow(
      /retained 31998 PCM bytes.*32000/u,
    );
  });

  test("rejects an unversioned or differently framed capture", () => {
    expect(() =>
      parseProductionAecDiagnosticCapture({ ...captureFixture(), schemaVersion: 2 }),
    ).toThrow(/schemaVersion/u);
    expect(() =>
      parseProductionAecDiagnosticCapture({ ...captureFixture(), frameBytes: 320 }),
    ).toThrow(/frameBytes/u);
  });

  test("uses accepted PCM timing rather than control-RPC latency as the audio clock", () => {
    /*
     * This is the exact shape observed in the production HAVPE run: the finish
     * RPC made the control interval 4050 ms, while 199 contiguous frames covered
     * 3980 ms of PCM with only 14 ms of aggregate arrival-clock error. Comparing
     * frame count to RPC duration incorrectly blamed audio for control latency.
     * Ordinals, accepted timestamps, and the maximum gap remain strict.
     */
    const productionBoundary = parseProductionAecDiagnosticCapture(
      captureFixture({
        durationMs: 4_050,
        frames: 199,
        lastAcceptedAtMs: 10_001 + 3_966,
        maximumInterFrameGapMs: 46,
        pcm: new Uint8Array(199 * 640),
      }),
    );

    expect(assessProductionAecDiagnosticCapture(productionBoundary)).toMatchObject({
      frameConservationPassed: true,
      expectedFrames: 203,
      passed: true,
      realtimeCadencePassed: true,
      reasons: [],
    });
  });

  test("captures a boundary tail but extracts the same exact acoustic window", () => {
    /*
     * The old 4000 ms capture retained 63680 samples, one frame short of the
     * exact 64000-sample lead-plus-analysis interval. The recorder now runs
     * beyond that interval; selection still fails closed unless every required
     * sample exists and deliberately excludes the extra control-boundary tail.
     */
    const plan = planProductionAecAnalysisWindow({
      assessmentDurationMs: 3_000,
      settledLeadMs: 1_000,
    });
    const shortCapture = new Int16Array(63_680);
    const marginedCapture = Int16Array.from({ length: 67_840 }, (_, index) => index);

    expect(plan).toEqual({
      assessmentDurationMs: 3_000,
      assessmentSampleCount: 48_000,
      assessmentStartSample: 16_000,
      captureDurationMs: 4_250,
      settledLeadMs: 1_000,
    });
    expect(() =>
      extractProductionAecAnalysisWindow(shortCapture, plan, "production capture"),
    ).toThrow(/retained 63680 samples; 64000 are required/u);
    const selected = extractProductionAecAnalysisWindow(
      marginedCapture,
      plan,
      "production capture",
    );
    expect(selected).toHaveLength(48_000);
    expect(selected[0]).toBe(marginedCapture[16_000]);
    expect(selected.at(-1)).toBe(marginedCapture[63_999]);
  });

  test("separates exact accepted-frame conservation from a queued arrival burst", () => {
    /*
     * A queued burst can preserve every PCM byte while violating realtime
     * delivery. The AEC waveform remains a contiguous provider-accepted
     * sample stream, but the run must still fail its cadence gate and explain
     * why. Conflating these two facts previously encouraged widening the
     * frame-count tolerance and would have hidden the actual queueing fault.
     */
    const burst = parseProductionAecDiagnosticCapture(
      captureFixture({
        frames: 54,
        lastAcceptedAtMs: 10_981,
        pcm: new Uint8Array(54 * 640),
      }),
    );

    expect(assessProductionAecDiagnosticCapture(burst)).toMatchObject({
      acceptedFrameSpanMs: 980,
      capturedAudioDurationMs: 1_080,
      frameConservationPassed: true,
      passed: false,
      realtimeCadencePassed: false,
    });
    expect(assessProductionAecDiagnosticCapture(burst).reasons).toEqual([
      "The retained PCM covers 1060 ms between frame starts but arrived over 980 ms; the 80 ms compression exceeds the 60 ms realtime allowance.",
    ]);
  });

  test("rejects a single long accepted-uplink gap even when aggregate cadence recovers", () => {
    /*
     * A later burst can hide a stall in the first/last timestamp span. The
     * device reports its worst accepted-frame gap separately so the oracle
     * cannot call such a stream realtime merely because the endpoints align.
     */
    const stalled = parseProductionAecDiagnosticCapture(
      captureFixture({ maximumInterFrameGapMs: 61 }),
    );

    expect(assessProductionAecDiagnosticCapture(stalled)).toMatchObject({
      frameConservationPassed: true,
      passed: false,
      realtimeCadencePassed: false,
    });
    expect(assessProductionAecDiagnosticCapture(stalled).reasons).toContain(
      "The maximum accepted-uplink gap was 61 ms; 60 ms is the fixed realtime limit.",
    );
  });

  test("rejects a missing provider-accepted ordinal even when wall-clock cadence looks healthy", () => {
    /*
     * Fifty buffers and 32,000 bytes are not conservation if one accepted
     * provider frame disappeared and a later one took its place. Absolute
     * ordinals make that loss visible without embedding test metadata in the
     * production PCM lane.
     */
    const discontinuous = parseProductionAecDiagnosticCapture(
      captureFixture({
        lastAcceptedUplinkFrame: 151,
      }),
    );

    expect(assessProductionAecDiagnosticCapture(discontinuous)).toMatchObject({
      frameConservationPassed: false,
      passed: false,
      realtimeCadencePassed: true,
    });
    expect(assessProductionAecDiagnosticCapture(discontinuous).reasons).toContain(
      "Retained accepted uplink ordinals span 101 through 151 (51 frames), but the capture contains 50 frames.",
    );
  });

  test("classifies overflow and a too-short interval as incomplete evidence", () => {
    const overflowed = parseProductionAecDiagnosticCapture(captureFixture({ truncatedFrames: 1 }));
    const tooShort = parseProductionAecDiagnosticCapture(
      captureFixture({ durationMs: 800, frames: 40, pcm: new Uint8Array(40 * 640) }),
    );

    expect(assessProductionAecDiagnosticCapture(overflowed).reasons).toContain(
      "Diagnostic capture discarded 1 accepted uplink frame after reaching its fixed bound.",
    );
    expect(assessProductionAecDiagnosticCapture(tooShort).reasons).toContain(
      "Diagnostic capture lasted 800 ms; at least 1000 ms is required.",
    );
    expect(assessProductionAecDiagnosticCapture(tooShort).reasons).toContain(
      "Diagnostic capture retained 800 ms of accepted PCM; at least 1000 ms is required.",
    );
  });
});
