import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  assessDeviceRuntimeMetrics,
  parseDeviceRuntimeLogLine,
} from "../../src/device/device-runtime-log.ts";

function fixturePath() {
  const path = process.env.ITERATE_KIT_RUNTIME_DIAGNOSTICS_FIXTURE;
  if (!path) {
    throw new Error(
      "ITERATE_KIT_RUNTIME_DIAGNOSTICS_FIXTURE must point at the built C fixture.",
    );
  }
  return path;
}

/*
 * A C unit test can prove byte accounting while still emitting field names or
 * values the real TypeScript recorder rejects. Execute the compiled formatter
 * as the producer of record, then pass every line through the same parser and
 * health assessor used by physical USB runs. The fixture emits one
 * pre-baseline observation and one live interval so `cpu_permille=-1` remains
 * explicit during startup without being mistaken for a ready-device result,
 * while the second sample proves all three cycle deltas are usable evidence.
 */
describe("C runtime diagnostics wire contract", () => {
  test("every C-formatted family is accepted by the physical recorder", () => {
    const fixture = spawnSync(fixturePath(), [], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(fixture.error).toBeUndefined();
    expect(fixture.signal).toBeNull();
    expect(fixture.status).toBe(0);
    expect(fixture.stderr).toBe("");

    const observations = fixture.stdout
      .trim()
      .split("\n")
      .map((line) => parseDeviceRuntimeLogLine(line));
    expect(observations).toHaveLength(6);
    expect(observations.every((observation) => observation?.kind === "metrics")).toBe(true);

    for (const observation of observations) {
      if (observation?.kind !== "metrics") {
        throw new Error("The C fixture emitted a non-metrics observation.");
      }
      expect(
        assessDeviceRuntimeMetrics(observation.values, {
          maximumTaskWorkCyclesPerReport: 300_000_000,
          minimumNetworkStackHeadroomBytes: 512,
        }),
      ).toBeUndefined();
    }

    const system = observations.filter(
      (observation) => observation?.kind === "metrics" && observation.family === "system",
    );
    expect(system).toHaveLength(2);
    const liveSystem = system[1];
    if (liveSystem?.kind !== "metrics") {
      throw new Error("The live C system report was not parsed.");
    }
    expect(liveSystem.values).toMatchObject({
      control_transport: "ready",
      cpu_permille: 73,
      main_cycles: 54_000,
      net_cycles: 91_000,
      pcm_net_cycles: 81_000,
      pcm_transport: "ready",
      report_seq: 2,
    });
  });
});
