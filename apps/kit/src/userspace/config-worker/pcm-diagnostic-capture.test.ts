import { describe, expect, test } from "vitest";
import { canStartPcmDiagnosticCapture, PcmDiagnosticCapture } from "./pcm-diagnostic-capture.ts";

describe("diagnostic capture eligibility", () => {
  test("allows an explicitly armed active full-duplex lane regardless of provider", () => {
    /*
     * A Grok VAD incident cannot be attributed from a tone-provider capture.
     * Eligibility therefore follows the audio lane and active-call boundary;
     * the caller still controls the fixed six-second allocation explicitly.
     */
    expect(
      canStartPcmDiagnosticCapture({
        audioMode: "full-duplex-aec",
        conversationActive: true,
      }),
    ).toBe(true);
  });

  test("rejects inactive and manual lanes", () => {
    expect(
      canStartPcmDiagnosticCapture({
        audioMode: "full-duplex-aec",
        conversationActive: false,
      }),
    ).toBe(false);
    expect(
      canStartPcmDiagnosticCapture({ audioMode: "push-to-talk", conversationActive: true }),
    ).toBe(false);
  });
});

describe("bounded userspace PCM diagnostic capture", () => {
  test("uses monotonic time for cadence while retaining a backward wall-clock step", () => {
    /*
     * NTP or host correction can move Date.now() backward during an otherwise
     * continuous physical AEC phase. Treating that as three observer failures
     * discards the very waveform needed to diagnose audio. Wall time remains
     * evidence for cross-system correlation, but only the monotonic clock may
     * order frames or decide the maximum accepted-uplink gap.
     */
    const capture = new PcmDiagnosticCapture({
      frameBytes: 4,
      maximumFrames: 2,
      startedAtMonotonicMs: 50,
      startedAtMs: 1_000,
    });

    expect(capture.observe(Uint8Array.of(1, 2, 3, 4), 41, 1_005, 55)).toBe(true);
    expect(capture.observe(Uint8Array.of(5, 6, 7, 8), 42, 995, 75)).toBe(true);

    expect(capture.snapshot(990, 80)).toMatchObject({
      finishedAtMonotonicMs: 80,
      finishedAtMs: 990,
      firstAcceptedAtMonotonicMs: 55,
      firstAcceptedAtMs: 1_005,
      lastAcceptedAtMonotonicMs: 75,
      lastAcceptedAtMs: 995,
      maximumInterFrameGapMs: 20,
      schemaVersion: 3,
      startedAtMonotonicMs: 50,
      startedAtMs: 1_000,
    });
  });

  test("copies accepted frames into one fixed allocation and reports overflow", () => {
    /*
     * A long physical conversation must never make diagnostic memory grow.
     * The capture allocates its declared ceiling once, copies only complete
     * accepted frames, and counts later frames instead of allocating or
     * overwriting evidence that has already been aligned with a test phase.
     */
    const capture = new PcmDiagnosticCapture({
      frameBytes: 4,
      maximumFrames: 2,
      startedAtMonotonicMs: 1_000,
      startedAtMs: 1_000,
    });
    const first = Uint8Array.of(1, 2, 3, 4);

    expect(capture.observe(first, 41, 1_005, 1_005)).toBe(true);
    first.fill(99);
    expect(capture.observe(Uint8Array.of(5, 6, 7, 8), 42, 1_025, 1_025)).toBe(true);
    expect(capture.observe(Uint8Array.of(9, 10, 11, 12), 43, 1_045, 1_045)).toBe(false);

    expect(capture.status()).toEqual({
      frameBytes: 4,
      frames: 2,
      firstAcceptedAtMonotonicMs: 1_005,
      firstAcceptedAtMs: 1_005,
      firstAcceptedUplinkFrame: 41,
      lastAcceptedAtMonotonicMs: 1_025,
      lastAcceptedAtMs: 1_025,
      lastAcceptedUplinkFrame: 42,
      maximumFrames: 2,
      maximumInterFrameGapMs: 20,
      startedAtMonotonicMs: 1_000,
      startedAtMs: 1_000,
      truncatedFrames: 1,
    });

    expect(capture.snapshot(1_250, 1_250)).toEqual({
      finishedAtMonotonicMs: 1_250,
      finishedAtMs: 1_250,
      frameBytes: 4,
      frames: 2,
      firstAcceptedAtMonotonicMs: 1_005,
      firstAcceptedAtMs: 1_005,
      firstAcceptedUplinkFrame: 41,
      lastAcceptedAtMonotonicMs: 1_025,
      lastAcceptedAtMs: 1_025,
      lastAcceptedUplinkFrame: 42,
      maximumFrames: 2,
      maximumInterFrameGapMs: 20,
      pcm: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
      schemaVersion: 3,
      startedAtMonotonicMs: 1_000,
      startedAtMs: 1_000,
      truncatedFrames: 1,
    });
  });

  test("rejects malformed construction and frame sizes", () => {
    /*
     * The recorder sits beside the realtime relay, so accepting a partial
     * frame would make its byte offsets lie about time. Fail immediately at
     * this optional observation boundary without weakening the PCM transport.
     */
    expect(
      () =>
        new PcmDiagnosticCapture({
          frameBytes: 0,
          maximumFrames: 1,
          startedAtMonotonicMs: 0,
          startedAtMs: 0,
        }),
    ).toThrow("frameBytes");
    expect(
      () =>
        new PcmDiagnosticCapture({
          frameBytes: 4,
          maximumFrames: 0,
          startedAtMonotonicMs: 0,
          startedAtMs: 0,
        }),
    ).toThrow("maximumFrames");

    const capture = new PcmDiagnosticCapture({
      frameBytes: 4,
      maximumFrames: 1,
      startedAtMonotonicMs: 0,
      startedAtMs: 0,
    });
    expect(() => capture.observe(Uint8Array.of(1, 2), 1, 1, 1)).toThrow("exactly 4 bytes");
  });

  test("makes queued bursts and accepted-frame continuity explicit in the snapshot", () => {
    /*
     * The start/finish capability calls and device WebSocket messages are
     * separate event sources. A server-side queue can therefore deliver old
     * microphone frames immediately after start and make a four-second RPC
     * interval contain more than four seconds of PCM. Frame ordinals prove
     * exact provider-acceptance conservation; acceptance timestamps expose
     * that burst instead of asking a broad wall-clock tolerance to hide it.
     */
    const capture = new PcmDiagnosticCapture({
      frameBytes: 4,
      maximumFrames: 4,
      startedAtMonotonicMs: 10_000,
      startedAtMs: 10_000,
    });

    capture.observe(Uint8Array.of(1, 1, 1, 1), 800, 10_001, 10_001);
    capture.observe(Uint8Array.of(2, 2, 2, 2), 801, 10_001, 10_001);
    capture.observe(Uint8Array.of(3, 3, 3, 3), 802, 10_001, 10_001);
    capture.observe(Uint8Array.of(4, 4, 4, 4), 803, 10_021, 10_021);

    expect(capture.snapshot(10_041, 10_041)).toMatchObject({
      firstAcceptedAtMs: 10_001,
      firstAcceptedUplinkFrame: 800,
      frames: 4,
      lastAcceptedAtMs: 10_021,
      lastAcceptedUplinkFrame: 803,
      maximumInterFrameGapMs: 20,
      schemaVersion: 3,
    });
  });
});
