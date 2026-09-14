import {
  VOICE_AGENT_GUEST_SOURCE,
  VOICE_AGENT_PACKAGE_NAME,
  VOICE_AGENT_PACKAGE_SPEC,
  VOICE_AGENT_ZOD_SPEC,
} from "@iterate-com/voice-agent";
import { expect, test } from "vitest";
import {
  chatVoiceStreamPath,
  ensureVoiceAgentSetup,
  setupMarker,
  MOBILE_VOICE_SETUP,
} from "./voice-setup.ts";

/** A repo that already has the agent: both dependency lines and the re-export — the common case. */
const repoWithTemplate = {
  readFile: async ({ path }: { path: string }) =>
    path === "package.json"
      ? {
          commitOid: "0".repeat(40),
          content: JSON.stringify(
            {
              name: "a-project",
              dependencies: {
                [VOICE_AGENT_PACKAGE_NAME]: VOICE_AGENT_PACKAGE_SPEC,
                zod: VOICE_AGENT_ZOD_SPEC,
              },
            },
            null,
            2,
          ),
        }
      : path === "voice-agent.ts"
        ? { commitOid: "0".repeat(40), content: VOICE_AGENT_GUEST_SOURCE }
        : null,
  commitFiles: async () => {
    throw new Error("must not commit over an installed package");
  },
};

test("the marker is stable for one stream and distinct across streams and configs", () => {
  expect(setupMarker("/agents/voice/mobile-a")).toBe(setupMarker("/agents/voice/mobile-a"));
  expect(setupMarker("/agents/voice/mobile-a")).not.toBe(setupMarker("/agents/voice/mobile-b"));
  /* Each chat has its own line, so two chats never share a marker. */
  expect(setupMarker(chatVoiceStreamPath("/agents/mobile/1"))).not.toBe(
    setupMarker(chatVoiceStreamPath("/agents/mobile/2")),
  );
});

test("a chat's voice line derives from its path without legacy routing settings", () => {
  expect(chatVoiceStreamPath("/agents/mobile/1756422")).toBe("/agents/voice/chat/mobile/1756422");
  expect("greeting" in MOBILE_VOICE_SETUP).toBe(false);
});

test("a matching marker skips setup entirely", async () => {
  const calls: unknown[] = [];
  await ensureVoiceAgentSetup({
    workers: { get: () => ({ setupVoiceAgent: async (o: unknown) => calls.push(o) }) },
    repo: repoWithTemplate,
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
  const streamPath = chatVoiceStreamPath("/agents/mobile/device-1");
  await ensureVoiceAgentSetup({
    workers: { get: () => ({ setupVoiceAgent: async (o: unknown) => calls.push(o) }) },
    repo: repoWithTemplate,
    streamPath,
    readMarker: async () => null,
    writeMarker: async (path, marker) => {
      written.push([path, marker]);
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    streamPath: "/agents/voice/chat/mobile/device-1",
    instructions: MOBILE_VOICE_SETUP.instructions,
  });
  expect(calls[0]).not.toHaveProperty("tools");
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
      repo: repoWithTemplate,
      streamPath: "/agents/voice/mobile-x",
      readMarker: async () => null,
      writeMarker: async (_, marker) => {
        written.push(marker);
      },
    }),
  ).rejects.toThrow("secret missing");
  expect(written).toEqual([]);
});
