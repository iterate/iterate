import { describe, expect, it } from "vitest";
import {
  assessAecReleaseMatrixCompletion,
  aecReleaseMatrix,
  aecReleaseMatrixPhaseIds,
} from "./aec-release-matrix.ts";

describe("AEC release matrix", () => {
  it("defines one target-independent experiment covering every release-blocking class", () => {
    /*
     * StackChan and HAVPE previously accumulated superficially similar target
     * scripts. A target-local phase list makes it possible to omit the hardest
     * case on one board and still call both accepted. Pin one public protocol
     * with concrete coverage categories; hardware adapters may calibrate drive
     * values but cannot add, remove, or rename experiments.
     */
    expect(aecReleaseMatrix.devices).toEqual(["home-assistant-voice-preview-edition", "stackchan"]);
    expect(aecReleaseMatrix.driveLevels).toEqual(["quiet", "nominal", "maximum-non-clipping"]);
    expect(new Set(aecReleaseMatrix.phases.map((phase) => phase.id)).size).toBe(
      aecReleaseMatrix.phases.length,
    );

    const farStimuli = new Set(
      aecReleaseMatrix.phases
        .filter((phase) => phase.scenario === "far-end-only")
        .map((phase) => phase.stimulus),
    );
    expect(farStimuli).toEqual(
      new Set(["chirp", "impulse-train", "multi-tone", "speech-long", "speech-shaped", "tone"]),
    );
    for (const driveLevel of aecReleaseMatrix.driveLevels) {
      expect(
        aecReleaseMatrix.phases.some(
          (phase) => phase.scenario === "far-end-only" && phase.driveLevel === driveLevel,
        ),
      ).toBe(true);
    }
    expect(
      aecReleaseMatrix.phases.filter((phase) => phase.scenario === "near-end-only"),
    ).toHaveLength(3);
    expect(
      aecReleaseMatrix.phases.filter((phase) => phase.scenario === "double-talk"),
    ).toHaveLength(3);
    expect(
      aecReleaseMatrix.phases
        .filter((phase) => phase.scenario === "lifecycle")
        .map((phase) => phase.lifecycleAction),
    ).toEqual([
      "conversation-stop-start",
      "provider-generation-change",
      "playback-underrun-recovery",
      "aec-restart-reconvergence",
      "long-duration-changing-playback",
    ]);
  });

  it("refuses acceptance when even one matrix phase or required artifact is absent", () => {
    /*
     * A run directory full of plausible WAV files is not proof. This fixture
     * deliberately removes one terminal phase and one raw plane to ensure the
     * completion oracle names both omissions instead of averaging the run into
     * an aggregate pass.
     */
    const phaseIds = aecReleaseMatrixPhaseIds();
    const evidence = phaseIds.slice(0, -1).map((phaseId) => ({
      artifactPlanes:
        phaseId === phaseIds[0]
          ? (["playout", "clean"] as const)
          : (["raw", "playout", "clean"] as const),
      dspPassed: true,
      frameConservationPassed: true,
      lifetimeMetricsRetained: true,
      perWindowMetricsRetained: true,
      phaseId,
    }));
    const assessed = assessAecReleaseMatrixCompletion({
      device: "home-assistant-voice-preview-edition",
      evidence,
      network: { passed: true, reasons: [] },
    });
    expect(assessed.dsp.passed).toBe(false);
    expect(assessed.dsp.reasons).toContain(`Missing AEC phase ${phaseIds.at(-1)}.`);
    expect(assessed.dsp.reasons).toContain(
      `AEC phase ${phaseIds[0]} did not retain its raw PCM plane.`,
    );
    expect(assessed.accepted).toBe(false);
  });

  it("keeps network validity independent from the measured DSP verdict", () => {
    /*
     * A router spike invalidates attribution; it does not retroactively turn a
     * perfect captured canceller into a DSP failure. Conversely, a clean WAN
     * cannot excuse residual echo. Preserve both verdicts and require both for
     * release acceptance so reruns address the right subsystem.
     */
    const evidence = aecReleaseMatrixPhaseIds().map((phaseId) => ({
      artifactPlanes: ["raw", "playout", "clean"] as const,
      dspPassed: true,
      frameConservationPassed: true,
      lifetimeMetricsRetained: true,
      perWindowMetricsRetained: true,
      phaseId,
    }));
    const assessed = assessAecReleaseMatrixCompletion({
      device: "home-assistant-voice-preview-edition",
      evidence,
      network: { passed: false, reasons: ["Router RTT exceeded 100 ms."] },
    });
    expect(assessed.dsp).toEqual({ passed: true, reasons: [] });
    expect(assessed.network).toEqual({
      passed: false,
      reasons: ["Router RTT exceeded 100 ms."],
    });
    expect(assessed.accepted).toBe(false);
  });

  it("keeps the later Grok self-trigger gate out of deterministic DSP qualification", () => {
    /*
     * The Mac fixture server has no speech recognizer by design. Requiring a
     * provider-side semantic oracle here would either make deterministic AEC
     * impossible to accept or quietly substitute Grok generation variability
     * for retained byte-exact evidence. Conversational self-trigger remains a
     * separate production gate after DSP qualification.
     */
    const evidence = aecReleaseMatrixPhaseIds().map((phaseId) => ({
      artifactPlanes: ["raw", "playout", "clean"] as const,
      dspPassed: true,
      frameConservationPassed: true,
      lifetimeMetricsRetained: true,
      perWindowMetricsRetained: true,
      phaseId,
    }));
    expect(
      assessAecReleaseMatrixCompletion({
        device: "home-assistant-voice-preview-edition",
        evidence,
        network: { passed: true, reasons: [] },
      }),
    ).toEqual({
      accepted: true,
      dsp: { passed: true, reasons: [] },
      network: { passed: true, reasons: [] },
    });
  });

  it("requires only truthful target-owned trace planes", () => {
    /*
     * HAVPE's XMOS does not expose its electrical reference or completed DMA
     * playout as a readable trace. StackChan does expose its exact reference.
     * Requiring a fictional common plane would force the harness to synthesize
     * evidence, while requiring only raw/clean everywhere would discard a
     * valuable StackChan witness. The shared matrix therefore varies only the
     * target's truthful plane contract, never the experiment or DSP gates.
     */
    const evidence = aecReleaseMatrixPhaseIds().map((phaseId) => ({
      artifactPlanes: ["raw", "clean"] as const,
      dspPassed: true,
      frameConservationPassed: true,
      lifetimeMetricsRetained: true,
      perWindowMetricsRetained: true,
      phaseId,
    }));
    expect(
      assessAecReleaseMatrixCompletion({
        device: "home-assistant-voice-preview-edition",
        evidence,
        network: { passed: true, reasons: [] },
      }).accepted,
    ).toBe(true);
    expect(
      assessAecReleaseMatrixCompletion({
        device: "stackchan",
        evidence,
        network: { passed: true, reasons: [] },
      }).dsp.reasons,
    ).toContain(
      `AEC phase ${aecReleaseMatrixPhaseIds()[0]} did not retain its electrical-reference PCM plane.`,
    );
  });
});
