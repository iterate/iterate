import { describe, expect, it } from "vitest";
import { sliceMarkerPcm } from "../../scripts/prove-local-aec.ts";
import { aecReleaseTraceOffsets } from "./aec-release-trace-plan.ts";

describe("physical AEC phase slicing", () => {
  it("schedules non-overlapping onset, settled, and tail windows inside long phases", () => {
    /*
     * The device trace is intentionally bounded. The full matrix must sample
     * convergence and late stability without overlapping the same retained
     * samples under three persuasive labels or extending beyond the declared
     * physical phase.
     */
    expect(aecReleaseTraceOffsets(8_000, 3_000)).toEqual([0, 5_000]);
    expect(aecReleaseTraceOffsets(20_000, 3_000)).toEqual([0, 8_500, 17_000]);
    expect(aecReleaseTraceOffsets(600_000, 3_000)).toEqual([0, 298_500, 597_000]);
    expect(aecReleaseTraceOffsets(3_100, 3_000)).toEqual([0]);
  });

  it("retains a trace spanning the exact release-matrix source outage", () => {
    /*
     * The ordinary middle trace of a 30-second phase begins at 13.5 seconds.
     * The deliberate source outage begins after exactly five seconds, so that
     * schedule proved only pre/post steady state and entirely missed recovery.
     * Center a bounded trace on the manifest-owned boundary without overlapping
     * onset or tail.
     */
    expect(aecReleaseTraceOffsets(30_000, 3_000, "lifecycle-playback-underrun-recovery")).toEqual([
      0, 3_500, 27_000,
    ]);
  });

  it("retains an explicit empty downlink for the ambient phase", () => {
    /*
     * Ambient is intentionally the one phase where the fixture sends no
     * speaker PCM. Treating its equal speaker offsets as corrupt evidence made
     * an otherwise complete physical run fail only after the device had spent
     * ninety seconds collecting it. The caller must opt into this exception:
     * equal offsets in any stimulated phase still indicate a broken oracle.
     */
    const phase = {
      end: {
        event: "ambient.assessment.completed",
        microphoneByteOffset: 640,
        microphoneFrames: 1,
        observedAtMonotonicMs: 20,
        speakerByteOffset: 0,
        speakerFrames: 0,
      },
      start: {
        event: "ambient.assessment.started",
        microphoneByteOffset: 0,
        microphoneFrames: 0,
        observedAtMonotonicMs: 0,
        speakerByteOffset: 0,
        speakerFrames: 0,
      },
    };

    expect(sliceMarkerPcm(new Uint8Array(), phase, "speaker", { allowEmpty: true })).toEqual(
      new Int16Array(),
    );
    expect(() => sliceMarkerPcm(new Uint8Array(), phase, "speaker")).toThrow(
      "speaker phase boundaries 0..0",
    );
  });
});
