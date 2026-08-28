import { expect, test } from "vitest";
import {
  ensureVoiceAgentSetup,
  mobileVoiceStreamPath,
  setupMarker,
  MOBILE_VOICE_SETUP,
} from "./voice-setup.ts";

test("the marker is stable for one stream and distinct across streams", () => {
  expect(setupMarker("/agents/voice/mobile-a")).toBe(setupMarker("/agents/voice/mobile-a"));
  expect(setupMarker("/agents/voice/mobile-a")).not.toBe(setupMarker("/agents/voice/mobile-b"));
});

test("a matching marker skips setup entirely", async () => {
  const calls: unknown[] = [];
  await ensureVoiceAgentSetup({
    workers: { get: () => ({ setupVoiceAgent: async (o: unknown) => calls.push(o) }) },
    streamPath: "/agents/voice/mobile-x",
    readMarker: async () => setupMarker("/agents/voice/mobile-x"),
    writeMarker: async () => {
      throw new Error("must not rewrite a matching marker");
    },
  });
  expect(calls).toEqual([]);
});

test("a missing marker runs setup with the full config, then records the marker", async () => {
  const calls: any[] = [];
  const written: [string, string][] = [];
  const streamPath = mobileVoiceStreamPath("device-1");
  await ensureVoiceAgentSetup({
    workers: { get: () => ({ setupVoiceAgent: async (o: unknown) => calls.push(o) }) },
    streamPath,
    readMarker: async () => null,
    writeMarker: async (path, marker) => {
      written.push([path, marker]);
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    streamPath: "/agents/voice/mobile-device-1",
    clientTakesTurns: true,
    colleague: true,
    instructions: MOBILE_VOICE_SETUP.instructions,
  });
  expect(calls[0].tools.map((tool: any) => tool.name)).toEqual(["hang_up"]);
  expect(written).toEqual([[streamPath, setupMarker(streamPath)]]);
});

test("a failed setup writes no marker, so the next tap retries", async () => {
  const written: string[] = [];
  await expect(
    ensureVoiceAgentSetup({
      workers: {
        get: () => ({
          setupVoiceAgent: async () => {
            throw new Error("secret missing");
          },
        }),
      },
      streamPath: "/agents/voice/mobile-x",
      readMarker: async () => null,
      writeMarker: async (_, marker) => {
        written.push(marker);
      },
    }),
  ).rejects.toThrow("secret missing");
  expect(written).toEqual([]);
});
