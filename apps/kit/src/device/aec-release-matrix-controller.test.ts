import { describe, expect, it } from "vitest";
import type { AecReleaseFixturePlan } from "./aec-release-fixture-plan.ts";
import { runAecReleaseMatrixController } from "./aec-release-matrix-controller.ts";

describe("AEC release matrix controller", () => {
  it("executes every phase in order through one target-independent lifecycle", async () => {
    /*
     * A target-local loop can quietly skip difficult volume corners or model a
     * restart differently on HAVPE and StackChan. This miniature plan pins the
     * shared ordering and source/lifecycle choreography without waiting for a
     * physical twenty-minute acquisition in the host suite.
     */
    const events: string[] = [];
    let nowMs = 0;
    const plan = {
      phases: [
        {
          durationMs: 10,
          farSource: null,
          id: "ambient",
          lifecycleAction: null,
          nearSource: null,
          scenario: "ambient",
        },
        {
          durationMs: 20,
          farSource: { kind: "tone", peakAmplitude: 1_000, sampleRateHz: 16_000 },
          id: "double",
          lifecycleAction: null,
          nearSource: {
            kind: "deterministic-speech-wave",
            level: "nominal",
            macOutputVolumePercent: 30,
          },
          scenario: "double-talk",
        },
        {
          durationMs: 30,
          farSource: {
            kind: "speech-shaped",
            peakAmplitude: 1_000,
            sampleRateHz: 16_000,
            seed: 1,
          },
          id: "restart",
          lifecycleAction: "conversation-stop-start",
          nearSource: null,
          scenario: "lifecycle",
        },
      ],
    } as unknown as AecReleaseFixturePlan;

    await runAecReleaseMatrixController(
      plan,
      {
        beginPhase: async (phase) => {
          events.push(`begin:${phase.id}`);
        },
        capturePhase: async (phase) => {
          events.push(`capture:${phase.id}`);
        },
        endPhase: async (phase) => {
          events.push(`end:${phase.id}`);
        },
        performLifecycleAction: async (phase) => {
          events.push(`lifecycle:${phase.id}`);
        },
        startFarSource: async (phase) => {
          events.push(`far:${phase.id}`);
          return async () => {
            events.push(`far-done:${phase.id}`);
          };
        },
        startNearSource: async (phase) => {
          events.push(`near:${phase.id}`);
          return async () => {
            events.push(`near-done:${phase.id}`);
          };
        },
        sourcesStarted: async (phase) => {
          events.push(`sources-started:${phase.id}`);
        },
      },
      {
        now: () => nowMs,
        wait: async (durationMs) => {
          events.push(`wait:${durationMs}`);
          nowMs += durationMs;
        },
      },
    );

    expect(events).toEqual([
      "begin:ambient",
      "sources-started:ambient",
      "capture:ambient",
      "wait:10",
      "end:ambient",
      "begin:double",
      "far:double",
      "near:double",
      "sources-started:double",
      "capture:double",
      "far-done:double",
      "near-done:double",
      "wait:20",
      "end:double",
      "lifecycle:restart",
      "begin:restart",
      "far:restart",
      "sources-started:restart",
      "capture:restart",
      "far-done:restart",
      "wait:30",
      "end:restart",
    ]);
  });

  it("keeps a phase open for its declared duration even when a trace returns immediately", async () => {
    /*
     * A device trace is intentionally a bounded window. Treating completion of
     * that window as completion of a long physical phase would make the
     * ten-minute stability row a few seconds long while retaining a convincing
     * phase ID. The target-independent clock owns this invariant.
     */
    let nowMs = 100;
    const events: string[] = [];
    const plan = {
      phases: [
        {
          durationMs: 600_000,
          farSource: null,
          id: "stability",
          lifecycleAction: null,
          nearSource: null,
          scenario: "ambient",
        },
      ],
    } as unknown as AecReleaseFixturePlan;

    await runAecReleaseMatrixController(
      plan,
      {
        beginPhase: async () => {
          events.push("begin");
        },
        capturePhase: async () => {
          events.push("trace-complete");
        },
        endPhase: async () => {
          events.push("end");
        },
        performLifecycleAction: async () => undefined,
        startFarSource: async () => async () => undefined,
        startNearSource: async () => async () => undefined,
        sourcesStarted: async () => {
          events.push("sources-started");
        },
      },
      {
        now: () => nowMs,
        wait: async (durationMs) => {
          events.push(`wait:${durationMs}`);
          nowMs += durationMs;
        },
      },
    );

    expect(events).toEqual(["begin", "sources-started", "trace-complete", "wait:600000", "end"]);
  });

  it("does not mark a failed source phase complete", async () => {
    /*
     * Partial physical evidence is retained, but it must never receive the
     * same end marker as a completed phase after a provider/socket failure.
     */
    const events: string[] = [];
    const plan = {
      phases: [
        {
          durationMs: 20,
          farSource: { kind: "tone", peakAmplitude: 1_000, sampleRateHz: 16_000 },
          id: "failure",
          lifecycleAction: null,
          nearSource: null,
          scenario: "far-end-only",
        },
      ],
    } as unknown as AecReleaseFixturePlan;
    await expect(
      runAecReleaseMatrixController(
        plan,
        {
          beginPhase: async () => {
            events.push("begin");
          },
          capturePhase: async () => {
            throw new Error("socket lost");
          },
          endPhase: async () => {
            events.push("end");
          },
          performLifecycleAction: async () => undefined,
          startFarSource: async () => async () => {
            events.push("source-complete");
          },
          startNearSource: async () => async () => undefined,
          sourcesStarted: async () => undefined,
        },
        { now: () => 0, wait: async () => undefined },
      ),
    ).rejects.toThrow("socket lost");
    expect(events).toEqual(["begin"]);
  });
});
