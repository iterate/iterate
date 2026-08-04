import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  releaseHasLifetimeMetricPair,
  releaseTraceHasMetricCoverage,
  scoreRetainedAecReleaseEvidence,
} from "./aec-release-retained-evidence.ts";

describe("retained AEC release evidence", () => {
  it("requires metrics inside each exact device capture interval", () => {
    /*
     * A once-per-second metric somewhere in a twenty-second phase does not
     * describe onset, recovery, or tail. Bind it to the device trace's host
     * monotonic interval so every waveform claim carries simultaneous resource
     * and lifecycle diagnostics rather than phase-adjacent optimism.
     */
    const trace = {
      captureCompletedAtMonotonicMs: 4_000,
      captureStartedAtMonotonicMs: 1_000,
      metadata: {
        captureSamples: 48_000,
        capturedSamples: 48_000,
        firstFrameSequence: 1,
        frameSamples: 160,
        lastFrameSequence: 300,
        sampleRateHz: 16_000,
      },
      planes: {},
      scheduledOffsetMs: 0,
    };
    const inside = {
      phase: "quiet-far-tone",
      receivedAtMonotonicMs: 2_000,
      value: { lifetimeCaptureFrames: 100 },
    };
    expect(releaseTraceHasMetricCoverage(trace, [inside])).toBe(true);
    expect(
      releaseTraceHasMetricCoverage(trace, [
        { ...inside, receivedAtMonotonicMs: trace.captureCompletedAtMonotonicMs + 1 },
      ]),
    ).toBe(false);
  });

  it("rejects a regressed or single lifetime counter sample", () => {
    const sample = (at: number, count: number) => ({
      phase: "quiet-far-tone",
      receivedAtMonotonicMs: at,
      value: { lifetimeCaptureFrames: count },
    });
    expect(releaseHasLifetimeMetricPair([sample(1, 10), sample(2, 11)])).toBe(true);
    expect(releaseHasLifetimeMetricPair([sample(1, 10)])).toBe(false);
    expect(releaseHasLifetimeMetricPair([sample(1, 10), sample(2, 9)])).toBe(false);
  });

  it("fails closed before reading PCM when the canonical phase set is incomplete", async () => {
    /*
     * A partial physical run can contain excellent-looking traces. The scorer
     * must reject its structure before spending time correlating those traces,
     * otherwise an early socket failure can be mistaken for a shorter passing
     * matrix merely because every file which happens to exist scores well.
     */
    const directory = await mkdtemp(join(tmpdir(), "aec-release-score-"));
    await Promise.all([
      mkdir(join(directory, "release-phases")),
      writeFile(
        join(directory, "manifest.json"),
        JSON.stringify({
          device: "home-assistant-voice-preview-edition",
          exactMac: "D8:3B:DA:46:20:34",
          networkVerdict: "valid",
          qualification: "acquisition-complete-unscored",
          schemaVersion: 2,
        }),
      ),
      writeFile(join(directory, "release-traces.json"), JSON.stringify({})),
      writeFile(join(directory, "release-phase-artifacts.json"), JSON.stringify({})),
      writeFile(join(directory, "general-metrics.json"), JSON.stringify([])),
      writeFile(
        join(directory, "aec-metrics.json"),
        JSON.stringify({ stackchan: [], voicePe: [] }),
      ),
      writeFile(join(directory, "pcm-socket-closes.json"), JSON.stringify([])),
      writeFile(
        join(directory, "physical-network-validity.json"),
        JSON.stringify({ network: { reasons: [], verdict: "valid" } }),
      ),
    ]);

    await expect(scoreRetainedAecReleaseEvidence(directory)).rejects.toThrow(
      /missing canonical phase/u,
    );
  });
});
