import { describe, expect, it } from "vitest";
import { AecReleaseFixtureReplay } from "./aec-release-fixture-replay.ts";

describe("AEC release fixture replay", () => {
  it("allows exactly one verified prepared phase at each provider response index", async () => {
    /*
     * File verification is asynchronous but the WebSocket provider's
     * response.create callback is synchronous. A one-phase handoff keeps the
     * whole ten-minute bundle out of memory without permitting a reconnect or
     * duplicate request to consume the wrong phase under a persuasive label.
     */
    const sources = new Map([
      ["phase-a", new Uint8Array([1, 0, 2, 0])],
      ["phase-b", new Uint8Array([3, 0, 4, 0])],
    ]);
    const replay = new AecReleaseFixtureReplay({
      readFarPcm: async (phaseId) => sources.get(phaseId)!,
      sampleRateHz: 1_000,
    });

    await replay.prepare(phase("phase-a", 2));
    expect(() => replay.createResponse(1)).toThrow(/expected provider response index 0/u);
    const first = replay.createResponse(0);
    expect(first.durationMs).toBe(2);
    expect(first.renderer.render(2)).toEqual(sources.get("phase-a"));
    expect(() => replay.createResponse(0)).toThrow(/no prepared phase/u);

    await replay.prepare({
      ...phase("phase-b", 2),
      sourcePauses: [{ afterSamples: 1, durationMs: 50 }],
    });
    const second = replay.createResponse(1);
    expect(second.renderer.render(2)).toEqual(sources.get("phase-b"));
    expect(second.sourcePauses).toEqual([{ afterSamples: 1, durationMs: 50 }]);
    expect(replay.consumedPhaseIds).toEqual(["phase-a", "phase-b"]);
  });

  it("rejects an artifact whose byte count disagrees with its declared media duration", async () => {
    /*
     * A valid hash proves file identity, not that metadata assigns it the
     * correct duration. Rejecting the mismatch before response.create prevents
     * renderer exhaustion from appearing later as a device reconnect.
     */
    const replay = new AecReleaseFixtureReplay({
      readFarPcm: async () => new Uint8Array([1, 0]),
      sampleRateHz: 16_000,
    });
    await expect(replay.prepare(phase("short", 20))).rejects.toThrow(/bytes; expected 640/u);
  });
});

function phase(id: string, durationMs: number) {
  return {
    durationMs,
    farSource: { kind: "tone" as const, peakAmplitude: 1_000, sampleRateHz: 1_000 },
    id,
    lifecycleAction: null,
    nearSource: null,
    scenario: "far-end-only" as const,
    sourcePauses: [],
  };
}
