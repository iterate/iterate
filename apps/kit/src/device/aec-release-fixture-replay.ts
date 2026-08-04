import type { DeterministicPcmResponsePlan } from "../voice/deterministic-pcm-provider.ts";
import { createBufferPcm16LeRenderer } from "../voice/deterministic-pcm-renderers.ts";
import type { AecReleaseFixturePhase } from "./aec-release-fixture-plan.ts";

interface PreparedPhase {
  durationMs: number;
  phaseId: string;
  source: Uint8Array;
  sourcePauses: AecReleaseFixturePhase["sourcePauses"];
}

/** Bridges asynchronous retained-file verification into synchronous provider control. */
export class AecReleaseFixtureReplay {
  readonly #consumedPhaseIds: string[] = [];
  readonly #readFarPcm: (phaseId: string) => Promise<Uint8Array>;
  readonly #sampleRateHz: number;
  #nextResponseIndex = 0;
  #prepared: PreparedPhase | undefined;

  constructor(options: { readFarPcm(phaseId: string): Promise<Uint8Array>; sampleRateHz: number }) {
    if (!Number.isSafeInteger(options.sampleRateHz) || options.sampleRateHz <= 0) {
      throw new Error("AEC fixture replay requires a positive whole sample rate.");
    }
    this.#readFarPcm = options.readFarPcm;
    this.#sampleRateHz = options.sampleRateHz;
  }

  get consumedPhaseIds(): readonly string[] {
    return [...this.#consumedPhaseIds];
  }

  async prepare(phase: AecReleaseFixturePhase) {
    if (this.#prepared) {
      throw new Error(`AEC fixture phase ${this.#prepared.phaseId} is already prepared.`);
    }
    if (phase.farSource === null) {
      throw new Error(`AEC fixture phase ${phase.id} has no far source to prepare.`);
    }
    const expectedBytes = (phase.durationMs * this.#sampleRateHz * 2) / 1_000;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
      throw new Error(`AEC fixture phase ${phase.id} has an invalid duration.`);
    }
    const source = await this.#readFarPcm(phase.id);
    if (source.byteLength !== expectedBytes) {
      throw new Error(
        `AEC fixture phase ${phase.id} had ${source.byteLength} bytes; ` +
          `expected ${expectedBytes}.`,
      );
    }
    this.#prepared = {
      durationMs: phase.durationMs,
      phaseId: phase.id,
      source,
      sourcePauses: phase.sourcePauses,
    };
  }

  createResponse(responseIndex: number): DeterministicPcmResponsePlan {
    if (!this.#prepared) throw new Error("AEC fixture replay has no prepared phase.");
    if (responseIndex !== this.#nextResponseIndex) {
      throw new Error(
        `AEC fixture replay expected provider response index ${this.#nextResponseIndex}; ` +
          `received ${responseIndex}.`,
      );
    }
    const prepared = this.#prepared;
    this.#prepared = undefined;
    this.#nextResponseIndex += 1;
    this.#consumedPhaseIds.push(prepared.phaseId);
    return {
      durationMs: prepared.durationMs,
      renderer: createBufferPcm16LeRenderer(prepared.source),
      sourcePauses: prepared.sourcePauses,
    };
  }
}
