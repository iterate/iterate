import { describe, expect, it, vi } from "vitest";
import {
  AecDiagnosticPlane,
  AecDiagnosticTraceState,
  decodeAecDiagnosticTraceMetadata,
  retrieveAecDiagnosticTrace,
  type AecDiagnosticTraceCapability,
} from "./aec-diagnostic-trace.ts";

function metadata(overrides: Partial<Record<number, number>> = {}) {
  const words = [
    0x3154_4149,
    1,
    16_000,
    4,
    8,
    AecDiagnosticPlane.Near | AecDiagnosticPlane.Clean,
    4,
    AecDiagnosticTraceState.Ready,
    7,
    8,
    40,
    41,
    1,
    1,
    0,
    0,
  ];
  for (const [index, value] of Object.entries(overrides)) {
    if (value !== undefined) words[Number(index)] = value;
  }
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((value, index) => view.setUint32(index * 4, value, true));
  return bytes;
}

function planarChunk(offset: number, count: number) {
  const bytes = new Uint8Array(count * 5 * 2);
  const view = new DataView(bytes.buffer);
  for (let plane = 0; plane < 5; plane++) {
    for (let sample = 0; sample < count; sample++) {
      view.setInt16((plane * count + sample) * 2, plane * 100 + offset + sample, true);
    }
  }
  return bytes;
}

describe("AEC diagnostic trace retrieval", () => {
  it("decodes the explicit little-endian schema and rejects unknown provenance", () => {
    expect(decodeAecDiagnosticTraceMetadata(metadata())).toMatchObject({
      availablePlanes: AecDiagnosticPlane.Near | AecDiagnosticPlane.Clean,
      captureSamples: 8,
      frameSamples: 4,
      generation: 7,
      sampleRateHz: 16_000,
      state: AecDiagnosticTraceState.Ready,
    });
    expect(() => decodeAecDiagnosticTraceMetadata(metadata({ 0: 0 }))).toThrow(/magic/i);
    expect(() => decodeAecDiagnosticTraceMetadata(metadata({ 1: 2 }))).toThrow(/schema/i);
  });

  it("retains byte-exact available planes across bounded reads and never calls zeros an absent tap", async () => {
    const capability: AecDiagnosticTraceCapability = {
      describe: vi.fn(async () => metadata()),
      read: vi.fn(async ({ sampleOffset, sampleCount }) => planarChunk(sampleOffset, sampleCount)),
      release: vi.fn(async () => true),
      start: vi.fn(async () => 7),
    };

    const result = await retrieveAecDiagnosticTrace(capability, {
      expectedGeneration: 7,
      pollIntervalMs: 0,
      timeoutMs: 100,
    });

    expect([...result.planes.near!]).toEqual([0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0]);
    expect([...result.planes.clean!]).toEqual([
      0x90, 0x01, 0x91, 0x01, 0x92, 0x01, 0x93, 0x01, 0x94, 0x01, 0x95, 0x01, 0x96, 0x01, 0x97,
      0x01,
    ]);
    expect(result.planes.reference).toBeUndefined();
    expect(result.planes.playout).toBeUndefined();
    expect(result.planes.linear).toBeUndefined();
    expect(capability.read).toHaveBeenCalledTimes(2);
    expect(capability.release).toHaveBeenCalledOnce();
  });

  it("releases an aborted generation and preserves its failure as a rejection", async () => {
    const capability: AecDiagnosticTraceCapability = {
      describe: vi.fn(async () =>
        metadata({
          7: AecDiagnosticTraceState.Aborted,
          9: 4,
          14: 1,
        }),
      ),
      read: vi.fn(),
      release: vi.fn(async () => true),
      start: vi.fn(async () => 7),
    };
    await expect(
      retrieveAecDiagnosticTrace(capability, {
        expectedGeneration: 7,
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/aborted/i);
    expect(capability.read).not.toHaveBeenCalled();
    expect(capability.release).toHaveBeenCalledOnce();
  });

  it("rejects short planar replies instead of padding an evidence artifact", async () => {
    const capability: AecDiagnosticTraceCapability = {
      describe: vi.fn(async () => metadata()),
      read: vi.fn(async () => new Uint8Array(1)),
      release: vi.fn(async () => true),
      start: vi.fn(async () => 7),
    };
    await expect(
      retrieveAecDiagnosticTrace(capability, {
        expectedGeneration: 7,
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/byte length/i);
    expect(capability.release).toHaveBeenCalledOnce();
  });
});
