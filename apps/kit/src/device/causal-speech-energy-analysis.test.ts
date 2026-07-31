import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  analyzePcm16WindowEnergy,
  assessCausalSpeechEnergy,
  causalSpeechActiveThreshold,
} from "./causal-speech-energy-analysis.ts";

const artifacts: string[] = [];
const sampleRateHz = 16_000;

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(artifacts.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe("causal returned-speech energy oracle", () => {
  test("accepts sustained response energy while retaining the exact baseline-relative threshold", async () => {
    const baseline = sine(1_000, 35);
    const response = sine(1_000, 1_200);
    const artifactPath = await artifact([...baseline, ...response]);
    const baselineAnalysis = await analyzePcm16WindowEnergy({
      artifactPath,
      endSample: baseline.length,
      sampleRateHz,
      startSample: 0,
    });
    const responseAnalysis = await analyzePcm16WindowEnergy({
      activeThresholdRms: causalSpeechActiveThreshold(baselineAnalysis),
      artifactPath,
      endSample: baseline.length + response.length,
      sampleRateHz,
      startSample: baseline.length,
    });

    expect(assessCausalSpeechEnergy(baselineAnalysis, responseAnalysis)).toMatchObject({
      activeWindowCount: 50,
      passed: true,
      reasons: [],
    });
  });

  test("rejects ambient noise that did not become materially louder after the causal marker", async () => {
    const baseline = sine(1_000, 90);
    const response = sine(1_000, 90);
    const artifactPath = await artifact([...baseline, ...response]);
    const baselineAnalysis = await analyzePcm16WindowEnergy({
      artifactPath,
      endSample: baseline.length,
      sampleRateHz,
      startSample: 0,
    });
    const responseAnalysis = await analyzePcm16WindowEnergy({
      activeThresholdRms: causalSpeechActiveThreshold(baselineAnalysis),
      artifactPath,
      endSample: baseline.length + response.length,
      sampleRateHz,
      startSample: baseline.length,
    });

    const assessment = assessCausalSpeechEnergy(baselineAnalysis, responseAnalysis);
    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(
      "The causal response contained 0 active 20 ms windows; expected at least 4.",
    );
  });

  test("rejects one loud click because an impulse is not an audible spoken return", async () => {
    const baseline = new Int16Array(sampleRateHz);
    const response = new Int16Array(sampleRateHz);
    response[1_000] = 12_000;
    const artifactPath = await artifact([...baseline, ...response]);
    const baselineAnalysis = await analyzePcm16WindowEnergy({
      artifactPath,
      endSample: baseline.length,
      sampleRateHz,
      startSample: 0,
    });
    const responseAnalysis = await analyzePcm16WindowEnergy({
      activeThresholdRms: causalSpeechActiveThreshold(baselineAnalysis),
      artifactPath,
      endSample: baseline.length + response.length,
      sampleRateHz,
      startSample: baseline.length,
    });

    expect(assessCausalSpeechEnergy(baselineAnalysis, responseAnalysis).passed).toBe(false);
  });
});

function sine(durationMs: number, amplitude: number) {
  return Int16Array.from({ length: (sampleRateHz * durationMs) / 1_000 }, (_, index) =>
    Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRateHz) * amplitude),
  );
}

async function artifact(samples: number[]) {
  const directory = await mkdtemp(join(tmpdir(), "iterate-kit-speech-energy-"));
  artifacts.push(directory);
  const artifactPath = join(directory, "capture.pcm16le");
  const bytes = Buffer.alloc(samples.length * Int16Array.BYTES_PER_ELEMENT);
  for (const [index, sample] of samples.entries()) {
    bytes.writeInt16LE(sample, index * Int16Array.BYTES_PER_ELEMENT);
  }
  await writeFile(artifactPath, bytes);
  return artifactPath;
}
